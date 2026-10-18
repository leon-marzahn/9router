"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { Button, Field, IconButton, Input, Segmented } from "@/ui";
import { inputClass } from "@/ui";
import { Note, Row, RowSkeleton, SectionCard } from "./parts";
import { notify, type Settings, type SettingsApi } from "./useSettings";

type Mode = "password" | "both" | "sso";
type Kind = "saml" | "oidc";
type Msg = { tone: "success" | "danger"; text: string } | null;

const noop = () => () => {};
const modeOf = (m?: string): Mode =>
  m === "both" ? "both" : m && m !== "password" ? "sso" : "password";

function Copy({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-text-subtle">{label}</div>
      <div className="flex min-w-0 items-center gap-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-muted">
          {value}
        </code>
        <IconButton
          icon="content_copy"
          label={`Copy ${label}`}
          onClick={() => void navigator.clipboard?.writeText(value)}
        />
      </div>
    </div>
  );
}

/** Pull the login URL and certificate out of an IdP metadata XML file. */
function parseIdpMetadata(xml: string) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return null;
  let entry = "";
  for (const n of Array.from(doc.getElementsByTagNameNS("*", "SingleSignOnService"))) {
    const loc = n.getAttribute("Location") || "";
    if (loc) {
      entry = loc;
      if ((n.getAttribute("Binding") || "").includes("HTTP-Redirect")) break;
    }
  }
  const cert = doc.getElementsByTagNameNS("*", "X509Certificate")[0]?.textContent?.trim() ?? "";
  return { entry, cert };
}

export function Sso({ api }: { api: SettingsApi }) {
  const s = api.settings;
  return (
    <SectionCard id="sso" icon="badge" title="Single sign-on">
      {!s ? (
        <RowSkeleton />
      ) : (
        <SsoForm key={String(s.ssoType) + String(s.authMode)} s={s} api={api} />
      )}
    </SectionCard>
  );
}

