// routes/integrations.js
const express = require("express");
const jwt = require("jsonwebtoken");
const {getStatus, acceptTerms, connectStart, connectCallback, sendTest, disconnect , sendInvoicePDF} = require("../controllers/integrations/gmailController");

const router = express.Router();

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "Invalid token" }); }
}

// Allow token via query for the start route (opens in a new tab)
function requireAuthAllowQuery(req, res, next) {
  let token = null;
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) token = auth.slice(7);
  if (!token && req.query && req.query.token) token = req.query.token;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "Invalid token" }); }
}

router.get("/gmail/status", requireAuth, getStatus);
router.post("/gmail/accept-terms", requireAuth, acceptTerms);
router.get("/gmail/connect", requireAuthAllowQuery, connectStart);          // start OAuth
router.get("/gmail/callback", connectCallback);                             // OAuth redirect URI
router.post("/gmail/send-test", requireAuth, sendTest);
router.post("/gmail/disconnect", requireAuth, disconnect);
router.post("/gmail/send-invoice", requireAuth, sendInvoicePDF);

module.exports = router;
