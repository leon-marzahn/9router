// Request validation for the dashboard Playground (POST /api/dashboard/chat/completions).
// The route is not a general proxy: it accepts an OpenAI chat body with a fixed set of
// fields, nothing that could point the request elsewhere (base URLs, headers, keys),
// and images only as inline data: URLs.

export const MAX_BODY_BYTES = 10 * 1024 * 1024; // base64 images
export const MAX_OUTPUT_TOKENS = 32_768;
export const MAX_MESSAGES = 200;
const MAX_MODEL_CHARS = 200;
const MAX_STOP = 4;
const MAX_STOP_CHARS = 200;

const ROLES = new Set(["system", "user", "assistant"]);
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_DETAIL = new Set(["auto", "low", "high"]);
const REASONING_EFFORT = new Set(["minimal", "low", "medium", "high"]);
// Provider/model ids, combo names and "[1m]" markers: no spaces or control chars.
const MODEL_RE = /^[A-Za-z0-9._:@/[\]-]+$/;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const range = (min, max) => (v) => isNum(v) && v >= min && v <= max;
const intRange = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;

/** Sampling params the Playground may set, each with its own check. */
const SAMPLING = {
  temperature: range(0, 2),
  top_p: range(0, 1),
  presence_penalty: range(-2, 2),
  frequency_penalty: range(-2, 2),
  max_tokens: intRange(1, MAX_OUTPUT_TOKENS),
  max_completion_tokens: intRange(1, MAX_OUTPUT_TOKENS),
  seed: intRange(-(2 ** 31), 2 ** 31 - 1),
  reasoning_effort: (v) => REASONING_EFFORT.has(v),
  stop: (v) =>
    (typeof v === "string" && v.length <= MAX_STOP_CHARS) ||
    (Array.isArray(v) &&
      v.length <= MAX_STOP &&
      v.every((s) => typeof s === "string" && s.length <= MAX_STOP_CHARS)),
};
const ALLOWED_FIELDS = new Set(["model", "messages", "stream", "keyId", ...Object.keys(SAMPLING)]);
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class InvalidBody extends Error {}
const fail = (message) => {
  throw new InvalidBody(message);
};

function checkKeys(obj, allowed, where) {
  for (const k of Object.keys(obj))
    if (!allowed.has(k)) fail(`Unsupported field "${String(k).slice(0, 40)}" in ${where}`);
}

const PART_KEYS = { text: new Set(["type", "text"]), image_url: new Set(["type", "image_url"]) };
const IMAGE_KEYS = new Set(["url", "detail"]);
const MESSAGE_KEYS = new Set(["role", "content"]);

function checkPart(part, where) {
  if (!isObj(part)) fail(`${where} must be an object`);
  const keys = PART_KEYS[part.type];
  if (!keys) fail(`${where}.type must be "text" or "image_url"`);
  checkKeys(part, keys, where);
  if (part.type === "text") {
    if (typeof part.text !== "string") fail(`${where}.text must be a string`);
    return;
  }
  const img = part.image_url;
  if (!isObj(img)) fail(`${where}.image_url must be an object`);
  checkKeys(img, IMAGE_KEYS, `${where}.image_url`);
  if (typeof img.url !== "string" || !IMAGE_DATA_URL_RE.test(img.url))
    fail(`${where}.image_url.url must be a data:image/… base64 URL`);
  if (img.detail !== undefined && !IMAGE_DETAIL.has(img.detail))
    fail(`${where}.image_url.detail is invalid`);
}

function checkMessage(msg, i) {
  const where = `messages[${i}]`;
  if (!isObj(msg)) fail(`${where} must be an object`);
  checkKeys(msg, MESSAGE_KEYS, where);
  if (!ROLES.has(msg.role)) fail(`${where}.role must be system, user or assistant`);
  const { content } = msg;
  if (typeof content === "string") return;
  if (msg.role !== "user") fail(`${where}.content must be a string`);
  if (!Array.isArray(content) || content.length === 0)
    fail(`${where}.content must be a string or a non-empty array`);
  content.forEach((part, j) => checkPart(part, `${where}.content[${j}]`));
}

/**
 * Validates a parsed Playground body. Returns { body, keyId } (body: a fresh object with
 * only the fields forwarded to the engine; keyId stays here) or { error }.
 */
export function validatePlaygroundBody(input) {
  try {
    if (!isObj(input)) fail("Body must be a JSON object");
    checkKeys(input, ALLOWED_FIELDS, "body");
    const { model, messages, stream, keyId } = input;
    if (typeof keyId !== "string" || !KEY_ID_RE.test(keyId)) fail("keyId must name an API key");
    if (
      typeof model !== "string" ||
      !model.trim() ||
      model.length > MAX_MODEL_CHARS ||
      !MODEL_RE.test(model)
    )
      fail("model must be a model or combo name");
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES)
      fail(`messages must be an array of 1-${MAX_MESSAGES} messages`);
    messages.forEach(checkMessage);
    if (stream !== undefined && typeof stream !== "boolean") fail("stream must be a boolean");

    const body = { model: model.trim(), messages, stream: stream === true };
    for (const [k, ok] of Object.entries(SAMPLING)) {
      if (input[k] === undefined) continue;
      if (!ok(input[k])) fail(`${k} is out of range`);
      body[k] = input[k];
    }
    return { body, keyId };
  } catch (e) {
    if (e instanceof InvalidBody) return { error: e.message };
    throw e;
  }
}
