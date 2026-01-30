const User = require("../models/User");
const Company = require("../models/Company");
const bcrypt = require("bcryptjs");
const Client = require("../models/Client");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const axios = require("axios");
// 👇 NEW
const Role = require("../models/Role");
const UserPermission = require("../models/UserPermission");
const Permission = require("../models/Permission");
const { CAP_KEYS } = require("../services/effectivePermissions");


async function getActorRoleDoc(req) {
  if (req.user?.roleId && mongoose.Types.ObjectId.isValid(req.user.roleId)) {
    const r = await Role.findById(req.user.roleId);
    if (r) return r;
  }
  if (req.user?.role) {
    const r = await Role.findOne({ name: String(req.user.role).toLowerCase() });
    if (r) return r;
  }
  return null;
}

function normalizeRoleName(x) {
  return String(x || "").trim().toLowerCase();
}

async function getRoleByInput({ roleId, roleName }) {
  if (roleId && mongoose.Types.ObjectId.isValid(roleId)) {
    const r = await Role.findById(roleId);
    if (r) return r;
  }
  if (roleName) {
    const r = await Role.findOne({ name: normalizeRoleName(roleName) });
    if (r) return r;
  }
  return null;
}



// allow master anything; client/admin anything except 'master'; manager -> 'user' only
function canAssignRole(actorRoleDoc, targetRoleDoc, actorNameRaw) {
  const actor = normalizeRoleName(actorRoleDoc?.name || actorNameRaw);
  const target = normalizeRoleName(targetRoleDoc?.name);
  if (!target) return false;

  if (actor === "master") return true;
  if (actor === "admin" || actor === "client") return target !== "master";
  if (actor === "manager") return target === "user";
  return false;
}



function pickOverrideFlags(input) {
  const out = {};
  for (const k of CAP_KEYS || []) {
    if (Object.prototype.hasOwnProperty.call(input || {}, k)) {
      const v = input[k];
      if (v === true || v === false || v === null) out[k] = v; // null means "inherit"
    }
  }
  return out;
}

function pickOnlyCaps(doc) {
  const out = {};
  for (const k of CAP_KEYS || []) {
    if (doc && Object.prototype.hasOwnProperty.call(doc, k)) {
      out[k] = doc[k];
    }
  }
  return out;
}



function seedFromRole(roleDoc) {
  const list = Array.isArray(roleDoc?.defaultPermissions)
    ? roleDoc.defaultPermissions
    : [];

  // "*" means all caps are granted
  const grantsAll = list.includes("*");
  const seed = {};

  for (const key of CAP_KEYS) {
    if (grantsAll || list.includes(key)) {
      seed[key] = true;     // set granted caps to true
    }
    // don't set anything for other keys -> they will remain schema default (null)
  }
  return seed;
}



exports.createUser = async (req, res) => {
  try {
    const {
      userName,
      userId,
      password,
      contactNumber,
      email,
      address,
      companies = [],
      roleId,
      roleName,
      permissions = [], // optional array of capability keys to force true
      overrides,        // optional object of {capKey: true|false|null}
    } = req.body;

    // 1) resolve role
    let targetRole = null;
    if (roleId && mongoose.Types.ObjectId.isValid(roleId)) {
      targetRole = await Role.findById(roleId);
    } else if (roleName) {
      targetRole = await Role.findOne({ name: String(roleName).toLowerCase() });
    }
    if (!targetRole) return res.status(400).json({ message: "Invalid role" });

    // 2) tenant/company validations
    const clientId = req.user.createdByClient || req.user.id;
    const validCompanies = await Company.find({
      _id: { $in: companies },
      client: clientId,
    });
    if ((companies?.length || 0) !== validCompanies.length) {
      return res.status(400).json({ message: "Invalid companies selected" });
    }

    // 3) user limit
    const permission = await Permission.findOne({ client: clientId });
    const maxUsers = permission?.maxUsers ?? 1; // fallback to 1 if no permission found
    const userCount = await User.countDocuments({ createdByClient: clientId });
    if (userCount >= maxUsers) {
      return res
        .status(403)
        .json({ message: "User creation limit reached. Please contact admin." });
    }

    // 4) create user
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      userName,
      userId,
      password: hashedPassword,
      contactNumber,
      email,
      address,
      role: targetRole._id, // Role ref
      companies,
      createdByClient: clientId,
    });

    // 5) seed UserPermission from role defaults + merge any incoming overrides
    const seed = seedFromRole(targetRole);               // <-- define seed here
    const extra = {};                                    // from client request
    if (overrides) Object.assign(extra, pickOverrideFlags(overrides));
    if (Array.isArray(permissions) && permissions.length && CAP_KEYS) {
      for (const k of permissions) if (CAP_KEYS.includes(k)) extra[k] = true;
    }
    const finalSet = { ...seed, ...extra, updatedBy: req.user._id };

    let userPermission = await UserPermission.findOneAndUpdate(
      { client: clientId, user: newUser._id },
      {
        $setOnInsert: {
          client: clientId,
          user: newUser._id,
          allowedCompanies: companies, // optional
        },
        $set: finalSet,
      },
      { upsert: true, new: true }
    );

    return res
      .status(201)
      .json({ message: "User created", user: newUser, userPermission });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "User ID already exists" });
    }
    return res.status(500).json({ error: err.message });
  }
};



