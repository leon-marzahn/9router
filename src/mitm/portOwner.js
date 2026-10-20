// Find (and safely kill) the process LISTENING on a TCP port, on macOS and Linux.
//
// Shared by manager.js (dashboard "port 443 busy" + force-kill) and server.js
// (free LOCAL_PORT on boot). CommonJS and dependency-free: server.js runs as a
// standalone child process and only requires its siblings.
//
// Why this exists: on Alpine, /usr/bin/lsof is busybox. It ignores
// `-nP -iTCP:443 -sTCP:LISTEN -t` and lists every open file as
// `PID\tbinary\tFD\tpath`, so "first line = PID" picked an arbitrary process
// that force-kill then SIGKILLed. Rules here:
//   - a PID is a line matching /^\d+$/; any other line means "unknown", never a guess
//   - busybox lsof is skipped for ss → netstat → fuser → /proc/net/tcp{,6}
//   - unknown owners and protected PIDs (≤1, ourselves, our parent, our
//     ancestors) are never killed
// Windows keeps its own PowerShell paths in the callers.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PID_RE = /^\d+$/;

function defaultRun(cmd, args) {
  // stdio: ignore stderr (fuser prints its "443/tcp:" label there)
  return execFileSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
}

// Commands like lsof/fuser exit 1 when nothing matches; that is "no output", not a failure.
function runTool(run, cmd, args) {
  try {
    return { ok: true, out: String(run(cmd, args) ?? "") };
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, reason: `${cmd} not installed` };
    if (e && e.status === 1 && !String(e.stdout ?? "").trim()) return { ok: true, out: "" };
    return { ok: false, reason: `${cmd} failed: ${e && e.message ? e.message.split("\n")[0] : e}` };
  }
}

// ---------- parsers (pure; exported for tests) ----------

/** `lsof -t` output → PIDs, or null when any line is not a bare PID. */
function parseLsofPids(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.some((l) => !PID_RE.test(l))) return null;
  return uniq(lines.map(Number));
}

/** Busybox lsof prints tab-separated `PID\tbin\tFD\tpath` rows; real `lsof -t` never has tabs. */
function looksLikeBusyboxOutput(stdout) {
  return String(stdout ?? "").includes("\t");
}

function portOf(addr) {
  const m = /:(\d+)$/.exec(String(addr ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * `ss -Htlnp 'sport = :PORT'` → { pids, listenerWithoutPid }.
 * Row: `LISTEN 0 1 0.0.0.0:443 0.0.0.0:* users:(("nc",pid=123,fd=3))`
 */
function parseSs(stdout, port) {
  const pids = [];
  let listenerWithoutPid = false;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    // with -H there is no header; columns: State Recv-Q Send-Q Local Peer [Process]
    if (cols[0] !== "LISTEN" || portOf(cols[3]) !== port) continue;
    const found = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    if (found.length) pids.push(...found);
    else listenerWithoutPid = true;
  }
  return { pids: uniq(pids), listenerWithoutPid };
}

/** `netstat -tlnp` → { pids, listenerWithoutPid }. Row: `tcp 0 0 0.0.0.0:443 0.0.0.0:* LISTEN 1234/nc` */
function parseNetstat(stdout, port) {
  const pids = [];
  let listenerWithoutPid = false;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (!/^tcp6?$/.test(cols[0] || "") || cols.length < 6) continue;
    if (cols[5] !== "LISTEN" || portOf(cols[3]) !== port) continue;
    const m = /^(\d+)\//.exec(cols[6] || "");
    if (m) pids.push(Number(m[1]));
    else listenerWithoutPid = true;
  }
  return { pids: uniq(pids), listenerWithoutPid };
}

/** `fuser PORT/tcp` stdout → PIDs, or null when any token is not a bare PID. */
function parseFuser(stdout) {
  const tokens = String(stdout ?? "")
    .replace(/^\s*\d+\/tcp:/, "")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.some((t) => !PID_RE.test(t))) return null;
  return uniq(tokens.map(Number));
}

/** /proc/net/tcp{,6} text → socket inodes in state LISTEN (0A) on `port`. */
function parseProcNetTcp(text, port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = [];
  for (const line of String(text ?? "")
    .split(/\r?\n/)
    .slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const local = cols[1] || "";
    if (local.split(":").pop()?.toUpperCase() !== hexPort || cols[3] !== "0A") continue;
    if (PID_RE.test(cols[9]) && cols[9] !== "0") inodes.push(cols[9]);
  }
  return uniq(inodes);
}

