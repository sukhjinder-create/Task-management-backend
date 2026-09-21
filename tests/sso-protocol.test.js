import assert from "node:assert/strict";
import test from "node:test";

import { decryptSecret, encryptSecret } from "../config/dataEncryption.js";
import {
  PostgresSamlCache,
  signSsoRelayState,
  verifySsoRelayState,
} from "../services/ssoProtocol.service.js";

test("enterprise secrets use authenticated encryption and reject tampering", () => {
  const encrypted = encryptSecret("client-secret");
  assert.notEqual(encrypted, "client-secret");
  assert.equal(decryptSecret(encrypted), "client-secret");
  const changed = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptSecret(changed));
});

test("SSO RelayState is signed, expiring, and provider-bound", () => {
  const state = signSsoRelayState("workspace-1", "saml");
  assert.equal(verifySsoRelayState(state, "saml").workspaceId, "workspace-1");
  assert.throws(() => verifySsoRelayState(state, "oidc"), /Invalid SSO state/);
  assert.throws(() => verifySsoRelayState(`${state}x`, "saml"));
});

test("SAML request cache hashes request identifiers and consumes them once", async () => {
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT")) return { rows: [{ value: "created-at" }] };
      if (sql.startsWith("DELETE")) return { rows: [{ value: "created-at" }] };
      return { rows: [] };
    },
  };
  const cache = new PostgresSamlCache("workspace-1", database);
  await cache.saveAsync("_request-id", "created-at");
  assert.equal(await cache.getAsync("_request-id"), "created-at");
  assert.equal(await cache.removeAsync("_request-id"), "created-at");
  assert.notEqual(calls[0].params[1], "_request-id");
  assert.match(calls[0].params[1], /^[a-f0-9]{64}$/);
  assert.match(calls[2].sql, /^DELETE/);
});
