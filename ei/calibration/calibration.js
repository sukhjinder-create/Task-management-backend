// ei/calibration/calibration.js
//
// EI V2.1 Wave C — the Calibration Engine. Turns the validation calibration table
// (predicted vs observed per confidence bucket) into an IMMUTABLE, VERSIONED
// calibration model that maps raw confidence → calibrated confidence via monotone
// (isotonic) regression. It keeps raw / calibrated / observed / historical confidence
// SEPARATE and never overwrites: a new model is a new version with a lineage pointer.
// Applying calibration is opt-in downstream — the engine never mutates predictions.
// Deterministic, no LLM. Reuses deepFreeze.

import { createHash } from "node:crypto";
import { deepFreeze } from "../../ai-platform/contract/common.js";

export const CALIBRATION_SCHEMA_VERSION = 1;
function round(x, dp = 6) { return x == null ? null : Math.round(x * 10 ** dp) / 10 ** dp; }

/** Weighted isotonic (PAVA), non-decreasing. Deterministic. */
export function isotonic(ys, ws) {
  const val = [], wt = [], cnt = [];
  for (let i = 0; i < ys.length; i++) {
    let cv = ys[i], cw = ws[i] || 1, cc = 1;
    while (val.length && val[val.length - 1] > cv) {
      const pv = val.pop(), pw = wt.pop(), pc = cnt.pop();
      cv = (pv * pw + cv * cw) / (pw + cw); cw = pw + cw; cc = pc + cc;
    }
    val.push(cv); wt.push(cw); cnt.push(cc);
  }
  const out = [];
  for (let b = 0; b < val.length; b++) for (let k = 0; k < cnt[b]; k++) out.push(round(val[b]));
  return out;
}

function inputHash(buckets) {
  return "cal_" + createHash("sha256").update(JSON.stringify(buckets.map((b) => [b.range, b.predicted, b.observed, b.count]))).digest("hex").slice(0, 24);
}

/**
 * Build an immutable, versioned calibration model from a validation calibration table.
 * @param {object} p { workspaceId, calibration:[{range,predicted,observed,count}], version?, priorModel? }
 * @returns {object|null} frozen model
 */
export function buildCalibrationModel({ workspaceId, calibration = [], version = null, priorModel = null } = {}) {
  if (!workspaceId) return null;
  const src = calibration.filter((b) => b.count > 0).slice().sort((a, b) => a.predicted - b.predicted);
  const calibrated = isotonic(src.map((b) => b.observed), src.map((b) => b.count));
  const buckets = src.map((b, i) => ({
    lo: b.range?.[0] ?? null, hi: b.range?.[1] ?? null, mid: round(((b.range?.[0] ?? 0) + (b.range?.[1] ?? 0)) / 2, 4),
    predicted: b.predicted, observed: b.observed, calibrated: calibrated[i], count: b.count,
  }));
  const ver = version != null ? version : ((priorModel?.version ?? 0) + 1);
  const ih = inputHash(src);
  return deepFreeze({
    calibrationId: "calm_" + createHash("sha256").update(JSON.stringify([workspaceId, ver, ih])).digest("hex").slice(0, 40),
    eiVersion: "2.1",
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    workspaceId: String(workspaceId),
    version: ver,
    method: "bucket_isotonic_v1",
    buckets,
    // Explicit separation of confidence views (never merged, never overwritten).
    confidenceViews: { raw: "prediction.probability", calibrated: "model.apply(raw)", observed: "buckets[].observed", historical: priorModel ? { calibrationId: priorModel.calibrationId, version: priorModel.version } : null },
    supersedes: priorModel ? { calibrationId: priorModel.calibrationId, version: priorModel.version } : null,
    provenance: { engineVersion: "ei-cal-1", inputHash: ih, sourceBucketCount: src.length },
  });
}

/**
 * Apply a calibration model to a raw confidence. Deterministic, side-effect-free.
 * @returns {{raw:number, calibrated:number, method:string, calibrationId:string|null, bucket:number|null}}
 */
export function applyCalibration(rawConfidence, model) {
  const raw = Math.min(1, Math.max(0, Number(rawConfidence) || 0));
  if (!model || !Array.isArray(model.buckets) || model.buckets.length === 0) {
    return { raw, calibrated: raw, method: "identity", calibrationId: model?.calibrationId ?? null, bucket: null };
  }
  let chosen = model.buckets.find((b) => raw >= (b.lo ?? 0) && raw < (b.hi ?? 1));
  if (!chosen) {
    // nearest bucket by mid (deterministic tie-break to the lower mid)
    chosen = model.buckets.slice().sort((a, b) => Math.abs((a.mid ?? 0) - raw) - Math.abs((b.mid ?? 0) - raw) || (a.mid - b.mid))[0];
  }
  return { raw, calibrated: chosen.calibrated ?? raw, method: model.method, calibrationId: model.calibrationId, bucket: model.buckets.indexOf(chosen) };
}
