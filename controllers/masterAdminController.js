const MasterAdmin = require("../models/MasterAdmin");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");

// Register (for initial setup — can disable in production)
exports.registerMasterAdmin = async (req, res) => {
  try {
    const { username, password } = req.body;

    const existingAdmin = await MasterAdmin.findOne({ username });
    if (existingAdmin) {
      return res.status(400).json({ message: "Username already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newAdmin = new MasterAdmin({
      username,
      password: hashedPassword,
      role: "master", // optional, since schema sets default
    });

    await newAdmin.save();
    res.status(201).json({ message: "Master admin created successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Login
exports.loginMasterAdmin = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res
        .status(400)
        .json({ message: "Username and password are required" });
    }

    // Find admin by username
    const admin = await MasterAdmin.findOne({
      username: username.toLowerCase(),
    });

    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Check if password exists for the admin
    if (!admin.password) {
      return res
        .status(401)
        .json({ message: "Account not properly configured" });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: admin._id, role: "master" },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.status(200).json({
      message: "Login successful",
      token,
      admin: {
        id: admin._id,
        username: admin.username,
        name: admin.name,
        email: admin.email,
        role: "master",
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.getMasterAdminProfile = async (req, res) => {
  try {
    const adminId = req.user.id;
    const admin = await MasterAdmin.findById(adminId).select("-password");

    if (!admin) {
      return res.status(404).json({ message: "Admin not found" });
    }

    res.status(200).json({
      message: "Profile fetched successfully",
      admin,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};
