// ai-platform/contract/tool.js
//
// Contract v2 §14 — Tool contract (interface only). Type definitions + a ToolPort
// marker + enums. No tool execution, no registry, no agent loop.

export const TOOL_SIDE_EFFECTS = Object.freeze(["none", "read", "write", "external"]);
export const TOOL_SAFETY_CLASSES = Object.freeze(["safe", "guarded", "dangerous"]);
export const TOOL_MODES = Object.freeze(["off", "auto", "required"]);

/**
 * @typedef {object} ToolDefinition
 * @property {string} key
 * @property {string} name
 * @property {string} description
 * @property {import("./common.js").SchemaRef} inputSchema
 * @property {import("./common.js").SchemaRef} outputSchema
 * @property {("none"|"read"|"write"|"external")} sideEffects
 * @property {object} requiredPermissions
 * @property {("safe"|"guarded"|"dangerous")} safetyClass
 * @property {boolean} idempotent
 * @property {number} [timeoutMs]
 * @property {("PLATFORM"|string)} scope
 *
 * @typedef {object} ToolDirective
 * @property {string[]} [allow]
 * @property {string[]} [deny]
 * @property {("off"|"auto"|"required")} mode
 * @property {number} [maxLoops]
 * @property {("none"|"human_in_loop")} [approval]
 *
 * ToolPort (interface). Implementations arrive in a later phase.
 * @typedef {object} ToolPort
 * @property {()=>ToolDefinition} describe
 * @property {(call:object, ctx:object)=>Promise<object>} invoke
 */

export const TOOL_PORT_METHODS = Object.freeze(["describe", "invoke"]);

export class ToolPortBase {
  describe() { throw new Error("ToolPort.describe() not implemented"); }
  async invoke() { throw new Error("ToolPort.invoke() not implemented"); }
}
