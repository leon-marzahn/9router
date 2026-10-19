// GET /api/customer/usage — a key holder's own usage, spend and budget.
// Auth is the caller's API key (Authorization: Bearer), not the dashboard session; the
// path is on the public allow-list in src/dashboardGuard.js for that reason.
// Failed attempts are rate-limited per client IP (same limiter as dashboard login, own
// bucket). A success does NOT clear the bucket, so one valid key can't be used to keep
// resetting a brute-force run. No CORS headers: same-origin only.
import { checkLock, getClientIp, recordFail } from "@/lib/auth/loginLimiter";
import { bearerFrom, getCustomerUsage, resolveCustomerKey } from "@/lib/customerView/index.js";

export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
  Vary: "Authorization",
};

const reply = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });

const UNAUTHORIZED = { error: "Invalid or unauthorized API key" };

let warnedUnknownIp = false;

export async function GET(request) {
  const ip = getClientIp(request);
  // Without custom-server.js (or TRUST_PROXY) every caller is "unknown": one shared
  // bucket would let 5 bad requests lock out every customer. Skip the lockout then;
  // keys are high-entropy, so guessing one isn't practical.
  const bucket = ip && ip !== "unknown" ? `customer:${ip}` : null;
  if (!bucket && !warnedUnknownIp) {
    warnedUnknownIp = true;
    console.warn(
      "[customer-view] client IP unknown (not behind custom-server.js / TRUST_PROXY): failed-key lockout is off",
    );
  }
  try {
    const lock = bucket ? checkLock(bucket) : { locked: false };
    if (lock.locked) {
      return reply(
        429,
        { error: "Too many failed attempts. Try again later.", retryAfter: lock.retryAfter },
        { "Retry-After": String(lock.retryAfter) },
      );
    }
    const rec = await resolveCustomerKey(bearerFrom(request));
    if (!rec) {
      if (bucket) recordFail(bucket);
      return reply(401, UNAUTHORIZED, { "WWW-Authenticate": "Bearer" });
    }
    return reply(200, await getCustomerUsage(rec));
  } catch (error) {
    console.warn("[customer-view] usage failed:", error?.message || error);
    return reply(500, { error: "Couldn't load usage" });
  }
}
