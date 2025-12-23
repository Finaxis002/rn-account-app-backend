const Client = require("../models/Client");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const slugifyUsername = require("../utils/slugify");
const Permission = require("../models/Permission");
const AccountValidity = require("../models/AccountValidity");
const { randomInt } = require("crypto");
const {
  myCache,
  key,
  invalidateClientsForMaster,
  invalidateClient,
} = require("../cache");
const axios = require("axios");

// Create Client (Only Master Admin)
// controllers/clientController.js

function addToDate(d, amount, unit) {
  const date = new Date(d);
  if (unit === "days") date.setDate(date.getDate() + Number(amount || 0));
  if (unit === "months") date.setMonth(date.getMonth() + Number(amount || 0));
  if (unit === "years")
    date.setFullYear(date.getFullYear() + Number(amount || 0));
  return date;
}

// configurable, with safe defaults
const OTP_TTL_MIN = Number(process.env.OTP_TTL_MIN ?? 5);
const OTP_RESEND_SECONDS = Number(process.env.OTP_RESEND_SECONDS ?? 45);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS ?? 5);

// 6-digit numeric OTP using crypto (better than Math.random)
function generateOtp(digits = 6) {
  const min = 10 ** (digits - 1);
  const max = 10 ** digits;
  return String(randomInt(min, max));
}

