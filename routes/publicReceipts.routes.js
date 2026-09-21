import express from "express";
import { createHash } from "node:crypto";
import pool from "../db.js";
import {
  buildSignedReceiptDocument,
  canonicalReceiptJson,
  verifyReceiptSignature,
} from "../services/outcomeReceiptSigning.service.js";

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.get("/keys/:id", async (req, res) => {
  if (!UUID.test(req.params.id || "")) return res.status(404).json({ error: "Signing key not found" });
  const { rows } = await pool.query(
    `SELECT id, algorithm, public_key_pem, created_at, retired_at
     FROM outcome_signing_keys WHERE id=$1 LIMIT 1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Signing key not found" });
  res.setHeader("Cache-Control", "public, max-age=3600, immutable");
  return res.json({
    id: rows[0].id,
    algorithm: rows[0].algorithm,
    publicKeyPem: rows[0].public_key_pem,
    createdAt: rows[0].created_at,
    retiredAt: rows[0].retired_at,
  });
});

router.get("/:publicId", async (req, res) => {
  if (!UUID.test(req.params.publicId || "")) return res.status(404).json({ error: "Receipt not found" });
  const { rows } = await pool.query(
    `SELECT receipt.*, key.public_key_pem
     FROM assurance_outcome_receipts receipt
     JOIN outcome_signing_keys key
       ON key.workspace_id=receipt.workspace_id AND key.id=receipt.signing_key_id
     WHERE receipt.public_id=$1 AND receipt.published_at IS NOT NULL
     LIMIT 1`,
    [req.params.publicId]
  );
  const receipt = rows[0];
  if (!receipt) return res.status(404).json({ error: "Receipt not found" });
  const document = buildSignedReceiptDocument(receipt);
  const digestValid = cryptoDigest(document.snapshot) === receipt.sha256;
  const signatureValid = verifyReceiptSignature(
    document,
    receipt.signature,
    receipt.public_key_pem
  );
  res.setHeader("Cache-Control", "public, max-age=60");
  return res.json({
    ...document,
    signature: {
      algorithm: receipt.signature_algorithm,
      keyId: receipt.signing_key_id,
      value: receipt.signature,
    },
    verification: {
      valid: digestValid && signatureValid && !receipt.revoked_at,
      digestValid,
      signatureValid,
      revokedAt: receipt.revoked_at,
      verifiedAt: new Date().toISOString(),
    },
  });
});

function cryptoDigest(value) {
  return createHash("sha256").update(canonicalReceiptJson(value)).digest("hex");
}

export default router;
