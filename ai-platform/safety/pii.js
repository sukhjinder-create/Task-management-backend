// ai-platform/safety/pii.js
//
// P7 — PII DETECTION/tagging (Contract v2 §11). Pure, permissive: TAGs only.
// No redaction/blocking in Epic A (that is the SafetyPolicy piiRedaction mode in
// enforced mode, E2). No network.

const PII_PATTERNS = Object.freeze([
  { type: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: "phone", re: /\b(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3}\)?[\s-]?)\d{3}[\s-]?\d{4}\b/g },
  { type: "credit_card", re: /\b(?:\d[ -]*?){13,16}\b/g },
  { type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
]);

/**
 * @param {string} text
 * @returns {{found:boolean, types:string[], count:number}}
 */
export function detectPii(text) {
  const s = String(text ?? "");
  const types = [];
  let count = 0;
  for (const p of PII_PATTERNS) {
    const m = s.match(p.re);
    if (m && m.length) {
      types.push(p.type);
      count += m.length;
    }
  }
  return { found: types.length > 0, types, count };
}