/** /proc/<pid>/stat → { ppid, pgrp } (comm may contain spaces/parens, so parse after the last ")"). */
function parseProcStat(text) {
  const s = String(text ?? "");
  const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(rest[1]);
  const pgrp = Number(rest[2]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgrp)) return null;
  return { ppid, pgrp };
}

/** `ps -o pid,comm` (busybox-compatible) → name for `pid`. */
function parsePsComm(stdout, pid) {
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && Number(m[1]) === pid) return m[2];
  }
  return null;
}

function uniq(arr) {
  return [...new Set(arr)];
}

// ---------- environment probes ----------

function makeCtx(opts = {}) {
  return {
    platform: opts.platform || process.platform,
    run: opts.run || defaultRun,
    fs: opts.fs || fs,
    procRoot: opts.procRoot || "/proc",
    lsofBin: opts.lsofBin || "lsof",
    selfPid: opts.selfPid ?? process.pid,
    selfPpid: opts.selfPpid ?? process.ppid,
  };
}

function isBusyboxBinary(ctx) {
  try {
    return /busybox/i.test(ctx.fs.realpathSync(ctx.lsofBin));
  } catch {
    return false;
  }
}

function readText(ctx, p) {
  try {
    return ctx.fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Map socket inodes to PIDs by scanning /proc/*\/fd (needs permission to read other users' fds). */
function pidsForInodes(ctx, inodes) {
  if (!inodes.length) return { pids: [], unreadable: false };
  const wanted = new Set(inodes.map((i) => `socket:[${i}]`));
  const pids = [];
  let unreadable = false;
  let entries = [];
  try {
    entries = ctx.fs.readdirSync(ctx.procRoot);
  } catch {
    return { pids: [], unreadable: true };
  }
  for (const name of entries) {
    if (!PID_RE.test(name)) continue;
    const fdDir = path.join(ctx.procRoot, name, "fd");
    let fds;
    try {
      fds = ctx.fs.readdirSync(fdDir);
    } catch {
      unreadable = true;
      continue;
    }
    for (const fd of fds) {
      try {
        if (wanted.has(ctx.fs.readlinkSync(path.join(fdDir, fd)))) {
          pids.push(Number(name));
          break;
        }
      } catch {
        /* fd closed meanwhile */
      }
    }
  }
  return { pids: uniq(pids), unreadable };
}

// ---------- lookup ----------

/**
 * Who is LISTENING on TCP `port`?
 * @returns {{ status: "found", pids: number[], method: string }
 *         | { status: "none", method: string }
 *         | { status: "unknown", reason: string }}
 * "unknown" means the port may be held but we can't say by whom — callers must not kill.
 */
function findListeningPids(port, opts = {}) {
  const r = lookupListeningPids(port, opts);
  // The caller already knows the port is taken (bind failed): "nobody" just means
  // the tools can't see the listener (e.g. another user's process without sudo).
  if (r.status === "none" && opts.portBusy) {
    return {
      status: "unknown",
      reason: `port ${port} is in use but ${r.method} cannot see its listener`,
    };
  }
  return r;
}

function lookupListeningPids(port, opts) {
  const ctx = makeCtx(opts);
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    return { status: "unknown", reason: `invalid port ${port}` };
  if (ctx.platform === "win32") return { status: "unknown", reason: "use the Windows path" };

  const notes = [];
  let busybox = isBusyboxBinary(ctx);
  if (!busybox) {
    const r = runTool(ctx.run, ctx.lsofBin, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    if (r.ok) {
      const pids = parseLsofPids(r.out);
      if (pids)
        return pids.length
          ? { status: "found", pids, method: "lsof" }
          : { status: "none", method: "lsof" };
      if (looksLikeBusyboxOutput(r.out)) busybox = true;
      else return { status: "unknown", reason: "lsof printed something other than PIDs" };
    } else {
      notes.push(r.reason);
    }
  }
  // macOS always has a real lsof; don't second-guess it with Linux tools.
  if (ctx.platform === "darwin")
    return { status: "unknown", reason: notes.join("; ") || "lsof unavailable" };
  if (busybox) notes.push("lsof is busybox (ignores -i/-t filters)");

  let sawPidlessListener = false;
  let anyReliableNone = false;

  const ss = runTool(ctx.run, "ss", ["-Htlnp", `sport = :${port}`]);
  if (ss.ok) {
    const { pids, listenerWithoutPid } = parseSs(ss.out, port);
    if (pids.length) return { status: "found", pids, method: "ss" };
    if (listenerWithoutPid) sawPidlessListener = true;
    else anyReliableNone = true;
  } else notes.push(ss.reason);

  const ns = runTool(ctx.run, "netstat", ["-tlnp"]);
  if (ns.ok) {
    const { pids, listenerWithoutPid } = parseNetstat(ns.out, port);
    if (pids.length) return { status: "found", pids, method: "netstat" };
    if (listenerWithoutPid) sawPidlessListener = true;
    else anyReliableNone = true;
  } else notes.push(ns.reason);

  // `PORT/tcp` works on busybox and psmisc; busybox only checks IPv4 there and needs
  // `PORT/tcp6` for IPv6 listeners (psmisc rejects tcp6, which is fine).
  const fuserPids = [];
  let fuserJunk = false;
  for (const spec of [`${port}/tcp`, `${port}/tcp6`]) {
    const fu = runTool(ctx.run, "fuser", [spec]);
    if (!fu.ok) {
      notes.push(fu.reason);
      continue;
    }
    const pids = parseFuser(fu.out);
    if (pids) fuserPids.push(...pids);
    else fuserJunk = true;
  }
  // fuser prints nothing both for "free" and for "not allowed to see": not proof of none
  if (fuserJunk) notes.push("fuser printed something other than PIDs");
  else if (fuserPids.length) return { status: "found", pids: uniq(fuserPids), method: "fuser" };

  const inodes = [];
  let procReadable = false;
  for (const f of ["tcp", "tcp6"]) {
    const text = readText(ctx, path.join(ctx.procRoot, "net", f));
    if (text != null) {
      procReadable = true;
      inodes.push(...parseProcNetTcp(text, port));
    }
  }
  if (procReadable) {
    if (!inodes.length) return { status: "none", method: "/proc/net/tcp" };
    const { pids } = pidsForInodes(ctx, uniq(inodes));
    if (pids.length) return { status: "found", pids, method: "/proc" };
    sawPidlessListener = true;
    notes.push("listening socket found but its process is not visible (permissions?)");
  } else notes.push("/proc/net/tcp unreadable");

  if (anyReliableNone && !sawPidlessListener) return { status: "none", method: "ss/netstat" };
  return { status: "unknown", reason: notes.join("; ") || "no tool could identify the listener" };
}

// ---------- process info + guards ----------

function procStat(ctx, pid) {
  const t = readText(ctx, path.join(ctx.procRoot, String(pid), "stat"));
  if (t) return parseProcStat(t);
  // macOS / no procfs
  const r = runTool(ctx.run, "ps", ["-o", "ppid=,pgid=", "-p", String(pid)]);
  if (!r.ok) return null;
  const [ppid, pgrp] = r.out.trim().split(/\s+/).map(Number);
  return Number.isInteger(ppid) && Number.isInteger(pgrp) ? { ppid, pgrp } : null;
}

/** Name of `pid`: /proc/<pid>/comm, else `ps` (busybox `ps` has no -p; `ps -o pid,comm` works). */
function getProcessName(pid, opts = {}) {
  const ctx = makeCtx(opts);
  const comm = readText(ctx, path.join(ctx.procRoot, String(pid), "comm"));
  if (comm && comm.trim()) return comm.trim();
  if (ctx.platform === "darwin") {
    const r = runTool(ctx.run, "ps", ["-p", String(pid), "-o", "comm="]);
    if (r.ok && r.out.trim()) return r.out.trim();
    return "unknown";
  }
  const r = runTool(ctx.run, "ps", ["-o", "pid,comm"]);
  return (r.ok && parsePsComm(r.out, pid)) || "unknown";
}

/** PIDs that must never be killed: init/kernel, ourselves, our parent and every ancestor. */
function getProtectedPids(opts = {}) {
  const ctx = makeCtx(opts);
  const set = new Set([0, 1, ctx.selfPid, ctx.selfPpid]);
  let cur = ctx.selfPpid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    const st = procStat(ctx, cur);
    if (!st || set.has(st.ppid)) {
      if (st) set.add(st.ppid);
      break;
    }
    set.add(st.ppid);
    cur = st.ppid;
  }
  return set;
}

/** Why `pid` must not be killed, or null when it is fair game. */
function protectedReason(pid, opts = {}) {
  const ctx = makeCtx(opts);
  if (!Number.isInteger(pid) || pid <= 1) return `PID ${pid} is not a killable process`;
  if (pid === ctx.selfPid) return `PID ${pid} is this regent process`;
  const prot = opts.protectedPids || getProtectedPids(opts);
  if (prot.has(pid)) return `PID ${pid} is a parent of this regent process`;
  // No process-group rule: a stale MITM child (spawned detached:false) shares our group
  // and must stay killable.
  return null;
}

/**
 * Owner of `port` for the dashboard.
 * @returns {null | { pid, pids, name, method } | { unknown: true, reason }}
 */
function getPortOwner(port, opts = {}) {
  const r = findListeningPids(port, opts);
  if (r.status === "none") return null;
  if (r.status === "unknown") return { unknown: true, reason: r.reason };
  return { pid: r.pids[0], pids: r.pids, name: getProcessName(r.pids[0], opts), method: r.method };
}

/**
 * server.js boot step: free `port` by SIGKILLing its listeners, never guessing.
 * `deps` (find, kill, log, err) are injectable for tests.
 * @returns {{ status: string, killed: number[] }}
 */
function killPortListeners(port, deps = {}) {
  const find = deps.find || ((p) => findListeningPids(p, deps.opts));
  const kill = deps.kill || ((pid) => process.kill(pid, "SIGKILL"));
  const log = deps.log || (() => {});
  const err = deps.err || (() => {});
  const found = find(port);
  if (found.status === "none") return { status: "none", killed: [] };
  if (found.status === "unknown") {
    // Never guess a PID; if the port really is held, listen() reports it.
    err(`Not killing anything on port ${port}: could not identify its listener (${found.reason})`);
    return { status: "unknown", killed: [] };
  }
  const res = killPids(found.pids, kill, deps.opts);
  res.refused.forEach(({ pid, reason }) => err(`Not killing PID ${pid}: ${reason}`));
  res.failed.forEach(({ pid, error }) => err(`Failed to kill PID ${pid}: ${error}`));
  if (res.killed.length) log(`Killed ${res.killed.length} process(es) on port ${port}`);
  return { status: "found", killed: res.killed };
}

/**
 * Message explaining why a dashboard force-kill of `owner` must be refused, or null.
 * Refuses unknown owners and any protected PID (all-or-nothing).
 */
function forceKillRefusal(owner, port, opts = {}) {
  if (!owner) return `Refusing to force-kill: nothing identified on port ${port}.`;
  if (owner.unknown) {
    return `Refusing to force-kill: could not identify the process on port ${port} (${owner.reason}). Stop it manually.`;
  }
  const pids = owner.pids || [owner.pid];
  if (!pids.length) return `Refusing to force-kill: nothing identified on port ${port}.`;
  const protectedPids = getProtectedPids(opts);
  const reasons = pids
    .map((pid) => protectedReason(pid, { ...opts, protectedPids }))
    .filter(Boolean);
  return reasons.length
    ? `Refusing to force-kill the port ${port} owner: ${reasons.join("; ")}.`
    : null;
}

/**
 * Kill every listener in `pids` after re-checking the guards.
 * `kill(pid)` does the signalling (sudo or process.kill) and throws on failure.
 * @returns {{ killed: number[], refused: {pid, reason}[], failed: {pid, error}[] }}
 */
function killPids(pids, kill, opts = {}) {
  const out = { killed: [], refused: [], failed: [] };
  const protectedPids = getProtectedPids(opts);
  for (const pid of pids) {
    const reason = protectedReason(pid, { ...opts, protectedPids });
    if (reason) {
      out.refused.push({ pid, reason });
      continue;
    }
    try {
      kill(pid);
      out.killed.push(pid);
    } catch (e) {
      out.failed.push({ pid, error: e && e.message ? e.message : String(e) });
    }
  }
  return out;
}

module.exports = {
  findListeningPids,
  getPortOwner,
  getProcessName,
  getProtectedPids,
  protectedReason,
  killPids,
  forceKillRefusal,
  killPortListeners,
  // parsers, for tests
  parseLsofPids,
  looksLikeBusyboxOutput,
  parseSs,
  parseNetstat,
  parseFuser,
  parseProcNetTcp,
  parseProcStat,
  parsePsComm,
};
