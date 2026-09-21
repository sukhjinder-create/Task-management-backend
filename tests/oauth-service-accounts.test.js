import assert from "node:assert/strict";
import test from "node:test";

import {
  createServiceAccountCredentials,
  parseClientCredentials,
} from "../services/serviceAccount.service.js";

test("OAuth client credentials are high entropy and parse Basic authentication", () => {
  const value = createServiceAccountCredentials();
  assert.match(value.clientId, /^asy_client_[a-f0-9]{32}$/);
  assert.match(value.clientSecret, /^asy_secret_[a-f0-9]{64}$/);
  const basic = `Basic ${Buffer.from(`${value.clientId}:${value.clientSecret}`).toString("base64")}`;
  assert.deepEqual(parseClientCredentials(basic), value);
  assert.equal(parseClientCredentials("Basic broken"), null);
});

test("body credentials are accepted for standards-compatible OAuth clients", () => {
  const value = createServiceAccountCredentials();
  assert.deepEqual(parseClientCredentials(null, {
    client_id: value.clientId,
    client_secret: value.clientSecret,
  }), value);
});
