const {
  extractTextFromImage,
  extractStructuredData,
} = require("../services/googleVisionService");
const {
  processPDF,
  processImage,
  processExcel,
} = require("../utils/fileProcessor"); // ← processImage added
const { mapToTransactionForm, mapToPartyForm } = require("../utils/dataMapper");

/**
 * Core OCR logic — extracted so batch route can reuse it
 */
async function runOCR(file, type = "transaction", transactionType = "sales") {
  const { buffer: fileBuffer, mimetype: mimeType, size, originalname } = file;

  if (mimeType.startsWith("image/") && size > 10 * 1024 * 1024) {
    return {
      success: false,
      error: "Image size exceeds 10MB limit.",
      status: 400,
    };
  }

  let extractedText = "";
  try {
    if (mimeType.startsWith("image/")) {
      extractedText = await processImage(fileBuffer);
    } else if (mimeType === "application/pdf") {
      extractedText = await processPDF(fileBuffer);
    } else if (
      mimeType.includes("spreadsheet") ||
      mimeType.includes("excel") ||
      mimeType === "application/vnd.ms-excel"
    ) {
      extractedText = processExcel(fileBuffer);
    } else {
      return { success: false, error: "Unsupported file type.", status: 400 };
    }
  } catch (err) {
    console.error(`[runOCR] Extraction error:`, err.message);
    return {
      success: false,
      error: err.message || "Failed to process file.",
      status: 500,
    };
  }

  if (!extractedText || !extractedText.trim()) {
    return {
      success: false,
      error: "No text could be extracted from the file.",
      status: 400,
    };
  }

  const structuredData = await extractStructuredData(extractedText);

  const mappedData =
    type === "party"
      ? mapToPartyForm(structuredData)
      : mapToTransactionForm(structuredData, transactionType);

  return {
    success: true,
    status: 200,
    data: mappedData,
    rawText: extractedText,
    structuredData,
  };
}

async function processOCR(req, res) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file uploaded." });
    }
    const { type = "transaction", transactionType = "sales" } = req.body;
    const result = await runOCR(req.file, type, transactionType);
    return res.status(result.status ?? 200).json(result);
  } catch (error) {
    console.error("OCR Processing Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to process file.",
    });
  }
}

async function processBatchOCR(req, res) {
  try {
    if (!req.files || req.files.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "No files uploaded." });
    }
    if (req.files.length > 5) {
      return res.status(400).json({
        success: false,
        error: "Batch limit exceeded. Max 5 files allowed.",
      });
    }
    const { type = "transaction", transactionType = "sales" } = req.body;
    const results = await Promise.all(
      req.files.map(async (file) => {
        const result = await runOCR(file, type, transactionType);
        return { ...result, fileName: file.originalname };
      }),
    );
    return res.json({ success: true, results });
  } catch (error) {
    console.error("Batch OCR Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Batch processing failed.",
    });
  }
}

module.exports = { processOCR, processBatchOCR };
