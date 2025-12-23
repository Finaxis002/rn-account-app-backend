// controllers/vendor.controller.js
const Vendor = require("../models/Vendor");
const { getEffectivePermissions } = require("../services/effectivePermissions");
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");

const PRIV_ROLES = new Set(["master", "client", "admin"]);

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
function buildVendorNotificationMessage(action, { actorName, vendorName }) {
  const vName = vendorName || "Unknown Vendor";
  switch (action) {
    case "create":
      return `New vendor created by ${actorName}: ${vName}`;
    case "update":
      return `Vendor updated by ${actorName}: ${vName}`;
    case "delete":
      return `Vendor deleted by ${actorName}: ${vName}`;
    default:
      return `Vendor ${action} by ${actorName}: ${vName}`;
  }
}

// Unified notifier for vendor module
async function notifyAdminOnVendorAction({ req, action, vendorName, entryId }) {
  const actor = await resolveActor(req);
  const adminUser = await findAdminUser();
  if (!adminUser) {
    console.warn("notifyAdminOnVendorAction: no admin user found");
    return;
  }

  const message = buildVendorNotificationMessage(action, {
    actorName: actor.name,
    vendorName,
  });

  await createNotification(
    message,
    adminUser._id, // recipient (admin)
    actor.id, // actor id (user OR client)
    action, // "create" | "update" | "delete"
    "vendor", // entry type / category
    entryId, // vendor id
    req.auth.clientId
  );
}

exports.createVendor = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    // permission gate (non-privileged must have explicit capability)
    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canCreateVendors) {
      return res.status(403).json({ message: "Not allowed to create vendors" });
    }


    const {
      vendorName,
      contactNumber,
      email,
      address,
      city,
      state,
      gstin,
      gstRegistrationType,
      pan,
      isTDSApplicable,
      company,
    } = req.body;

    // Validation - ONLY vendorName is required
if (!vendorName || vendorName.trim().length < 2) {
  return res.status(400).json({ message: "Vendor name is required and must be at least 2 characters." });
}

// Optional validations - only check if value is provided
if (contactNumber && !/^[6-9]\d{9}$/.test(contactNumber)) {
  return res.status(400).json({ message: "Invalid mobile number. Must be 10 digits starting with 6-9." });
}

