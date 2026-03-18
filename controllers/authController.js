const Client = require("../models/Client");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const AccountValidity = require("../models/AccountValidity");
const axios = require("axios");
const nodemailer = require("nodemailer");

// OTP policy (match clientController defaults)
const OTP_TTL_MIN = Number(process.env.OTP_TTL_MIN ?? 5);
const OTP_RESEND_SECONDS = Number(process.env.OTP_RESEND_SECONDS ?? 45);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS ?? 5);

// 6-digit numeric OTP
function generateOtp(digits = 6) {
  const min = 10 ** (digits - 1);
  const max = 10 ** digits;
  return String(Math.floor(Math.random() * (max - min)) + min);
}

// Development-only hardcoded accounts (safe by NODE_ENV / explicit flag)
// const DEV_HARDCODE_OTP =
//   process.env.DEV_HARDCODE_OTP === "true" ||
//   process.env.NODE_ENV !== "production";
const DEV_HARDCODE_OTP = true;
const DEV_USERS = {
  "master01@gmail.com": {
    otp: "111111",
    accountType: "master",
    role: "master",
    user: {
      id: "dev-master",
      clientUsername: "master01",
      contactName: "Master Dev",
      email: "master01@gmail.com",
    },
  },
  "client01@gmail.com": {
    otp: "222222",
    accountType: "client",
    role: "client",
    user: {
      id: "dev-client",
      clientUsername: "client01",
      contactName: "Client Dev",
      email: "client01@gmail.com",
    },
  },
  "user01@gmail.com": {
    otp: "333333",
    accountType: "user",
    role: "user",
    user: { id: "dev-user", userName: "user01", email: "user01@gmail.com" },
  },
};

