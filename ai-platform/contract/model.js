// ai-platform/contract/model.js
//
// Contract v2 §6 — Model contract (type definitions only). Models are
// first-class, discoverable entities. No discovery logic here — just the shape.

export const MODEL_LIFECYCLES = Object.freeze(["preview", "ga", "deprecated", "retired"]);
export const MODEL_AVAILABILITY = Object.freeze(["available", "limited", "unavailable"]);
export const COST_CLASSES = Object.freeze(["trivial", "low", "medium", "high"]);
export const LATENCY_CLASSES = Object.freeze(["instant", "fast", "normal", "slow"]);

/**
 * @typedef {object} ModelPricing
 * @property {number} [inputPer1k]
 * @property {number} [outputPer1k]
 *
 * @typedef {object} ModelDescriptor
 * @property {string} providerKey
 * @property {string} key
 * @property {string} [aliasOf]                 stable alias → versioned model (deprecation safety)
 * @property {string} displayName
 * @property {string} [family]
 * @property {number} contextWindowTokens
 * @property {number} [maxOutputTokens]
 * @property {string[]} modalitiesIn
 * @property {string[]} modalitiesOut
 * @property {{json:boolean, tools:boolean, streaming:boolean, reasoning:boolean, vision:boolean, audio:boolean, embeddings:boolean}} supports
 * @property {("instant"|"fast"|"normal"|"slow")} latencyClass
 * @property {("trivial"|"low"|"medium"|"high")} costClass
 * @property {ModelPricing} [pricing]
 * @property {("preview"|"ga"|"deprecated"|"retired")} lifecycle
 * @property {("available"|"limited"|"unavailable")} availability
 * @property {string} [knowledgeCutoff]
 */

export {};
