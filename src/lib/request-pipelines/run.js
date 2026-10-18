import { Worker } from "node:worker_threads";
import { compilePattern, selectPipelines, validatePipelines } from "./config.js";
import { transformRequest } from "./engine.js";

// Per-pipeline counters since the server started. Kept on globalThis so every
// route bundle in the Next server shares one copy.
const stats = (globalThis.__regentPipelineStats ??= new Map());

export function getPipelineStats() {
  return Object.fromEntries(stats);
}

function record(name, charsRemoved) {
  const entry = stats.get(name) ?? { requests: 0, charsRemoved: 0, lastUsed: 0 };
  entry.requests++;
  entry.charsRemoved += Math.max(0, charsRemoved);
  entry.lastUsed = Date.now();
  stats.set(name, entry);
}

/**
 * Run pipelines in order on one body, in a worker with a time limit.
 * Disabled rules are skipped; their stats entry is null so stats line up with rules.
 */
export async function runPipelines(body, pipelines, { timeoutMs = 1000, track = false } = {}) {
  if (!pipelines.length) return { body, stats: [] };
  const validated = validatePipelines(pipelines);
  const enabled = validated.flatMap((pipeline) => pipeline.rules.filter((rule) => rule.enabled !== false));
  const result = enabled.length ? await runInWorker(body, enabled, timeoutMs) : { body, stats: [] };
  const queue = [...result.stats];
  const perRule = validated.map((pipeline) => pipeline.rules.map((rule) => (rule.enabled === false ? null : queue.shift())));
  if (track) {
    validated.forEach((pipeline, index) => record(pipeline.name, perRule[index].reduce((sum, stat) => sum + (stat?.removed ?? 0), 0)));
  }
  return { body: result.body, stats: perRule.length === 1 ? perRule[0] : perRule.flat() };
}

/** Backwards-compatible single-pipeline entry point (header name only). */
export async function runRequestPipeline(body, name, pipelines, timeoutMs = 1000) {
  const selected = selectPipelines(pipelines, { header: name });
  return runPipelines(body, selected, { timeoutMs });
}

function runInWorker(body, rules, timeoutMs) {
  // Inline source avoids worker asset resolution differences in Next standalone builds.
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    const compile = ${compilePattern.toString()};
    const transform = ${transformRequest.toString()};
    try { parentPort.postMessage(transform(workerData.body, workerData.rules, compile)); }
    catch (error) { parentPort.postMessage({ error: error.message }); }
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { body, rules } });
    const timer = setTimeout(() => finish(new Error("Request pipeline exceeded its time limit")), timeoutMs);
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result);
    }
    worker.once("message", (result) => finish(result.error ? new Error(result.error) : null, result));
    worker.once("error", (error) => finish(error));
    worker.once("exit", () => finish(new Error("Request pipeline worker exited before completing")));
  });
}
