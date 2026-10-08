const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const net = require("net");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

// Reverse proxies besides loopback whose forwarding headers are believed: comma-separated
// IPs or CIDRs, e.g. TRUSTED_PROXIES="172.16.0.0/12,173.245.48.0/20,2400:cb00::/32".
// List every hop that appends to X-Forwarded-For (a CDN in front of the proxy too): the client
// is the first entry from the right that is not listed, so entries a client forged on the left
// of the real one are never used. Unset means only loopback proxies are trusted.
let trustedProxyCache = { raw: null, list: null };

function trustedProxyList() {
  const raw = process.env.TRUSTED_PROXIES || "";
  if (raw === trustedProxyCache.raw) return trustedProxyCache.list;
  const list = new net.BlockList();
  let count = 0;
  for (const item of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits] = item.split("/");
    try {
      const version = net.isIP(addr);
      if (!version) throw new Error("not an IP");
      const family = version === 6 ? "ipv6" : "ipv4";
      if (bits === undefined) {
        list.addAddress(addr, family);
      } else {
        if (!/^\d+$/.test(bits)) throw new Error("bad prefix");
        list.addSubnet(addr, Number(bits), family);
      }
      count++;
    } catch {
      console.warn(`[custom-server] ignoring invalid TRUSTED_PROXIES entry: ${item}`);
    }
  }
  trustedProxyCache = { raw, list: count ? list : null };
  return trustedProxyCache.list;
}

function isTrustedProxy(ip) {
  const list = trustedProxyList();
  if (!list || typeof ip !== "string") return false;
  const bare = ip.startsWith("::ffff:") && net.isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const version = net.isIP(bare);
  return version !== 0 && list.check(bare, version === 6 ? "ipv6" : "ipv4");
}

function clientIpFromForwardedChain(xff) {
  const hops = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (isTrustedProxy(hops[i])) continue;
    return net.isIP(hops[i]) ? hops[i] : "";
  }
  return "";
}

// Direct/public sockets stay keyed by the unspoofable peer address. Forwarding headers are
// believed only from a loopback proxy or a peer listed in TRUSTED_PROXIES.
function resolveClientIp(socketIp, xff, xRealIp) {
  const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
  if (isLoopbackProxy) {
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    return proxyIp || socketIp;
  }
  // X-Real-IP is ignored here: a client can pass its own value straight through the proxy.
  if (xff && isTrustedProxy(socketIp)) return clientIpFromForwardedChain(xff) || socketIp;
  return socketIp;
}

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const ip = resolveClientIp(socketIp, xff, xRealIp);
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

module.exports = { __test__: { resolveClientIp, isTrustedProxy } };

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
