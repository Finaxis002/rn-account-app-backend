// utils/fileProcessor.js
const XLSX = require("xlsx");
const pdfParse = require("pdf-parse");

/**
 * Extract PDF text using pdf-parse (best for text-based PDFs, free)
 */
async function extractTextFromPDFTextLayer(fileBuffer) {
  const data = await pdfParse(fileBuffer);
  return (data.text || "").trim();
}

/**
 * Extract text from scanned PDF by converting pages to images and using Vision OCR.
 * NOTE: This uses Google Vision (you already have it). Keep as fallback only.
 */
async function extractTextFromScannedPDF(fileBuffer) {
  const pdfImg = require("pdf-img-convert");
  const { extractTextFromImage } = require("../services/googleVisionService");

  const imgBuffers = await pdfImg.convert(fileBuffer, {
    base64: false,
    scale: 2.0, // increase for better OCR
  });

  if (!imgBuffers || imgBuffers.length === 0) return "";

  const pageTexts = await Promise.all(
    imgBuffers.map(async (imgData, i) => {
      try {
        const buf = Buffer.isBuffer(imgData) ? imgData : Buffer.from(imgData);
        const text = await extractTextFromImage(buf);
        return text || "";
      } catch (err) {
        console.error(`Vision OCR failed for page ${i + 1}:`, err.message);
        return "";
      }
    }),
  );

  return pageTexts.join("\n").trim();
}

/**
 * Process PDF file and extract text with fallback.
 * 1) pdf-parse first
 * 2) if text is too low -> scanned -> Vision fallback
 */
async function processPDF(fileBuffer) {
  // 1) Try pdf-parse first (FAST + FREE)
  let text = "";
  try {
    text = await extractTextFromPDFTextLayer(fileBuffer);
  } catch (e) {
    console.warn(
      "[processPDF] pdf-parse failed, will try OCR fallback:",
      e.message,
    );
    text = "";
  }

  // 2) Fallback if very little text (likely scanned PDF)
  if (!text || text.length < 80) {
    console.warn(
      `[processPDF] Low text (${text?.length || 0} chars). Running Vision OCR fallback...`,
    );
    try {
      const ocrText = await extractTextFromScannedPDF(fileBuffer);

      if (ocrText && ocrText.length > text.length) text = ocrText;
    } catch (e) {
      console.warn("[processPDF] OCR fallback failed:", e.message);
    }
  }

  if (!text || text.trim().length < 10) {
    throw new Error(
      "Could not extract text from PDF. Please ensure the file is not corrupted.",
    );
  }

  return text;
}

/**
 * Process image file (JPG, PNG, WebP) using Google Vision.
 */
async function processImage(fileBuffer) {
  const { extractTextFromImage } = require("../services/googleVisionService");
  const text = await extractTextFromImage(fileBuffer);
  if (!text || text.trim().length < 10) {
    throw new Error("No meaningful text found in image.");
  }
  return text;
}

/**
 * Process Excel / CSV file using xlsx library.
 */
function processExcel(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: "buffer" });
  let extractedText = "";

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
    });

    jsonData.forEach((row) => {
      if (Array.isArray(row)) {
        const rowText = row
          .map((cell) =>
            cell !== null && cell !== undefined ? String(cell).trim() : "",
          )
          .filter(Boolean)
          .join("\t");
        if (rowText) extractedText += rowText + "\n";
      }
    });
  });

  if (!extractedText.trim()) {
    throw new Error("Excel file appears to be empty.");
  }

  return extractedText;
}

module.exports = { processPDF, processImage, processExcel };
