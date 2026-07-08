// ei/calibration/service.js
//
// EI V2.1 Wave C — orchestration for the calibration engine. Deterministic, flag-gated,
// additive. Builds a NEW versioned calibration model from a validation report and
// appends it (idempotent). It does NOT apply calibration to any prediction and never
// mutates history — application is opt-in downstream.

import { buildCalibrationModel } from "./calibration.js";
import { appendCalibrationModel } from "./store.js";
import { isEiCalibrationEnabled } from "../config/flags.js";

/**
 * @param {object} args { workspaceId, validation (from ei/validation), version?, priorModel? }
 * @param {object} [deps] { appendCalibrationModel }
 */
export async function buildWorkspaceCalibration({ workspaceId, validation = {}, version = null, priorModel = null } = {}, deps = {}) {
  if (!isEiCalibrationEnabled(workspaceId)) return { skipped: "flag_off" };
  const append = deps.appendCalibrationModel || appendCalibrationModel;
  const calibration = validation.calibration || [];
  if (calibration.length === 0) return { workspaceId: String(workspaceId), built: false, reason: "no calibration table (predictions need outcomes first)" };

  const model = buildCalibrationModel({ workspaceId, calibration, version, priorModel });
  if (!model) return { workspaceId: String(workspaceId), built: false, reason: "model_build_failed" };
  const id = await append(model);
  return { workspaceId: String(workspaceId), built: true, written: Boolean(id), model };
}