if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  return res.status(400).json({ message: "Invalid email format." });
}



    const vendor = await Vendor.create({
      vendorName,
      contactNumber,
      email,
      address,
      city,
      state,
      gstin,
      gstRegistrationType,
      pan,
      isTDSApplicable,
      company,
      createdByClient: req.auth.clientId,
      createdByUser: req.auth.userId,
    });

    // Notify admin after vendor created
    await notifyAdminOnVendorAction({
      req,
      action: "create",
      vendorName: vendor.vendorName,
      entryId: vendor._id,
    });

    res.status(201).json({ message: "Vendor created", vendor });
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
      
        message = `Duplicate field: ${Object.keys(err.keyValue)[0]}`;
      }
      
      return res.status(400).json({ message });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getVendors = async (req, res) => {
  try {
    const {
      q,
      page = 1,
      limit,
    } = req.query;

    const where = { createdByClient: req.auth.clientId };

    if (q) {
      // search by name / email / phone
      where.$or = [
        { vendorName: { $regex: String(q), $options: "i" } },
        { email: { $regex: String(q), $options: "i" } },
        { contactNumber: { $regex: String(q), $options: "i" } },
      ];
    }

    const perPage = limit ? Math.min(Number(limit), 5000) : null; // No limit if not specified
    const skip = perPage ? (Number(page) - 1) * perPage : 0;

    let query = Vendor.find(where).sort({ createdAt: -1 });
    if (perPage) {
      query = query.skip(skip).limit(perPage);
    }

    const [vendors, total] = await Promise.all([
      query.lean(),
      Vendor.countDocuments(where),
    ]);

    res.json({ vendors, total, page: Number(page), limit: perPage });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getVendor = async (req, res) => {
  try {
    const { id } = req.params;

    const vendor = await Vendor.findById(id);
    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    // Check if vendor belongs to the same client
    const sameTenant = String(vendor.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    res.json(vendor);
  } catch (err) {
    console.error("Error fetching vendor:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getVendorBalance = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { companyId } = req.query;

    const vendor = await Vendor.findById(vendorId);

    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    // Check if vendor belongs to the same client
    const sameTenant = String(vendor.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Calculate company-specific balance if companyId is provided
    if (companyId) {
      // Always calculate from transactions to ensure accuracy
      // Import required models
      const PurchaseEntry = require("../models/PurchaseEntry");
      const PaymentEntry = require("../models/PaymentEntry");

      // Get all purchase entries for this vendor and company
      const purchaseEntries = await PurchaseEntry.find({
        client: req.auth.clientId,
        vendor: vendorId,
        company: companyId
      });

      // Get all payment entries for this vendor and company
      const paymentEntries = await PaymentEntry.find({
        client: req.auth.clientId,
        vendor: vendorId,
        company: companyId,
        paymentMethod: { $ne: "Credit" } // Exclude credit payments
      });

      // Calculate balance: payments - purchases (negative = payable, positive = advance)
      const totalPurchases = purchaseEntries.reduce((sum, entry) => sum + (entry.totalAmount || 0), 0);
      const totalPayments = paymentEntries.reduce((sum, entry) => sum + (entry.amount || 0), 0);
      const companyBalance = totalPayments - totalPurchases;

      // Store the calculated balance for future use
      if (!vendor.balances) vendor.balances = new Map();
      vendor.balances.set(companyId, companyBalance);
      await vendor.save();

      res.json({ balance: companyBalance });
    } else {
      // Return stored balance for all companies (legacy support)
      res.json({ balance: vendor.balance || 0 });
    }
  } catch (err) {
    console.error("Error fetching vendor balance:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// GET /api/vendors/balances
exports.getVendorBalancesBulk = async (req, res) => {
  try {
    const where = { createdByClient: req.auth.clientId };

    const rows = await Vendor.find(where)
      .select({ _id: 1, balance: 1 })
      .lean();

    const balances = {};

    return res.json({ balances });
  } catch (err) {
    console.error("getVendorBalancesBulk error:", err);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.updateVendor = async (req, res) => {
  try {
    const doc = await Vendor.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Vendor not found" });

    const sameTenant = String(doc.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const up = req.body;
    if (up.vendorName != null) doc.vendorName = up.vendorName;
    if (up.contactNumber != null) doc.contactNumber = up.contactNumber;
    if (up.email != null) doc.email = up.email;
    if (up.address != null) doc.address = up.address;
    if (up.city != null) doc.city = up.city;
    if (up.state != null) doc.state = up.state;
    if (up.gstin != null) doc.gstin = up.gstin;
    if (up.gstRegistrationType != null) doc.gstRegistrationType = up.gstRegistrationType;
    if (up.pan != null) doc.pan = up.pan;
    if (typeof up.isTDSApplicable === "boolean") doc.isTDSApplicable = up.isTDSApplicable;

    await doc.save();

    // Notify admin after vendor updated
    await notifyAdminOnVendorAction({
      req,
      action: "update",
      vendorName: doc.vendorName,
      entryId: doc._id,
    });

    res.json({ message: "Vendor updated", vendor: doc });
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

exports.deleteVendor = async (req, res) => {
  try {
    const doc = await Vendor.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Vendor not found" });

    const sameTenant = String(doc.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Notify admin before deleting
    await notifyAdminOnVendorAction({
      req,
      action: "delete",
      vendorName: doc.vendorName,
      entryId: doc._id,
    });

    await doc.deleteOne();
    res.json({ message: "Vendor deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Download import template
exports.downloadImportTemplate = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    // permission gate (non-privileged must have explicit capability)
    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canCreateVendors) {
      return res.status(403).json({ message: "Not allowed to import vendors" });
    }

    // Create Excel template with headers
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Vendor Import Template');

    // Define columns
    worksheet.columns = [
      { header: 'Vendor Name*', key: 'vendorname*', width: 20 },
      { header: 'Contact Number', key: 'contactnumber', width: 15 },
      { header: 'Email', key: 'email', width: 25 },
      { header: 'Address', key: 'address', width: 30 },
      { header: 'City', key: 'city', width: 15 },
      { header: 'State', key: 'state', width: 15 },
      { header: 'GSTIN', key: 'gstin', width: 15 },
      { header: 'GST Registration Type', key: 'gstregistrationtype', width: 20 },
      { header: 'PAN', key: 'pan', width: 15 },
      { header: 'TDS Applicable (Yes/No)', key: 'istdsapplicable', width: 20 },
      { header: 'TDS Section', key: 'tdssection', width: 15 }
    ];

    // Add sample data row
    worksheet.addRow({
      'vendorname*': 'ABC Suppliers',
      contactnumber: '9876543210',
      email: 'contact@abc.com',
      address: '123 Main Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      gstin: '22AAAAA0000A1Z5',
      gstregistrationtype: 'Regular',
      pan: 'AAAAA0000A',
      'istdsapplicable': 'Yes',
      tdssection: '194C'
    });

    // Style the header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE6E6FA' }
    };

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="vendor_import_template.xlsx"');

    // Write to response
    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Error generating template:', err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Import vendors from CSV (matching customer import pattern)
exports.importVendors = async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ message: "No file uploaded." });
  }

  try {
    await ensureAuthCaps(req);

    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canCreateVendors) {
      return res.status(403).json({ message: "Not allowed to create vendors" });
    }

    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      return res.status(400).json({ message: "Please upload a CSV file." });
    }

    const fileContent = file.buffer.toString('utf8');
    const records = parseCSV(fileContent);


    if (records.length === 0) {
      return res.status(400).json({ message: "CSV file is empty or could not be parsed." });
    }

    let importedCount = 0;
    const errors = [];

    // Define valid GST types
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
        // Normalize column names to handle variations (like customer import does)
        const normalizedRow = {};
        Object.keys(row).forEach(key => {
          const normalizedKey = key.toLowerCase()
            .replace(/\s+/g, '')
            .replace(/[^\w]/g, '')
            .replace(/\*/g, '');
          normalizedRow[normalizedKey] = row[key];
        });


        // Map columns (handle variations in column names)
        const vendorData = {
          vendorName: normalizedRow.vendorname || normalizedRow.name || row['Vendor Name'] || '',
          contactNumber: normalizedRow.contactnumber || normalizedRow.contact || normalizedRow.phone || '',
          email: normalizedRow.email || '',
          address: normalizedRow.address || '',
          city: normalizedRow.city || '',
          state: normalizedRow.state || '',
          gstin: normalizedRow.gstin || '',
          gstRegistrationType: normalizedRow.gstregistrationtype || normalizedRow.gsttype || 'Unregistered',
          pan: normalizedRow.pan || '',
          isTDSApplicable: (normalizedRow.istdsapplicable || normalizedRow.tdsapplicable || 'no').toString().toLowerCase() === 'yes',
          tdsSection: normalizedRow.tdssection || '',
          createdByClient: req.auth.clientId,
          createdByUser: req.auth.userId,
        };

        // Validate required fields
        if (!vendorData.vendorName || vendorData.vendorName.trim() === '') {
          errors.push(`Row ${rowNumber}: Vendor Name is required`);
          continue;
        }

        // Normalize GST registration type
        if (vendorData.gstRegistrationType && gstTypeMapping[vendorData.gstRegistrationType]) {
          vendorData.gstRegistrationType = gstTypeMapping[vendorData.gstRegistrationType];
        }

        // Validate GST Registration Type against actual schema enum
        if (vendorData.gstRegistrationType && !validGstTypes.includes(vendorData.gstRegistrationType)) {
          errors.push(`Row ${rowNumber}: Invalid GST registration type "${vendorData.gstRegistrationType}". Must be one of: ${validGstTypes.join(', ')}`);
          continue;
        }

        // Clear GSTIN if unregistered
        if (vendorData.gstRegistrationType === 'Unregistered') {
          vendorData.gstin = '';
        }

        // Validate TDS data
        if (vendorData.isTDSApplicable) {
          if (!vendorData.tdsSection || vendorData.tdsSection.trim() === '') {
            errors.push(`Row ${rowNumber}: TDS Section is required when TDS is applicable`);
            continue;
          }
        } else {
          vendorData.tdsSection = '';
        }

        // Check for duplicates (vendor name within same client)
        const existingVendor = await Vendor.findOne({
          vendorName: vendorData.vendorName.trim(),
          createdByClient: req.auth.clientId
        });

        if (existingVendor) {
          errors.push(`Row ${rowNumber}: Vendor name '${vendorData.vendorName}' already exists`);
          continue;
        }

        // Create new vendor
        const newVendor = new Vendor(vendorData);
        const savedVendor = await newVendor.save();
        importedCount++;

        // Notify admin for each imported vendor
        await notifyAdminOnVendorAction({
          req,
          action: "create",
          vendorName: savedVendor.vendorName,
          entryId: savedVendor._id,
        });

      } catch (error) {
        console.error(`Error processing row ${rowNumber}:`, error);
        if (error.code === 11000) {
          const field = Object.keys(error.keyValue)[0];
          errors.push(`Row ${rowNumber}: Duplicate ${field} - ${error.keyValue[field]}`);
        } else if (error.name === 'ValidationError') {
          // Handle mongoose validation errors
          const validationErrors = Object.values(error.errors).map(err => err.message);
          errors.push(`Row ${rowNumber}: ${validationErrors.join(', ')}`);
        } else {
          errors.push(`Row ${rowNumber}: ${error.message}`);
        }
      }
    }

    return res.status(200).json({
      message: 'Import completed',
      importedCount: importedCount,
      totalCount: records.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error("Error importing vendors:", error);
    return res.status(500).json({ 
      message: "Error importing vendors.", 
      error: error.message 
    });
  }
};

// Use the same parseCSV function as customer import
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

  return records;
}