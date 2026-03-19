// controllers/integrations/gmailController.js
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const EmailIntegration = require("../../models/EmailIntegration");
const Company = require("../../models/Company");
const User = require("../../models/User");
const MailComposer = require("nodemailer/lib/mail-composer");

// helper: build OAuth client
function buildOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// GET /api/integrations/gmail/status
// GET /api/integrations/gmail/status
exports.getStatus = async (req, res) => {
  try {
    const clientId = req.user.id;

    // include refreshToken because we need to test it
    let doc = await EmailIntegration.findOne({ client: clientId }).lean();

    if (!doc) {
      const created = await EmailIntegration.create({ client: clientId });
      doc = created.toObject();
    }

    // ✅ Proactive health check: if we think we're connected, try to mint an access token now.
    if (doc.connected && doc.refreshToken) {
      const oauth2 = buildOAuthClient();
      oauth2.setCredentials({ refresh_token: doc.refreshToken });
      try {
        const tokenResp = await oauth2.getAccessToken(); // throws on invalid_grant in most cases
        if (!tokenResp || !tokenResp.token) {
          throw new Error("invalid_grant"); // normalize weird cases
        }
      } catch (err) {
        const reason = /invalid_grant|expired|revoked/i.test(err?.message || "")
          ? "token_expired"
          : "unknown";

        await EmailIntegration.updateOne(
          { client: clientId },
          { $set: { connected: false, reason, lastFailureAt: new Date() } }
        );

        // reflect in response
        doc.connected = false;
        doc.reason = reason;
        doc.lastFailureAt = new Date();
      }
    }

  //  console.log('Email Integration Status:', doc); // Add this line for debugging

return res.json({
  connected: !!doc.connected,
  email: doc.email || null,
  termsAcceptedAt: doc.termsAcceptedAt || null,
  reason: doc.reason || null,
  lastFailureAt: doc.lastFailureAt || null,
});

  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/integrations/gmail/accept-terms
exports.acceptTerms = async (req, res) => {
  try {
    const clientId = req.user.id;
    await EmailIntegration.findOneAndUpdate(
      { client: clientId },
      { $set: { termsAcceptedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

exports.connectStart = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { redirect = "/" } = req.query;

    // In dev you can still support mock via env
    if (!process.env.GOOGLE_CLIENT_ID || process.env.MOCK_GMAIL === "1") {
      await EmailIntegration.findOneAndUpdate(
        { client: clientId },
        { $set: { connected: true, email: "connected@example.com" } },
        { upsert: true }
      );
      return res.redirect(redirect);
    }

    const oauth2 = buildOAuthClient();

    // encode state to recover client + post-connect redirect
    const state = jwt.sign(
      { clientId, redirect },
      process.env.JWT_SECRET,
      { expiresIn: "10m" }
    );

    const scopes = [
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.send",
    ];

    const authUrl = oauth2.generateAuthUrl({
      access_type: "offline",                 // get refresh_token
      include_granted_scopes: true,
      prompt: "consent select_account",       // force chooser + ensure refresh_token on re-consent
      scope: scopes,
      state,                                  // pass through to callback
    });

    return res.redirect(authUrl);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/**
 * GET /api/integrations/gmail/callback
 * Handles Google's redirect; exchanges code for tokens; stores email + tokens.
 */
exports.connectCallback = async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code/state");

    // restore state
    let decoded;
    try {
      decoded = jwt.verify(state, process.env.JWT_SECRET);
    } catch {
      return res.status(400).send("Invalid state");
    }
    const { clientId, redirect = "/" } = decoded;

    const oauth2 = buildOAuthClient();
    const { tokens } = await oauth2.getToken(code); // {access_token, refresh_token, scope, expiry_date, id_token, token_type}
    oauth2.setCredentials(tokens);

    // Extract email from ID token (we requested 'openid email')
    let email = null;
    if (tokens.id_token) {
      const ticket = await oauth2.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      email = payload?.email || null;
    }

    if (!email) {
      // Fallback: use Gmail profile (needs gmail.send; we already have it)
      const gmail = google.gmail({ version: "v1", auth: oauth2 });
      const me = await gmail.users.getProfile({ userId: "me" });
      email = me.data.emailAddress || null;
    }

    if (!email) return res.status(400).send("Could not determine Gmail address");

    // We want to persist only refreshToken + email
    const existing = await EmailIntegration.findOne({ client: clientId }).lean();

    const update = {
      provider: "gmail",
      connected: true,
      email,
    };

    // Only set refreshToken if Google sent a new one **OR** we don't have one yet
    if (tokens.refresh_token) {
      update.refreshToken = tokens.refresh_token;
    } else if (!existing?.refreshToken) {
      // Sometimes Google doesn't send refresh_token on re-consent.
      // If we don't already have one, ask user to fully re-connect:
      // (tell them to remove app access in Google Account -> Security -> Third-party access)
      return res.status(400).send("No refresh token received. Please remove app access from your Google Account and reconnect.");
    }

    // Persist
    await EmailIntegration.findOneAndUpdate(
      { client: clientId },
      {
        $set: {
          provider: "gmail",
          connected: true,
          email,
          refreshToken: tokens.refresh_token || existing?.refreshToken || null,
          // clear diagnostics
          reason: null,
          lastFailureAt: null,
        },
      },
      { upsert: true }
    );


    // Back to app
    const url = new URL(redirect, "http://dummy");
    const search = url.search ? url.search + "&" : "?";
    return res.redirect(redirect + search + "gmail=connected&email=" + encodeURIComponent(email));
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth callback error: " + e.message);
  }
};

/**
 * Utility: send email via the client's Gmail using refresh_token.
 * Use this from your Sales/Purchase flows.
 */
/**
 * Utility: send email via the client's Gmail using refresh_token only.
 */
async function assertSenderHasGmail(clientId) {
  const integ = await EmailIntegration.findOne({
    client: clientId,
    provider: "gmail",
    connected: true,
  })
    .select("+refreshToken email")
    .lean();

  if (!integ || !integ.refreshToken || !integ.email) {
    const err = new Error(
      "Gmail is not connected for the company sender. Please connect Gmail in settings."
    );
    err.statusCode = 400;
    throw err;
  }
  return { senderEmail: integ.email, refreshToken: integ.refreshToken };
}


async function sendWithClientGmail({
  clientId,
  refreshToken,
  senderEmail,     // ✅ new
  fromName,
  to,
  subject,
  html,
  attachments = [],
}) {
  // Ensure we have both refresh token and sender email.
  let rt = refreshToken;
  let email = senderEmail;

  if (!rt || !email) {
    const integ = await EmailIntegration.findOne({
      client: clientId, provider: "gmail", connected: true,
    }).select("+refreshToken email").lean();

    if (!integ?.refreshToken || !integ?.email) {
      throw new Error("Client has not connected Gmail or refresh token/email missing");
    }
    rt = rt || integ.refreshToken;
    email = email || integ.email;
  }

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials({ refresh_token: rt });

  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  // ✅ build explicit From header
  const fromHeader = fromName ? `${fromName} <${email}>` : email;

  const mail = new MailComposer({
    from: fromHeader,
    to,
    subject,
    html,
    attachments,
  }).compile();

  const raw = (await mail.build())
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  } catch (err) {
    const isAuthErr =
      err?.code === 401 ||
      /invalid_grant|unauthorized|not authorized|permission|expired|revoked/i.test(err?.message || "");
    if (isAuthErr) {
      await EmailIntegration.updateOne(
        { client: clientId },
        { $set: { connected: false, refreshToken: null, reason: "revoked", lastFailureAt: new Date() } }
      );
      throw new Error("Gmail access was revoked/expired. Please reconnect Gmail.");
    }
    throw err;
  }
}




// POST /api/integrations/gmail/send-invoice
exports.sendInvoicePDF = async (req, res) => {
  try {
    const {
      to,
      subject,
      message,
      html,
      fileName,
      pdfBase64,
      companyId,                 // optional but recommended
    } = req.body || {};

    if (!to || !pdfBase64) {
      return res.status(400).json({ message: "Missing 'to' or 'pdfBase64'." });
    }

    // Determine which Client (owner) to send as.
    let senderClientId = null;
    let companyDoc = null;
    // 1) Prefer the company owner if companyId provided and owner exists
    if (companyId) {
      const company = await Company.findById(companyId).select("businessName owner").lean();
      if (!company) return res.status(404).json({ message: "Company not found." });
      if (company.owner) senderClientId = company.owner;
    }

    if (companyId) {
      companyDoc = await Company.findById(companyId).select("businessName owner").lean(); // <-- assign here
      if (!companyDoc) return res.status(404).json({ message: "Company not found." });
      if (companyDoc.owner) senderClientId = companyDoc.owner;
    }

    // 2) Else use the user's creator client (User.createdByClient)
    if (!senderClientId) {
      const actorUserId = req.user?.id;
      if (actorUserId) {
        const actor = await User.findById(actorUserId).select("createdByClient").lean();
        if (actor?.createdByClient) senderClientId = actor.createdByClient;
      }
    }

    // 3) Fallback (legacy) to req.user.id (if your auth sometimes sets it to Client id)
    if (!senderClientId) senderClientId = req.user?.id;

    if (!senderClientId) {
      return res.status(400).json({
        message:
          "No email sender configured for this request. Ensure the Company has an owner or the user has createdByClient.",
      });
    }

    // Ensure the chosen sender has Gmail connected
    const { senderEmail, refreshToken } = await assertSenderHasGmail(senderClientId);

    const htmlBody =
      typeof html === "string" && html.trim()
        ? html
        : `<pre style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;white-space:pre-wrap;">${message || ""}</pre>`;


    // Send the email using the sender’s Gmail
    await sendWithClientGmail({
      clientId: senderClientId,
      refreshToken,
      senderEmail,
      fromName: companyDoc?.businessName || undefined,
      to,
      subject: subject || "Invoice",
      html: htmlBody,                          // ✅ use the template
      attachments: [
        {
          filename: fileName || "invoice.pdf",
          content: Buffer.from(pdfBase64, "base64"),
          contentType: "application/pdf",
        },
      ],
    });

    return res.json({ ok: true, sentFrom: senderEmail });
  } catch (e) {
    const code = e.statusCode || e.code;
    return res.status(code === 400 ? 400 : 500).json({ message: e.message || "Failed to send invoice email." });
  }
};



// Example endpoint: POST /api/integrations/gmail/send-test { to }
exports.sendTest = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { to } = req.body;
    await sendWithClientGmail({
      clientId,
      fromName: "Your Company",
      to,
      subject: "Test email from your connected Gmail",
      html: "<p>Success! Your integration works.</p>",
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};



// POST /api/integrations/gmail/disconnect
exports.disconnect = async (req, res) => {
  try {
    const clientId = req.user.id;
    const integ = await EmailIntegration.findOne({ client: clientId });
    if (!integ) return res.json({ ok: true });

    // Optional: revoke on Google side (if you want)
    // await fetch('https://oauth2.googleapis.com/revoke?token=' + integ.refreshToken, { method: 'POST', headers: {'Content-type': 'application/x-www-form-urlencoded'} });

    await EmailIntegration.updateOne(
      { client: clientId },
      { $set: { connected: false, refreshToken: null } }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Export for reuse in your invoice flows
exports._internal = { sendWithClientGmail };
