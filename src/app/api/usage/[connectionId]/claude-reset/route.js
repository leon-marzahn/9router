// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import { consumeClaudeResetGrant } from "open-sse/services/usage.js";
import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "../route.js";

// Spend one free Claude "limit reset" grant (irreversible). The server picks the
// grant from the account's own fresh grant list; a grantId from the client is
// only honoured if it is one of those usable grants.
export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;
    const { grantId } = await request.json().catch(() => ({}));

    let connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (connection.provider !== "claude" || connection.authType !== "oauth") {
      return Response.json({ error: "Limit reset is only available for Claude OAuth connections." }, { status: 400 });
    }

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    ({ connection } = await refreshAndUpdateCredentials(connection, false, proxyOptions));
    const usage = await getClaudeUsage(connection.accessToken, proxyOptions, { force: true });
    const credits = usage?.resetCredits;
    const usable = (credits?.grants ?? []).filter((g) => !g.paused && g.resetsLeft > 0).map((g) => g.id);
    const chosen = grantId ? (usable.includes(grantId) ? grantId : null) : credits?.nextGrantId || usable[0] || null;
    if (!chosen) {
      return Response.json(
        { ok: false, message: grantId ? "That reset grant isn't available on this account." : "No limit resets are available on this account." },
        { status: 409 },
      );
    }
    const result = await consumeClaudeResetGrant(connection.accessToken, chosen, proxyOptions);

    if (result.ok) return Response.json(result);
    const status = result.status >= 400 && result.status < 500 ? result.status : 409;
    return Response.json({ ...result, message: result.message || `Reset not applied: ${result.reason || result.result || "unknown"}` }, { status });
  } catch (error) {
    console.warn(`[Claude Reset] ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
