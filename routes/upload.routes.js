// routes/upload.routes.js
import express from "express";
import multer from "multer";
import { uploadFile, storageMode } from "../services/storage.service.js";

const router = express.Router();

// Use memory storage so we can forward buffer to S3 when configured
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

/**
 * POST /upload/richtext
 * field name: "file"
 * Returns: { url, original_name }
 */
router.post("/richtext", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const url = await uploadFile({
      buffer:       file.buffer,
      originalname: file.originalname,
      mimetype:     file.mimetype,
      folder:       "uploads",
    });
    return res.json({ url, original_name: file.originalname });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

/**
 * POST /upload/chat-attachment
 * field name: "file"
 * Returns: { url, name, size, type }
 */
router.post("/chat-attachment", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const url = await uploadFile({
      buffer:       file.buffer,
      originalname: file.originalname,
      mimetype:     file.mimetype,
      folder:       "uploads",
    });
    return res.json({ url, name: file.originalname, size: file.size, type: file.mimetype });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

/**
 * POST /upload/avatar
 * field name: "file"
 * Returns: { url }
 */
router.post("/avatar", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const url = await uploadFile({
      buffer:       file.buffer,
      originalname: file.originalname,
      mimetype:     file.mimetype,
      folder:       "avatars",
    });
    return res.json({ url });
  } catch (err) {
    console.error("Avatar upload error:", err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

/**
 * GET /upload/storage-mode
 * Returns whether S3 or local storage is active.
 */
router.get("/storage-mode", (_req, res) => {
  res.json({ mode: storageMode });
});

export default router;
