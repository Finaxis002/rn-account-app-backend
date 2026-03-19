// controllers/party.controller.js
const Party = require("../models/Party");
const Customer = require("../models/Client")
const { getEffectivePermissions } = require("../services/effectivePermissions");
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");

const PRIV_ROLES = new Set(["master", "client", "admin"]);
const { invalidateClient } = require("../cache");  // Add cache import

function userIsPriv(req) {
  return PRIV_ROLES.has(req.auth?.role);
}

async function ensureAuthCaps(req) {
  // normalize legacy req.user → req.auth
  if (!req.auth && req.user) {
    req.auth = {
      clientId: req.user.id,
      userId: req.user.userId || req.user.id,
      role: req.user.role,
      caps: req.user.caps,
      allowedCompanies: req.user.allowedCompanies,
      // do NOT force "Unknown" – let resolver fetch names correctly
      userName: req.user.userName,       // may be undefined for clients
      clientName: req.user.contactName,  // if your auth layer sets it for clients
    };
  }
  if (!req.auth) throw new Error("Unauthorized (no auth context)");

  if (!req.auth.caps || !Array.isArray(req.auth.allowedCompanies)) {
    const { caps, allowedCompanies } = await getEffectivePermissions({
      clientId: req.auth.clientId,
      userId: req.auth.userId,
    });
    if (!req.auth.caps) req.auth.caps = caps;
    if (!req.auth.allowedCompanies) req.auth.allowedCompanies = allowedCompanies;
  }
}


// Build message text per action
function buildPartyNotificationMessage(action, { actorName, partyName }) {
  const pName = partyName || "Unknown Party";
  switch (action) {
    case "create":
      return `New party created by ${actorName}: ${pName}`;
    case "update":
      return `Party updated by ${actorName}: ${pName}`;
    case "delete":
      return `Party deleted by ${actorName}: ${pName}`;
    default:
      return `Party ${action} by ${actorName}: ${pName}`;
  }
}

// Unified notifier for party module
async function notifyAdminOnPartyAction({ req, action, partyName, entryId }) {
  const actor = await resolveActor(req);
  const adminUser = await findAdminUser();
  if (!adminUser) {
    console.warn("notifyAdminOnPartyAction: no admin user found");
    return;
  }

  const message = buildPartyNotificationMessage(action, {
    actorName: actor.name,
    partyName,
  });

  await createNotification(
    message,
    adminUser._id, // recipient (admin)
    actor.id, // actor id (user OR client)
    action, // "create" | "update" | "delete"
    "party", // entry type / category
    entryId, // party id
    req.auth.clientId
  );
}

exports.createParty = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canCreateCustomers) {
      return res.status(403).json({ message: "Not allowed to create customers" });
    }


    const {
      name,
      address,
      city,
      state,
      pincode,
      gstin,
      gstRegistrationType,
      pan,
      isTDSApplicable,
      tdsRate,
      tdsSection,
      contactNumber,
      email,
      company,
    } = req.body;

    
console.log("Incoming contactNumber:", contactNumber);
console.log("Incoming email:", email);

const conditions = [];
if (contactNumber?.trim()) conditions.push({ contactNumber: contactNumber.trim() });
if (email?.trim()) conditions.push({ email: email?.trim().toLowerCase() });

console.log("Duplicate check conditions:", conditions);

let existingParty = null;
if (conditions.length > 0) {
  existingParty = await Party.findOne({
    createdByClient: req.auth.clientId,
    $or: conditions
  });
  console.log("Existing party found:", existingParty);
}