exports.getUsers = async (req, res) => {
  try {
    const actorRoleName = String(req.user.role || "").toLowerCase();
    const clientId = req.user.createdByClient || req.user.id;

    const query =
      actorRoleName === "admin" || actorRoleName === "master"
        ? { createdByClient: clientId } // or {} if you want admin to see all tenants
        : { createdByClient: clientId };

    const users = await User.find(query).populate("companies").populate("role");

    res.status(200).json(users);
  } catch (err) {
    console.error("🔥 Error in /api/users:", err);
    res.status(500).json({ error: err.message });
  }
};



exports.updateUser = async (req, res) => {
  try {
    const {
      userName,
      contactNumber,
      email,
      address,
      companies,
      // do not allow password here; use reset route below
      roleId,
      roleName,
      overrides,        // optional: {capKey: true|false|null}
      permissions,      // optional: ["canCreateInventory", ...] => true
    } = req.body;

    const targetUserId = req.params.id;
    const doc = await User.findById(targetUserId);
    if (!doc) return res.status(404).json({ message: "User not found" });

    const clientId = req.user.createdByClient || req.user.id;
    const actorRoleDoc = await getActorRoleDoc(req);
    const actorRoleName = normalizeRoleName(req.user.role);
    const isSameTenant = String(doc.createdByClient) === String(clientId);
    const isPrivileged = actorRoleName === "admin" || actorRoleName === "master";

    // only same-tenant actors or privileged roles can edit
    if (!isSameTenant && !isPrivileged) {
      return res.status(403).json({ message: "Not authorized to update this user" });
    }

    // --- basic fields
    if (typeof userName === "string") doc.userName = userName;
    if (typeof contactNumber === "string") doc.contactNumber = contactNumber;
    if (typeof email === "string") doc.email = email;
    if (typeof address === "string") doc.address = address;

    // --- company list (validate belongs to tenant)
    if (Array.isArray(companies)) {
      const validCompanies = await Company.find({ _id: { $in: companies }, client: clientId });
      if (validCompanies.length !== companies.length) {
        return res.status(400).json({ message: "Invalid companies selected" });
      }
      doc.companies = companies;

      // keep UserPermission.allowedCompanies aligned
      await UserPermission.findOneAndUpdate(
        { client: clientId, user: doc._id },
        {
          $setOnInsert: { client: clientId, user: doc._id },
          $set: { allowedCompanies: companies, updatedBy: req.user._id },
        },
        { upsert: true, new: true }
      );
    }

    // --- role change (only if actually different)
    if (roleId || roleName) {
      const newRole = await getRoleByInput({ roleId, roleName });
      if (!newRole) return res.status(400).json({ message: "Invalid role" });

      const isDifferent = String(doc.role) !== String(newRole._id);
      if (isDifferent) {
        if (!canAssignRole(actorRoleDoc, newRole, req.user.role)) {
          return res.status(403).json({ message: "Not allowed to assign this role" });
        }
        doc.role = newRole._id;

        // reseed user-permissions from role defaults + keep overrides
        const seed = seedFromRole(newRole);              // role.defaultPermissions → {cap:true}
        const extra = {};
        if (overrides) Object.assign(extra, pickOverrideFlags(overrides));
        if (Array.isArray(permissions) && permissions.length && CAP_KEYS) {
          for (const k of permissions) if (CAP_KEYS.includes(k)) extra[k] = true;
        }

        // merge with existing record to preserve explicit false/null overrides
        // read only capability keys so we don't accidentally $set client/user/etc.
        const existingUPCaps = await UserPermission
          .findOne({ client: clientId, user: doc._id })
          .select(CAP_KEYS.join(" "))
          .lean();

        const mergedCaps = {
          ...seed,                      // role defaults
          ...(existingUPCaps || {}),    // keep explicit false/null from previous
          ...extra,                     // incoming overrides/permissions
          updatedBy: req.user._id,
        };

        await UserPermission.findOneAndUpdate(
          { client: clientId, user: doc._id },
          {
            $setOnInsert: {
              client: clientId,
              user: doc._id,
              allowedCompanies: doc.companies || [],
            },
            $set: mergedCaps,           // ✅ only caps + updatedBy
          },
          { upsert: true, new: true }
        );

      }
    } else if (overrides || permissions) {
      // no role change, but explicit permission updates
      const extra = {};
      if (overrides) Object.assign(extra, pickOverrideFlags(overrides));
      if (Array.isArray(permissions) && permissions.length && CAP_KEYS) {
        for (const k of permissions) if (CAP_KEYS.includes(k)) extra[k] = true;
      }
      if (Object.keys(extra).length) {
        await UserPermission.findOneAndUpdate(
          { client: clientId, user: doc._id },
          {
            $setOnInsert: { client: clientId, user: doc._id, allowedCompanies: doc.companies || [] },
            $set: { ...extra, updatedBy: req.user._id },
          },
          { upsert: true, new: true }
        );
      }
    }

    await doc.save();
    
    // Emit user update event via socket if companies were changed
    if (global.io && Array.isArray(companies)) {
      console.log('📡 Emitting user-update event for user:', doc._id);
      
      // Emit to the user themselves
      global.io.to(`user-${doc._id}`).emit('user-update', {
        message: 'Your company assignments have been updated',
        userId: doc._id,
        companies: companies,
        action: 'company-assignment-update'
      });
      
      // Also emit to the client admin
      const clientId = req.user.createdByClient || req.user.id;
      global.io.to(`client-${clientId}`).emit('user-update', {
        message: 'User company assignments updated',
        userId: doc._id,
        updatedBy: req.user._id,
        companies: companies,
        action: 'company-assignment-update'
      });
    }
    
    return res.status(200).json({ message: "User updated", user: doc });
  } catch (err) {
    console.error("updateUser error:", err);
    return res.status(500).json({ error: err.message });
  }
};



