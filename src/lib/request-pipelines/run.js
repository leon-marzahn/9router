import { Worker } from "node:worker_threads";
import { compilePattern, validatePipelines } from "./config.js";
import { transformRequest } from "./engine.js";

export async function runRequestPipeline(body, name, pipelines, timeoutMs = 1000) {
  if (name === null || name === undefined) return { body, stats: [] };
  const selected = pipelines?.find((pipeline) => pipeline.name === name.trim());
  if (!selected) throw new Error(`Unknown request pipeline: ${name}`);
  const [pipeline] = validatePipelines([selected]);
  // Inline source avoids worker asset resolution differences in Next standalone builds.
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    const compile = ${compilePattern.toString()};
    const transform = ${transformRequest.toString()};
    try { parentPort.postMessage(transform(workerData.body, workerData.rules, compile)); }
    catch (error) { parentPort.postMessage({ error: error.message }); }
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { body, rules: pipeline.rules } });
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
