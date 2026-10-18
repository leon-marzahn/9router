"use client";

import { useState } from "react";
import { Button, Field, Input, ProviderLogo, Segmented } from "@/ui";
import { useNotificationStore } from "@/store/notificationStore";
import type { ProviderNode } from "../model";

export type Flavor = "openai" | "anthropic";

export const TEMPLATES: { id: string; flavor: Flavor; name: string; icon: string; hint: string }[] =
  [
    {
      id: "__new-openai",
      flavor: "openai",
      name: "OpenAI-compatible",
      icon: "/providers/oai-cc.png",
      hint: "Chat Completions or Responses API",
    },
    {
      id: "__new-anthropic",
      flavor: "anthropic",
      name: "Anthropic-compatible",
      icon: "/providers/anthropic-m.png",
      hint: "Messages API",
    },
  ];

const slug = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

/** Inline "create custom endpoint" form shown in the detail pane. */
export function CustomEndpointForm({
  flavor,
  onCreated,
}: {
  flavor: Flavor;
  onCreated: (node: ProviderNode) => void;
}) {
  const isOpenAI = flavor === "openai";
  const t = TEMPLATES.find((x) => x.flavor === flavor)!;
  const notify = useNotificationStore() as unknown as {
    success: (m: string) => void;
    error: (m: string) => void;
  };
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiType, setApiType] = useState<"chat" | "responses">("chat");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<null | "test" | "create">(null);
  const [check, setCheck] = useState<null | { valid: boolean; error?: string }>(null);

  const effectivePrefix = prefixTouched ? prefix : slug(name);
  const type = isOpenAI ? "openai-compatible" : "anthropic-compatible";
  const canSubmit = name.trim() && effectivePrefix && baseUrl.trim();

  const test = async () => {
    setBusy("test");
    setCheck(null);
    try {
      const res = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), apiKey, type }),
      });
      setCheck((await res.json()) as { valid: boolean; error?: string });
    } catch {
      setCheck({ valid: false, error: "Network error" });
    } finally {
      setBusy(null);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy("create");
    try {
      const res = await fetch("/api/provider-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          prefix: effectivePrefix,
          baseUrl: baseUrl.trim(),
          type,
          ...(isOpenAI ? { apiType } : {}),
        }),
      });
      const data = (await res.json()) as { node?: ProviderNode; error?: string };
      if (!res.ok || !data.node) throw new Error(data.error || "Could not create endpoint");
      if (apiKey.trim()) {
        const keyRes = await fetch("/api/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: data.node.id,
            authType: "apikey",
            name: "Default",
            apiKey: apiKey.trim(),
          }),
        });
        if (!keyRes.ok)
          notify.error(
            "Endpoint created, but the API key couldn't be saved — add it from the endpoint's page",
          );
      }
      notify.success(`${data.node.name} created`);
      onCreated(data.node);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-6 pb-10 pt-8 lg:px-8">
      <div className="flex items-start gap-4">
        <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-surface shadow-soft ring-1 ring-border">
          <ProviderLogo src={t.icon} name={t.name} size={34} />
        </div>
        <div>
          <h1 className="font-display text-3xl tracking-tight">New {t.name} endpoint</h1>
          <p className="mt-1 text-text-muted">
            Route to any server that speaks the {isOpenAI ? "OpenAI" : "Anthropic Messages"} API,
            such as a self-hosted model, a proxy or another gateway.
          </p>
        </div>
      </div>
      <form className="mt-8 space-y-5" onSubmit={create}>
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isOpenAI ? "My vLLM box" : "Corp Claude proxy"}
            required
          />
        </Field>
        <Field
          label="Model prefix"
          hint={
            <>
              Models are addressed as{" "}
              <code className="font-mono">{effectivePrefix || "prefix"}/model-name</code>.
            </>
          }
        >
          <Input
            mono
            value={effectivePrefix}
            onChange={(e) => {
              setPrefixTouched(true);
              setPrefix(slug(e.target.value));
            }}
            placeholder="my-endpoint"
            required
          />
        </Field>
        <Field label="Base URL">
          <Input
            mono
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={isOpenAI ? "https://llm.example.com/v1" : "https://proxy.example.com/v1"}
            type="url"
            required
          />
        </Field>
        {isOpenAI && (
          <Field label="API format">
            <Segmented
              size="md"
              value={apiType}
              onChange={setApiType}
              options={[
                { value: "chat", label: "Chat Completions" },
                { value: "responses", label: "Responses" },
              ]}
            />
          </Field>
        )}
        <Field
          label="API key"
          hint="Optional. You can add more keys after creating the endpoint."
          error={check && !check.valid ? check.error || "Endpoint check failed" : undefined}
        >
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
          />
        </Field>
        {check?.valid && (
          <p className="text-xs text-success-text">Endpoint responded — looks good.</p>
        )}
        <div className="flex gap-2 pt-2">
          <Button
            type="submit"
            variant="primary"
            size="md"
            icon="add"
            loading={busy === "create"}
            disabled={!canSubmit || !!busy}
          >
            Create endpoint
          </Button>
          <Button
            size="md"
            icon="play_arrow"
            loading={busy === "test"}
            disabled={!baseUrl.trim() || !!busy}
            onClick={test}
          >
            Test first
          </Button>
        </div>
      </form>
    </div>
  );
}
