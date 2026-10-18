"use client";

import { useState } from "react";
import { Input } from "@/ui";
import { getProviderAlias } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import {
  EndpointRow,
  ErrorNote,
  ExamplePanel,
  KeyRow,
  RequestBlock,
  ResponseBlock,
  Row,
  Select,
  authHeaders,
  errorText,
  now,
  useExampleEnv,
} from "./shared";

type Model = { id: string; name?: string };

const PLACEHOLDER = `{
  "object": "list",
  "data": [{
    "object": "embedding",
    "index": 0,
    "embedding": [0.002301, -0.019212, 0.004815, -0.031249, ...]
  }],
  "model": "...",
  "usage": { "prompt_tokens": 9, "total_tokens": 9 }
}`;

// Long vectors: first 4 values + dimension count.
function compact(data: unknown): string {
  const clone = JSON.parse(JSON.stringify(data)) as { data?: { embedding?: unknown }[] };
  for (const item of clone.data || []) {
    if (Array.isArray(item.embedding) && item.embedding.length > 4) {
      item.embedding = [
        ...item.embedding.slice(0, 4).map((v: number) => parseFloat(Number(v).toFixed(6))),
        `... (${item.embedding.length} dims)`,
      ];
    }
  }
  return JSON.stringify(clone, null, 2);
}

export function EmbeddingExample({
  providerId,
  customAlias,
}: {
  providerId: string;
  /** Prefix of a custom embedding node (its model alias). */
  customAlias?: string;
}) {
  const custom = customAlias !== undefined;
  const alias = custom ? customAlias || providerId : (getProviderAlias(providerId) as string);
  const models = custom
    ? []
    : (getModelsByProviderId(providerId) as Model[]).filter((m) => getModelKind(m) === "embedding");
  const env = useExampleEnv();
  const [model, setModel] = useState(models[0]?.id ?? "");
  const [input, setInput] = useState("The quick brown fox jumps over the lazy dog");
  const [dimensions, setDimensions] = useState("");
  const [result, setResult] = useState<{ data: unknown; latencyMs: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const modelFull = model.trim() ? `${alias}/${model.trim()}` : "";
  const body = () => {
    const b: Record<string, unknown> = { model: modelFull, input: input.trim() };
    const dim = Number(dimensions);
    if (dimensions && Number.isFinite(dim) && dim > 0) b.dimensions = dim;
    return b;
  };
  const curl = (key: string) => `curl -X POST ${env.endpoint}/v1/embeddings \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${key}" \\
  -d '${JSON.stringify(body())}'`;

  const run = async () => {
    if (!input.trim() || !modelFull) return;
    setRunning(true);
    setError("");
    setResult(null);
    const start = now();
    try {
      const res = await fetch("/api/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(env) },
        body: JSON.stringify(body()),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setError(errorText(data, res.status));
      else setResult({ data, latencyMs: now() - start });
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <ExamplePanel method="POST" path="/v1/embeddings">
      <Row label="Model">
        {custom || models.length === 0 ? (
          <Input
            mono
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. voyage-3, embed-english-v3.0, text-embedding-3-small"
          />
        ) : (
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </Select>
        )}
      </Row>
      <EndpointRow env={env} path="/v1/embeddings" />
      <KeyRow env={env} />
      <Row label="Input">
        <Input value={input} onChange={(e) => setInput(e.target.value)} />
      </Row>
      <Row label="Dimensions">
        <Input
          type="number"
          min={1}
          value={dimensions}
          onChange={(e) => setDimensions(e.target.value)}
          placeholder="Optional, e.g. 512"
        />
      </Row>
      <RequestBlock
        env={env}
        curl={curl}
        onRun={run}
        running={running}
        disabled={!input.trim() || !modelFull}
        runLabel="Embed"
        runningLabel="Embedding…"
      />
      <ErrorNote>{error}</ErrorNote>
      <ResponseBlock
        text={result ? compact(result.data) : ""}
        copyText={result ? JSON.stringify(result.data, null, 2) : undefined}
        placeholder={PLACEHOLDER}
        latencyMs={result?.latencyMs}
      />
    </ExamplePanel>
  );
}
