const express = require("express");
const router = express.Router();
const { verifyOtp, requestUserOtp } = require("../controllers/authController");

// POST /api/auth/verify-otp
router.post("/verify-otp", verifyOtp);

// Optional: request otp for user (not implemented)
router.post("/request-user-otp", requestUserOtp);

module.exports = router;
