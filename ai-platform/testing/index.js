// ai-platform/testing/index.js
//
// P0 test harness — barrel export. Test-only utilities for the AI Platform
// migration: provider mocks, golden-output corpus, parity-diff runner,
// latency/cost baselines, and flag control. None of this is imported by any
// production code path.

export { MockAdapter, fixedMockAdapter } from "./mockAdapter.js";
export {
  saveGolden,
  loadGolden,
  listGoldenCases,
  listGoldenCapabilities,
  captureGolden,
  stableStringify,
  DEFAULT_BASE_DIR,
} from "./goldenStore.js";
export {
  textParityScore,
  jsonParityScore,
  scoreParity,
  runParity,
  formatParityReport,
} from "./parityRunner.js";
export { percentile, mean, captureBaseline, compareToBaseline } from "./baseline.js";
export {
  AI_FLAG_NAMES,
  snapshotFlags,
  restoreFlags,
  setFlags,
  resetAiFlags,
  withFlags,
  isAiPlatformEnabled,
} from "./flagControl.js";
