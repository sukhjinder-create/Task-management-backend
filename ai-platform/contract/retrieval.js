// ai-platform/contract/retrieval.js
//
// Contract v2 §16 — Retrieval contract (interface only). Type definitions + a
// RetrieverPort marker. No retrieval, ranking, or grounding logic.

/**
 * @typedef {object} RetrieverDescriptor
 * @property {string[]} sources
 * @property {string[]} [modalities]
 * @property {object} [filters]
 *
 * @typedef {object} RetrievalDirective
 * @property {string[]} sources
 * @property {number} [topK]
 * @property {object} [filters]
 * @property {boolean} [rerank]
 * @property {number} [minScore]
 * @property {boolean} [citationsRequired]
 *
 * @typedef {object} RetrievedChunk
 * @property {string} sourceId
 * @property {string} [text]
 * @property {Array<object>} [parts]     // Part[]
 * @property {number} score
 * @property {import("./common.js").JsonValue} metadata
 *
 * RetrieverPort (interface). Implementations arrive in a later phase.
 * @typedef {object} RetrieverPort
 * @property {()=>RetrieverDescriptor} describe
 * @property {(q:object, ctx:object)=>Promise<RetrievedChunk[]>} retrieve
 */

export const RETRIEVER_PORT_METHODS = Object.freeze(["describe", "retrieve"]);

export class RetrieverPortBase {
  describe() { throw new Error("RetrieverPort.describe() not implemented"); }
  async retrieve() { throw new Error("RetrieverPort.retrieve() not implemented"); }
}
