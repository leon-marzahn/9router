import { describe, it, expect } from "vite-plus/test";
import { mergeCoworkConfig, removeCoworkConfig } from "../../src/app/api/cli-tools/cowork-settings/coworkConfig.js";

const securityRelax = { isLocalDevMcpEnabled: true, coworkEgressAllowedHosts: ["*"] };
const ours = {
  ...securityRelax,
  inferenceProvider: "gateway",
  inferenceGatewayBaseUrl: "http://localhost:20128/v1",
  inferenceGatewayApiKey: "sk-r",
  inferenceModels: [{ name: "m" }],
  managedMcpServers: [{ name: "exa" }],
};

describe("Cowork config", () => {
  it("apply keeps the user's own keys", () => {
    const merged = mergeCoworkConfig({ userSetting: 1, managedMcpServers: [{ name: "old" }] }, { ...ours, managedMcpServers: undefined });
    expect(merged.userSetting).toBe(1);
    expect(merged.managedMcpServers).toBeUndefined();
  });

  it("reset removes only what Apply added", () => {
    const applied = mergeCoworkConfig({ userSetting: 1 }, ours);
    expect(removeCoworkConfig(applied, { provider: "gateway", securityRelax })).toEqual({ userSetting: 1 });
  });

  it("reset keeps relax keys the user changed and another provider's gateway", () => {
    const cfg = { inferenceProvider: "other", inferenceGatewayBaseUrl: "https://corp", isLocalDevMcpEnabled: false };
    expect(removeCoworkConfig(cfg, { provider: "gateway", securityRelax })).toEqual(cfg);
  });
});