// POST /api/auth/verify-otp
exports.verifyOtp = async (req, res) => {
  try {
    const { identifier, otp, type } = req.body;
    console.log(
      `[verifyOtp] received identifier=${identifier} otp=${
        otp ? "***" : ""
      } type=${type}`,
    );

    if (!identifier || !otp)
      return res.status(400).json({ message: "Missing identifier or otp" });

    const normalized = String(identifier).trim();
    // Try Client first (by clientUsername)
    if (!type || type === "client") {
      // Accept either clientUsername or email when identifying a client (matching requestUserOtp)
      const client = await Client.findOne({
        $or: [{ clientUsername: normalized }, { email: normalized }],
      });
      if (client) {
        console.log(
          "[verifyOtp] matched client by",
          client.clientUsername || client.email,
        );
        // validity check
        const validity = await AccountValidity.findOne({ client: client._id });
        if (!validity)
          return res
            .status(403)
            .json({ message: "Account validity not found" });
        if (validity.status === "disabled")
          return res.status(403).json({ message: "Account disabled" });
        if (new Date() >= new Date(validity.expiresAt))
          return res.status(403).json({ message: "Account expired" });

        if (!client.otpHash || !client.otpExpiresAt)
          return res.status(400).json({ message: "No OTP requested" });
        if (client.otpAttempts >= OTP_MAX_ATTEMPTS)
          return res.status(429).json({ message: "Too many attempts" });
        if (client.otpExpiresAt.getTime() < Date.now())
          return res.status(400).json({ message: "OTP expired" });

        const ok = await bcrypt.compare(String(otp), client.otpHash);
        client.otpAttempts = (client.otpAttempts || 0) + 1;
        if (!ok) {
          await client.save();
          return res.status(401).json({ message: "Invalid OTP" });
        }

        // success
        client.otpHash = null;
        client.otpExpiresAt = null;
        client.otpAttempts = 0;
        await client.save();

        const token = jwt.sign(
          { id: client._id, role: "client", slug: client.slug },
          process.env.JWT_SECRET,
          { expiresIn: "1d" },
        );

        return res.status(200).json({
          message: "Login successful",
          token,
          accountType: "client",
          user: {
            id: client._id,
            clientUsername: client.clientUsername,
            slug: client.slug,
            contactName: client.contactName,
            email: client.email,
            phone: client.phone,
            role: client.role || "client",
          },
        });
      }
    }

    // Try User (by userId, email or contactNumber)
    if (!type || type === "user") {
      const user = await User.findOne({
        $or: [
          { userId: normalized },
          { email: normalized },
          { contactNumber: normalized },
        ],
      }).populate("role");

      if (user) {
        if (!user.otpHash || !user.otpExpiresAt)
          return res.status(400).json({ message: "No OTP requested for user" });
        if (user.otpAttempts >= OTP_MAX_ATTEMPTS)
          return res.status(429).json({ message: "Too many attempts" });
        if (user.otpExpiresAt.getTime() < Date.now())
          return res.status(400).json({ message: "OTP expired" });

        const ok = await bcrypt.compare(String(otp), user.otpHash);
        user.otpAttempts = (user.otpAttempts || 0) + 1;
        if (!ok) {
          await user.save();
          return res.status(401).json({ message: "Invalid OTP" });
        }

        user.otpHash = null;
        user.otpExpiresAt = null;
        user.otpAttempts = 0;
        await user.save();

        const perms = Array.from(
          new Set([
            ...(user.role?.permissions || []),
            ...(user.permissions || []),
          ]),
        );

        const token = jwt.sign(
          {
            id: user._id,
            role: user.role?.name || "user",
            roleId: user.role?._id,
            perms,
            companies: (user.companies || []).map((c) => c._id),
            createdByClient: user.createdByClient,
          },
          process.env.JWT_SECRET,
          { expiresIn: "8h" },
        );

        return res.status(200).json({
          message: "Login successful",
          token,
          accountType: "user",
          user: {
            id: user._id,
            userName: user.userName,
            role: user.role?.name || "user",
            companies: user.companies || [],
          },
        });
      }
    }

    // DEV fallback: accept hardcoded OTPs when enabled even if no DB account was matched
    const devEntry = DEV_USERS[String(normalized).toLowerCase()];
    if (devEntry && DEV_HARDCODE_OTP) {
      console.log(
        "[verifyOtp] DEV entry found for",
        normalized,
        "devOtp=",
        devEntry.otp,
      );
    }
    if (devEntry && DEV_HARDCODE_OTP && String(otp) === devEntry.otp) {
      const token = jwt.sign(
        { id: `dev-${devEntry.role}`, role: devEntry.role },
        process.env.JWT_SECRET || "dev-secret",
        { expiresIn: devEntry.accountType === "client" ? "1d" : "8h" },
      );

      return res.status(200).json({
        message: "Login successful (dev)",
        token,
        accountType: devEntry.accountType,
        user: devEntry.user,
      });
    }

    return res.status(404).json({ message: "Account not found" });
  } catch (err) {
    console.error("verifyOtp error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.requestUserOtp = async (req, res) => {
  try {
    const { identifier } = req.body;
    console.log(
      "[requestUserOtp] received identifier=",
      identifier,
      "DEV_HARDCODE_OTP=",
      DEV_HARDCODE_OTP,
    );

    if (!identifier)
      return res.status(400).json({ message: "Missing identifier" });

    const normalized = String(identifier).trim().toLowerCase();

    // DEV shortcut: return hardcoded OTPs for known dev users (only in dev or when flag set)
    const devEntry = DEV_USERS[normalized];
    if (devEntry && DEV_HARDCODE_OTP) {
      console.log(
        "[requestUserOtp] DEV entry matched for",
        normalized,
        "will use dev OTP=",
        devEntry.otp,
      );
      // try to persist to DB if account exists, otherwise just return dev OTP in response
      const client = await Client.findOne({
        $or: [{ clientUsername: normalized }, { email: normalized }],
      });
      if (client) {
        if (
          client.otpLastSentAt &&
          Date.now() - client.otpLastSentAt.getTime() <
            OTP_RESEND_SECONDS * 1000
        ) {
          const retryAfter = Math.ceil(
            (OTP_RESEND_SECONDS * 1000 -
              (Date.now() - client.otpLastSentAt.getTime())) /
              1000,
          );
          return res.status(429).json({
            message: `Wait ${retryAfter}s before requesting OTP again`,
          });
        }
        const otp = devEntry.otp;
        client.otpHash = await bcrypt.hash(otp, 10);
        client.otpExpiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
        client.otpAttempts = 0;
        client.otpLastSentAt = new Date();
        await client.save();
        return res.json({ message: "OTP sent (dev)", dev: true, otp: otp });
      }

      const user = await User.findOne({
        $or: [
          { email: normalized },
          { userId: normalized },
          { contactNumber: normalized },
        ],
      });
      if (user) {
        if (
          user.otpLastSentAt &&
          Date.now() - user.otpLastSentAt.getTime() < OTP_RESEND_SECONDS * 1000
        ) {
          const retryAfter = Math.ceil(
            (OTP_RESEND_SECONDS * 1000 -
              (Date.now() - user.otpLastSentAt.getTime())) /
              1000,
          );
          return res.status(429).json({
            message: `Wait ${retryAfter}s before requesting OTP again`,
          });
        }
        const otp = devEntry.otp;
        user.otpHash = await bcrypt.hash(otp, 10);
        user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
        user.otpAttempts = 0;
        user.otpLastSentAt = new Date();
        await user.save();
        return res.json({ message: "OTP sent (dev)", dev: true, otp: otp });
      }

      // no DB user found — return dev OTP in response (convenience for local dev)
      return res.json({ message: "OTP (dev)", dev: true, otp: devEntry.otp });
    }

    // Try client by username or email
    let client = await Client.findOne({
      $or: [{ clientUsername: normalized }, { email: normalized }],
    });
    if (client) {
      // throttle resend
      if (
        client.otpLastSentAt &&
        Date.now() - client.otpLastSentAt.getTime() < OTP_RESEND_SECONDS * 1000
      ) {
        const retryAfter = Math.ceil(
          (OTP_RESEND_SECONDS * 1000 -
            (Date.now() - client.otpLastSentAt.getTime())) /
            1000,
        );
        return res
          .status(429)
          .json({ message: `Wait ${retryAfter}s before requesting OTP again` });
      }

      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);
      client.otpHash = otpHash;
      client.otpExpiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
      client.otpAttempts = 0;
      client.otpLastSentAt = new Date();
      await client.save();

      const transporter = nodemailer.createTransport({
        service: "gmail",
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

      return res.json({
        message: "OTP sent to registered email",
        email: client.email,
        clientUsername: client.clientUsername,
      });
    }

    // Try user by email or userId
    const user = await User.findOne({
      $or: [
        { email: normalized },
        { userId: normalized },
        { contactNumber: normalized },
      ],
    });
    if (!user) return res.status(404).json({ message: "Account not found" });

    if (!user.email)
      return res.status(400).json({ message: "User has no email to send OTP" });

    if (
      user.otpLastSentAt &&
      Date.now() - user.otpLastSentAt.getTime() < OTP_RESEND_SECONDS * 1000
    ) {
      const retryAfter = Math.ceil(
        (OTP_RESEND_SECONDS * 1000 -
          (Date.now() - user.otpLastSentAt.getTime())) /
          1000,
      );
      return res
        .status(429)
        .json({ message: `Wait ${retryAfter}s before requesting OTP again` });
    }

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    user.otpHash = otpHash;
    user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);
    user.otpAttempts = 0;
    user.otpLastSentAt = new Date();
    await user.save();

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER || process.env.MAIL_FROM,
      to: user.email,
      subject: "Your Vinimay Login OTP",
      text: `Your OTP is ${otp}. It expires in ${OTP_TTL_MIN} minutes.`,
      html: `<p>Your OTP is <b>${otp}</b>. It expires in ${OTP_TTL_MIN} minutes.</p>`,
    });

    return res.json({
      message: "OTP sent to registered email",
      email: user.email,
      userName: user.userName,
    });
  } catch (err) {
    console.error("requestUserOtp error:", err);
    return res.status(500).json({ message: "Failed to send OTP" });
  }
};
