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

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
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
  return `http://localhost:${process.env.PORT || 5000}`;
}

const workspaceId = argValue("workspace-id");
const apiUrl = argValue("api-url", defaultApiUrl()).replace(/\/+$/, "");
const executeCutover = hasFlag("execute-cutover");
const ranges = (argValue("ranges", "30d,90d,6m,1y,all") || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const secret = process.env.INTERNAL_SERVICE_SECRET || process.env.AI_SERVICE_SECRET;

if (!workspaceId) {
  console.error("Missing required --workspace-id <uuid>");
  process.exit(2);
}

if (!secret) {
  console.error("Missing INTERNAL_SERVICE_SECRET or AI_SERVICE_SECRET in environment");
  process.exit(2);
}

const response = await fetch(`${apiUrl}/internal/enterprise-intelligence/certify-core`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${secret}`,
  },
  body: JSON.stringify({
    workspaceId,
    executeCutover,
    ranges,
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
  "enterprise-core-certification-output.json"
);
await fs.writeFile(outputPath, JSON.stringify(payload, null, 2));

console.log("Enterprise intelligence core certification response", {
  status: response.status,
  ok: response.ok,
  apiUrl,
  workspaceId,
  executeCutover,
  outputPath,
  certified: payload.certified ?? null,
  verdicts: payload.verdicts ?? null,
  blockers: payload.blockers ?? null,
});

if (!response.ok) {
  process.exit(1);
}
