const CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MOJIBAKE_MARKERS =
  /(?:\u00C3.|\u00C2.|\u00E2.|\u00E0[\u00A4\u00A5])/g;

function markerCount(value) {
  return (String(value || "").match(MOJIBAKE_MARKERS) || []).length;
}

function devanagariCount(value) {
  return (String(value || "").match(/[\u0900-\u097F]/g) || []).length;
}

function repairUtf8Mojibake(value) {
  if (markerCount(value) === 0) return { text: value, repaired: false };
  const candidate = Buffer.from(value, "latin1").toString("utf8");
  if (
    candidate.includes("\uFFFD") ||
    markerCount(candidate) >= markerCount(value) ||
    devanagariCount(candidate) < devanagariCount(value)
  ) {
    return { text: value, repaired: false };
  }
  return { text: candidate, repaired: true };
}

export function normalizeHuddleTranscriptText(value, { maxLength = 4000 } = {}) {
  const source = typeof value === "string" ? value : String(value || "");
  const prepared = source
    .replace(/\r\n?/g, "\n")
    .normalize("NFC");
  const repaired = repairUtf8Mojibake(prepared);
  const cleaned = repaired.text
    .replace(CONTROL_CHARACTERS, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
  const text = maxLength ? cleaned.slice(0, maxLength) : cleaned;
  return {
    text,
    diagnostics: {
      version: 1,
      unicodeNormalization: "NFC",
      utf8MojibakeRepaired: repaired.repaired,
      sourceLength: source.length,
      normalizedLength: text.length,
      truncated: Boolean(maxLength && cleaned.length > maxLength),
    },
  };
}

export default normalizeHuddleTranscriptText;