exports.deleteUser = async (req, res) => {
  try {
    const userId = req.params.id;
    const doc = await User.findById(userId);
    if (!doc) return res.status(404).json({ message: "User not found" });

    const actorRoleName = String(req.user.role || "").toLowerCase();
    const clientId = req.user.createdByClient || req.user.id;

    const isSameTenant = String(doc.createdByClient) === String(clientId);
    const isPrivileged = actorRoleName === "admin" || actorRoleName === "master";

    if (!isSameTenant && !isPrivileged) {
      return res.status(403).json({ message: "Not authorized to delete this user" });
    }

    await doc.deleteOne();
    res.status(200).json({ message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};



exports.resetPassword = async (req, res) => {
  try {
    const { userId } = req.params; // URL param: /api/users/:userId/reset-password
    const { newPassword } = req.body; //user password works 

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: "New password is too short." });
    }

    const doc = await User.findById(userId);
    if (!doc) return res.status(404).json({ message: "User not found." });

    const actorRole = normalizeRoleName(req.user.role); // 'admin', 'client', 'user', etc.
    const isPrivileged = actorRole === "admin" || actorRole === "master";

    const actorId = req.user.id;
    const clientId = req.user.createdByClient || req.user.id;

    const isSelf = String(actorId) === String(doc._id);
    const isSameTenant = String(doc.createdByClient) === String(clientId);

    // 🛡️ Permission Check: Only self, same-tenant, or privileged users can reset
    if (!isSelf && !isSameTenant && !isPrivileged) {
      return res.status(403).json({ message: "Not authorized to reset this user's password" });
    }

    const salt = await bcrypt.genSalt(10);
    doc.password = await bcrypt.hash(newPassword, salt);
    doc.passwordChangedAt = new Date(); // Optional: helps with token invalidation
    await doc.save();

    return res.json({ message: "Password reset successfully." });

  } catch (error) {
    console.error("resetPassword error:", error);
    return res.status(500).json({ message: "Server error." });
  }
};




