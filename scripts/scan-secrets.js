import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const skip = /(^|\/)(\.claude|\.serena|package-lock\.json|dist|artifacts|freelance-profile-kit|node_modules|tests|tmp-huddle-cert)(\/|$)|\.example$/i;
const credential = /(?:^|[\s,{])(JWT_SECRET|DATA_ENCRYPTION_KEY|BACKUP_ENCRYPTION_KEY|DB_PASSWORD|DATABASE_URL|SMTP_PASS|(?:AWS|BACKUP_S3)_SECRET_ACCESS_KEY|(?:OPENAI|GROQ|ANTHROPIC|GEMINI|DEEPGRAM)_API_KEY|RAZORPAY_KEY_SECRET|STRIPE_SECRET_KEY)\s*[:=]\s*["']?([^\s,"']+)/i;
const token = /(?:sk_live_|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}/;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const safeValue = /^(?:$|replace|example|your[-_]|(?:gsk|sk|hf|xai)_your_|test|local|verification|get[A-Z]|process\.env|\$\{|<|postgres:\/\/\.\.\.|DATABASE_URL|JWT_SECRET|[^\s]+:latest)/i;
const findings = [];

for (const file of files) {
  const normalized = file.replaceAll("\\", "/");
  if (skip.test(normalized)) continue;
  let content;
  try { content = readFileSync(file, "utf8"); } catch { continue; }
  if (content.includes("\0")) continue;
  content.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(credential);
    if (privateKey.test(line)) findings.push(`${file}:${index + 1} private key`);
    else if (token.test(line)) findings.push(`${file}:${index + 1} provider token`);
    else if (match && !safeValue.test(match[2]) && !/\.\.\.|<[^>]+>/.test(match[2])) findings.push(`${file}:${index + 1} ${match[1]}`);
  });
}

if (findings.length) {
  console.error(`Potential committed secrets found (${findings.length}); values are intentionally hidden:`);
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} repository files checked).`);
