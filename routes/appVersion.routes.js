// routes/appVersion.routes.js
import express from "express";

const router = express.Router();

// GET /app-version
// Returns latest Android app version + APK download URL
// Set these env vars in Cloud Run when you upload a new APK:
//   APP_VERSION=1.0.1
//   APP_APK_URL=https://your-s3-bucket.amazonaws.com/app/app-release.apk
router.get("/", (req, res) => {
  const version = process.env.APP_VERSION || "1.0.0";
  const apkUrl  = process.env.APP_APK_URL  || null;

  res.json({ version, apkUrl });
});

export default router;
