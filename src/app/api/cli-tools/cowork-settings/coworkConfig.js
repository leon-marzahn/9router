// Keys the Cowork Apply writes into Claude Desktop's 3p config (configLibrary/<id>.json).
// Reset removes these and nothing else; a SECURITY_RELAX key is only removed while it
// still holds the value we wrote, so a setting the user changed afterwards survives.

const GATEWAY_KEYS = [
  "inferenceGatewayBaseUrl",
  "inferenceGatewayApiKey",
  "inferenceModels",
  "managedMcpServers",
];

export function mergeCoworkConfig(existing, ours) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  // managedMcpServers is fully ours: an Apply with none selected must drop the old list.
  delete base.managedMcpServers;
  return { ...base, ...ours };
}

export function removeCoworkConfig(existing, { provider, securityRelax }) {
  if (!existing || typeof existing !== "object") return {};
  const next = { ...existing };
  if (next.inferenceProvider === provider) {
    delete next.inferenceProvider;
    for (const key of GATEWAY_KEYS) delete next[key];
  }
  for (const [key, value] of Object.entries(securityRelax)) {
    if (key in next && JSON.stringify(next[key]) === JSON.stringify(value)) delete next[key];
  }
  return next;
}
