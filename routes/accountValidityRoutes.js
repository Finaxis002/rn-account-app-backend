// routes/accountValidityRoutes.js
const express = require("express");
const router = express.Router();
const verifyMasterAdmin = require("../middleware/verifyMasterAdmin");
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin")
const { setValidity, getValidity, disableValidity, updateValidityPartial, getMyValidity} = require("../controllers/accountValidityController");

router.put("/:clientId/validity", verifyMasterAdmin, setValidity);      // create/update
router.get("/me/validity", verifyClientOrAdmin, getMyValidity);
router.get("/:clientId/validity", verifyMasterAdmin, getValidity);      // read
router.patch("/:clientId/validity", verifyMasterAdmin, updateValidityPartial); 
router.patch("/:clientId/validity/disable", verifyMasterAdmin, disableValidity);


module.exports = router;
