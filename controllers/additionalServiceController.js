const AdditionalService = require("../models/AdditionalService");

function normalizeAdditionalServiceCompanyIds(input) {
  const toArray = (value) => {
    if (value === undefined || value === null || value === "") return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed;
        } catch (_) {
          // Ignore parse errors and treat as single id string.
        }
      }
      return [trimmed];
    }
    return [value];
  };

  return Array.from(
    new Set(
      toArray(input)
        .map((item) => {
          if (!item) return "";
          if (typeof item === "string") return item.trim();
          if (typeof item === "object") {
            const id = item._id || item.id || "";
            return String(id).trim();
          }
          return String(item).trim();
        })
        .filter(Boolean)
    )
  );
}

function buildAdditionalServiceCompanyScopeFilter(companyId) {
  if (!companyId || companyId === "all") return {};

  return {
    $or: [
      { companies: companyId },
      { company: companyId },
      {
        $and: [
          {
            $or: [
              { companies: { $exists: false } },
              { companies: null },
              { companies: { $size: 0 } },
            ],
          },
          {
            $or: [{ company: { $exists: false } }, { company: null }],
          },
        ],
      },
    ],
  };
}

function toNonNegativeNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function toValidDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// POST /api/additional-services
exports.createAdditionalService = async (req, res) => {
  try {
    const {
      serviceName,
      serviceCost,
      additionalCharges,
      description,
      company,
      companies,
    } = req.body;

    const normalizedName = String(serviceName || "").trim();
    if (!normalizedName) {
      return res.status(400).json({ message: "Service name is required" });
    }


    const normalizedCompanies = normalizeAdditionalServiceCompanyIds(
      companies !== undefined ? companies : company
    );

    const entry = await AdditionalService.create({
      serviceName: normalizedName,
      serviceCost: toNonNegativeNumber(serviceCost, 0),
      additionalCharges: toNonNegativeNumber(additionalCharges, 0),
      description: typeof description === "string" ? description.trim() : "",
      company: normalizedCompanies.length === 1 ? normalizedCompanies[0] : undefined,
      companies: normalizedCompanies,
      createdByClient: req.auth.clientId,
      createdByUser: req.auth.userId,
    });

    return res.status(201).json({
      message: "Additional service created",
      additionalService: entry,
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// GET /api/additional-services
exports.getAdditionalServices = async (req, res) => {
  try {
    const requestedClientId = req.query.clientId || req.auth.clientId;
    const {
      q,
      companyId,
      company,
      dateFrom,
      dateTo,
      page = 1,
      limit = 100,
    } = req.query;

    const isPrivileged = ["master", "admin"].includes(req.auth.role);
    if (!isPrivileged && requestedClientId !== req.auth.clientId) {
      return res
        .status(403)
        .json({ message: "Not authorized to view this client's data." });
    }

    const where = { createdByClient: requestedClientId };

    if (q) {
      where.serviceName = { $regex: String(q), $options: "i" };
    }

    const from = toValidDateOrNull(dateFrom);
    const to = toValidDateOrNull(dateTo);

    const resolvedCompanyId = companyId || company;
    if (resolvedCompanyId && resolvedCompanyId !== "all") {
      Object.assign(
        where,
        buildAdditionalServiceCompanyScopeFilter(String(resolvedCompanyId))
      );
    }

    const perPage = Math.min(Number(limit) || 100, 500);
    const skip = (Number(page) - 1) * perPage;

    const [items, total] = await Promise.all([
      AdditionalService.find(where)
        .populate("company")
        .populate("companies")
        .skip(skip)
        .limit(perPage)
        .lean(),
      AdditionalService.countDocuments(where),
    ]);

    return res.json({
      additionalServices: items,
      total,
      page: Number(page),
      limit: perPage,
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// GET /api/additional-services/:id
exports.getAdditionalServiceById = async (req, res) => {
  try {
    const entry = await AdditionalService.findOne({
      _id: req.params.id,
      createdByClient: req.auth.clientId,
    })
      .populate("company")
      .populate("companies");

    if (!entry) {
      return res.status(404).json({ message: "Additional service not found" });
    }

    return res.json({ additionalService: entry });
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// PUT /api/additional-services/:id
exports.updateAdditionalService = async (req, res) => {
  try {
    const entry = await AdditionalService.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ message: "Additional service not found" });
    }

    const privileged = ["master", "client", "admin"].includes(req.auth.role);
    const sameTenant = String(entry.createdByClient) === req.auth.clientId;
    if (!privileged && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const {
      serviceName,
      serviceCost,
      additionalCharges,
      description,
      company,
      companies,
    } = req.body;

    if (serviceName !== undefined) {
      const normalizedName = String(serviceName || "").trim();
      if (!normalizedName) {
        return res.status(400).json({ message: "Service name cannot be empty" });
      }
      entry.serviceName = normalizedName;
    }

    if (serviceCost !== undefined) {
      entry.serviceCost = toNonNegativeNumber(serviceCost, entry.serviceCost);
    }

    if (additionalCharges !== undefined) {
      entry.additionalCharges = toNonNegativeNumber(
        additionalCharges,
        entry.additionalCharges
      );
    }

    if (description !== undefined) {
      entry.description = typeof description === "string" ? description.trim() : "";
    }

    const hasCompany =
      Object.prototype.hasOwnProperty.call(req.body, "company") ||
      Object.prototype.hasOwnProperty.call(req.body, "companies");
    if (hasCompany) {
      const normalizedCompanies = normalizeAdditionalServiceCompanyIds(
        Object.prototype.hasOwnProperty.call(req.body, "companies")
          ? companies
          : company
      );
      entry.companies = normalizedCompanies;
      entry.company = normalizedCompanies.length === 1 ? normalizedCompanies[0] : undefined;
    }

    await entry.save();

    return res.json({
      message: "Additional service updated",
      additionalService: entry,
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// DELETE /api/additional-services/:id
exports.deleteAdditionalService = async (req, res) => {
  try {
    const entry = await AdditionalService.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ message: "Additional service not found" });
    }

    const privileged = ["master", "client", "admin"].includes(req.auth.role);
    const sameTenant = String(entry.createdByClient) === req.auth.clientId;
    if (!privileged && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await entry.deleteOne();
    return res.json({ message: "Additional service deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

