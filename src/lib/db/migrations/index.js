// Migration registry — append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import m001 from "./001-initial.js";
import m002 from "./002-request-traces.js";
import m003 from "./003-budgets.js";
import m004 from "./004-key-pricing.js";
import m005 from "./005-usage-key-refs.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005].sort((a, b) => a.version - b.version);

export function latestVersion() {
  return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}
