// ei/validation/validation.js
//
// EI V2.1 Wave C — deterministic Prediction Validation. A PURE projection over
// predictions + their outcomes (no new store). Classifies each prediction as
// correct / incorrect / unknown, and computes precision, recall, accuracy, Brier
// score, and a calibration table (confidence buckets: predicted vs observed), plus
// false positives / negatives. Fully deterministic. When no outcomes exist, metrics
// are returned insufficient — never fabricated.

function round(x, dp = 6) { return x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp; }
function ok(value, basis) { return { value, evidenceSufficient: true, basis }; }
function gap(reason) { return { value: null, evidenceSufficient: false, reason }; }

// Map a prediction outcome status to a realized truth value in [0,1] (null = unknown).
function realizedOf(status) {
  if (status === "confirmed") return 1;
  if (status === "refuted") return 0;
  if (status === "partially_confirmed") return 0.5;
  return null; // unknown
}

const BUCKETS = 10; // deciles

/**
 * @param {object} p
 * @param {Array} p.predictions
 * @param {Array} p.outcomes      prediction-kind outcomes
 * @returns {object}
 */
export function validatePredictionOutcomes({ predictions = [], outcomes = [] } = {}) {
  const outByPred = new Map();
  for (const o of outcomes) {
    const key = o.refs?.predictionId || o.predictionId || o.subjectId;
    if (!key) continue;
    // Latest observation wins as the validation truth (deterministic by observedAt then id).
    const prev = outByPred.get(key);
    if (!prev || new Date(o.observedAt) > new Date(prev.observedAt) || (String(o.observedAt) === String(prev.observedAt) && String(o.outcomeId) > String(prev.outcomeId))) outByPred.set(key, o);
  }

  const classifications = [];
  let tp = 0, fp = 0, tn = 0, fn = 0, brierSum = 0, brierN = 0;
  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({ bucket: i, lo: round(i / BUCKETS, 2), hi: round((i + 1) / BUCKETS, 2), predictedSum: 0, observedSum: 0, count: 0 }));

  for (const pr of predictions.slice().sort((a, b) => String(a.predictionId).localeCompare(String(b.predictionId)))) {
    const o = outByPred.get(pr.predictionId);
    const realized = o ? realizedOf(o.status) : null;
    const prob = pr.probability ?? 0;
    if (realized == null) { classifications.push({ predictionId: pr.predictionId, classification: "unknown", probability: prob }); continue; }

    const predPositive = prob >= 0.5;
    const truthPositive = realized >= 0.5;
    const correct = predPositive === truthPositive;
    classifications.push({ predictionId: pr.predictionId, classification: correct ? "correct" : "incorrect", probability: prob, realized, predPositive, truthPositive });

    if (predPositive && truthPositive) tp += 1;
    else if (predPositive && !truthPositive) fp += 1;
    else if (!predPositive && !truthPositive) tn += 1;
    else fn += 1;

    brierSum += (prob - realized) ** 2; brierN += 1;
    const bi = Math.min(BUCKETS - 1, Math.floor(prob * BUCKETS));
    buckets[bi].predictedSum += prob; buckets[bi].observedSum += realized; buckets[bi].count += 1;
  }

  const known = tp + fp + tn + fn;
  const metrics = {};
  metrics.evaluated = ok(known, { predictions: predictions.length, withOutcome: known });
  metrics.accuracy = known ? ok(round((tp + tn) / known), { tp, tn, known }) : gap("no validated predictions (outcomes required)");
  metrics.precision = (tp + fp) ? ok(round(tp / (tp + fp)), { tp, fp }) : gap("no positive predictions with outcomes");
  metrics.recall = (tp + fn) ? ok(round(tp / (tp + fn)), { tp, fn }) : gap("no positive truths with outcomes");
  metrics.brierScore = brierN ? ok(round(brierSum / brierN), { n: brierN }) : gap("no validated predictions (outcomes required)");
  metrics.falsePositives = ok(fp, { fp });
  metrics.falseNegatives = ok(fn, { fn });

  const calibration = buckets.filter((b) => b.count > 0).map((b) => ({
    bucket: b.bucket, range: [b.lo, b.hi], count: b.count,
    predicted: round(b.predictedSum / b.count), observed: round(b.observedSum / b.count),
  }));
  // Calibration quality = 1 - mean absolute gap between predicted and observed per bucket.
  const calGap = calibration.length ? calibration.reduce((a, b) => a + Math.abs(b.predicted - b.observed), 0) / calibration.length : null;
  metrics.calibrationQuality = calGap != null ? ok(round(1 - calGap), { buckets: calibration.length }) : gap("no validated predictions to calibrate");

  return { counts: { tp, fp, tn, fn, unknown: predictions.length - known }, metrics, calibration, classifications };
}
