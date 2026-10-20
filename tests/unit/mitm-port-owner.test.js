import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createRequire } from "module";

// portOwner.js is CJS so the standalone MITM server.js can require it.
const require = createRequire(import.meta.url);
const po = require("../../src/mitm/portOwner.js");

// ---- fixtures (captured shapes) ----
const REAL_LSOF = "4321\n";
// busybox lsof ignores -nP/-i/-t and dumps every open file
const BUSYBOX_LSOF = [
  "1\t/usr/local/bin/node\t0\t/dev/null",
  "1\t/usr/local/bin/node\t21\tsocket:[88001]",
  "57\t/bin/busybox\t3\tsocket:[99123]",
  "212\t/usr/bin/sleep\t1\tpipe:[5555]",
].join("\n");
const SS =
  'LISTEN 0      1            0.0.0.0:443        0.0.0.0:*    users:(("nc",pid=57,fd=3))\n';
const SS_OTHER_PORT = 'LISTEN 0 511 0.0.0.0:4430 0.0.0.0:* users:(("node",pid=1,fd=21))\n';
const SS_NO_PID = "LISTEN 0 1 0.0.0.0:443 0.0.0.0:*\n";
const NETSTAT = [
  "Active Internet connections (only servers)",
  "Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name",
  "tcp        0      0 0.0.0.0:20128           0.0.0.0:*               LISTEN      1/node",
  "tcp        0      0 0.0.0.0:443             0.0.0.0:*               LISTEN      57/nc",
].join("\n");
const NETSTAT_NO_PID = NETSTAT.replace("57/nc", "-");
const PROC_TCP = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000:4E20 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 88001 1 0000000000000000 100 0 0 10 0",
  "   1: 00000000:01BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 99123 1 0000000000000000 100 0 0 10 0",
  "   2: 0100007F:01BB 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 77777 1 0000000000000000 100 0 0 10 0",
].join("\n");
const PROC_TCP6_HEADER =
  "  sl  local_address                         remote_address                        st ...\n";

const enoent = (cmd) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });

/** Fake fs over a { path: content | string[] (dir) | {link} } map. */
function fakeFs(files = {}, { lsofReal = "/usr/sbin/lsof" } = {}) {
  const get = (p) => {
    if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    return files[p];
  };
  return {
    realpathSync: () => lsofReal,
    readFileSync: (p) => {
      const v = get(p);
      if (typeof v !== "string") throw new Error("EISDIR");
      return v;
    },
    readdirSync: (p) => {
      const v = get(p);
      if (!Array.isArray(v)) throw new Error("ENOTDIR");
      return v;
    },
    readlinkSync: (p) => get(p).link,
  };
}

/** run() that answers per command, ENOENT for anything not listed. */
function fakeRun(answers) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const a = answers[cmd];
    if (a === undefined) throw enoent(cmd);
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a(args) : a;
  };
  run.calls = calls;
  return run;
}

// a busybox container: nc (57) owns :443, node regent is PID 1
const busyboxProc = {
  "/proc/net/tcp": PROC_TCP,
  "/proc/net/tcp6": PROC_TCP6_HEADER,
  "/proc": ["1", "57", "212", "self", "net"],
  "/proc/1/fd": ["0", "21"],
  "/proc/1/fd/0": { link: "/dev/null" },
  "/proc/1/fd/21": { link: "socket:[88001]" },
  "/proc/57/fd": ["3"],
  "/proc/57/fd/3": { link: "socket:[99123]" },
  "/proc/212/fd": ["1"],
  "/proc/212/fd/1": { link: "pipe:[5555]" },
  "/proc/57/comm": "nc\n",
};

