// ai-platform/testing/goldenStore.js
//
// P0 test harness — golden-output corpus infrastructure.
// Stores/loads per-capability "golden" records (captured legacy outputs) as
// deterministic JSON files. Later phases capture real legacy output here before
// a capability is migrated; P0 only ships the machinery + sample fixtures.
//
// Pure filesystem + node builtins. No product code, no DB, no network.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_DIR = fileURLToPath(new URL("./fixtures/golden", import.meta.url));

/** Deterministic (sorted-key) JSON so golden files are diff-stable. */
export function stableStringify(value, indent = 2) {
  const seen = new WeakSet();
  const sortKeys = (v) => {
    if (v && typeof v === "object") {
      if (seen.has(v)) throw new Error("Cannot stableStringify circular value");
      seen.add(v);
      if (Array.isArray(v)) return v.map(sortKeys);
      return Object.keys(v)
        .sort()
        .reduce((acc, k) => {
          acc[k] = sortKeys(v[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(sortKeys(value), null, indent);
}

function caseFile(baseDir, capability, caseId) {
  return path.join(baseDir, capability, `${caseId}.json`);
}

/**
 * @param {object} record { capability, caseId, outputType?, input, output, meta?, capturedAt? }
 */
export function saveGolden(record, { baseDir = DEFAULT_BASE_DIR } = {}) {
  if (!record?.capability || !record?.caseId) {
    throw new Error("Golden record requires capability + caseId");
  }
  const complete = {
    capability: record.capability,
    caseId: record.caseId,
    outputType: record.outputType || (typeof record.output === "object" ? "json" : "text"),
    input: record.input ?? null,
    output: record.output ?? null,
    meta: record.meta ?? {},
    capturedAt: record.capturedAt || new Date().toISOString(),
  };
  const file = caseFile(baseDir, record.capability, record.caseId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stableStringify(complete) + "\n", "utf8");
  return file;
}

export function loadGolden(capability, caseId, { baseDir = DEFAULT_BASE_DIR } = {}) {
  const file = caseFile(baseDir, capability, caseId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function listGoldenCases(capability, { baseDir = DEFAULT_BASE_DIR } = {}) {
  const dir = path.join(baseDir, capability);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function listGoldenCapabilities({ baseDir = DEFAULT_BASE_DIR } = {}) {
  if (!fs.existsSync(baseDir)) return [];
  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * Capture a golden record by running a producer over an input. In later phases
 * `produce` is the LEGACY path (e.g., generateText); in P0 it is a mock.
 * @param {(input:any)=>Promise<string|object>} produce
 */
export async function captureGolden({ capability, caseId, input, produce, meta = {} }, opts = {}) {
  const startedAt = Date.now();
  const output = await produce(input);
  const record = {
    capability,
    caseId,
    input,
    output,
    meta: { ...meta, latencyMs: Date.now() - startedAt },
  };
  if (opts.persist) saveGolden(record, opts);
  return record;
}

export { DEFAULT_BASE_DIR };
