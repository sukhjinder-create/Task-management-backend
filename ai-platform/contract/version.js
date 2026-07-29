// ai-platform/contract/version.js
//
// Contract v2 — the frozen version marker and the additive-only evolution rule
// (Contract §1.4). Pure constants + guards. No logic beyond version checks.

/** The permanent contract major version. Frozen at "2.x" (Contract §1.4). */
export const AI_CONTRACT_VERSION = "2.0";

/** Major line this codebase speaks. A 3.x is discouraged by design. */
export const AI_CONTRACT_MAJOR = 2;

/**
 * Is a given envelope version compatible with this runtime?
 * Rule: same MAJOR = compatible (minor additions are backward compatible).
 * Unknown newer MINORs are accepted (forward compatible — consumers ignore
 * fields/kinds they don't understand, per Contract §1.4).
 * @param {string} version e.g. "2.0", "2.3"
 * @returns {boolean}
 */
export function isSupportedContractVersion(version) {
  if (typeof version !== "string") return false;
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) && major === AI_CONTRACT_MAJOR;
}
