// ai-platform/providers/toolWire.js
//
// Translates the NEUTRAL tool spec (Contract v2 §14, see ../contract/tool.js)
// into each provider's wire format, and parses provider tool calls back into a
// neutral shape. Pure functions — no network, no DB, no provider SDK.
//
// The neutral spec deliberately mirrors JSON Schema function calling, which both
// the OpenAI Chat Completions protocol and the Anthropic Messages protocol are
// expressible in:
//
//   { name, description, parameters: <JSON Schema object> }
//
// Nothing here executes a tool. Adapters send the wire form and return the
// parsed calls; deciding what to DO with a call belongs to the caller.

/**
 * @typedef {object} NeutralTool
 * @property {string} name
 * @property {string} [description]
 * @property {object} parameters   JSON Schema (type: "object")
 *
 * @typedef {object} NeutralToolCall
 * @property {string} id
 * @property {string} name
 * @property {object} arguments    parsed; {} when the model emitted nothing usable
 * @property {boolean} argumentsValid  false when the raw payload failed to parse
 * @property {string} [rawArguments]
 */

const EMPTY_SCHEMA = Object.freeze({ type: "object", properties: {} });

/**
 * Accepts either a bare array of tools or a ToolDirective-ish object and returns
 * a clean NeutralTool[]. Anything unusable is dropped rather than throwing — a
 * malformed tool must never take down a generation call.
 * @returns {NeutralTool[]}
 */
export function normalizeTools(input) {
  const list = Array.isArray(input) ? input : Array.isArray(input?.tools) ? input.tools : [];
  const seen = new Set();
  const out = [];
  for (const tool of list) {
    // Tolerate an already-OpenAI-shaped tool ({type:"function", function:{...}}).
    const src = tool?.function && typeof tool.function === "object" ? tool.function : tool;
    const name = String(src?.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const parameters =
      src?.parameters && typeof src.parameters === "object"
        ? src.parameters
        : src?.input_schema && typeof src.input_schema === "object"
          ? src.input_schema
          : EMPTY_SCHEMA;
    out.push({
      name,
      description: String(src?.description || ""),
      parameters,
    });
  }
  return out;
}

/**
 * Apply a Contract §14 ToolDirective to a set of inline tool definitions.
 *
 * The directive shape from ../contract/tool.js is { allow, deny, mode, maxLoops,
 * approval }; because no central ToolPort registry exists yet, definitions are
 * carried inline on `definitions` (or `tools`). Callers that pass no directive
 * get an empty list, which means "no tool calling" — the default everywhere.
 *
 * @returns {{definitions: NeutralTool[], mode: string, maxLoops: number, approval: string}}
 */
export function applyToolDirective(directive) {
  const off = { definitions: [], mode: "off", maxLoops: 1, approval: "none" };
  if (!directive || typeof directive !== "object") return off;

  const mode = String(directive.mode || "auto").toLowerCase();
  if (mode === "off") return off;

  let definitions = normalizeTools(directive.definitions || directive.tools || []);
  const allow = Array.isArray(directive.allow) ? directive.allow.map(String) : null;
  const deny = Array.isArray(directive.deny) ? directive.deny.map(String) : null;
  if (allow?.length) definitions = definitions.filter((tool) => allow.includes(tool.name));
  if (deny?.length) definitions = definitions.filter((tool) => !deny.includes(tool.name));

  if (!definitions.length) return off;

  const maxLoops = Number.isFinite(directive.maxLoops) ? Math.max(1, Math.min(10, directive.maxLoops)) : 1;
  return {
    definitions,
    mode: mode === "required" ? "required" : "auto",
    maxLoops,
    approval: directive.approval === "human_in_loop" ? "human_in_loop" : "none",
  };
}

/**
 * Neutral tool mode → OpenAI `tool_choice`.
 * `mode` follows TOOL_MODES ("off"|"auto"|"required"); a string that is not a
 * mode is treated as "force this specific tool".
 */
export function toOpenAIToolChoice(mode) {
  if (mode == null) return undefined;
  if (typeof mode === "object" && mode.name) {
    return { type: "function", function: { name: String(mode.name) } };
  }
  const value = String(mode).toLowerCase();
  if (value === "off" || value === "none") return "none";
  if (value === "auto") return "auto";
  if (value === "required" || value === "any") return "required";
  return { type: "function", function: { name: String(mode) } };
}

/** @param {NeutralTool[]} tools */
export function toOpenAITools(tools) {
  return normalizeTools(tools).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Neutral tool mode → Anthropic `tool_choice`. */
export function toAnthropicToolChoice(mode) {
  if (mode == null) return undefined;
  if (typeof mode === "object" && mode.name) return { type: "tool", name: String(mode.name) };
  const value = String(mode).toLowerCase();
  if (value === "off" || value === "none") return undefined; // Anthropic: omit to disable
  if (value === "auto") return { type: "auto" };
  if (value === "required" || value === "any") return { type: "any" };
  return { type: "tool", name: String(mode) };
}

/** @param {NeutralTool[]} tools */
export function toAnthropicTools(tools) {
  return normalizeTools(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/**
 * Parse a JSON argument blob emitted by a model. Models occasionally wrap JSON
 * in prose or a fenced block; we make one bounded repair attempt before giving
 * up. Never throws.
 * @returns {{value: object, valid: boolean}}
 */
export function parseToolArguments(raw) {
  if (raw == null || raw === "") return { value: {}, valid: true };
  if (typeof raw === "object") return { value: raw, valid: true };
  const text = String(raw);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? { value: parsed, valid: true } : { value: {}, valid: false };
  } catch {
    // Repair attempt: pull the outermost {...} out of surrounding prose/fences.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (parsed && typeof parsed === "object") return { value: parsed, valid: true };
      } catch {
        // fall through
      }
    }
    return { value: {}, valid: false };
  }
}

/**
 * Extract tool calls from an OpenAI-Chat-Completions response.
 * @returns {NeutralToolCall[]}
 */
export function parseOpenAIToolCalls(data) {
  const calls = data?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || !calls.length) return [];
  return calls
    .map((call, index) => {
      const name = String(call?.function?.name || "").trim();
      if (!name) return null;
      const rawArguments = call?.function?.arguments;
      const { value, valid } = parseToolArguments(rawArguments);
      return {
        id: String(call?.id || `call_${index}`),
        name,
        arguments: value,
        argumentsValid: valid,
        ...(typeof rawArguments === "string" ? { rawArguments } : {}),
      };
    })
    .filter(Boolean);
}

/**
 * Extract tool calls from an Anthropic Messages response (`tool_use` blocks).
 * @returns {NeutralToolCall[]}
 */
export function parseAnthropicToolCalls(data) {
  const blocks = data?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((block) => block?.type === "tool_use")
    .map((block, index) => {
      const name = String(block?.name || "").trim();
      if (!name) return null;
      const { value, valid } = parseToolArguments(block?.input);
      return {
        id: String(block?.id || `call_${index}`),
        name,
        arguments: value,
        argumentsValid: valid,
      };
    })
    .filter(Boolean);
}
