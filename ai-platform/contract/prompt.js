// ai-platform/contract/prompt.js
//
// Contract v2 §7 — Prompt contract (structured prompts). Type definitions only.
// Trust boundaries (system/developer trusted; userTemplate variables untrusted)
// are captured in the shape; enforcement is the Safety layer (a later phase).

export const PROMPT_STATUSES = Object.freeze(["draft", "testing", "published", "archived"]);
export const VARIABLE_INJECTION_CLASSES = Object.freeze(["trusted", "untrusted"]);

/**
 * @typedef {object} PromptSegment
 * @property {string} text
 *
 * @typedef {object} VariableSpec
 * @property {string} name
 * @property {string} [type]
 * @property {boolean} [required]
 * @property {import("./common.js").SchemaRef} [schema]
 * @property {("trusted"|"untrusted")} [injectionClass]
 *
 * @typedef {object} PromptDefinition
 * @property {string} key
 * @property {string} category
 * @property {string} [description]
 * @property {string} feature
 * @property {string} [owner]
 * @property {("global_locked"|"workspace_customizable"|"workspace_locked")} lock
 *
 * @typedef {object} Example
 * @property {Array<object>} input     // Part[]
 * @property {Array<object>} output    // Part[]
 *
 * @typedef {object} PromptVersion
 * @property {string} promptKey
 * @property {number} version
 * @property {("draft"|"testing"|"published"|"archived")} status
 * @property {PromptSegment} [system]
 * @property {PromptSegment} [developer]
 * @property {PromptSegment} userTemplate
 * @property {Example[]} [fewShot]
 * @property {VariableSpec[]} variables
 * @property {import("./common.js").SchemaRef} [inputSchemaRef]
 * @property {import("./common.js").SchemaRef} [outputSchemaRef]
 * @property {object} [safety]
 * @property {object[]} [modelHints]
 * @property {object} metadata
 */

export {};
