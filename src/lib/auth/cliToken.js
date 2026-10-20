import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const CLI_TOKEN_HEADER = "x-9r-cli-token";
export const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;
export async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

// Constant-time compare. Hashing both sides yields equal-length buffers for timingSafeEqual.
export function cliTokenMatches(provided, expected) {
  if (typeof provided !== "string" || !provided || typeof expected !== "string" || !expected) {
    return false;
  }
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// True only when the request carries the real CLI token; presence alone is not enough.
export async function hasValidCliToken(request) {
  const provided = request?.headers?.get?.(CLI_TOKEN_HEADER);
  if (!provided) return false;
  return cliTokenMatches(provided, await getCliToken());
}