describe("portOwner parsers", () => {
  it("accepts only bare PID lines from lsof -t", () => {
    expect(po.parseLsofPids(REAL_LSOF)).toEqual([4321]);
    expect(po.parseLsofPids("12\n12\n34\n")).toEqual([12, 34]);
    expect(po.parseLsofPids("")).toEqual([]);
    expect(po.parseLsofPids(BUSYBOX_LSOF)).toBeNull();
    expect(po.parseLsofPids("123abc")).toBeNull();
    expect(po.looksLikeBusyboxOutput(BUSYBOX_LSOF)).toBe(true);
    expect(po.looksLikeBusyboxOutput(REAL_LSOF)).toBe(false);
  });

  it("parses ss, only for LISTEN rows on the exact port", () => {
    expect(po.parseSs(SS, 443)).toEqual({ pids: [57], listenerWithoutPid: false });
    expect(po.parseSs(SS_OTHER_PORT, 443)).toEqual({ pids: [], listenerWithoutPid: false });
    expect(po.parseSs(SS_NO_PID, 443)).toEqual({ pids: [], listenerWithoutPid: true });
    expect(
      po.parseSs('LISTEN 0 1 [::]:443 [::]:* users:(("a",pid=7,fd=3),("a",pid=8,fd=3))', 443).pids,
    ).toEqual([7, 8]);
  });

  it("parses netstat -tlnp", () => {
    expect(po.parseNetstat(NETSTAT, 443)).toEqual({ pids: [57], listenerWithoutPid: false });
    expect(po.parseNetstat(NETSTAT, 20128).pids).toEqual([1]);
    expect(po.parseNetstat(NETSTAT_NO_PID, 443)).toEqual({ pids: [], listenerWithoutPid: true });
  });

  it("parses fuser strictly", () => {
    expect(po.parseFuser(" 57 212")).toEqual([57, 212]);
    expect(po.parseFuser("443/tcp:  57")).toEqual([57]);
    expect(po.parseFuser("")).toEqual([]);
    expect(po.parseFuser("57c")).toBeNull();
  });

  it("finds LISTEN (0A) inodes for the port in /proc/net/tcp", () => {
    expect(po.parseProcNetTcp(PROC_TCP, 443)).toEqual(["99123"]); // 77777 is ESTABLISHED
    expect(po.parseProcNetTcp(PROC_TCP, 20000)).toEqual(["88001"]);
    expect(po.parseProcNetTcp(PROC_TCP6_HEADER, 443)).toEqual([]);
  });

  it("parses /proc/<pid>/stat and ps output", () => {
    expect(po.parseProcStat("57 (n c) (x)) S 12 57 1 0")).toEqual({ ppid: 12, pgrp: 57 });
    expect(po.parsePsComm("PID   COMMAND\n    1 node\n   57 nc\n", 57)).toBe("nc");
    expect(po.parsePsComm("PID   COMMAND\n    1 node\n", 57)).toBeNull();
  });
});

