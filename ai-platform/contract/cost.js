// ai-platform/contract/cost.js
//
// Contract v2 §17 — Cost contract. Type definitions + a CostEngine interface
// marker. NO estimation math, NO pricing, NO enforcement — those are later
// phases. This only fixes the permanent shapes and the port surface.

/**
 * @typedef {object} CostEstimate
 * @property {import("./common.js").Money} amount
 * @property {string} pricingSource
 *
 * @typedef {object} CostActual
 * @property {import("./common.js").Money} amount
 *
 * @typedef {object} CostReport
 * @property {number} estimated
 * @property {number} [actual]
 * @property {string} currency
 * @property {("PLATFORM"|string)} owner
 * @property {string} pricingSource
 *
 * @typedef {object} Budget
 * @property {("PLATFORM"|string)} scope
 * @property {("daily"|"monthly")} period
 * @property {import("./common.js").Money} limit
 * @property {boolean} hardLimit
 * @property {number[]} alertThresholds
 * @property {("PLATFORM"|string)} costOwner
 *
 * @typedef {object} BudgetDecision
 * @property {boolean} allowed
 * @property {string} [reason]
 */

/**
 * CostEngine port (interface). Implementations arrive in a later phase.
 * @typedef {object} CostEngine
 * @property {(req:object)=>CostEstimate} estimate
 * @property {(res:object)=>CostActual} record
 * @property {(scope:object, estimate:CostEstimate)=>BudgetDecision} budgetCheck
 * @property {(scope:object, horizon:string)=>object} forecast
 * @property {(scope:object, period:object)=>object} chargeback
 */

export const COST_ENGINE_METHODS = Object.freeze([
  "estimate", "record", "budgetCheck", "forecast", "chargeback",
]);

export class CostEngineBase {
  estimate() { throw new Error("CostEngine.estimate() not implemented"); }
  record() { throw new Error("CostEngine.record() not implemented"); }
  budgetCheck() { throw new Error("CostEngine.budgetCheck() not implemented"); }
  forecast() { throw new Error("CostEngine.forecast() not implemented"); }
  chargeback() { throw new Error("CostEngine.chargeback() not implemented"); }
}
