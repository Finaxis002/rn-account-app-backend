const express = require("express");
const router = express.Router();
const { createClient, getClients, loginClient, updateClient, deleteClient, resetPassword , getClientById, setUserLimit , checkUsername,
  requestClientOtp, loginClientWithOtp
} = require("../controllers/clientController");
const verifyMasterAdmin = require("../middleware/verifyMasterAdmin");
const verifyClient = require("../middleware/verifyClient")
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin")
const rateLimit = require("express-rate-limit");
const usernameCheckLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 checks/min/IP
  standardHeaders: true,
  legacyHeaders: false,
});


// OTP throttles (tune as needed)
const otpRequestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,              // 5 OTP requests/min/IP
  standardHeaders: true,
  legacyHeaders: false,
});
const otpVerifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,             // 15 verifications/min/IP
  standardHeaders: true,
  legacyHeaders: false,
});


//client login
// PUBLIC: no middleware here
//password login
router.post("/login", loginClient);

// ✅  PUBLIC OTP endpoints (do not require middleware)
router.post("/request-otp", otpRequestLimiter, requestClientOtp);
router.post("/login-otp", otpVerifyLimiter, loginClientWithOtp);
router.get("/check-username", usernameCheckLimiter, checkUsername);

// Create a client
router.post("/", verifyMasterAdmin, createClient);

// Get all clients created by logged-in master admin
router.get("/", verifyMasterAdmin, getClients);

// PATCH /api/clients/:id
router.patch("/:id", verifyMasterAdmin, updateClient);

// DELETE /api/clients/:id
router.delete("/:id", verifyMasterAdmin, deleteClient);


router.put("/reset-password/:id", verifyMasterAdmin, resetPassword);


// Get company by ID (client or master)
router.get("/:id", verifyClientOrAdmin, getClientById);

//PUT set user limit

router.put("/:clientId/user-limit",verifyMasterAdmin, setUserLimit)






// router.post('/login-debug', loginClient);
module.exports = router;