describe("findListeningPids", () => {
  it("uses real lsof when its output is bare PIDs (macOS path unchanged)", () => {
    const run = fakeRun({ lsof: REAL_LSOF });
    const r = po.findListeningPids(443, { platform: "darwin", run, fs: fakeFs() });
    expect(r).toEqual({ status: "found", pids: [4321], method: "lsof" });
    expect(run.calls).toEqual(["lsof -nP -iTCP:443 -sTCP:LISTEN -t"]);
  });

  it("lsof exit 1 with no output means nobody listens", () => {
    const run = fakeRun({ lsof: Object.assign(new Error("exit 1"), { status: 1, stdout: "" }) });
    expect(po.findListeningPids(443, { platform: "darwin", run, fs: fakeFs() }).status).toBe(
      "none",
    );
  });

  it("busybox lsof output never yields a PID; falls back to ss", () => {
    const run = fakeRun({ lsof: BUSYBOX_LSOF, ss: SS });
    const r = po.findListeningPids(443, { platform: "linux", run, fs: fakeFs({}) });
    expect(r).toEqual({ status: "found", pids: [57], method: "ss" });
  });

  it("skips a busybox lsof binary entirely (realpath)", () => {
    const run = fakeRun({ lsof: REAL_LSOF, netstat: NETSTAT });
    const fs = fakeFs({}, { lsofReal: "/bin/busybox" });
    const r = po.findListeningPids(443, { platform: "linux", run, fs });
    expect(r).toEqual({ status: "found", pids: [57], method: "netstat" });
    expect(run.calls.some((c) => c.startsWith("lsof"))).toBe(false);
  });

  it("falls through ss/netstat/fuser to /proc inode mapping", () => {
    const run = fakeRun({ lsof: BUSYBOX_LSOF });
    const r = po.findListeningPids(443, { platform: "linux", run, fs: fakeFs(busyboxProc) });
    expect(r).toEqual({ status: "found", pids: [57], method: "/proc" });
  });

  it("treats none as unknown when the caller knows the port is busy", () => {
    const run = fakeRun({ lsof: "" });
    expect(po.findListeningPids(443, { platform: "darwin", run, fs: fakeFs() }).status).toBe(
      "none",
    );
    const r = po.findListeningPids(443, { platform: "darwin", run, fs: fakeFs(), portBusy: true });
    expect(r).toMatchObject({ status: "unknown" });
    expect(r.reason).toMatch(/in use but lsof cannot see/);
  });

  it("uses fuser (PORT/tcp form, busybox-compatible) before /proc", () => {
    const run = fakeRun({
      lsof: BUSYBOX_LSOF,
      fuser: (args) => (args.join(" ") === "443/tcp" ? " 57" : ""),
    });
    expect(
      po.findListeningPids(443, { platform: "linux", run, fs: fakeFs(busyboxProc) }).method,
    ).toBe("fuser");
  });

  it("reports none when /proc shows no listener on the port", () => {
    const run = fakeRun({ lsof: BUSYBOX_LSOF });
    expect(
      po.findListeningPids(8443, { platform: "linux", run, fs: fakeFs(busyboxProc) }).status,
    ).toBe("none");
  });

  it("is unknown (never guesses) when the listener's process is not visible", () => {
    const run = fakeRun({ lsof: BUSYBOX_LSOF, ss: SS_NO_PID, netstat: NETSTAT_NO_PID });
    const procNoFd = { ...busyboxProc, "/proc/57/fd": undefined };
    delete procNoFd["/proc/57/fd"];
    const r = po.findListeningPids(443, { platform: "linux", run, fs: fakeFs(procNoFd) });
    expect(r.status).toBe("unknown");
  });

  it("is unknown when real lsof prints non-PID junk and no fallback applies", () => {
    const run = fakeRun({ lsof: "COMMAND PID\nnc 57" });
    expect(po.findListeningPids(443, { platform: "linux", run, fs: fakeFs() }).status).toBe(
      "unknown",
    );
  });

  it("is unknown when nothing can be inspected", () => {
    const run = fakeRun({});
    expect(po.findListeningPids(443, { platform: "linux", run, fs: fakeFs() }).status).toBe(
      "unknown",
    );
    expect(po.findListeningPids(0, { platform: "linux", run, fs: fakeFs() }).status).toBe(
      "unknown",
    );
    expect(po.findListeningPids(443, { platform: "darwin", run, fs: fakeFs() }).status).toBe(
      "unknown",
    );
    expect(po.findListeningPids(443, { platform: "win32", run, fs: fakeFs() }).status).toBe(
      "unknown",
    );
  });

  it("an empty ss answer counts as none only when nothing contradicts it", () => {
    const run = fakeRun({ lsof: BUSYBOX_LSOF, ss: "" });
    expect(po.findListeningPids(443, { platform: "linux", run, fs: fakeFs() }).status).toBe("none");
  });
});

describe("getPortOwner / getProcessName", () => {
  it("names the owner from /proc/<pid>/comm", () => {
    const run = fakeRun({ lsof: BUSYBOX_LSOF, ss: SS });
    expect(po.getPortOwner(443, { platform: "linux", run, fs: fakeFs(busyboxProc) })).toEqual({
      pid: 57,
      pids: [57],
      name: "nc",
      method: "ss",
    });
  });

  it("falls back to busybox-compatible `ps -o pid,comm`, then macOS `ps -p`", () => {
    const run = fakeRun({
      ps: (args) => (args.includes("-p") ? "Safari\n" : "PID COMMAND\n 99 nginx\n"),
    });
    expect(po.getProcessName(99, { platform: "linux", run, fs: fakeFs() })).toBe("nginx");
    expect(po.getProcessName(98, { platform: "linux", run, fs: fakeFs() })).toBe("unknown");
    expect(po.getProcessName(99, { platform: "darwin", run, fs: fakeFs() })).toBe("Safari");
  });

  it("returns null when free and { unknown } when unidentifiable", () => {
    const none = fakeRun({ lsof: "" });
    expect(po.getPortOwner(443, { platform: "darwin", run: none, fs: fakeFs() })).toBeNull();
    const junk = fakeRun({ lsof: "garbage" });
    expect(po.getPortOwner(443, { platform: "linux", run: junk, fs: fakeFs() })).toMatchObject({
      unknown: true,
    });
  });
});

