const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload");
const { processOCR, processBatchOCR } = require("../controllers/ocrController");

// POST /api/ocr         — single file
router.post("/", upload.single("file"), processOCR);

// POST /api/ocr/batch   — up to 5 files
router.post("/batch", upload.array("files", 5), processBatchOCR);

module.exports = router;
