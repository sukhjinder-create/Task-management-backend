import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  buildSignedReceiptDocument,
  createReceiptSignature,
  verifyReceiptSignature,
} from "../services/outcomeReceiptSigning.service.js";

test("outcome receipts are Ed25519 signed and any snapshot change invalidates them", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const receipt = {
    id: "receipt-1",
    public_id: "public-1",
    goal_id: "goal-1",
    version: 1,
    schema_version: 1,
    generated_at: "2026-09-21T00:00:00.000Z",
    sha256: "a".repeat(64),
    signature_algorithm: "Ed25519",
    signing_key_id: "key-1",
    snapshot: { title: "Delivered" },
  };
  const document = buildSignedReceiptDocument(receipt);
  const signature = createReceiptSignature(document, privateKey);
  assert.equal(verifyReceiptSignature(document, signature, publicKey), true);
  assert.equal(verifyReceiptSignature({ ...document, snapshot: { title: "Changed" } }, signature, publicKey), false);
});
