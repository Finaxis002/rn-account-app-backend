const express = require("express");
const router = express.Router();

const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const additionalServiceController = require("../controllers/additionalServiceController");

router.post("/", verifyClientOrAdmin, additionalServiceController.createAdditionalService);
router.get("/", verifyClientOrAdmin, additionalServiceController.getAdditionalServices);
router.get("/:id", verifyClientOrAdmin, additionalServiceController.getAdditionalServiceById);
router.put("/:id", verifyClientOrAdmin, additionalServiceController.updateAdditionalService);
router.delete("/:id", verifyClientOrAdmin, additionalServiceController.deleteAdditionalService);

module.exports = router;