if (existingParty) {
  if (existingParty.contactNumber === contactNumber?.trim()) {
    return res.status(400).json({ message: "Contact number already exists for this client" });
  }
  if (existingParty.email === email?.trim()?.toLowerCase()) {
    return res.status(400).json({ message: "Email already exists for this client" });
  }
}
    const party = await Party.create({
      name,
      address,
      city,
      state,
      pincode,
      gstin,
      gstRegistrationType,
      pan,
      isTDSApplicable,
      tdsRate,
      tdsSection,
      contactNumber,
      email: email?.toLowerCase(),
      company,
      createdByClient: req.auth.clientId,
      createdByUser: req.auth.userId,
    });

    // Notify admin after party created
    await notifyAdminOnPartyAction({
      req,
      action: "create",
      partyName: party.name,
      entryId: party._id,
    });

    res.status(201).json({ message: "Party created", party });
  } catch (err) {
    if (err.code === 11000) {
      // Better error message extraction
      const keyPattern = err.keyPattern;
      let message = "Duplicate field error";
      
      if (keyPattern.contactNumber && keyPattern.createdByClient) {
        message = "Contact number already exists for this client";
      } else if (keyPattern.email && keyPattern.createdByClient) {
        message = "Email already exists for this client";
      } else {
        // Log the actual duplicate field for debugging
        console.log("Duplicate key error details:", err.keyValue);
        message = `Duplicate field: ${Object.keys(err.keyValue)[0]}`;
      }
      
      return res.status(400).json({ message });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// exports.getParties = async (req, res) => {
//   try {
//     const {
//       q,
//       page = 1,
//       limit = 1000,
//     } = req.query;

//     const where = { createdByClient: req.auth.clientId };

//     if (q) {
//       where.$or = [
//         { name: { $regex: String(q), $options: "i" } },
//         { email: { $regex: String(q), $options: "i" } },
//         { contactNumber: { $regex: String(q), $options: "i" } },
//       ];
//     }

//       // 2) If cache miss, fetch from DB
//     const perPage = limit ? Math.min(Number(limit), 5000) : null; // No limit if not specified
//     const skip = perPage ? (Number(page) - 1) * perPage : 0;

//     let query = Party.find(where).sort({ createdAt: -1 });
//     if (perPage) {
//       query = query.skip(skip).limit(perPage);
//     }

//     const [parties, total] = await Promise.all([
//       query.lean(),
//       Party.countDocuments(where),
//     ]);


//     res.json({ parties, total, page: Number(page), limit: perPage });
//   } catch (err) {
//     res.status(500).json({ message: "Server error", error: err.message });
//   }
// };

exports.getParties = async (req, res) => {
  try {
    const {
      q,
      page = 1,
      limit = 10000, // Increased default to 10000
    } = req.query;

    const where = { createdByClient: req.auth.clientId };

    if (q) {
      where.$or = [
        { name: { $regex: String(q), $options: "i" } },
        { email: { $regex: String(q), $options: "i" } },
        { contactNumber: { $regex: String(q), $options: "i" } },
      ];
    }

    // ✅ REMOVED: Math.min(Number(limit), 5000) - No hardcoded limit!
    // ✅ KEPT: Still supports unlimited when limit not specified
    const perPage = limit ? Number(limit) : null; // No limit if not specified
    const skip = perPage ? (Number(page) - 1) * perPage : 0;

    let query = Party.find(where).sort({ createdAt: -1 });
    if (perPage) {
      query = query.skip(skip).limit(perPage);
    }

    const [parties, total] = await Promise.all([
      query.lean(),
      Party.countDocuments(where),
    ]);

    // ✅ Performance protection - log warning for very large datasets
    if (total > 50000) {
      console.warn(`Large party dataset: ${total} parties for client ${req.auth.clientId}.`);
    }

    res.json({ 
      parties, 
      total, 
      page: Number(page), 
      limit: perPage,
      // Add helpful metadata without breaking existing structure
      ...(perPage && {
        totalPages: Math.ceil(total / perPage),
        hasMore: total > (skip + parties.length)
      })
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getParty = async (req, res) => {
  try {
    const { id } = req.params;

    const party = await Party.findById(id);
    if (!party) {
      return res.status(404).json({ message: "Party not found" });
    }

    // Check if party belongs to the same client
    const sameTenant = String(party.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    res.json(party);
  } catch (err) {
    console.error("Error fetching party:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getPartyBalance = async (req, res) => {
  try {
    const { partyId } = req.params;
    const { companyId } = req.query;

    const party = await Party.findById(partyId);

    if (!party) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Check authorization
    const sameTenant = String(party.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // If companyId provided, calculate company-specific balance
    if (companyId && companyId !== "undefined" && companyId !== "null") {
      // Use balances map if it exists
      if (party.balances && party.balances.get(companyId) !== undefined) {
        return res.json({ balance: party.balances.get(companyId) });
      }

      // Calculate from transactions
      const SalesEntry = require("../models/SalesEntry");
      const ReceiptEntry = require("../models/ReceiptEntry");

      // Get sales entries for this party and company
      const salesEntries = await SalesEntry.find({
        client: req.auth.clientId,
        party: partyId,
        company: companyId
      });

      // Get receipt entries for this party and company
      const receiptEntries = await ReceiptEntry.find({
        client: req.auth.clientId,
        party: partyId,
        company: companyId
      });

      let totalCredit = 0;
      let totalDebit = 0;

      // Calculate credit (sales)
      salesEntries.forEach(sale => {
        const amount = sale.invoiceTotal || sale.totalAmount || 0;
        totalCredit += amount;
        
        // If it's NOT a credit transaction, also count as debit (immediate payment)
        if (sale.paymentMethod && sale.paymentMethod !== "Credit") {
          totalDebit += amount;
        }
      });

      // Calculate debit (receipts)
      receiptEntries.forEach(receipt => {
        totalDebit += receipt.amount || 0;
      });

      const companyBalance = totalCredit - totalDebit;

      // Store in balances map
      if (!party.balances) party.balances = new Map();
      party.balances.set(companyId, companyBalance);
      await party.save();

      return res.json({ balance: companyBalance });
    } else {
      // Return overall balance (legacy support)
      return res.json({ balance: party.balance || 0 });
    }
  } catch (err) {
    console.error("Error fetching party balance:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// PUT /api/parties/:partyId/balance
exports.updatePartyBalance = async (req, res) => {
  try {
    const { partyId } = req.params;
    const { companyId, balance } = req.body;

    const party = await Party.findById(partyId);
    if (!party) {
      return res.status(404).json({ message: "Party not found" });
    }

    // Authorization check
    const sameTenant = String(party.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    if (companyId) {
      if (!party.balances) party.balances = new Map();
      party.balances.set(companyId, balance);
    } else {
      party.balance = balance;
    }

    await party.save();
    res.json({ message: "Balance updated successfully", party });
  } catch (err) {
    console.error("Error updating party balance:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
// GET /api/parties/balances
exports.getPartyBalancesBulk = async (req, res) => {
  try {
    const { companyId } = req.query;
    const where = { createdByClient: req.auth.clientId };

    const parties = await Party.find(where)
      .select({ _id: 1, name: 1, balances: 1 })
      .lean();

    const balances = {};

    if (companyId && companyId !== "undefined" && companyId !== "null") {
      // Return company-specific balances
      parties.forEach(party => {
        if (party.balances && party.balances.get) {
          balances[party._id] = party.balances.get(companyId) || 0;
        } else if (party.balances && party.balances[companyId] !== undefined) {
          balances[party._id] = party.balances[companyId] || 0;
        } else {
          balances[party._id] = 0;
        }
      });
    } else {
      // Return overall balances (sum of all company balances)
      parties.forEach(party => {
        if (party.balances) {
          if (party.balances instanceof Map) {
            balances[party._id] = Array.from(party.balances.values()).reduce((sum, b) => sum + b, 0);
          } else if (typeof party.balances === 'object') {
            balances[party._id] = Object.values(party.balances).reduce((sum, b) => sum + b, 0);
          } else {
            balances[party._id] = 0;
          }
        } else {
          balances[party._id] = 0;
        }
      });
    }

    // Log the balances for all companies (log balances for each party)
    console.log("Balances for all companies:");
    Object.keys(balances).forEach((partyId) => {
      console.log(`Party: ${partyId}, Balance: ₹${balances[partyId]}`);
    });

    return res.json({ balances });
  } catch (err) {
    console.error("getPartyBalancesBulk error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};


// Add this to your party.controller.js
exports.getPartyById = async (req, res) => {
  try {
    await ensureAuthCaps(req);
    
    const { id } = req.params;

    const party = await Party.findOne({
      _id: id,
      createdByClient: req.auth.clientId
    }).lean();

    if (!party) {
      return res.status(404).json({ message: "Party not found" });
    }

    res.json(party);
  } catch (err) {
    console.error("Error fetching party by ID:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.updateParty = async (req, res) => {
  try {
    const doc = await Party.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Party not found" });

    const sameTenant = String(doc.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    Object.assign(doc, req.body);
    await doc.save();

    // Invalidate cache after update
    invalidateClient(req.auth.clientId);

    // Notify admin after party updated
    await notifyAdminOnPartyAction({
      req,
      action: "update",
      partyName: doc.name,
      entryId: doc._id,
    });

    res.json({ message: "Party updated", party: doc });
  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      let message = `Duplicate ${field}`;
      if (field === "contactNumber") {
        message = "Contact number already exists for this client";
      } else if (field === "email") {
        message = "Email already exists for this client";
      }
      return res.status(400).json({ message });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.importParties = async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ message: "No file uploaded." });
  }

  try {
    await ensureAuthCaps(req);

    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canCreateCustomers) {
      return res.status(403).json({ message: "Not allowed to create customers" });
    }

    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      return res.status(400).json({ message: "Please upload a CSV file." });
    }

    const fileContent = file.buffer.toString('utf8');
    const records = parseCSV(fileContent);

    if (records.length === 0) {
      return res.status(400).json({ message: "CSV file is empty or could not be parsed." });
    }

    const importedParties = [];
    const errors = [];

    // Define valid GST types based on your actual schema
    const validGstTypes = [
      "Regular",
      "Composition", 
      "Unregistered",
      "Consumer",
      "Overseas",
      "Special Economic Zone",
      "Unknown"
    ];

    // Mapping from common terms to your schema terms
    const gstTypeMapping = {
      'Registered': 'Regular',
      'REGISTERED': 'Regular',
      'registered': 'Regular',
      'Composition': 'Composition',
      'COMPOSITION': 'Composition',
      'composition': 'Composition',
      'Unregistered': 'Unregistered',
      'UNREGISTERED': 'Unregistered',
      'unregistered': 'Unregistered',
      'Consumer': 'Consumer',
      'Overseas': 'Overseas',
      'Special Economic Zone': 'Special Economic Zone',
      'Unknown': 'Unknown'
    };

    // Process each record
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNumber = i + 2;

      try {
        // Validate required fields
        if (!row.name || row.name.trim() === '') {
          errors.push(`Row ${rowNumber}: Name is required`);
          continue;
        }

        // Prepare party data
        let companyId = undefined;
        if (row.company?.trim()) {
          // Look up company by businessName for the client
          const Company = require("../models/Company");
          const company = await Company.findOne({
            businessName: row.company.trim(),
            client: req.auth.clientId
          });
          if (company) {
            companyId = company._id;
          } else {
            errors.push(`Row ${rowNumber}: Company "${row.company.trim()}" not found`);
            continue;
          }
        }

        const partyData = {
          name: row.name.trim(),
          contactNumber: row.contactNumber?.trim() || '',
          email: row.email?.trim()?.toLowerCase() || '',
          address: row.address?.trim() || '',
          city: row.city?.trim() || '',
          state: row.state?.trim() || '',
          pincode: row.pincode?.trim() || '',
          gstin: row.gstin?.trim()?.toUpperCase() || '',
          gstRegistrationType: row.gstRegistrationType?.trim() || 'Unregistered',
          pan: row.pan?.trim()?.toUpperCase() || '',
          isTDSApplicable: row.isTDSApplicable?.toLowerCase() === 'true' || row.isTDSApplicable === '1',
          tdsRate: parseFloat(row.tdsRate) || 0,
          tdsSection: row.tdsSection?.trim() || '',
          company: companyId,
          createdByClient: req.auth.clientId,
          createdByUser: req.auth.userId,
        };

        // Normalize GST registration type
        if (partyData.gstRegistrationType && gstTypeMapping[partyData.gstRegistrationType]) {
          partyData.gstRegistrationType = gstTypeMapping[partyData.gstRegistrationType];
        }

        // Validate GST Registration Type against actual schema enum
        if (partyData.gstRegistrationType && !validGstTypes.includes(partyData.gstRegistrationType)) {
          errors.push(`Row ${rowNumber}: Invalid GST registration type "${partyData.gstRegistrationType}". Must be one of: ${validGstTypes.join(', ')}`);
          continue;
        }

        // Clear GSTIN if unregistered
        if (partyData.gstRegistrationType === 'Unregistered') {
          partyData.gstin = '';
        }

        // Validate TDS data
        if (partyData.isTDSApplicable) {
          if (!partyData.tdsSection || partyData.tdsSection.trim() === '') {
            errors.push(`Row ${rowNumber}: TDS Section is required when TDS is applicable`);
            continue;
          }
          if (partyData.tdsRate <= 0) {
            errors.push(`Row ${rowNumber}: TDS Rate must be greater than 0 when TDS is applicable`);
            continue;
          }
        } else {
          partyData.tdsRate = 0;
          partyData.tdsSection = '';
        }

        // Check for duplicate contact number or email
        const existingParty = await Party.findOne({
          createdByClient: req.auth.clientId,
          $or: [
            { contactNumber: partyData.contactNumber },
            { email: partyData.email }
          ].filter(condition => {
            const value = Object.values(condition)[0];
            return value && value.trim() !== '';
          })
        });

        if (existingParty) {
          if (existingParty.contactNumber === partyData.contactNumber && partyData.contactNumber) {
            errors.push(`Row ${rowNumber}: Contact number '${partyData.contactNumber}' already exists`);
            continue;
          }
          if (existingParty.email === partyData.email && partyData.email) {
            errors.push(`Row ${rowNumber}: Email '${partyData.email}' already exists`);
            continue;
          }
        }

        // Create new party
        const newParty = new Party(partyData);
        const savedParty = await newParty.save();
        importedParties.push(savedParty);

        // Notify admin for each imported party
        await notifyAdminOnPartyAction({
          req,
          action: "create",
          partyName: savedParty.name,
          entryId: savedParty._id,
        });

      } catch (error) {
        console.error(`Error processing row ${rowNumber}:`, error);
        if (error.code === 11000) {
          const field = Object.keys(error.keyValue)[0];
          if (field === "contactNumber") {
            errors.push(`Row ${rowNumber}: Contact number already exists`);
          } else if (field === "email") {
            errors.push(`Row ${rowNumber}: Email already exists`);
          } else {
            errors.push(`Row ${rowNumber}: Duplicate field error`);
          }
        } else if (error.name === 'ValidationError') {
          // Handle mongoose validation errors
          const validationErrors = Object.values(error.errors).map(err => err.message);
          errors.push(`Row ${rowNumber}: ${validationErrors.join(', ')}`);
        } else {
          errors.push(`Row ${rowNumber}: ${error.message}`);
        }
      }
    }

    // Invalidate cache after import
    if (importedParties.length > 0) {
      invalidateClient(req.auth.clientId);
    }

    return res.status(200).json({
      message: 'Import completed',
      importedCount: importedParties.length,
      totalCount: records.length,
      errors: errors.length > 0 ? errors : undefined,
      importedParties: importedParties.map(p => ({ id: p._id, name: p.name }))
    });

  } catch (error) {
    console.error("Error importing parties:", error);
    return res.status(500).json({ 
      message: "Error importing parties.", 
      error: error.message 
    });
  }
};

// Replace your current parseCSV function with this improved version
function parseCSV(content) {
  const lines = content.split('\n').filter(line => line.trim() !== '');
  
  if (lines.length < 2) return []; // Need at least header and one data row

  const headers = lines[0].split(',').map(header => header.trim());
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // Skip empty lines

    // More robust CSV parsing that handles quoted fields with commas
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      const nextChar = line[j + 1];
      
      if (char === '"') {
        // Toggle quote state
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        // End of field
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    // Push the last field
    values.push(current.trim());

    // Remove quotes from values if present
    const cleanValues = values.map(value => {
      if (value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1);
      }
      return value;
    });

    const record = {};
    
    headers.forEach((header, index) => {
      record[header] = cleanValues[index] || '';
    });
    
    // Only add non-empty records (at least one field has value)
    const hasData = Object.values(record).some(value => value !== '');
    if (hasData) {
      records.push(record);
    }
  }

  console.log(`Parsed ${records.length} records from CSV`); // Debug log
  return records;
}

exports.deleteParty = async (req, res) => {
  try {
    const doc = await Party.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Party not found" });

    const sameTenant = String(doc.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Notify admin before deleting (since doc will be gone after)
    await notifyAdminOnPartyAction({
      req,
      action: "delete",
      partyName: doc.name,
      entryId: doc._id,
    });

    await doc.deleteOne();

    res.json({ message: "Party deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

