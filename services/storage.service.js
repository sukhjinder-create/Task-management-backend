// services/storage.service.js
// Unified file storage — uses S3 when configured, falls back to local disk.
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const USE_S3 = !!(process.env.AWS_S3_BUCKET && process.env.AWS_ACCESS_KEY_ID);
const BUCKET  = process.env.AWS_S3_BUCKET;
const REGION  = process.env.AWS_REGION || "us-east-1";
const CDN_URL = process.env.AWS_CDN_URL; // optional CloudFront URL

let _s3 = null;
function getS3() {
  if (!_s3) {
    _s3 = new S3Client({
      region: REGION,
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3;
}

/**
 * Upload a file buffer to S3 or local disk.
 * @returns {string} public URL
 */
export async function uploadFile({ buffer, originalname, mimetype, folder = "uploads" }) {
  const ext      = path.extname(originalname) || "";
  const key      = `${folder}/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

  if (USE_S3) {
    await getS3().send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: mimetype,
      ACL:         "public-read",
    }));

    const base = CDN_URL || `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
    return `${base}/${key}`;
  }

  // Local disk fallback
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = path.dirname(__filename);
  const dir        = path.join(__dirname, "..", folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `/${folder}/${filename}`;
}

/**
 * Generate a presigned GET URL for a private S3 object.
 * Returns the original URL unchanged when using local storage.
 */
export async function getPresignedUrl(key, expiresInSeconds = 3600) {
  if (!USE_S3) return key;

  const url = await getSignedUrl(
    getS3(),
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: expiresInSeconds }
  );
  return url;
}

/**
 * Delete a file from S3 or local disk.
 */
export async function deleteFile(urlOrKey) {
  try {
    if (USE_S3) {
      const key = urlOrKey.replace(/^https?:\/\/[^/]+\//, "");
      await getS3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    } else {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname  = path.dirname(__filename);
      const localPath  = path.join(__dirname, "..", urlOrKey.replace(/^\//, ""));
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
  } catch (err) {
    console.warn("[storage] deleteFile failed:", err.message);
  }
}

export const storageMode = USE_S3 ? "s3" : "local";
