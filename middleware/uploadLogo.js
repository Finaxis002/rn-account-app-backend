// middleware/uploadLogo.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");

// Ensure folder exists
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const LOGO_DIR = path.join(UPLOAD_ROOT, "company-logos");
if (!fs.existsSync(LOGO_DIR)) fs.mkdirSync(LOGO_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGO_DIR),
  filename: (req, file, cb) => {
    const safeBase = (file.originalname || "logo")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/\s+/g, "_");
    const ext = path.extname(safeBase) || ".png";
    const base = path.basename(safeBase, ext);
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const ok = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(file.mimetype);
  cb(ok ? null : new Error("Only PNG, JPG, WEBP, SVG allowed"), ok);
};

const uploadLogo = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
}).single("logo");

module.exports = { uploadLogo, LOGO_DIR };
