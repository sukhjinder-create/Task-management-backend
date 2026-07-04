// ai-platform/safety/injection.js
//
// P7 — prompt-injection DETECTION (Contract v2 §11). Pure, permissive: it flags
// suspicious patterns; it does NOT modify or block anything in Epic A. No network.

const INJECTION_PATTERNS = Object.freeze([
  { name: "ignore_previous", re: /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts?)\b/i },
  { name: "disregard", re: /\bdisregard\s+(the\s+)?(system|previous|above)\b/i },
  { name: "reveal_system_prompt", re: /\b(reveal|show|print|repeat)\s+(the\s+)?(system|developer)\s+prompt\b/i },
  { name: "role_override", re: /\byou\s+are\s+now\b|\bact\s+as\s+(an?\s+)?(?:admin|root|system|dan)\b/i },
  { name: "instruction_injection", re: /\bnew\s+instructions?:|\boverride\s+(the\s+)?(rules|instructions)\b/i },
  { name: "jailbreak_marker", re: /\b(developer\s+mode|jailbreak|do\s+anything\s+now)\b/i },
]);

/**
 * @param {string} text
 * @returns {{flagged:boolean, matches:string[]}}
 */
export function scanInjection(text) {
  const s = String(text ?? "");
  const matches = [];
  for (const p of INJECTION_PATTERNS) if (p.re.test(s)) matches.push(p.name);
  return { flagged: matches.length > 0, matches };
}
