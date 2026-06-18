// routes/appVersion.routes.js
import express from "express";

const router = express.Router();

const DEFAULT_ANDROID_VERSION = "1.0.13";
const DEFAULT_ANDROID_VERSION_CODE = 14;
const DEFAULT_ANDROID_APK_URL =
  "https://pub-5e8d0742f1224c3dbf01efc7851e96f5.r2.dev/app-release.apk";

// GET /app-version
// Returns latest Android app version + APK download URL
// Set these env vars in Cloud Run when you upload a new APK:
//   APP_VERSION=1.0.13
//   APP_VERSION_CODE=14
//   APP_APK_URL=https://<your-public-cdn>/asystence-android-1.0.13.apk
//   APP_APK_SHA256=<optional checksum>
router.get("/", (req, res) => {
  const version = process.env.APP_VERSION || DEFAULT_ANDROID_VERSION;
  const versionCode = Number(process.env.APP_VERSION_CODE || DEFAULT_ANDROID_VERSION_CODE);
  const apkUrl = process.env.APP_APK_URL || DEFAULT_ANDROID_APK_URL;

  res.json({
    platform: "android",
    packageName: "com.proxima.app",
    version,
    versionCode,
    apkUrl,
    mandatory: false,
    checksum: process.env.APP_APK_SHA256 || null,
    notes: process.env.APP_RELEASE_NOTES || "Native Flutter Android release.",
  });
});

export default router;
