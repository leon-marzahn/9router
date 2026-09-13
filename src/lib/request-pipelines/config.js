export const PIPELINE_HEADER = "x-9router-pipeline";

export function compilePattern(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 4096) {
    throw new Error("Regex must contain 1–4096 characters");
  }
  // Accept a bare pattern or /pattern/flags. Always replace globally.
  const literal = pattern.match(/^\/([\s\S]*)\/([a-z]*)$/);
  const source = literal ? literal[1] : pattern;
  const flags = literal ? literal[2] : "";
  if (/[^gimsu]/.test(flags) || new Set(flags).size !== flags.length) {
    throw new Error("Regex flags may include g, i, m, s and u once each");
  }
  return new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
}

export function validatePipelines(pipelines) {
  if (!Array.isArray(pipelines) || pipelines.length > 50) {
    throw new Error("Provide an array of at most 50 pipelines");
  }
  const names = new Set();
  return pipelines.map((pipeline) => {
    if (!pipeline || typeof pipeline.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(pipeline.name)) {
      throw new Error("Pipeline names must contain 1–64 letters, numbers, underscores or hyphens");
    }
    if (names.has(pipeline.name)) throw new Error(`Duplicate pipeline name: ${pipeline.name}`);
    names.add(pipeline.name);
    if (!Array.isArray(pipeline.rules) || !pipeline.rules.length || pipeline.rules.length > 50) {
      throw new Error(`Pipeline ${pipeline.name} must have 1–50 rules`);
    }
    return {
      name: pipeline.name,
      rules: pipeline.rules.map((rule, index) => {
        try {
          if (!rule || typeof rule !== "object") throw new Error("Invalid rule");
          compilePattern(rule.regex);
          const replacement = rule.replacement ?? "";
          const depth = rule.depth ?? 0;
          if (typeof replacement !== "string" || replacement.length > 16384) throw new Error("Replacement must be a string of at most 16384 characters");
          if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("Depth must be a non-negative integer");
          return { regex: rule.regex, replacement, depth };
        } catch (error) {
          throw new Error(`${pipeline.name}, rule ${index + 1}: ${error.message}`);
        }
      }),
    };
  });
}