function SsoForm({ s, api }: { s: Settings; api: SettingsApi }) {
  const origin = useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => "",
  );
  const [mode, setMode] = useState<Mode>(modeOf(s.authMode));
  const [kind, setKind] = useState<Kind>(s.ssoType === "saml" ? "saml" : "oidc");
  const [saml, setSaml] = useState({
    samlEntryPoint: s.samlEntryPoint ?? "",
    samlIssuer: s.samlIssuer || "urn:9router:sp",
    samlCert: s.samlCert ?? "",
    samlLoginLabel: s.samlLoginLabel || "Sign in with SAML SSO",
    samlAttributeEmail: s.samlAttributeEmail || "email",
    samlAttributeName: s.samlAttributeName || "name",
  });
  const [oidc, setOidc] = useState({
    oidcIssuerUrl: s.oidcIssuerUrl ?? "",
    oidcClientId: s.oidcClientId ?? "",
    oidcScopes: s.oidcScopes || "openid profile email",
    oidcLoginLabel: s.oidcLoginLabel || "Sign in with OIDC",
  });
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<null | "save" | "test">(null);
  const [msg, setMsg] = useState<Msg>(null);
  const metaFile = useRef<HTMLInputElement>(null);

  const savedMode = modeOf(s.authMode);
  const savedKind: Kind = s.ssoType === "saml" ? "saml" : "oidc";
  const dirty =
    mode !== savedMode ||
    kind !== savedKind ||
    secret !== "" ||
    Object.entries(kind === "saml" ? saml : oidc).some(([k, v]) => (s[k] ?? "") !== v);

  const save = async () => {
    setBusy("save");
    setMsg(null);
    const fields =
      kind === "saml"
        ? Object.fromEntries(Object.entries(saml).map(([k, v]) => [k, v.trim()]))
        : {
            ...Object.fromEntries(Object.entries(oidc).map(([k, v]) => [k, v.trim()])),
            ...(secret.trim() ? { oidcClientSecret: secret.trim() } : {}),
          };
    try {
      await api.save({ ...fields, ssoType: kind, authMode: mode }, { quiet: true });
      setSecret("");
      notify().success("Sign-in saved");
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMsg(null);
    try {
      const res =
        kind === "saml"
          ? await fetch("/api/auth/saml/test", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                samlEntryPoint: saml.samlEntryPoint.trim(),
                samlIssuer: saml.samlIssuer.trim(),
                samlCert: saml.samlCert.trim(),
              }),
            })
          : await fetch("/api/auth/oidc/test", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                issuerUrl: oidc.oidcIssuerUrl.trim(),
                clientId: oidc.oidcClientId.trim(),
                scopes: oidc.oidcScopes.trim(),
                ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
              }),
            });
      const data = await res.json().catch(() => ({}));
      setMsg(
        res.ok && data.ok
          ? {
              tone: "success",
              text:
                kind === "saml"
                  ? data.message || "The provider's settings look right."
                  : `Found the provider at ${data.issuerUrl}.${data.clientSecretTested ? (data.clientSecretValid ? " The client secret works." : "") : " The client secret wasn't checked."}`,
            }
          : { tone: "danger", text: data.error || "Test failed" },
      );
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const oidcReady = !!(oidc.oidcIssuerUrl && oidc.oidcClientId && (secret || s.oidcConfigured));
  const samlReady = !!(saml.samlEntryPoint && saml.samlCert);
  const ready = kind === "saml" ? samlReady : oidcReady;

  return (
    <>
      <Row
        title="How people sign in"
        hint={
          mode === "password"
            ? "Password only. Single sign-on is off."
            : mode === "both"
              ? "Password or single sign-on, whichever they pick on the login page."
              : "Single sign-on only. The password still works for backups and turning off login."
        }
      >
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "password", label: "Password" },
            { value: "both", label: "Both" },
            { value: "sso", label: "SSO only" },
          ]}
        />
      </Row>
      <Row
        title="Provider type"
        hint="OpenID Connect for Google, Microsoft, Authentik and most others. SAML for enterprise setups like Okta or AWS IAM Identity Center."
      >
        <Segmented
          value={kind}
          onChange={(v) => {
            setKind(v);
            setMsg(null);
          }}
          options={[
            { value: "oidc", label: "OpenID Connect" },
            { value: "saml", label: "SAML" },
          ]}
        />
      </Row>

      {kind === "oidc" ? (
        <Row
          stack
          title="OpenID Connect"
          hint="Register an app with your provider using the redirect URL below."
        >
          <div className="space-y-3">
            <Copy label="Redirect URL" value={`${origin}/api/auth/oidc/callback`} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Issuer URL" className="sm:col-span-2">
                <Input
                  value={oidc.oidcIssuerUrl}
                  placeholder="https://accounts.google.com"
                  onChange={(e) => setOidc({ ...oidc, oidcIssuerUrl: e.target.value })}
                />
              </Field>
              <Field label="Client ID">
                <Input
                  value={oidc.oidcClientId}
                  onChange={(e) => setOidc({ ...oidc, oidcClientId: e.target.value })}
                />
              </Field>
              <Field
                label="Client secret"
                hint={s.oidcConfigured ? "Saved. Leave empty to keep it." : undefined}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={secret}
                  placeholder={s.oidcConfigured ? "••••••••" : ""}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </Field>
              <Field label="Scopes">
                <Input
                  value={oidc.oidcScopes}
                  onChange={(e) => setOidc({ ...oidc, oidcScopes: e.target.value })}
                />
              </Field>
              <Field label="Login button text">
                <Input
                  value={oidc.oidcLoginLabel}
                  onChange={(e) => setOidc({ ...oidc, oidcLoginLabel: e.target.value })}
                />
              </Field>
            </div>
          </div>
        </Row>
      ) : (
        <Row
          stack
          title="SAML"
          hint="Give your identity provider these two values, then paste its login URL and certificate, or load its metadata file."
        >
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Copy label="ACS URL" value={`${origin}/api/auth/saml/acs`} />
              <Copy label="Entity ID" value={saml.samlIssuer} />
            </div>
            <div>
              <Button size="sm" icon="upload_file" onClick={() => metaFile.current?.click()}>
                Load metadata XML
              </Button>
              <a
                href="/api/auth/saml/metadata"
                target="_blank"
                rel="noreferrer"
                className="ml-3 text-[12px] text-accent-text hover:underline"
              >
                Our metadata
              </a>
              <input
                ref={metaFile}
                type="file"
                accept=".xml,text/xml,application/xml"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const r = parseIdpMetadata(await f.text());
                  if (!r || (!r.entry && !r.cert))
                    return setMsg({
                      tone: "danger",
                      text: "No login URL or certificate in that file",
                    });
                  setSaml((v) => ({
                    ...v,
                    samlEntryPoint: r.entry || v.samlEntryPoint,
                    samlCert: r.cert || v.samlCert,
                  }));
                  setMsg({
                    tone: "success",
                    text: `Loaded ${[r.entry && "login URL", r.cert && "certificate"].filter(Boolean).join(" and ")}. Save to keep it.`,
                  });
                }}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Login URL (SSO URL)" className="sm:col-span-2">
                <Input
                  value={saml.samlEntryPoint}
                  onChange={(e) => setSaml({ ...saml, samlEntryPoint: e.target.value })}
                />
              </Field>
              <Field label="Certificate" className="sm:col-span-2">
                <textarea
                  rows={4}
                  value={saml.samlCert}
                  onChange={(e) => setSaml({ ...saml, samlCert: e.target.value })}
                  className={`${inputClass} h-auto py-2 font-mono text-[11px]`}
                  placeholder="-----BEGIN CERTIFICATE-----"
                />
              </Field>
              <Field label="Entity ID">
                <Input
                  value={saml.samlIssuer}
                  onChange={(e) => setSaml({ ...saml, samlIssuer: e.target.value })}
                />
              </Field>
              <Field label="Login button text">
                <Input
                  value={saml.samlLoginLabel}
                  onChange={(e) => setSaml({ ...saml, samlLoginLabel: e.target.value })}
                />
              </Field>
              <Field label="Email attribute">
                <Input
                  value={saml.samlAttributeEmail}
                  onChange={(e) => setSaml({ ...saml, samlAttributeEmail: e.target.value })}
                />
              </Field>
              <Field label="Name attribute">
                <Input
                  value={saml.samlAttributeName}
                  onChange={(e) => setSaml({ ...saml, samlAttributeName: e.target.value })}
                />
              </Field>
            </div>
          </div>
        </Row>
      )}

      <div className="flex flex-wrap items-center gap-2 py-4">
        <Button
          size="sm"
          icon="science"
          loading={busy === "test"}
          disabled={!ready}
          onClick={() => void test()}
        >
          Test
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon="check"
          loading={busy === "save"}
          disabled={!dirty || (mode !== "password" && !ready)}
          onClick={() => void save()}
        >
          Save
        </Button>
        {dirty && !msg && <span className="text-[12px] text-text-subtle">Unsaved changes</span>}
        {msg && <Note tone={msg.tone}>{msg.text}</Note>}
      </div>
    </>
  );
}
