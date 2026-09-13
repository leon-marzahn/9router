"use client";

import { useEffect, useState } from "react";
import { Button, Card, Input } from "@/shared/components";
import { validatePipelines } from "@/lib/request-pipelines/config.js";

const exampleRule = () => ({ regex: "<internal_states>[\\s\\S]*?</internal_states>", replacement: "", depth: 1 });
const exampleBody = JSON.stringify({
  messages: [
    { role: "user", content: "Earlier context <internal_states>old state</internal_states>" },
    { role: "user", content: "Continue working <internal_states>latest state</internal_states>" },
  ],
}, null, 2);
const textareaClass = "w-full rounded-lg border border-border bg-surface-2 p-3 text-sm font-mono text-text-main";

export default function RequestPipelinesPage() {
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewIndex, setPreviewIndex] = useState(0);
  const [sample, setSample] = useState(exampleBody);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/settings").then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load pipelines");
      if (active) setPipelines(data.requestPipelines || []);
    }).catch((error) => {
      if (active) { setError(error.message); setLoadFailed(true); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function change(next) {
    setPipelines(next);
    setNotice("");
    setError("");
    setPreview(null);
  }

  function updateRule(pipelineIndex, ruleIndex, patch) {
    change(pipelines.map((pipeline, index) => index === pipelineIndex ? {
      ...pipeline, rules: pipeline.rules.map((rule, i) => i === ruleIndex ? { ...rule, ...patch } : rule),
    } : pipeline));
  }

  function moveRule(pipelineIndex, ruleIndex, direction) {
    const rules = [...pipelines[pipelineIndex].rules];
    [rules[ruleIndex], rules[ruleIndex + direction]] = [rules[ruleIndex + direction], rules[ruleIndex]];
    change(pipelines.map((pipeline, index) => index === pipelineIndex ? { ...pipeline, rules } : pipeline));
  }

  async function save() {
    setSaving(true); setError(""); setNotice("");
    try {
      const validated = validatePipelines(pipelines);
      const response = await fetch("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestPipelines: validated }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save pipelines");
      setPipelines(data.requestPipelines);
      setNotice("Pipelines saved. Changes apply to new requests immediately.");
    } catch (error) { setError(error.message); }
    finally { setSaving(false); }
  }

  async function runPreview() {
    setPreviewing(true); setError(""); setPreview(null);
    try {
      const response = await fetch("/api/settings/request-pipelines/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipeline: pipelines[previewIndex], body: JSON.parse(sample) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Preview failed");
      setPreview(data);
    } catch (error) { setError(error.message); }
    finally { setPreviewing(false); }
  }

  if (loading) return <p className="text-text-muted">Loading pipelines…</p>;

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold text-text-main">Request Pipelines</h1>
        <p className="text-sm text-text-muted mt-2">
          Apply regex rules before a chat request is routed to a provider. Select one saved pipeline with the header{" "}
          <code>X-9Router-Pipeline: agentic</code>. Requests without the header are unchanged.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      {notice && <p role="status" className="text-sm text-green-600">{notice}</p>}
      <fieldset disabled={saving || previewing || loadFailed} className="flex flex-col gap-6 min-w-0">
        <Card className="p-5 text-sm text-text-muted">
          Rules run from top to bottom on message text and textual tool results. Depth preserves the latest N matches across the request;
          0 replaces all matches. System instructions are scanned first, then messages from oldest to newest.
          Matches stay within individual text blocks. Use a bare regex or /pattern/flags; matching is always global.
          Replacement defaults to empty and supports JavaScript capture references such as $1.
        </Card>
        {pipelines.map((pipeline, pipelineIndex) => (
          <Card key={pipelineIndex} className="p-5 flex flex-col gap-5">
            <div className="flex items-end gap-3">
              <Input className="flex-1" label="Pipeline name" aria-label={`Pipeline ${pipelineIndex + 1} name`}
                value={pipeline.name} hint="Use this name as the header value (case-sensitive)."
                onChange={(event) => change(pipelines.map((item, index) => index === pipelineIndex ? { ...item, name: event.target.value } : item))} />
              <Button variant="ghost" onClick={() => { change(pipelines.filter((_, index) => index !== pipelineIndex)); setPreviewIndex(0); }}>Remove pipeline</Button>
            </div>
            <code className="text-xs text-text-muted break-all">X-9Router-Pipeline: {pipeline.name || "pipeline-name"}</code>
            {pipeline.rules.map((rule, ruleIndex) => (
              <div key={ruleIndex} className="border border-border rounded-lg p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium mr-auto">Rule {ruleIndex + 1}</span>
                  <Button size="sm" variant="ghost" disabled={ruleIndex === 0} aria-label={`Move rule ${ruleIndex + 1} up`} onClick={() => moveRule(pipelineIndex, ruleIndex, -1)}>Up</Button>
                  <Button size="sm" variant="ghost" disabled={ruleIndex === pipeline.rules.length - 1} aria-label={`Move rule ${ruleIndex + 1} down`} onClick={() => moveRule(pipelineIndex, ruleIndex, 1)}>Down</Button>
                  <Button size="sm" variant="ghost" disabled={pipeline.rules.length === 1} onClick={() => change(pipelines.map((item, index) => index === pipelineIndex ? { ...item, rules: item.rules.filter((_, i) => i !== ruleIndex) } : item))}>Remove rule</Button>
                </div>
                <label className="text-sm font-medium flex flex-col gap-2">
                  Regex
                  <textarea className={textareaClass} rows={2} value={rule.regex} spellCheck={false}
                    onChange={(event) => updateRule(pipelineIndex, ruleIndex, { regex: event.target.value })} />
                </label>
                <label className="text-sm font-medium flex flex-col gap-2">
                  Replace with
                  <textarea className={textareaClass} rows={2} value={rule.replacement} placeholder="Empty (remove matches)" spellCheck={false}
                    onChange={(event) => updateRule(pipelineIndex, ruleIndex, { replacement: event.target.value })} />
                </label>
                <Input label="Depth" aria-label={`Rule ${ruleIndex + 1} depth`} type="number" min={0} step={1} value={rule.depth}
                  hint="Matches to keep: 1 keeps only the latest; 0 replaces everything matched."
                  onChange={(event) => updateRule(pipelineIndex, ruleIndex, { depth: event.target.value === "" ? "" : Number(event.target.value) })} />
              </div>
            ))}
            <Button variant="secondary" className="self-start" disabled={pipeline.rules.length >= 50}
              onClick={() => change(pipelines.map((item, index) => index === pipelineIndex ? { ...item, rules: [...item.rules, { regex: "", replacement: "", depth: 0 }] } : item))}>Add rule</Button>
          </Card>
        ))}
        {!pipelines.length && <p className="text-text-muted">No pipelines configured. Add one to start with the internal_states example.</p>}
        <div className="flex gap-3">
          <Button variant="secondary" disabled={pipelines.length >= 50} onClick={() => {
            let name = "agentic";
            for (let suffix = 2; pipelines.some((pipeline) => pipeline.name === name); suffix++) name = `agentic-${suffix}`;
            change([...pipelines, { name, rules: [exampleRule()] }]);
          }}>Add pipeline</Button>
          <Button loading={saving} onClick={save}>Save pipelines</Button>
        </div>
        {pipelines.length > 0 && <Card className="p-5 flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Preview unsaved rules</h2>
          <label className="text-sm flex flex-col gap-2">Pipeline
            <select className={textareaClass} value={previewIndex} onChange={(event) => { setPreviewIndex(Number(event.target.value)); setPreview(null); }}>
              {pipelines.map((pipeline, index) => <option key={index} value={index}>{pipeline.name || `Pipeline ${index + 1}`}</option>)}
            </select>
          </label>
          <label className="text-sm flex flex-col gap-2">Sample request JSON
            <textarea className={textareaClass} rows={10} value={sample} spellCheck={false} onChange={(event) => { setSample(event.target.value); setPreview(null); }} />
          </label>
          <Button className="self-start" variant="secondary" loading={previewing} onClick={runPreview}>Run preview</Button>
          {preview && <div className="flex flex-col gap-3" aria-live="polite">
            {preview.stats.map((stat, index) => <p key={index} className="text-sm text-text-muted">Rule {index + 1}: {stat.matches} matches, {stat.replaced} replaced, {stat.preserved} preserved.</p>)}
            <pre className={`${textareaClass} overflow-auto whitespace-pre-wrap`}>{JSON.stringify(preview.body, null, 2)}</pre>
          </div>}
        </Card>}
      </fieldset>
    </div>
  );
}