describe("kill guards", () => {
  // regent tree: 1 (init) -> 10 (su-exec/shell) -> 20 (regent, pgrp 20) -> 30 (mitm server)
  const tree = {
    "/proc/30/stat": "30 (node) S 20 20 1 0",
    "/proc/20/stat": "20 (node) S 10 20 1 0",
    "/proc/10/stat": "10 (sh) S 1 10 1 0",
    "/proc/40/stat": "40 (node) S 20 20 1 0", // stale MITM child sharing our process group
    "/proc/57/stat": "57 (nc) S 1 57 1 0",
  };
  const ctx = { platform: "linux", selfPid: 30, selfPpid: 20, fs: fakeFs(tree), run: fakeRun({}) };

  it("protects init, ourselves, parent and every ancestor", () => {
    const set = po.getProtectedPids(ctx);
    for (const pid of [0, 1, 10, 20, 30]) expect(set.has(pid)).toBe(true);
    expect(set.has(57)).toBe(false);
  });

  it("explains why a PID is protected, or null", () => {
    expect(po.protectedReason(1, ctx)).toMatch(/not a killable/);
    expect(po.protectedReason(-3, ctx)).toMatch(/not a killable/);
    expect(po.protectedReason(Number.NaN, ctx)).toMatch(/not a killable/);
    expect(po.protectedReason(30, ctx)).toMatch(/this regent process/);
    expect(po.protectedReason(20, ctx)).toMatch(/parent/);
    expect(po.protectedReason(10, ctx)).toMatch(/parent/);
    // same process group is NOT protected: a stale detached:false MITM child must stay killable
    expect(po.protectedReason(40, ctx)).toBeNull();
    expect(po.protectedReason(57, ctx)).toBeNull();
  });

  it("uses ps for ancestry when there is no procfs (macOS)", () => {
    const run = fakeRun({ ps: (args) => ({ 20: "10 20", 10: "1 10" })[args.at(-1)] ?? "" });
    const set = po.getProtectedPids({
      platform: "darwin",
      selfPid: 30,
      selfPpid: 20,
      fs: fakeFs(),
      run,
    });
    expect([...set].sort((a, b) => a - b)).toEqual([0, 1, 10, 20, 30]);
  });

  it("killPids kills only unprotected PIDs and counts only successes", () => {
    const signalled = [];
    const kill = (pid) => {
      if (pid === 58) throw new Error("EPERM");
      signalled.push(pid);
    };
    const res = po.killPids([57, 1, 30, 20, 40, 58], kill, ctx);
    expect(signalled).toEqual([57, 40]);
    expect(res.killed).toEqual([57, 40]);
    expect(res.refused.map((r) => r.pid)).toEqual([1, 30, 20]);
    expect(res.failed).toEqual([{ pid: 58, error: "EPERM" }]);
  });

  it("force-kill refuses unknown, empty or protected owners", () => {
    expect(po.forceKillRefusal(null, 443, ctx)).toMatch(/nothing identified/);
    expect(po.forceKillRefusal({ pids: [] }, 443, ctx)).toMatch(/nothing identified/);
    expect(po.forceKillRefusal({ unknown: true, reason: "lsof is busybox" }, 443, ctx)).toMatch(
      /could not identify .*lsof is busybox.*Stop it manually/,
    );
    expect(po.forceKillRefusal({ pid: 1, pids: [1] }, 443, ctx)).toMatch(/Refusing/);
    expect(po.forceKillRefusal({ pid: 20, pids: [20] }, 443, ctx)).toMatch(/parent/);
    expect(po.forceKillRefusal({ pid: 57, pids: [57, 30] }, 443, ctx)).toMatch(
      /this regent process/,
    );
    expect(po.forceKillRefusal({ pid: 57, pids: [57] }, 443, ctx)).toBeNull();
    expect(po.forceKillRefusal({ pid: 57 }, 443, ctx)).toBeNull();
  });

  it("the real process is protected from itself", () => {
    expect(po.protectedReason(process.pid)).toMatch(/this regent process/);
    expect(po.protectedReason(process.ppid)).toMatch(/parent|not a killable/);
  });
});

