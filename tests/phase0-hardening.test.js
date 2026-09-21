import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { getPoolConfigFromConnectionString } from "../backup/databaseTarget.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("request logs exclude query strings and database TLS verifies certificates by default", () => {
  const index = read("index.js");
  const databaseFiles = [
    "db.js",
    "backup/databaseTarget.js",
    "migrate-to-supabase.js",
    "run-ewip-v3-migration.js",
    "run-rls-migration.mjs",
    "run-migration.js",
    "scripts/final-production-e2e.mjs",
  ];
  assert.match(index, /req\.method, req\.path/);
  assert.doesNotMatch(index, /GLOBAL REQUEST:[\s\S]{0,80}originalUrl/);
  assert.match(read("db.js"), /DB_SSL_REJECT_UNAUTHORIZED/);
  for (const file of databaseFiles) {
    assert.doesNotMatch(read(file), /rejectUnauthorized\s*:\s*false/, file);
  }
});

test("webhook signing secrets use authenticated encryption with legacy read compatibility", () => {
  assert.match(read("routes/webhooks.routes.js"), /encryptSecret\(secret\)/);
  assert.match(read("services/webhook.service.js"), /decryptSecret\(delivery\.secret\)/);
});

test("database helpers verify remote TLS and leave local development plaintext", () => {
  const previous = process.env.DB_SSL_REJECT_UNAUTHORIZED;
  delete process.env.DB_SSL_REJECT_UNAUTHORIZED;
  try {
    assert.equal(
      getPoolConfigFromConnectionString("postgresql://user:pass@db.example.com/app").ssl.rejectUnauthorized,
      true
    );
    assert.equal(
      getPoolConfigFromConnectionString("postgresql://user:pass@localhost/app").ssl,
      undefined
    );
  } finally {
    if (previous === undefined) delete process.env.DB_SSL_REJECT_UNAUTHORIZED;
    else process.env.DB_SSL_REJECT_UNAUTHORIZED = previous;
  }
});

test("production workflows preserve certificate verification and encryption keys", () => {
  const workflows = [
    read(".github/workflows/deploy-selfhosted.yml"),
    read(".github/workflows/migrate-production.yml"),
  ].join("\n");
  assert.doesNotMatch(workflows, /rejectUnauthorized:\s*false/);
  assert.match(workflows, /ensure_encryption_key DATA_ENCRYPTION_KEY/);
  assert.match(workflows, /ensure_encryption_key BACKUP_ENCRYPTION_KEY/);
});
