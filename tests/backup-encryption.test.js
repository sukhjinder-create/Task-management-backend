import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { createBackupDecryptTransform, createBackupEncryptTransform } from "../backup/backup.service.js";

test("backup envelope uses authenticated encryption and detects tampering", async () => {
  const key = crypto.randomBytes(32);
  const collect = async (stream) => {
    const chunks = [];
    await pipeline(stream, new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } }));
    return Buffer.concat(chunks);
  };
  const plaintext = Buffer.from("database backup contents");
  const encrypted = await collect(Readable.from(plaintext).pipe(createBackupEncryptTransform(key, Buffer.alloc(12, 7))));
  assert.equal(encrypted.includes(plaintext), false);
  assert.equal((await collect(Readable.from(encrypted).pipe(createBackupDecryptTransform(key)))).toString(), plaintext.toString());
  encrypted[encrypted.length - 1] ^= 1;
  await assert.rejects(() => collect(Readable.from(encrypted).pipe(createBackupDecryptTransform(key))));
});
