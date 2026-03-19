// controllers/bankDetailController.js
const BankDetail = require("../models/BankDetail");
const Company = require("../models/Company");
const Client = require("../models/Client");
const jwt = require('jsonwebtoken');
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");
const { getEffectivePermissions } = require("../services/effectivePermissions");

const PRIV_ROLES = new Set(["master", "client", "admin"]);

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


// Build message text per action for bank details
function buildBankDetailNotificationMessage(action, { actorName, bankName }) {
  const bName = bankName || "Unknown Bank";
  switch (action) {
    case "create":
      return `New bank detail created by ${actorName}: ${bName}`;
    case "update":
      return `Bank detail updated by ${actorName}: ${bName}`;
    case "delete":
      return `Bank detail deleted by ${actorName}: ${bName}`;
    default:
      return `Bank detail ${action} by ${actorName}: ${bName}`;
  }
}



// Unified notifier for bank detail module
async function notifyAdminOnBankDetailAction({ req, action, bankName, entryId }) {
  const actor = await resolveActor(req);
  const adminUser = await findAdminUser();
  if (!adminUser) {
    console.warn("notifyAdminOnBankDetailAction: no admin user found");
    return;
  }

  const message = buildBankDetailNotificationMessage(action, {
    actorName: actor.name,
    bankName,
  });

  await createNotification(
    message,
    adminUser._id, // recipient (admin)
    actor.id, // actor id (user OR client)
    action, // "create" | "update" | "delete"
    "vendor", // entry type / category - using vendor as it's a valid enum
    entryId, // bank detail id
    req.auth.clientId
  );
}

/** Build DB filter from query params & auth */
function buildFilter(req) {
  const f = {};
  // If you use req.user / req.auth, prefer limiting by client automatically
  // Example (align with your existing auth shape):
  if (req.user && req.user.role === "client") {
    f.client = req.user.id;
  }
  if (req.query.clientId) f.client = req.query.clientId;
  if (req.query.companyId) f.company = req.query.companyId;
  if (req.query.city) f.city = new RegExp(`^${req.query.city}$`, "i");
  if (req.query.bankName) f.bankName = new RegExp(req.query.bankName, "i");
  return f;
}

/** POST /api/bank-details */
exports.createBankDetail = async (req, res) => {
  try {
    // Extract client ID from the token
    const token = req.headers.authorization.split(" ")[1]; // Get the token from headers
    const decodedToken = jwt.verify(token, process.env.JWT_SECRET); // Use your JWT secret key to verify the token

    // Create a new BankDetail with the client ID
    const { company, bankName, managerName, contactNumber, email, city, accountNo, ifscCode, branchAddress, upiId, upiName, upiMobile } = req.body;

    // Construct upiDetails object from separate fields
    const upiDetails = {
      upiId: upiId || undefined,
      upiName: upiName || undefined,
      upiMobile: upiMobile || undefined,
    };

    const newBankDetail = new BankDetail({
      client:req.auth.clientId, // Assign the client from the token
      user:req.auth.userId,
      company,
      bankName,
      // managerName,
      // contactNumber,
      // email,
      city,
      accountNo,
      ifscCode,
      branchAddress,
      upiDetails,
      qrCode: req.file ? req.file.path : undefined, // Save QR code file path if uploaded
      createdByUser: decodedToken.userId, // If you want to assign the user who is creating the bank detail
    });

    await newBankDetail.save();

    // Notify admin after bank detail created
    await notifyAdminOnBankDetailAction({
      req,
      action: "create",
      bankName: newBankDetail.bankName,
      entryId: newBankDetail._id,
    });

    res.status(201).json({ message: "Bank detail created successfully", bankDetail: newBankDetail });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: "Error creating bank detail" });
  }
};

/** GET /api/bank-details (list with search, filters, pagination) */
// exports.getBankDetails = async (req, res) => {
//   try {
//     const page = Math.max(parseInt(req.query.page || "1", 10), 1);
//     const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
//     const skip = (page - 1) * limit;

//     const filter = buildFilter(req);

