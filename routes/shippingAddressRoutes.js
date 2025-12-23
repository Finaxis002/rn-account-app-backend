const express = require("express");
const router = express.Router();
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const shippingAddressController = require("../controllers/shippingAddressController");

// Create shipping address
router.post("/", verifyClientOrAdmin, shippingAddressController.createShippingAddress);

// Get shipping addresses for a party
router.get("/party/:partyId", verifyClientOrAdmin, shippingAddressController.getShippingAddresses);

// Update shipping address
router.put("/:id", verifyClientOrAdmin, shippingAddressController.updateShippingAddress);

// Delete shipping address
router.delete("/:id", verifyClientOrAdmin, shippingAddressController.deleteShippingAddress);

module.exports = router;