describe("killPortListeners (server.js boot)", () => {
  it("returns early on unknown without killing", () => {
    const kill = vi.fn();
    const err = vi.fn();
    const r = po.killPortListeners(443, {
      find: () => ({ status: "unknown", reason: "busybox" }),
      kill,
      err,
    });
    expect(r).toEqual({ status: "unknown", killed: [] });
    expect(kill).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/Not killing anything on port 443/));
  });

  it("does nothing when free, and reports only successful kills", () => {
    const kill = vi.fn();
    expect(po.killPortListeners(443, { find: () => ({ status: "none" }), kill })).toEqual({
      status: "none",
      killed: [],
    });
    expect(kill).not.toHaveBeenCalled();
    const log = vi.fn();
    const err = vi.fn();
    const failing = (pid) => {
      if (pid === 58) throw new Error("EPERM");
    };
    const r = po.killPortListeners(443, {
      find: () => ({ status: "found", pids: [57, 58, 1, process.pid] }),
      kill: failing,
      log,
      err,
    });
    expect(r.killed).toEqual([57]);
    expect(log).toHaveBeenCalledWith("Killed 1 process(es) on port 443");
    const errs = err.mock.calls.flat().join("\n");
    expect(errs).toMatch(/Failed to kill PID 58: EPERM/);
    expect(errs).toMatch(/Not killing PID 1:/);
    expect(errs).toMatch(new RegExp(`Not killing PID ${process.pid}:`));
  });
});

describe("manager port-443 conflict (portOwner mocked)", () => {
  const manager = require("../../src/mitm/manager.js");
  const dns = require("../../src/mitm/dns/dnsConfig.js");
  afterEach(() => vi.restoreAllMocks());

  function spies() {
    const exec = vi.spyOn(dns, "execWithPassword").mockResolvedValue("");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    return { exec, kill };
  }

  it("unknown owner: throws a plain error (no PORT_443_BUSY) and never kills, forced or not", async () => {
    const { exec, kill } = spies();
    const owner = { unknown: true, reason: "lsof is busybox" };
    for (const force of [false, true]) {
      const e = await manager.resolvePort443Conflict(owner, force, "pw").catch((x) => x);
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toBeUndefined();
      expect(e.message).toMatch(/could not identify .*Stop it manually/);
    }
    expect(exec).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("protected owner: no PORT_443_BUSY offer, no kill", async () => {
    const { exec, kill } = spies();
    const e = await manager
      .resolvePort443Conflict({ pid: process.pid, pids: [process.pid], name: "node" }, false, "pw")
      .catch((x) => x);
    expect(e.code).toBeUndefined();
    expect(e.message).toMatch(/Refusing/);
    expect(exec).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("killable owner: PORT_443_BUSY when not forced", async () => {
    spies();
    vi.spyOn(po, "forceKillRefusal").mockReturnValue(null);
    const e = await manager
      .resolvePort443Conflict({ pid: 4242, pids: [4242], name: "/usr/bin/nc" }, false, "pw")
      .catch((x) => x);
    expect(e.code).toBe("PORT_443_BUSY");
    expect(e.portOwner).toEqual({ pid: 4242, name: "nc" });
  });

  it("killUnixPortOwner throws before execWithPassword for unknown or protected owners", async () => {
    const { exec, kill } = spies();
    await expect(manager.killUnixPortOwner({ unknown: true, reason: "x" }, "pw")).rejects.toThrow(
      /could not identify/,
    );
    await expect(manager.killUnixPortOwner({ pid: 1, pids: [1] }, "pw")).rejects.toThrow(
      /Refusing/,
    );
    await expect(
      manager.killUnixPortOwner({ pid: process.ppid, pids: [process.ppid] }, "pw"),
    ).rejects.toThrow(/Refusing/);
    expect(exec).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("killUnixPortOwner kills an allowed owner via sudo", async () => {
    const { exec } = spies();
    vi.spyOn(po, "forceKillRefusal").mockReturnValue(null);
    vi.useFakeTimers();
    const p = manager.killUnixPortOwner({ pid: 4242, pids: [4242] }, "pw");
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
    expect(exec).toHaveBeenCalledWith("kill -9 4242", "pw");
  });
});