//     // simple text search
//     const search = (req.query.search || "").trim();
//     const findQuery = BankDetail.find(
//       search
//         ? {
//             $and: [
//               filter,
//               { $text: { $search: search } },
//             ],
//           }
//         : filter
//     )
//       .populate("client", "contactName email")
//       .populate("company", "businessName")
//       .sort({ createdAt: -1 })
//       .skip(skip)
//       .limit(limit);

//     const [items, total] = await Promise.all([
//       findQuery.exec(),
//       BankDetail.countDocuments(search ? { $and: [filter, { $text: { $search: search } }] } : filter),
//     ]);

//     return res.status(200).json({
//       success: true,
//       page,
//       limit,
//       total,
//       data: items,
//     });
//   } catch (err) {
//     console.error("getBankDetails error:", err);
//     return res.status(500).json({ message: "Failed to fetch bank details", error: err.message });
//   }
// };


/** GET /api/bank-details */
exports.getBankDetails = async (req, res) => {
  try {
    const { role, companies = [], createdByClient } = req.user || {};
    let query;

    // Employees (including admin) → only explicitly assigned companies
    if (["user", "manager", "admin"].includes(role)) {
      if (!Array.isArray(companies) || companies.length === 0) {
        return res.json([]);
      }
      query = { company: { $in: companies } };
    }
    // Tenant owners
    else if (["client", "customer"].includes(role)) {
      query = { client: req.user.id };
    }
    // Master (optional: constrain to tenant if you want)
    else if (role === "master") {
      query = createdByClient ? { client: createdByClient } : {};
    } else {
      return res.status(403).json({ message: "Forbidden" });
    }

    const bankDetails = await BankDetail.find(query)
      .populate("client", "contactName email")
      .populate("company", "businessName")
      .lean();

    return res.json(bankDetails);
  } catch (err) {
    console.error("getMyBankDetails error:", err);
    return res.status(500).json({ message: "Failed to fetch bank details", error: err.message });
  }
};


/** GET /api/bank-details/options?companyId=...&q=... */
exports.listBanksForCompany = async (req, res) => {
  try {
    const { companyId, q, createdByClient } = req.query;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required" });
    }

    const { role, companies = [], id: userId } = req.user || {};
    const base = { company: companyId };

    // 🔐 Access control consistent with your getBankDetails
    if (["user", "manager", "admin"].includes(role)) {
      if (!Array.isArray(companies) || !companies.includes(companyId)) {
        return res.status(403).json({ message: "Not allowed for this company" });
      }
      // base.company already set
    } else if (["client", "customer"].includes(role)) {
      base.client = req.user.id;
    } else if (role === "master") {
      if (createdByClient) base.client = createdByClient;
      // else: all tenants allowed (or add tenant scoping if you prefer)
    } else {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (q) base.bankName = new RegExp(q, "i");

    const docs = await BankDetail.find(base)
      .select("_id bankName ifscCode city branchAddress")
      .sort({ bankName: 1 })
      .lean();

    // Shape for dropdown
    const options = docs.map(d => ({
      value: d._id,
      label: `${d.bankName}${d.city ? " — " + d.city : ""}${d.ifscCode ? " (" + d.ifscCode + ")" : ""}`,
      bankName: d.bankName,
      ifscCode: d.ifscCode,
      city: d.city,
      branchAddress: d.branchAddress,
    }));

    return res.json(options);
  } catch (err) {
    console.error("listBanksForCompany error:", err);
    return res.status(500).json({ message: "Failed to fetch bank options", error: err.message });
  }
};


/** GET /api/bank-details/:id */
exports.getBankDetailById = async (req, res) => {
  try {
    const doc = await BankDetail.findById(req.params.id)
      .populate("client", "contactName email")
      .populate("company", "businessName");
    if (!doc) return res.status(404).json({ message: "Bank detail not found" });
    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    console.error("getBankDetailById error:", err);
    return res.status(500).json({ message: "Failed to fetch bank detail", error: err.message });
  }
};

