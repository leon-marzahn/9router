import { compilePattern } from "./config.js";

// Kept self-contained so the same implementation can run in an isolated worker.
export function transformRequest(body, rules, compile = compilePattern) {
  const result = structuredClone(body);
  const fields = [];
  function collect(parent, key) {
    const value = parent[key];
    if (typeof value === "string") {
      fields.push({ parent, key });
    } else if (Array.isArray(value)) {
      value.forEach((_, index) => collect(value, index));
    } else if (value && typeof value === "object") {
      // Do not change tool arguments, images, signatures or structured metadata.
      if (value.type && !["message", "text", "input_text", "output_text", "tool_result", "function_call_output"].includes(value.type)) return;
      for (const child of ["content", "parts", "text", "output"]) {
        if (Object.hasOwn(value, child)) collect(value, child);
      }
    }
  }
  // System instructions precede chronological conversation history.
  for (const key of ["system", "instructions", "systemInstruction", "messages", "input", "contents"]) {
    if (Object.hasOwn(result, key)) collect(result, key);
  }
  const stats = [];
  for (const rule of rules) {
    const regex = compile(rule.regex);
    let total = 0;
    for (const { parent, key } of fields) {
      for (const unused of parent[key].matchAll(regex)) total++;
    }
    const replaceCount = Math.max(0, total - rule.depth);
    let seen = 0;
    for (const { parent, key } of fields) {
      const original = parent[key];
      parent[key] = original.replace(regex, (...args) => {
        if (seen++ >= replaceCount) return args[0];
        const hasGroups = typeof args.at(-1) === "object";
        const groups = hasGroups ? args.at(-1) : undefined;
        const offset = args.at(hasGroups ? -3 : -2);
        const captures = args.slice(1, hasGroups ? -3 : -2);
        // JavaScript replacement tokens, including numbered and named captures.
        return rule.replacement.replace(/\$([$&`']|\d{1,2}|<[^>]*>)/g, (token, name) => {
          if (name === "$") return "$";
          if (name === "&") return args[0];
          if (name === "`") return original.slice(0, offset);
          if (name === "'") return original.slice(offset + args[0].length);
          if (name.startsWith("<")) return groups ? (groups[name.slice(1, -1)] ?? "") : token;
          const index = Number(name);
          if (index > 0 && index <= captures.length) return captures[index - 1] ?? "";
          const first = Number(name[0]);
          if (name.length === 2 && first > 0 && first <= captures.length) return (captures[first - 1] ?? "") + name[1];
          return token;
        });
      });
    }
    stats.push({ matches: total, replaced: replaceCount, preserved: total - replaceCount });
  }
  return { body: result, stats };
}
