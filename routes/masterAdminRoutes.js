const express = require("express");
const router = express.Router();
const {
  registerMasterAdmin,
  loginMasterAdmin,
  getMasterAdminProfile
} = require("../controllers/masterAdminController");

const { authenticateToken } = require("../middleware/auth");

// For initial setup only
router.post("/register", registerMasterAdmin);

// Login with username/password
router.post("/login", loginMasterAdmin);


router.get("/profile", authenticateToken, getMasterAdminProfile);

module.exports = router;
