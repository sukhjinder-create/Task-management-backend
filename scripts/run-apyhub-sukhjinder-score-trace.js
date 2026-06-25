import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] || fallback;
  return fallback;
}

function defaultApiUrl() {
  if (process.env.ENTERPRISE_CERTIFICATION_API_URL) {
    return process.env.ENTERPRISE_CERTIFICATION_API_URL.replace(/\/+$/, "");
  }
  if (process.env.BACKEND_PUBLIC_URL) {
    return process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, "");
  }
  if (process.env.GOOGLE_CALLBACK_URL) {
    try {
      return new URL(process.env.GOOGLE_CALLBACK_URL).origin;
    } catch {}
  }
  return "http://localhost:3000";
}

const apiUrl = argValue("api-url", defaultApiUrl()).replace(/\/+$/, "");
const workspaceId = argValue("workspace-id", "3ff9264b-1a19-483a-b9e3-2a0b1840a1c2");
const userSearch = argValue("user", "Sukhjinder");
const secret = process.env.INTERNAL_SERVICE_SECRET || process.env.AI_SERVICE_SECRET;

if (!secret) {
  console.error("Missing INTERNAL_SERVICE_SECRET or AI_SERVICE_SECRET in environment");
  process.exit(2);
}

const response = await fetch(`${apiUrl}/internal/enterprise-intelligence/user-score-trace`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${secret}`,
  },
  body: JSON.stringify({
    workspaceId,
    userSearch,
    includeRecomputed: true,
  }),
});

const text = await response.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  payload = { raw: text };
}

const outputPath = path.resolve(
  "docs",
  "enterprise-intelligence",
  "apyhub-sukhjinder-score-trace-output.json"
);
await fs.writeFile(outputPath, JSON.stringify(payload, null, 2));

console.log("Apyhub Sukhjinder score trace response", {
  status: response.status,
  ok: response.ok,
  apiUrl,
  workspaceId,
  userSearch,
  outputPath,
  score: payload.displayedCard?.score ?? null,
  attendance: payload.displayedCard?.attendanceBar ?? null,
  delivery: payload.displayedCard?.productivityBar ?? null,
  reconstructed: payload.exactScoreComposition?.reconstructedFinalScore ?? null,
  attendanceContribution: payload.exactScoreComposition?.attendanceContribution ?? null,
});

if (!response.ok) {
  process.exit(1);
}
