// routes/bankDetailRoutes.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/bankDetailController");
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const multer = require("multer");

// Set up multer storage for QR code file handling
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/qr-codes/'); // Directory to save QR code images
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'qr-' + uniqueSuffix + '.' + file.originalname.split('.').pop());
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed for QR code'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Use your real auth middlewares here
// Example placeholders:
// const { requireAuth } = require("../middleware/auth");
// router.use(requireAuth);

router.post("/", verifyClientOrAdmin, upload.single('qrCode'), ctrl.createBankDetail);
router.get("/", verifyClientOrAdmin, ctrl.getBankDetails);
router.get("/:id", verifyClientOrAdmin, ctrl.getBankDetailById);
router.put("/:id", verifyClientOrAdmin, upload.single('qrCode'), ctrl.updateBankDetail);
router.delete("/:id", verifyClientOrAdmin, ctrl.deleteBankDetail);
router.get("/options", verifyClientOrAdmin, ctrl.listBanksForCompany);

module.exports = router;
