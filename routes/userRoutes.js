const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const  verifyClientOrAdmin  = require("../middleware/verifyClientOrAdmin");
const verifyMasterAdmin = require("../middleware/verifyMasterAdmin");
const verifyUser = require("../middleware/verifyUser");

router.post("/", verifyClientOrAdmin, userController.createUser);
router.get("/", verifyClientOrAdmin, userController.getUsers);
router.put("/:id", verifyClientOrAdmin, userController.updateUser);
router.delete("/:id", verifyClientOrAdmin, userController.deleteUser);
router.get("/by-client/:clientId",verifyMasterAdmin, userController.getUsersByClient);

router.post("/:userId/reset-password", verifyClientOrAdmin, userController.resetPassword);

// Example endpoints that only logged-in employees/admins can access:
router.post("/login", userController.loginUser)

module.exports = router;