/** PUT /api/bank-details/:id */
exports.updateBankDetail = async (req, res) => {
  try {
    // Construct upiDetails object from separate fields
    const upiDetails = {
      upiId: req.body.upiId || undefined,
      upiName: req.body.upiName || undefined,
      upiMobile: req.body.upiMobile || undefined,
    };

    const update = {
      client: req.body.client,
      company: req.body.company,
      clientName: req.body.clientName,
      businessName: req.body.businessName,
      bankName: req.body.bankName,
      // managerName: req.body.managerName,
      // contactNumber: req.body.contactNumber,
      post: req.body.post,
      // email: req.body.email,
      city: req.body.city,
      accountNo: req.body.accountNo,
      ifscCode: req.body.ifscCode,
      branchAddress: req.body.branchAddress,
      upiDetails,
      qrCode: req.file ? req.file.path : req.body.qrCode, // Update QR code if new file uploaded, otherwise keep existing
    };

    // remove undefined keys to avoid overwriting with undefined
    Object.keys(update).forEach((k) => update[k] === undefined && delete update[k]);

    const doc = await BankDetail.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!doc) return res.status(404).json({ message: "Bank detail not found" });

    // Notify admin after bank detail updated
    await notifyAdminOnBankDetailAction({
      req,
      action: "update",
      bankName: doc.bankName,
      entryId: doc._id,
    });

    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    console.error("updateBankDetail error:", err);
    return res.status(500).json({ message: "Failed to update bank detail", error: err.message });
  }
};

/** DELETE /api/bank-details/:id */
exports.deleteBankDetail = async (req, res) => {
  try {
    const doc = await BankDetail.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: "Bank detail not found" });

    // Notify admin before deleting
    await notifyAdminOnBankDetailAction({
      req,
      action: "delete",
      bankName: doc.bankName,
      entryId: doc._id,
    });

    return res.status(200).json({ success: true, message: "Bank detail deleted" });
  } catch (err) {
    console.error("deleteBankDetail error:", err);
    return res.status(500).json({ message: "Failed to delete bank detail", error: err.message });
  }
};


