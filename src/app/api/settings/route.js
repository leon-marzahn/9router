import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import { validatePipelines } from "@/lib/request-pipelines/config.js";
import { UPDATE_STATE_KEYS, webhookHost } from "@/lib/updates/webhook.js";
import { NOTIFY_KEYS } from "@/lib/notify/config.js";
import { validateCustomerViewPatch } from "@/lib/customerView/index.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
// (the redeploy hook is set through /api/settings/updates, which validates it)
// (email delivery is set through /api/settings/notifications, which validates it)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted", ...UPDATE_STATE_KEYS, ...NOTIFY_KEYS];

/** Drop secrets; say only whether the redeploy hook is set and where it points. */
function toPublicSettings({ password, oidcClientSecret, updateWebhookUrl, updateWebhookToken, mitmSudoEncrypted: _mitmSudo, ...safe }) {
  safe.oidcConfigured = !!(safe.oidcIssuerUrl && safe.oidcClientId && oidcClientSecret);
  safe.updateWebhookSet = !!updateWebhookUrl;
  safe.updateWebhookHost = updateWebhookUrl ? webhookHost(updateWebhookUrl) : null;
  // Email delivery has its own route (GET /api/settings/notifications) that reports secrets as booleans.
  for (const key of NOTIFY_KEYS) delete safe[key];
  return { safe, password };
}

export async function GET() {
  try {
    const settings = await getSettings();
    const { safe: safeSettings, password } = toPublicSettings(settings);

    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      // ENABLE_REQUEST_LOGS (any value) overrides the "save request bodies" switch.
      requestLogsEnvOverride: process.env.ENABLE_REQUEST_LOGS !== undefined,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

const SSO_MODES = new Set(["sso", "saml", "oidc", "both"]);

/**
 * Guards for changes that can lock someone out or open the dashboard:
 * - turning "Require login" off needs the current password (when one is set);
 * - an SSO sign-in mode needs that SSO type to be configured.
 */
async function checkSignInChange(body) {
  const settings = await getSettings();
  if (body.requireLogin === false && settings.requireLogin !== false && settings.password) {
    if (!body.currentPassword) return { status: 400, error: "Enter your password to turn off login" };
    if (!(await bcrypt.compare(String(body.currentPassword), settings.password))) {
      return { status: 401, error: "Wrong password" };
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "authMode") && SSO_MODES.has(body.authMode)) {
    const next = { ...settings, ...body };
    const ready =
      next.ssoType === "saml"
        ? !!(next.samlEntryPoint && next.samlCert)
        : !!(next.oidcIssuerUrl && next.oidcClientId && (body.oidcClientSecret || settings.oidcClientSecret));
    if (!ready) {
      return { status: 400, error: "Finish setting up single sign-on before turning it on" };
    }
  }
  return null;
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    if (Object.prototype.hasOwnProperty.call(body, "requestPipelines")) {
      try {
        body.requestPipelines = validatePipelines(body.requestPipelines);
      } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    const cv = validateCustomerViewPatch(body);
    if (cv.error) return NextResponse.json({ error: cv.error }, { status: 400 });
    Object.assign(body, cv.value);

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    const lockout = await checkSignInChange(body);
    if (lockout) return NextResponse.json({ error: lockout.error }, { status: lockout.status });

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    // Never store the plain-text password fields.
    delete body.currentPassword;
    delete body.newPassword;

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    const { safe: safeSettings } = toPublicSettings(settings);
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
