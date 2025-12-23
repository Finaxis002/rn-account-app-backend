// routes/permission.routes.js
const express = require("express");
const router = express.Router({ mergeParams: true });

const {
  getClientPermissions,
  upsertClientPermissions,
  patchClientPermissions,
  deleteClientPermissions,
} = require("../controllers/permission.controller");

// If validate is exported as `module.exports = (schema)=>...`
const validate = require("../middleware/validate");
const { putPermissionsSchema, patchPermissionsSchema } = require("../validation/permission.schema");

// Import the correct function name from your auth file
const { authenticateToken } = require("../middleware/auth");  // <-- this is a function
const verifyMasterAdmin = require("../middleware/verifyMasterAdmin");

// 1) Auth must run BEFORE router.param so req.user is available there
router.use(authenticateToken);

// 2) Safely resolve the ":clientId" param, supporting "/my"
router.param("clientId", (req, res, next, id) => {
  if (id === "my") {
    // Your JWT comment says it contains { id, role }.
    // If you don't store clientId in the token, fall back to req.user.id
    const resolved = req.user?.clientId || req.user?.id;
    if (!resolved) return res.status(401).json({ message: "Unauthenticated" });
    req.params.clientId = String(resolved);
  }
  next();
});

// 3) Routes (adjust paths depending on how you mount this router)
// If you do app.use('/api', router) keep '/clients/...'
// If you do app.use('/api/clients', router) change to '/:clientId/permissions'
router.get("/clients/:clientId/permissions", getClientPermissions);

router.put(
  "/clients/:clientId/permissions",
  verifyMasterAdmin,
  validate(putPermissionsSchema),
  upsertClientPermissions
);

router.patch(
  "/clients/:clientId/permissions",
  verifyMasterAdmin,
  validate(patchPermissionsSchema),
  patchClientPermissions
);

router.delete(
  "/clients/:clientId/permissions",
  verifyMasterAdmin,
  deleteClientPermissions
);

module.exports = router;