exports.createClient = async (req, res) => {
  try {
    const {
      clientUsername,
      password,
      contactName,
      phone,
      email,
      maxCompanies = 5,
      maxUsers = 10,
      canSendInvoiceEmail = false,
      canSendInvoiceWhatsapp = false,
      canCreateCompanies = false,
      canUpdateCompanies = false,
      validity,
    } = req.body;

    // 1) Normalize + validate BEFORE any session/transaction
    const slug = slugifyUsername(clientUsername);
    const normalizedUsername = String(clientUsername || "")
      .trim()
      .toLowerCase();
    if (!slug || !normalizedUsername) {
      return res.status(400).json({ message: "Invalid username/slug" });
    }

    // 2) Duplicate checks OUTSIDE a transaction (no session here)
    const [existingUsername, existingSlug, existingEmail, existingPhone] =
      await Promise.all([
        Client.findOne({ clientUsername: normalizedUsername }).lean(),
        Client.findOne({ slug }).lean(),
        Client.findOne({ email }).lean(),
        Client.findOne({ phone }).lean(),
      ]);
    if (existingUsername)
      return res.status(409).json({ message: "Username already exists" });
    if (existingSlug)
      return res.status(409).json({ message: "Slug already exists" });
    if (existingPhone)
      return res.status(409).json({ message: "Phone already exists" });
    if (existingEmail)
      return res.status(409).json({ message: "Email already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);

    // 3) Start a session ONLY for the writes
    const session = await Client.startSession();
    try {
      session.startTransaction();

      const [createdClient] = await Client.create(
        [
          {
            clientUsername: normalizedUsername,
            slug,
            password: hashedPassword,
            contactName,
            phone,
            email,
            maxCompanies,
            maxUsers,
            canSendInvoiceEmail,
            canSendInvoiceWhatsapp,
            role: "client",
            masterAdmin: req.user.id,
          },
        ],
        { session }
      );

      await Permission.findOneAndUpdate(
        { client: createdClient._id },
        {
          $setOnInsert: {
            client: createdClient._id,
            maxCompanies,
            maxUsers,
            canSendInvoiceEmail,
            canSendInvoiceWhatsapp,
            canCreateCompanies,
            canUpdateCompanies,
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
          runValidators: true,
          session,
        }
      );

      // >>> NEW: create validity in the same txn
      const amount = Number(validity?.amount ?? 30);
      const unit = String(validity?.unit ?? "days"); // "days" | "months" | "years"
      const now = new Date();
      const expiresAt = addToDate(now, amount, unit);

      await AccountValidity.create(
        [
          {
            client: createdClient._id,
            startsAt: now,
            expiresAt,
            isDisabled: false,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      // CACHE: invalidate the list for this master
      invalidateClientsForMaster(req.user.id);
      return res.status(201).json({
        message: "Client created successfully",
        client: createdClient,
      });
    } catch (err) {
      await session.abortTransaction();
      return res.status(500).json({ error: err.message });
    } finally {
      session.endSession(); // end exactly once
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Get All Clients (Only Master Admin)
// Get All Clients (Only Master Admin)
exports.getClients = async (req, res) => {
  try {
    const cacheKey = key.clientsList(req.user.id);

    const cached = myCache.get(cacheKey);
    if (cached) {
      // ✅ add these 2 lines
      res.set("X-Cache", "HIT");
      res.set("X-Cache-Key", cacheKey);

      return res.status(200).json(cached);
    }

    const clients = await Client.find({ masterAdmin: req.user.id }).select(
      "-password"
    );

    myCache.set(cacheKey, clients);

    // ✅ add these 2 lines
    res.set("X-Cache", "MISS");
    res.set("X-Cache-Key", cacheKey);

    return res.status(200).json(clients);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Client Login
exports.loginClient = async (req, res) => {
  try {
    console.log("🔍 loginClient called");
    console.log("Headers:", req.headers);
    console.log("Params:", req.params);
    console.log("Body:", req.body);

    const { clientUsername, password } = req.body;

    // Validate input
    if (!clientUsername || !password) {
      return res
        .status(400)
        .json({ message: "Client username and password are required" });
    }

    const normalizedUsername = String(clientUsername).trim().toLowerCase();
    const client = await Client.findOne({ clientUsername: normalizedUsername });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // 🔒 Account validity gate
    const validity = await AccountValidity.findOne({ client: client._id });
    if (!validity) {
      return res
        .status(403)
        .json({ message: "Account validity not set. Contact support." });
    }
    if (validity.status === "disabled") {
      return res
        .status(403)
        .json({ message: "Account disabled. Contact support." });
    }
    if (new Date() >= new Date(validity.expiresAt)) {
      // (optional) mark as expired asynchronously
      AccountValidity.updateOne(
        { _id: validity._id },
        { $set: { status: "expired" } }
      ).catch(() => {});
      return res
        .status(403)
        .json({ message: "Account validity expired. Contact support." });
    }

    // Password check
    const isMatch = await bcrypt.compare(password, client.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid password" });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: client._id, role: "client", slug: client.slug },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.status(200).json({
      message: "Login successful",
      token,
      client: {
        id: client._id,
        clientUsername: client.clientUsername,
        slug: client.slug,
        contactName: client.contactName,
        email: client.email,
        phone: client.phone,
        role: client.role,
      },
    });
  } catch (err) {
    console.error("LoginClient error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Update Client (Only Master Admin)
exports.updateClient = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      contactName,
      email,
      phone,
      maxCompanies,
      maxUsers,
      canSendInvoiceEmail,
      canSendInvoiceWhatsapp,
    } = req.body;

    const client = await Client.findOne({ _id: id, masterAdmin: req.user.id });
    if (!client) return res.status(404).json({ message: "Client not found" });

    // Check duplicates
    if (email && email !== client.email) {
      const existingEmail = await Client.findOne({ email });
      if (existingEmail)
        return res.status(400).json({ message: "Email already exists" });
      client.email = email;
    }

    if (phone && phone !== client.phone) {
      const existingPhone = await Client.findOne({ phone });
      if (existingPhone)
        return res.status(400).json({ message: "Phone already exists" });
      client.phone = phone;
    }

    if (contactName) client.contactName = contactName;
    if (typeof maxCompanies === "number") client.maxCompanies = maxCompanies;
    if (typeof maxUsers === "number") client.maxUsers = maxUsers;
    if (typeof canSendInvoiceEmail === "boolean")
      client.canSendInvoiceEmail = canSendInvoiceEmail;
    if (typeof canSendInvoiceWhatsapp === "boolean")
      client.canSendInvoiceWhatsapp = canSendInvoiceWhatsapp;

    await client.save();
    invalidateClient(req.user.id, client._id);
    res.status(200).json({ message: "Client updated successfully", client });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Delete Client (Only Master Admin)
exports.deleteClient = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if client belongs to the logged-in master admin
    const client = await Client.findOne({ _id: id, masterAdmin: req.user.id });
    if (!client) {
      return res
        .status(404)
        .json({ message: "Client not found or unauthorized" });
    }

    await Client.deleteOne({ _id: id });
    // CACHE: invalidate both this single client + the list
    invalidateClient(req.user.id, id);

    res.status(200).json({ message: "Client deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Reset Client Password (Only Master Admin or Client Themselves)
exports.resetPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newpassword } = req.body;
    if (!newpassword) {
      return res.status(400).json({ message: "New Password is required" });
    }
    if (req.user.role !== "master") {
      return res
        .status(403)
        .json({ message: "Only master admin can reset password" });
    }
    // Find the client under this master admin
    const client = await Client.findById(id);
    if (!client) {
      return res.status(404).json({ message: "client not found" });
    }
    // Hash and update password
    const hashedPassword = await bcrypt.hash(newpassword, 10);
    client.password = hashedPassword;

    client.save();
    res.status(200).json({ message: "Password reset successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get Single Client by ID (Master Admin or Client themselves)
exports.getClientById = async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = key.client(req.user.id, id);

    // 1) Try cache
    const cached = myCache.get(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    // 2) Fallback to DB
    let query;
    if (req.user.role === "client") {
      // Clients can only fetch their own data
      query = { _id: id, _id: req.user.id };
    } else {
      // Master admins can fetch clients they created
      query = { _id: id, masterAdmin: req.user.id };
    }

    const client = await Client.findOne(query).select("-password");
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    // 3) Cache it
    myCache.set(cacheKey, client);
    res.status(200).json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PUT /api/clients/:clientId/user-limit
exports.setUserLimit = async (req, res) => {
  const { clientId } = req.params;
  const { userLimit } = req.body;

  try {
    const client = await Client.findByIdAndUpdate(
      clientId,
      { userLimit },
      { new: true }
    );
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    invalidateClient(req.user.id, client._id);
    res.json({ message: "User limit updated", client });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// GET /api/clients/check-username?username=...&excludeId=...&base=...
exports.checkUsername = async (req, res) => {
  try {
    let { username = "", excludeId = "", base = "" } = req.query;
    username = String(username).trim().toLowerCase();
    base = String(base).trim();

    const normalized = slugifyUsername(username);
    if (!normalized) {
      return res
        .status(400)
        .json({ ok: false, available: false, reason: "invalid_username" });
    }

    const query = excludeId
      ? { clientUsername: normalized, _id: { $ne: excludeId } }
      : { clientUsername: normalized };

    const exists = await Client.exists(query);

    // Build suggestions (server side) based on `base` (contactName) or `username`
    const suggestions = await suggestUsernames(
      base || username,
      excludeId,
      normalized
    );

    // Optional: no caching
    res.set("Cache-Control", "no-store");

    return res.json({
      ok: true,
      username: normalized,
      available: !exists,
      suggestions, // array of up to ~6
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};

// --- helpers ---

function baseHandle(s) {
  return (
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 20) || "user"
  );
}

async function suggestUsernames(seed, excludeId, alreadyTried) {
  const core = baseHandle(seed);
  const year = new Date().getFullYear().toString();
  const seeds = [
    core,
    `${core}1`,
    `${core}123`,
    `${core}${year.slice(-2)}`,
    `${core}${year}`,
    `${core}_official`,
    `${core}_hq`,
    `real${core}`,
    `${core}_co`,
    `${core}_app`,
    `${core}_${Math.floor(Math.random() * 90 + 10)}`, // 2-digit random
  ];

  // Normalize & unique
  const candidates = Array.from(
    new Set(
      seeds.map((s) =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9_\.]/g, "")
          .slice(0, 24)
      )
    )
  ).filter(Boolean);

  // Remove the username that the user already tried
  const toCheck = candidates.filter((c) => c !== alreadyTried);

  // Check which candidates are free
  const taken = await Client.find(
    excludeId
      ? { clientUsername: { $in: toCheck }, _id: { $ne: excludeId } }
      : { clientUsername: { $in: toCheck } }
  )
    .select("clientUsername")
    .lean();

  const takenSet = new Set(taken.map((t) => t.clientUsername));
  const available = toCheck.filter((c) => !takenSet.has(c));

  return available.slice(0, 6);
}

// --- Request OTP: POST /api/clients/request-otp ---
exports.requestClientOtp = async (req, res) => {
  try {
    const { clientUsername } = req.body;

    if (!clientUsername)
      return res.status(400).json({ message: "clientUsername required" });

    const normalizedUsername = String(clientUsername).trim().toLowerCase();
    const client = await Client.findOne({
      clientUsername: normalizedUsername,
    });
    if (!client) return res.status(404).json({ message: "Client not found" });

    // 🔒 validity gate (same as login)
    const validity = await AccountValidity.findOne({ client: client._id });
    if (!validity)
      return res
        .status(403)
        .json({ message: "Account validity not set. Contact support." });
    if (validity.status === "disabled")
      return res
        .status(403)
        .json({ message: "Account disabled. Contact support." });
    if (new Date() >= new Date(validity.expiresAt)) {
      AccountValidity.updateOne(
        { _id: validity._id },
        { $set: { status: "expired" } }
      ).catch(() => {});
      return res
        .status(403)
        .json({ message: "Account validity expired. Contact support." });
    }

    // throttle resend
    if (
      client.otpLastSentAt &&
      Date.now() - client.otpLastSentAt.getTime() < OTP_RESEND_SECONDS * 1000
    ) {
      const wait = Math.ceil(
        (OTP_RESEND_SECONDS * 1000 -
          (Date.now() - client.otpLastSentAt.getTime())) /
          1000
      );
      return res.status(429).json({
        message: `Please wait ${wait}s before requesting another OTP.`,
      });
    }

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    client.otpHash = otpHash;
    client.otpExpiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
    client.otpAttempts = 0;
    client.otpLastSentAt = new Date();
    await client.save();

    // email OTP
    const transporter = nodemailer.createTransport({
      service: "gmail", // or: host: "smtp.gmail.com", port: 465, secure: true
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER || process.env.MAIL_FROM,
      to: client.email,
      subject: "Your Vinimay Login OTP",
      text: `Your OTP is ${otp}. It expires in ${OTP_TTL_MIN} minutes.`,
      html: `<p>Your OTP is <b>${otp}</b>. It expires in ${OTP_TTL_MIN} minutes.</p>`,
    });

    return res.json({ message: "OTP sent to registered email" });
  } catch (err) {
    console.error("requestClientOtp error:", err);
    return res.status(500).json({ message: "Failed to send OTP" });
  }
};

// --- Login with OTP: POST /api/clients/login-otp ---
exports.loginClientWithOtp = async (req, res) => {
  try {
    const { clientUsername, otp, captchaToken } = req.body;

    // Verify reCAPTCHA
    if (!captchaToken) {
      return res
        .status(400)
        .json({ message: "reCAPTCHA verification required" });
    }

    const recaptchaResponse = await axios.post(
      `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${captchaToken}`
    );

    if (!recaptchaResponse.data.success) {
      return res.status(400).json({ message: "reCAPTCHA verification failed" });
    }

    if (!clientUsername || !otp) {
      return res
        .status(400)
        .json({ message: "clientUsername and otp are required" });
    }

    const normalizedUsername = String(clientUsername).trim().toLowerCase();
    const client = await Client.findOne({
      clientUsername: normalizedUsername,
    });
    if (!client) return res.status(404).json({ message: "Client not found" });

    // 🔒 validity gate (same as login)
    const validity = await AccountValidity.findOne({ client: client._id });
    if (!validity)
      return res
        .status(403)
        .json({ message: "Account validity not set. Contact support." });
    if (validity.status === "disabled")
      return res
        .status(403)
        .json({ message: "Account disabled. Contact support." });
    if (new Date() >= new Date(validity.expiresAt)) {
      AccountValidity.updateOne(
        { _id: validity._id },
        { $set: { status: "expired" } }
      ).catch(() => {});
      return res
        .status(403)
        .json({ message: "Account validity expired. Contact support." });
    }

    // verify OTP
    if (!client.otpHash || !client.otpExpiresAt) {
      return res
        .status(400)
        .json({ message: "No OTP in progress. Please request a new OTP." });
    }
    if (client.otpAttempts >= OTP_MAX_ATTEMPTS) {
      return res
        .status(429)
        .json({ message: "Too many attempts. Request a new OTP." });
    }
    if (client.otpExpiresAt.getTime() < Date.now()) {
      client.otpHash = null;
      client.otpExpiresAt = null;
      client.otpAttempts = 0;
      await client.save();
      return res
        .status(400)
        .json({ message: "OTP expired. Request a new OTP." });
    }

    const ok = await bcrypt.compare(String(otp), client.otpHash);
    client.otpAttempts += 1;

    if (!ok) {
      await client.save();
      return res.status(401).json({ message: "Invalid OTP" });
    }

    // success → clear otp fields
    client.otpHash = null;
    client.otpExpiresAt = null;
    client.otpAttempts = 0;
    await client.save();

    // **IMPORTANT**: return the SAME shape as password login
    const token = jwt.sign(
      { id: client._id, role: "client", slug: client.slug },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      client: {
        id: client._id,
        clientUsername: client.clientUsername,
        slug: client.slug,
        contactName: client.contactName,
        email: client.email,
        phone: client.phone,
        role: client.role, // stays "client" like your existing login
      },
    });
  } catch (err) {
    console.error("loginClientWithOtp error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
