// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    userName: { type: String, required: true, trim: true },
    userId: { type: String, required: true,  lowercase: true, trim: true },
    password: { type: String, required: true },
    contactNumber: { type: String, trim: true },
    email: { type: String, trim: true },
    address: { type: String, trim: true },

    // 👇 changed
    role: { type: mongoose.Schema.Types.ObjectId, ref: "Role", required: true }, // reference

    // per-user extra perms (optional grants)
    permissions: { type: [String], default: [] },

    companies: [{ type: mongoose.Schema.Types.ObjectId, ref: "Company" }],
    createdByClient: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },

    
  },
  { timestamps: true }
);

userSchema.index({ userId: 1, createdByClient: 1 }, { unique: true });

// (Optional) derived roleName to not break old code immediately
userSchema.virtual("roleName").get(function () {
  return this._roleName || (this.role && this.role.name) || undefined;
});

module.exports = mongoose.model("User", userSchema);
