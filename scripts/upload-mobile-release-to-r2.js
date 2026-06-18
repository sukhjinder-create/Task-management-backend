import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const apkPath = process.argv[2];
const keys = process.argv.slice(3);

if (!apkPath || keys.length === 0) {
  console.error("Usage: node scripts/upload-mobile-release-to-r2.js <apk-path> <key> [key...]");
  process.exit(1);
}

const requiredEnv = [
  "AWS_S3_BUCKET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "R2_ACCOUNT_ID",
  "AWS_CDN_URL",
];

const missing = requiredEnv.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const absolutePath = path.resolve(apkPath);
const body = fs.readFileSync(absolutePath);

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

for (const key of keys) {
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/vnd.android.package-archive",
    }),
  );
  console.log(`${process.env.AWS_CDN_URL.replace(/\/+$/, "")}/${key}`);
}