// Download import template
exports.downloadImportTemplate = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    // permission gate (non-privileged must have explicit capability)
    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canCreateVendors) {
      return res.status(403).json({ message: "Not allowed to download bank details template" });
    }

    // Create Excel template with headers
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Bank Details Import Template');

    // Define columns with clean keys (no special characters)
    worksheet.columns = [
      { header: 'Company*', key: 'company', width: 25 },
      { header: 'Bank Name*', key: 'bankName', width: 25 },
      // { header: 'Manager Name', key: 'managerName', width: 20 },
      // { header: 'Contact Number', key: 'contactNumber', width: 15 },
      // { header: 'Email', key: 'email', width: 25 },
      { header: 'City', key: 'city', width: 15 },
      { header: 'Account No*', key: 'accountNo', width: 20 },
      { header: 'IFSC Code', key: 'ifscCode', width: 15 },
      { header: 'Branch Address', key: 'branchAddress', width: 30 },
      { header: 'UPI ID', key: 'upiId', width: 20 },
      { header: 'UPI Name', key: 'upiName', width: 20 },
      { header: 'UPI Mobile', key: 'upiMobile', width: 15 }
    ];

    // Add sample data row
    worksheet.addRow({
      company: 'ABC Company Ltd',
      bankName: 'State Bank of India',
      // managerName: 'Rajesh Kumar',
      // contactNumber: '9876543210',
      // email: 'manager@sbi.com',
      city: 'Mumbai',
      accountNo: '123456789012',
      ifscCode: 'SBIN0001234',
      branchAddress: '123 Main Street, Mumbai, Maharashtra',
      upiId: 'rajeshkumar@sbi',
      upiName: 'Rajesh Kumar',
      upiMobile: '9876543210'
    });

    // Style the header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE6E6FA' }
    };

    // Style the sample data row
    worksheet.getRow(2).font = { italic: true };
    worksheet.getRow(2).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF0F8FF' }
    };

    // Generate buffer and send response
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="bank_details_import_template.xlsx"');
    res.send(buffer);

  } catch (err) {
    console.error('Error generating template:', err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Import bank details from Excel/CSV
exports.importBankDetails = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    // permission gate (non-privileged must have explicit capability)
    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canCreateVendors) {
      return res.status(403).json({ message: "Not allowed to import bank details" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    let worksheet;

    // Determine file type and read accordingly
    if (req.file.originalname.endsWith('.csv')) {
      // Handle CSV
      const csv = require('csv-parser');
      const results = [];

      const buffer = req.file.buffer;
      const stream = require('stream');
      const bufferStream = new stream.PassThrough();
      bufferStream.end(buffer);

      await new Promise((resolve, reject) => {
        bufferStream
          .pipe(csv())
          .on('data', (data) => results.push(data))
          .on('end', resolve)
          .on('error', reject);
      });

      // Convert CSV data to worksheet format
      worksheet = workbook.addWorksheet('Data');
      if (results.length > 0) {
        worksheet.columns = Object.keys(results[0]).map(key => ({ header: key, key }));
        results.forEach(row => worksheet.addRow(row));
      }
    } else {
      // Handle Excel
      await workbook.xlsx.load(req.file.buffer);
      worksheet = workbook.getWorksheet(1);
      if (!worksheet) {
        return res.status(400).json({ message: "No worksheet found in Excel file" });
      }
    }

    // Check if file is empty or has no data rows
    if (worksheet.rowCount <= 1) {
      return res.status(400).json({ message: "File appears to be empty or contains no data rows" });
    }

    const rows = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) { // Skip header row
        const rowData = {};
        row.eachCell((cell, colNumber) => {
          const header = worksheet.getRow(1).getCell(colNumber).value;
          if (header) {
            // Clean header name to match our mapping
            const cleanHeader = header.toString().toLowerCase().replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, '').replace(/[^\w]/g, '');

            // Handle hyperlink cells - extract the text value
            let cellValue = cell.value;
            if (cell.hyperlink) {
              // If it's a hyperlink, use the hyperlink address or display text
              cellValue = cell.hyperlink;
            } else if (cell.value && typeof cell.value === 'object' && cell.value.text) {
              // Some hyperlink cells store value as object with text property
              cellValue = cell.value.text;
            }

            rowData[cleanHeader] = cellValue;
          }
        });
        rows.push(rowData);
      }
    });

    // Limit the number of rows to prevent abuse
    if (rows.length > 1000) {
      return res.status(400).json({ message: "File contains too many rows. Maximum allowed is 1000 rows." });
    }

    let importedCount = 0;
    const errors = [];

    console.log(`Starting import of ${rows.length} rows...`);

    // Get all companies for this client upfront
    const companies = await Company.find({ client: req.auth.clientId });
    console.log(`Found ${companies.length} companies for client ${req.auth.clientId}:`, 
      companies.map(c => c.businessName));

    // Create a normalized company lookup map
    const companyMap = new Map();
    companies.forEach(company => {
      const normalizedKey = normalizeCompanyName(company.businessName);
      companyMap.set(normalizedKey, company);
    });

    console.log('Company lookup map:', Array.from(companyMap.keys()));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log(`Processing row ${i + 2}:`, row);
      try {
        // Map columns (handle variations in column names)
        const companyName = row.company || row['company*'];
        
        if (!companyName) {
          errors.push(`Row ${i + 2}: Company name is required`);
          continue;
        }

        const normalizedCompanyName = companyName.toString().trim();
        console.log(`Looking up company: "${normalizedCompanyName}" (normalized: "${normalizeCompanyName(normalizedCompanyName)}")`);

        // Normalize the input company name for matching
        const searchKey = normalizeCompanyName(normalizedCompanyName);
        
        // Find company using normalized key
        const company = companyMap.get(searchKey);

        if (!company) {
          const availableCompanies = companies.map(c => `"${c.businessName}"`).join(', ');
          errors.push(`Row ${i + 2}: Company "${normalizedCompanyName}" not found. Available companies: ${availableCompanies}`);
          continue;
        }

        console.log(`Found company: "${company.businessName}" (ID: ${company._id})`);

        const bankDetailData = {
          company: company._id,
          bankName: row.bankname || row['bankname*'],
          // managerName: row.managername,
          // contactNumber: row.contactnumber,
          // email: row.email,
          city: row.city,
          accountNo: row.accountno || row['accountno*'],
          ifscCode: row.ifscode,
          branchAddress: row.branchaddress,
          upiDetails: {
            upiId: row.upiid,
            upiName: row.upiname,
            upiMobile: row.upimobile,
          },
          client: req.auth.clientId,
          user: req.auth.userId,
        };

        // Validate required fields
        if (!bankDetailData.bankName || bankDetailData.bankName.toString().trim().length < 2) {
          errors.push(`Row ${i + 2}: Bank name is required and must be at least 2 characters`);
          continue;
        }
        if (!bankDetailData.accountNo || bankDetailData.accountNo.toString().trim().length < 1) {
          errors.push(`Row ${i + 2}: Account number is required`);
          continue;
        }

        // Clean and validate data
        bankDetailData.bankName = bankDetailData.bankName.toString().trim();
        // if (bankDetailData.managerName) bankDetailData.managerName = bankDetailData.managerName.toString().trim();
        // if (bankDetailData.contactNumber) bankDetailData.contactNumber = bankDetailData.contactNumber.toString().trim();
        // if (bankDetailData.email) bankDetailData.email = bankDetailData.email.toString().trim();
        if (bankDetailData.city) bankDetailData.city = bankDetailData.city.toString().trim();
        if (bankDetailData.accountNo) bankDetailData.accountNo = bankDetailData.accountNo.toString().trim();
        if (bankDetailData.ifscCode) bankDetailData.ifscCode = bankDetailData.ifscCode.toString().trim();
        if (bankDetailData.branchAddress) bankDetailData.branchAddress = bankDetailData.branchAddress.toString().trim();
        if (bankDetailData.upiDetails) {
          if (bankDetailData.upiDetails.upiId) bankDetailData.upiDetails.upiId = bankDetailData.upiDetails.upiId.toString().trim();
          if (bankDetailData.upiDetails.upiName) bankDetailData.upiDetails.upiName = bankDetailData.upiDetails.upiName.toString().trim();
          if (bankDetailData.upiDetails.upiMobile) bankDetailData.upiDetails.upiMobile = bankDetailData.upiDetails.upiMobile.toString().trim();
        }

        // Optional validations
        if (bankDetailData.contactNumber && !/^[6-9]\d{9}$/.test(bankDetailData.contactNumber)) {
          errors.push(`Row ${i + 2}: Invalid mobile number format`);
          continue;
        }

        if (bankDetailData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bankDetailData.email)) {
          errors.push(`Row ${i + 2}: Invalid email format`);
          continue;
        }

        // Check for duplicate bank name within the same company
        const existingBankDetail = await BankDetail.findOne({
          bankName: bankDetailData.bankName,
          company: company._id,
          client: req.auth.clientId
        });

        if (existingBankDetail) {
          errors.push(`Row ${i + 2}: Bank "${bankDetailData.bankName}" already exists for company "${company.businessName}"`);
          continue;
        }

        // Create bank detail
        console.log(`Creating bank detail for row ${i + 2}:`, bankDetailData);
        const createdBankDetail = await BankDetail.create(bankDetailData);
        importedCount++;
        console.log(`Successfully imported row ${i + 2}: ${createdBankDetail._id}`);

        // Notify admin (with error handling)
        try {
          await notifyAdminOnBankDetailAction({
            req,
            action: "create",
            bankName: bankDetailData.bankName,
            entryId: createdBankDetail._id,
          });
        } catch (notifyError) {
          console.error(`Notification failed for row ${i + 2}, but import succeeded:`, notifyError.message);
          // Don't fail the import due to notification error
        }

      } catch (err) {
        console.error(`Error importing row ${i + 2}:`, err);
        if (err.code === 11000) {
          const field = Object.keys(err.keyValue)[0];
          errors.push(`Row ${i + 2}: Duplicate ${field} - ${err.keyValue[field]}`);
        } else {
          errors.push(`Row ${i + 2}: ${err.message}`);
        }
      }
    }

    console.log(`Import completed. Imported: ${importedCount}, Errors: ${errors.length}`);
    if (errors.length > 0) {
      console.log('Import errors:', errors);
    }

    res.json({
      message: "Import completed",
      importedCount,
      totalRows: rows.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Helper function to normalize company names (letters and numbers only, case-insensitive)
function normalizeCompanyName(name) {
  return name
    .toString()
    .toLowerCase() // Convert to lowercase
    .replace(/[^a-z0-9]/g, '') // Remove all non-alphanumeric characters (spaces, special chars, etc.)
    .trim();
}