exports.getUsersByClient = async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(clientId)) {
      return res.status(400).json({ message: "Invalid client id" });
    }

    const actorRoleName = String(req.user.role || "").toLowerCase();
    const myTenant = req.user.createdByClient || req.user.id;

    if (actorRoleName !== "admin" && actorRoleName !== "master" && String(myTenant) !== String(clientId)) {
      return res.status(403).json({ message: "Not authorized to view users for this client" });
    }

    const clientExists = await Client.exists({ _id: clientId });
    if (!clientExists) return res.status(404).json({ message: "Client not found" });

    const users = await User.find({ createdByClient: clientId })
      .populate({ path: "companies", select: "_id businessName" })
      .populate("role")
      .lean();

    return res.status(200).json(users);
  } catch (err) {
    console.error("getUsersByClient error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};




// ✅✅✅ UPDATED LOGIN WITH MANUAL CAPTCHA SUPPORT ✅✅✅
exports.loginUser = async (req, res) => {
  try {
    const { userId, password, captchaToken } = req.body;

    // ✅ Support for manual letter-based CAPTCHA
    if (captchaToken === "manual-captcha-verified") {
      // Frontend ne CAPTCHA verify kar liya hai, proceed karo
      const user = await User.findOne({ userId })
        .populate("companies")
        .populate("role");

      if (!user) return res.status(404).json({ message: "User not found" });

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });

      // permissions = role.permissions ∪ user.permissions
      const perms = Array.from(new Set([...(user.role?.permissions || []), ...(user.permissions || [])]));

      const token = jwt.sign(
        {
          id: user._id,
          role: user.role?.name || "user",
          roleId: user.role?._id,
          perms,
          companies: user.companies.map(c => c._id),
          createdByClient: user.createdByClient
        },
        process.env.JWT_SECRET,
        { expiresIn: "8h" }
      );

      return res.json({
        token,
        user: {
          _id: user._id,
          userName: user.userName,
          userId: user.userId,
          contactNumber: user.contactNumber,
          address: user.address,
          role: user.role?.name || "user",
          permissions: perms,
          createdByClient: user.createdByClient,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          companies: user.companies,
        },
      });
    }

    // ❌ If manual CAPTCHA not verified, check for Google reCAPTCHA
    if (!captchaToken) {
      return res.status(400).json({ message: "CAPTCHA verification required" });
    }

    // Optional: Google reCAPTCHA support (agar future mein chahiye)
    try {
      const recaptchaResponse = await axios.post(
        `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${captchaToken}`
      );

      if (!recaptchaResponse.data.success) {
        return res.status(400).json({ message: "reCAPTCHA verification failed" });
      }
    } catch (recaptchaError) {
      console.error("reCAPTCHA verification error:", recaptchaError);
      return res.status(400).json({ message: "CAPTCHA verification failed" });
    }

    const user = await User.findOne({ userId })
      .populate("companies")
      .populate("role");

    if (!user) return res.status(404).json({ message: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });

    const perms = Array.from(new Set([...(user.role?.permissions || []), ...(user.permissions || [])]));

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role?.name || "user",
        roleId: user.role?._id,
        perms,
        companies: user.companies.map(c => c._id),
        createdByClient: user.createdByClient
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      user: {
        _id: user._id,
        userName: user.userName,
        userId: user.userId,
        contactNumber: user.contactNumber,
        address: user.address,
        role: user.role?.name || "user",
        permissions: perms,
        createdByClient: user.createdByClient,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        companies: user.companies,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
};