"use client";

import { useEffect, useState } from "react";
import { Input, Switch, Select } from "@/ui";
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
  authHeaders,
  errorText,
  now,
  useExampleEnv,
} from "./shared";

type Model = { id: string; name?: string; params?: string[]; providerAlias?: string };

export function SttExample({ providerId }: { providerId: string }) {
  const alias = getProviderAlias(providerId) as string;
  const builtin = (getModelsByProviderId(providerId) as Model[]).filter(
    (m) => getModelKind(m) === "stt",
  );
  const [customModels, setCustomModels] = useState<Model[]>([]);
  const models = [...builtin, ...customModels];
  const env = useExampleEnv();

  const [model, setModel] = useState(builtin[0]?.id ?? "");
  const allowed = models.find((m) => m.id === model)?.params ?? [];
  const has = (p: string) => allowed.includes(p);
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState("");
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState("json");
  const [temperature, setTemperature] = useState("");
  const [granularity, setGranularity] = useState("");
  const [tagEvents, setTagEvents] = useState(false);
  const [diarize, setDiarize] = useState(false);
  const [speakers, setSpeakers] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  // User-added STT models for this provider; refresh when models change elsewhere.
  useEffect(() => {
    const load = () =>
      fetch("/api/models/custom", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { models: [] }))
        .then((d: { models?: Model[] }) =>
          setCustomModels(
            (d.models || []).filter((m) => getModelKind(m) === "stt" && m.providerAlias === alias),
          ),
        )
        .catch(() => {
          /* built-in models still work */
        });
    void load();
    window.addEventListener("focus", load);
    window.addEventListener("customModelChanged", load);
    return () => {
      window.removeEventListener("focus", load);
      window.removeEventListener("customModelChanged", load);
    };
  }, [alias]);

  const modelFull = model.trim() ? `${alias}/${model.trim()}` : "";
  // diarize and num_speakers are mutually exclusive upstream — only one goes out.
  const fields = (): [string, string][] =>
    [
      has("language") && language && ["language", language],
      has("response_format") && ["response_format", format],
      has("temperature") && temperature && ["temperature", temperature],
      has("prompt") && prompt && ["prompt", prompt],
      has("timestamps_granularity") && granularity && ["timestamps_granularity", granularity],
      has("tag_audio_events") && tagEvents && ["tag_audio_events", "true"],
      has("diarize") && diarize
        ? ["diarize", "true"]
        : has("num_speakers") && speakers && ["num_speakers", speakers],
    ].filter(Boolean) as [string, string][];

  const curl = (key: string) =>
    [
      `curl -X POST ${env.endpoint}/v1/audio/transcriptions`,
      `  -H "Authorization: Bearer ${key}"`,
      `  -F "file=@${file?.name || "audio.mp3"}"`,
      `  -F "model=${modelFull}"`,
      ...fields().map(([k, v]) => `  -F "${k}=${v}"`),
    ].join(" \\\n");

  const run = async () => {
    if (!file || !modelFull) return;
    setRunning(true);
    setError("");
    setResult(null);
    const start = now();
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("model", modelFull);
      for (const [k, v] of fields()) fd.append(k, v);
      const res = await fetch("/api/v1/audio/transcriptions", {
        method: "POST",
        headers: authHeaders(env),
        body: fd,
      });
      setLatency(now() - start);
      const ct = res.headers.get("content-type") || "";
      const data: unknown = ct.includes("application/json")
        ? await res.json().catch(() => null)
        : await res.text();
      if (!res.ok) setError(errorText(data, res.status));
      else setResult(data);
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  const text =
    result == null ? "" : typeof result === "string" ? result : JSON.stringify(result, null, 2);

  return (
    <ExamplePanel method="POST" path="/v1/audio/transcriptions">
      <Row label="Model">
        {models.length > 0 ? (
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            mono
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Enter model id"
          />
        )}
      </Row>
      <EndpointRow env={env} path="/v1/audio/transcriptions" />
      <KeyRow env={env} />
      <Row label="Audio file">
        <div className="min-w-0 space-y-1">
          <input
            type="file"
            accept="audio/*,video/mp4,.m4a,.mp3,.wav,.ogg,.flac,.webm,.opus"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="block w-full min-w-0 text-xs text-text-muted file:mr-2 file:h-8 file:cursor-pointer file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:text-xs file:text-text hover:file:bg-surface-2 dark:file:border-border"
          />
          {file && (
            <span className="block truncate font-mono text-[11px] text-text-muted">
              {file.name} · {(file.size / 1024).toFixed(1)} KB
            </span>
          )}
        </div>
      </Row>
      {has("language") && (
        <Row label="Language">
          <Input
            mono
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="e.g. en, vi, ja (auto-detect if empty)"
          />
        </Row>
      )}
      {has("prompt") && (
        <Row label="Prompt">
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Optional context to improve accuracy"
          />
        </Row>
      )}
      {has("temperature") && (
        <Row label="Temperature">
          <Input
            type="number"
            step={0.1}
            min={0}
            max={1}
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            placeholder="0 – 1 (default 0)"
          />
        </Row>
      )}
      {has("response_format") && (
        <Row label="Format">
          <Select value={format} onChange={(e) => setFormat(e.target.value)}>
            {["json", "text", "srt", "verbose_json", "vtt"].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Row>
      )}
      {has("timestamps_granularity") && (
        <Row label="Timestamps">
          <Select value={granularity} onChange={(e) => setGranularity(e.target.value)}>
            <option value="">Provider default</option>
            <option value="word">word</option>
            <option value="character">character</option>
            <option value="none">none</option>
          </Select>
        </Row>
      )}
      {has("tag_audio_events") && (
        <Row label="Audio events">
          <span className="flex items-center gap-2 text-xs text-text-muted">
            <Switch checked={tagEvents} onChange={setTagEvents} label="Tag audio events" />
            Label non-speech sounds as [laughter], [applause]…
          </span>
        </Row>
      )}
      {has("diarize") && (
        <Row label="Speakers">
          <span className="flex items-center gap-2 text-xs text-text-muted">
            <Switch checked={diarize} onChange={setDiarize} label="Detect speakers" />
            Detect speakers automatically
          </span>
        </Row>
      )}
      {has("num_speakers") && (
        <Row label="Speaker count">
          <Input
            type="number"
            step={1}
            min={1}
            max={32}
            value={speakers}
            onChange={(e) => setSpeakers(e.target.value)}
            disabled={diarize}
            placeholder={diarize ? "Detected automatically" : "Auto-detect"}
            className="disabled:opacity-50"
          />
        </Row>
      )}
      <RequestBlock
        env={env}
        curl={curl}
        onRun={run}
        running={running}
        disabled={!file || !modelFull}
        runLabel="Transcribe"
        runningLabel="Transcribing…"
      />
      {!file && <p className="text-[11px] text-text-muted">Pick an audio file to transcribe.</p>}
      <ErrorNote>{error}</ErrorNote>
      <ResponseBlock
        text={text}
        placeholder={`{\n  "text": "Hello world..."\n}`}
        latencyMs={result != null ? latency : null}
      />
    </ExamplePanel>
  );
}
