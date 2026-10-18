import { createHash } from "node:crypto";

/**
 * Prompt-cache affinity: keep one conversation on one account.
 *
 * Upstream prompt caches (Anthropic, OpenAI/Codex, Gemini) are per account, so
 * a conversation that hops accounts pays full price for its prefix on every hop.
 * We derive a stable, opaque key per conversation and pick the account by
 * rendezvous (highest-random-weight) hashing: each key has a fixed preference
 * order over accounts, adding/removing an unrelated account never moves it, and
 * when the preferred account is unavailable the next one in its order is used.
 *
 * Only a SHA-256 digest of the inputs is kept; prompt text is never stored or logged.
 */

// Explicit session ids clients send; checked before falling back to the prompt prefix.
const SESSION_HEADERS = [
  "x-claude-code-session-id",
  "x-session-id",
  "session_id",
  "session-id",
  "conversation_id",
];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("\n");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.content != null) return textOf(content.content);
    if (Array.isArray(content.parts)) return textOf(content.parts);
  }
  return "";
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

// Claude Code puts {"session_id": ...} (JSON) or "..._session_<uuid>" in metadata.user_id.
function sessionFromMetadata(body) {
  const userId = body?.metadata?.user_id;
  if (typeof userId !== "string" || !userId) return null;
  try {
    const sid = JSON.parse(userId)?.session_id;
    if (typeof sid === "string" && sid) return sid;
  } catch {
    /* not JSON */
  }
  const m = userId.match(/session_([0-9a-f-]{8,})/i);
  return m ? m[1] : null;
}

// The cacheable prefix: system prompt + first user turn, in any client format.
function promptPrefix(body) {
  if (!body || typeof body !== "object") return "";
  const system = [body.system, body.instructions, body.systemInstruction].map(textOf).join("\n");
  const turns =
    body.messages || body.contents || (Array.isArray(body.input) ? body.input : null) || [];
  let sys = system;
  let firstUser = typeof body.input === "string" ? body.input : "";
  if (!firstUser) {
    for (const m of turns) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "system" || m.role === "developer") {
        sys += `\n${textOf(m.content)}`;
        continue;
      }
      if (m.role === "user" || (m.type === "message" && m.role === undefined)) {
        firstUser = textOf(m.content ?? m.parts);
        break;
      }
    }
  }
  if (!sys.trim() && !firstUser.trim()) return "";
  return `${sys}\u0000${firstUser}`;
}

/**
 * Derive an opaque conversation key, or null when nothing stable is available.
 * @param {object} body - client request body (any supported format)
 * @param {Headers|object|null} headers - client request headers
 * @returns {string|null} hex digest
 */
export function deriveAffinityKey(body, headers = null) {
  for (const name of SESSION_HEADERS) {
    const v = headerValue(headers, name);
    if (typeof v === "string" && v.trim()) return sha256(`session:${v.trim()}`);
  }
  if (typeof body?.prompt_cache_key === "string" && body.prompt_cache_key)
    return sha256(`session:${body.prompt_cache_key}`);
  const sid = sessionFromMetadata(body);
  if (sid) return sha256(`session:${sid}`);
  const prefix = promptPrefix(body);
  return prefix ? sha256(`prefix:${prefix}`) : null;
}

function weight(key, id) {
  return createHash("sha256").update(`${key}\u0000${id}`).digest().readBigUInt64BE(0);
}

/**
 * Rendezvous-hash pick: the connection with the highest weight for this key.
 * @param {string} key
 * @param {Array<{id: string}>} connections - eligible connections
 */
export function pickByAffinity(key, connections) {
  let best = null;
  let bestW = -1n;
  for (const c of connections || []) {
    const w = weight(key, c.id);
    if (w > bestW) {
      best = c;
      bestW = w;
    }
  }
  return best;
}
