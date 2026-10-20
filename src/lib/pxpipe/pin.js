import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// pxpipe-proxy runs inside the chat request path and sees every prompt it
// transforms, so it is pinned to one reviewed release rather than @latest.
//
// To bump the pin:
//   1. `npm view pxpipe-proxy@<v> dist.integrity scripts dependencies --registry=https://registry.npmjs.org/`
//      and check there are still no preinstall/install/postinstall scripts.
//   2. `npm pack pxpipe-proxy@<v> --ignore-scripts --registry=https://registry.npmjs.org/`, extract
//      it and review the diff against the current pin (at least everything
//      dist/core/library.js imports: no network, fs writes, eval, child_process).
//      gpt-tokenizer is installed but not imported by library.js today; if a
//      future version imports it (or any bare/node: specifier, see
//      tests/unit/pxpipe-pin.test.js), pin and hash that dependency too.
//   3. Set PXPIPE_VERSION, PXPIPE_INTEGRITY (dist.integrity) and
//      PXPIPE_TREE_SHA256 (`node scripts/pxpipe-tree-hash.mjs <extracted>/package`).
//   4. Install through the dashboard and confirm the health check passes.
export const PXPIPE_PACKAGE = "pxpipe-proxy";
export const PXPIPE_VERSION = "0.15.0";
export const PXPIPE_INTEGRITY =
  "sha512-GMuiu5G8rTAcW/ITV/e6ZqE1g8ZR5ADpGmj06pjGrUV/46v+EjnpMFwhrQ792Y/5xzFv+w65uKaDW5SSrKOY9Q==";
// sha256 over the extracted package files (see treeHash); catches files
// edited on disk after install, which the lockfile integrity cannot.
export const PXPIPE_TREE_SHA256 =
  "b25e47eda1399d9b543c0e81d0696c3ea6f4168c4119faf1b2ef5730f7138231";
export const PXPIPE_SPEC = `${PXPIPE_PACKAGE}@${PXPIPE_VERSION}`;
// Explicit so a user/global .npmrc cannot redirect the download to a mirror.
export const PXPIPE_REGISTRY = "https://registry.npmjs.org/";

function listFiles(root, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    // Nested deps are not part of the package tarball.
    if (entry.isDirectory()) {
      if (relPath !== "node_modules") out.push(...listFiles(root, relPath));
    } else {
      out.push(relPath);
    }
  }
  return out;
}

// Deterministic hash of a package directory: sorted "path\0sha256(content)\n" lines.
// Symlinks and other non-regular files count as content "link" so they can't slip in unnoticed.
export function treeHash(root) {
  const h = crypto.createHash("sha256");
  for (const rel of listFiles(root).sort()) {
    const full = path.join(root, rel);
    const st = fs.lstatSync(full);
    const digest = st.isFile()
      ? crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")
      : "link";
    h.update(`${rel}\0${digest}\n`);
  }
  return h.digest("hex");
}

function fail(reason) {
  return { ok: false, reason };
}

// Check an installed copy against the pin: package.json version, the
// lockfile's recorded tarball integrity, and the on-disk file tree.
export function verifyPinnedInstall({ hostDir, packageRoot, pin }) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    return fail("package.json missing or unreadable");
  }
  if (pkg.name !== PXPIPE_PACKAGE || pkg.version !== pin.version) {
    return fail(`installed ${pkg.name}@${pkg.version}, pinned ${PXPIPE_PACKAGE}@${pin.version}`);
  }

  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(hostDir, "package-lock.json"), "utf8"));
  } catch {
    return fail("package-lock.json missing or unreadable");
  }
  const locked = lock?.packages?.[`node_modules/${PXPIPE_PACKAGE}`];
  if (!locked || locked.version !== pin.version || locked.integrity !== pin.integrity) {
    return fail("lockfile integrity does not match the pinned tarball");
  }

  let actual;
  try {
    actual = treeHash(packageRoot);
  } catch (e) {
    return fail(`cannot hash package files: ${e.message}`);
  }
  if (actual !== pin.treeSha256) return fail("package files differ from the pinned release");

  return { ok: true, reason: null, treeSha256: actual };
}

export function defaultPin() {
  return { version: PXPIPE_VERSION, integrity: PXPIPE_INTEGRITY, treeSha256: PXPIPE_TREE_SHA256 };
}
