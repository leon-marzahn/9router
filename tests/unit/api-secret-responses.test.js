import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const originalDataDir = process.env.DATA_DIR;
const SECRETS = ["cop-SEEDED", "cs-SEEDED", "cookie-SEEDED", "pw-SEEDED", "pool-SEEDED", "out-SEEDED"];
const PROXY = "http://alice:pw-SEEDED@proxy.example:8080";
const POOL = "http://bob:pool-SEEDED@pool.example:3128";

let tempDir;
let api;
let models;

function req(method, url, body) {
  return new Request(`https://regent.local${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const expectClean = (body) => {
  const json = JSON.stringify(body);
  for (const s of SECRETS) expect(json).not.toContain(s);
};

describe("dashboard API responses carry no secrets", () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-secret-responses-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));
    api = {
      providers: await import("@/app/api/providers/route.js"),
      provider: await import("@/app/api/providers/[id]/route.js"),
      pools: await import("@/app/api/proxy-pools/route.js"),
      pool: await import("@/app/api/proxy-pools/[id]/route.js"),
      settings: await import("@/app/api/settings/route.js"),
    };
    models = await import("@/models/index.js");
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("provider list, detail and update hide providerSpecificData secrets and keep them on save", async () => {
    const conn = await models.createProviderConnection({
      provider: "github",
      authType: "oauth",
      name: "Copilot demo",
      accessToken: "at-x",
      providerSpecificData: {
        copilotToken: "cop-SEEDED",
        clientSecret: "cs-SEEDED",
        cookies: [{ value: "cookie-SEEDED" }],
        connectionProxyEnabled: true,
        connectionProxyUrl: PROXY,
        region: "us",
      },
    });

    const list = await (await api.providers.GET(req("GET", "/api/providers"))).json();
    const detail = await (await api.provider.GET(req("GET", `/api/providers/${conn.id}`), ctx(conn.id))).json();
    expectClean(list);
    expectClean(detail);
    const psd = detail.connection.providerSpecificData;
    expect(psd.hasCopilotToken).toBe(true);
    expect(psd.connectionProxyUrl).toBe("http://alice:***@proxy.example:8080");

    // The edit form echoes back what it got, plus one real change.
    const res = await api.provider.PUT(
      req("PUT", `/api/providers/${conn.id}`, {
        providerSpecificData: { ...psd, region: "eu" },
        connectionProxyEnabled: true,
        connectionProxyUrl: psd.connectionProxyUrl,
      }),
      ctx(conn.id)
    );
    expect(res.status).toBe(200);
    expectClean(await res.json());
    const stored = await models.getProviderConnectionById(conn.id);
    expect(stored.providerSpecificData.copilotToken).toBe("cop-SEEDED");
    expect(stored.providerSpecificData.clientSecret).toBe("cs-SEEDED");
    expect(stored.providerSpecificData.cookies).toEqual([{ value: "cookie-SEEDED" }]);
    expect(stored.providerSpecificData.connectionProxyUrl).toBe(PROXY);
    expect(stored.providerSpecificData.region).toBe("eu");
    expect(stored.providerSpecificData).not.toHaveProperty("hasCopilotToken");
  });

  it("proxy pools mask URL passwords and keep them when saved unchanged", async () => {
    const created = await api.pools.POST(req("POST", "/api/proxy-pools", { name: "demo", proxyUrl: POOL }));
    const { proxyPool } = await created.json();
    expectClean(proxyPool);
    expect(proxyPool.proxyUrl).toBe("http://bob:***@pool.example:3128");

    expectClean(await (await api.pools.GET(req("GET", "/api/proxy-pools?includeUsage=true"))).json());
    expectClean(await (await api.pools.GET(req("GET", "/api/proxy-pools"))).json());
    expectClean(await (await api.pool.GET(req("GET", `/api/proxy-pools/${proxyPool.id}`), ctx(proxyPool.id))).json());

    const put = await api.pool.PUT(
      req("PUT", `/api/proxy-pools/${proxyPool.id}`, { name: "renamed", proxyUrl: proxyPool.proxyUrl }),
      ctx(proxyPool.id)
    );
    expectClean(await put.json());
    expect((await models.getProxyPoolById(proxyPool.id)).proxyUrl).toBe(POOL);

    await api.pool.PUT(
      req("PUT", `/api/proxy-pools/${proxyPool.id}`, { proxyUrl: "http://bob:new@pool.example:3128" }),
      ctx(proxyPool.id)
    );
    expect((await models.getProxyPoolById(proxyPool.id)).proxyUrl).toBe("http://bob:new@pool.example:3128");
  });

  it("settings mask the outbound proxy password and keep it on save", async () => {
    const outbound = "http://carol:out-SEEDED@out.example:1";
    await api.settings.PATCH(req("PATCH", "/api/settings", { outboundProxyUrl: outbound }));
    const got = await (await api.settings.GET()).json();
    expectClean(got);
    expect(got.outboundProxyUrl).toBe("http://carol:***@out.example:1");

    const saved = await api.settings.PATCH(req("PATCH", "/api/settings", { outboundProxyUrl: got.outboundProxyUrl }));
    expectClean(await saved.json());
    expect((await (await import("@/lib/localDb")).getSettings()).outboundProxyUrl).toBe(outbound);
  });

  it("a masked URL keeps the password on a host change and is refused for another user", async () => {
    const getOutbound = async () => (await (await import("@/lib/localDb")).getSettings()).outboundProxyUrl;

    // settings
    await api.settings.PATCH(req("PATCH", "/api/settings", { outboundProxyUrl: "http://carol:out-SEEDED@out.example:1" }));
    await api.settings.PATCH(req("PATCH", "/api/settings", { outboundProxyUrl: "http://carol:***@moved.example:2" }));
    expect(await getOutbound()).toBe("http://carol:out-SEEDED@moved.example:2");
    const badSettings = await api.settings.PATCH(req("PATCH", "/api/settings", { outboundProxyUrl: "http://eve:***@x:1" }));
    expect(badSettings.status).toBe(400);
    expect((await badSettings.json()).error).toMatch(/hidden password/);
    expect(await getOutbound()).toBe("http://carol:out-SEEDED@moved.example:2");

    // proxy pool
    const { proxyPool } = await (await api.pools.POST(req("POST", "/api/proxy-pools", { name: "p", proxyUrl: POOL }))).json();
    await api.pool.PUT(req("PUT", `/api/proxy-pools/${proxyPool.id}`, { proxyUrl: "http://bob:***@moved:1" }), ctx(proxyPool.id));
    expect((await models.getProxyPoolById(proxyPool.id)).proxyUrl).toBe("http://bob:pool-SEEDED@moved:1");
    const badPool = await api.pool.PUT(
      req("PUT", `/api/proxy-pools/${proxyPool.id}`, { proxyUrl: "http://eve:***@moved:1" }),
      ctx(proxyPool.id)
    );
    expect(badPool.status).toBe(400);
    const badNewPool = await api.pools.POST(req("POST", "/api/proxy-pools", { name: "q", proxyUrl: "http://bob:***@h" }));
    expect(badNewPool.status).toBe(400);

    // connection proxy
    const conn = await models.createProviderConnection({
      provider: "openai", authType: "apikey", apiKey: "k",
      providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: PROXY },
    });
    await api.provider.PUT(
      req("PUT", `/api/providers/${conn.id}`, { connectionProxyEnabled: true, connectionProxyUrl: "http://alice:***@new:9" }),
      ctx(conn.id)
    );
    expect((await models.getProviderConnectionById(conn.id)).providerSpecificData.connectionProxyUrl).toBe(
      "http://alice:pw-SEEDED@new:9"
    );
    const badConn = await api.provider.PUT(
      req("PUT", `/api/providers/${conn.id}`, { connectionProxyEnabled: true, connectionProxyUrl: "http://eve:***@new:9" }),
      ctx(conn.id)
    );
    expect(badConn.status).toBe(400);
    const badNewConn = await api.providers.POST(
      req("POST", "/api/providers", { provider: "openai", apiKey: "k2", connectionProxyEnabled: true, connectionProxyUrl: "http://a:***@h" })
    );
    expect(badNewConn.status).toBe(400);
  });
});
