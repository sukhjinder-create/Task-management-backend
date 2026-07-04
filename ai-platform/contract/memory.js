// ai-platform/contract/memory.js
//
// Contract v2 §15 — Memory contract (interface only). Type definitions + a
// MemoryPort marker + enums. No storage, no retention logic.

export const MEMORY_KINDS = Object.freeze([
  "working", "episodic", "semantic", "profile", "summary",
]);
export const MEMORY_ISOLATION = Object.freeze(["workspace", "user", "capability"]);

/**
 * @typedef {object} MemoryScope
 * @property {("working"|"episodic"|"semantic"|"profile"|"summary")} kind
 * @property {("PLATFORM"|string)} scope
 * @property {import("./common.js").EntityRef} [subjectRef]
 * @property {object} retention
 * @property {("workspace"|"user"|"capability")} isolation
 *
 * @typedef {object} MemoryDirective
 * @property {MemoryScope[]} [read]
 * @property {object[]} [write]
 *
 * MemoryPort (interface). Implementations arrive in a later phase.
 * @typedef {object} MemoryPort
 * @property {(q:object, ctx:object)=>Promise<object[]>} read
 * @property {(rec:object, ctx:object)=>Promise<void>} write
 * @property {(sel:object, ctx:object)=>Promise<void>} forget
 */

export const MEMORY_PORT_METHODS = Object.freeze(["read", "write", "forget"]);

export class MemoryPortBase {
  async read() { throw new Error("MemoryPort.read() not implemented"); }
  async write() { throw new Error("MemoryPort.write() not implemented"); }
  async forget() { throw new Error("MemoryPort.forget() not implemented"); }
}
