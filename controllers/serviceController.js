const Service = require("../models/Service");
const { resolveClientId } = require("./common/tenant");
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");

function normalizeServiceCompanyIds(input) {
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
          // Ignore parse errors and treat as single string id.
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

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildServiceCompanyScopeFilter(companyId) {
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


// Build message text per action
function buildServiceNotificationMessage(action, { actorName, serviceName }) {
  const sName = serviceName || "Unknown Service";
  switch (action) {
    case "create":
      return `New service created by ${actorName}: ${sName}`;
    case "update":
      return `Service updated by ${actorName}: ${sName}`;
    case "delete":
      return `Service deleted by ${actorName}: ${sName}`;
    default:
      return `Service ${action} by ${actorName}: ${sName}`;
  }
}

// Unified notifier for service module
async function notifyAdminOnServiceAction({ req, action, serviceName, entryId }) {
  const actor = await resolveActor(req);
  const adminUser = await findAdminUser();
  if (!adminUser) {
    console.warn("notifyAdminOnServiceAction: no admin user found");
    return;
  }

  const message = buildServiceNotificationMessage(action, {
    actorName: actor.name,
    serviceName,
  });

  await createNotification(
    message,
    adminUser._id, // recipient (admin)
    actor.id, // actor id (user OR client)
    action, // "create" | "update" | "delete"
    "service", // entry type / category
    entryId, // service id
    req.auth.clientId
  );
}

// Create
exports.createService = async (req, res) => {
  try {
    const { serviceName, amount, description, sac, company, companies } = req.body;
    const normalizedCompanies = normalizeServiceCompanyIds(
      companies !== undefined ? companies : company
    );
    const normalizedName = String(serviceName || "").trim();

    const existingService = normalizedName
      ? await Service.findOne({
          createdByClient: req.auth.clientId,
          serviceName: {
            $regex: new RegExp(`^${escapeRegex(normalizedName)}$`, "i"),
          },
        })
      : null;

    if (existingService) {
      const currentCompanyIds = normalizeServiceCompanyIds(
        Array.isArray(existingService.companies) && existingService.companies.length > 0
          ? existingService.companies
          : existingService.company
      );

      let mergedCompanyIds = currentCompanyIds;

      if (normalizedCompanies.length === 0) {
        // New request asks for global availability.
        mergedCompanyIds = [];
      } else if (currentCompanyIds.length > 0) {
        mergedCompanyIds = Array.from(
          new Set([...currentCompanyIds, ...normalizedCompanies])
        );
      }
      // If current service is already global (no companies), keep it global.

      existingService.company =
        mergedCompanyIds.length === 1 ? mergedCompanyIds[0] : undefined;
      existingService.companies = mergedCompanyIds;

      // Keep service details fresh when user creates same service from another screen.
      if (typeof amount === "number" && amount >= 0) existingService.amount = amount;
      if (typeof description === "string") existingService.description = description;
      if (sac !== undefined) existingService.sac = sac;

      await existingService.save();

      if (global.io) {
        global.io.to(`client-${req.auth.clientId}`).emit("service-update", {
          message: "Service updated",
          serviceId: existingService._id,
          serviceName: existingService.serviceName,
          action: "update",
        });
        global.io.to("all-inventory-updates").emit("service-update", {
          message: "Service updated",
          serviceId: existingService._id,
          serviceName: existingService.serviceName,
          action: "update",
          clientId: req.auth.clientId,
        });
      }

      await notifyAdminOnServiceAction({
        req,
        action: "update",
        serviceName: existingService.serviceName,
        entryId: existingService._id,
      });

      return res.status(200).json({
        message: "Service already exists. Company mapping updated.",
        service: existingService,
      });
    }

    const service = await Service.create({
      serviceName,
      amount,
      description,
      sac,
      company: normalizedCompanies.length === 1 ? normalizedCompanies[0] : undefined,
      companies: normalizedCompanies,
      createdByClient: req.auth.clientId,  // TENANT
      createdByUser: req.auth.userId,    // ACTOR (remove if not in schema)
    });

    await service.save();

    // Emit service update event via socket
    if (global.io) {
      console.log('📡 Emitting service-update event for client:', req.auth.clientId);
      global.io.to(`client-${req.auth.clientId}`).emit('service-update', {
        message: 'Service created',
        serviceId: service._id,
        serviceName: service.serviceName,  // 👇 NEW: Include service name
        action: 'create'
      });
      
      // 👇 NEW: Also emit to all-inventory-updates room for admins and users
      global.io.to('all-inventory-updates').emit('service-update', {
        message: 'Service created',
        serviceId: service._id,
        serviceName: service.serviceName,  // 👇 NEW: Include service name
        action: 'create',
        clientId: req.auth.clientId
      });
    }

    // Notify admin after service created
    await notifyAdminOnServiceAction({
      req,
      action: "create",
      serviceName: service.serviceName,
      entryId: service._id,
    });

    res.status(201).json({ message: "Service created", service });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "Service already exists for this client" });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Get all
exports.getServices = async (req, res) => {
 try {
 const requestedClientId = req.query.clientId || req.auth.clientId;
 const {
 q,
 companyId,
 company,
 page = 1,
 limit = 100,
  } = req.query;
 const isPrivileged = ["master", "admin"].includes(req.auth.role);
 if (!isPrivileged && requestedClientId !== req.auth.clientId) {
 return res.status(403).json({ message: "Not authorized to view this client's data." });
 }
 const where = { createdByClient: requestedClientId };
 if (q) {
 where.serviceName = { $regex: String(q), $options: "i" };
 }
  const resolvedCompanyId = companyId || company;
  if (resolvedCompanyId && resolvedCompanyId !== "all") {
 Object.assign(where, buildServiceCompanyScopeFilter(String(resolvedCompanyId)));
  }
  const perPage = Math.min(Number(limit) || 100, 500);
  const skip = (Number(page) - 1) * perPage;
  const [items, total] = await Promise.all([
 Service.find(where)
 .populate("company")
 .populate("companies")
 .sort({ createdAt: -1 })
 .skip(skip)
 .limit(perPage)
 .lean(),
 Service.countDocuments(where),
  ]);
 return res.json({
services: items,
 total,
 page: Number(page),
 limit: perPage,
 });
 } catch (err) {
 return res.status(500).json({ message: "Server error", error: err.message });
 }
};

// Update
exports.updateService = async (req, res) => {
  try {
    const service = await Service.findById(req.params.id);
    if (!service) return res.status(404).json({ message: "Service not found" });

    const privileged = ["master", "client", "admin"].includes(req.auth.role);
    const sameTenant = String(service.createdByClient) === req.auth.clientId;
    if (!privileged && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { serviceName, amount, description, sac, company, companies } = req.body;
    if (serviceName) service.serviceName = serviceName;
    if (typeof amount === "number" && amount >= 0) service.amount = amount;
    if (typeof description === "string") service.description = description;
    if (sac !== undefined) service.sac = sac;

    const hasCompany =
      Object.prototype.hasOwnProperty.call(req.body, "company") ||
      Object.prototype.hasOwnProperty.call(req.body, "companies");
    if (hasCompany) {
      const normalizedCompanies = normalizeServiceCompanyIds(
        Object.prototype.hasOwnProperty.call(req.body, "companies")
          ? companies
          : company
      );
      service.companies = normalizedCompanies;
      service.company =
        normalizedCompanies.length === 1 ? normalizedCompanies[0] : undefined;
    }

    await service.save();

    // Emit service update event via socket
    if (global.io) {
      console.log('📡 Emitting service-update event for client:', req.auth.clientId);
      global.io.to(`client-${req.auth.clientId}`).emit('service-update', {
        message: 'Service updated',
        serviceId: service._id,
        serviceName: service.serviceName,  // 👇 NEW: Include service name
        action: 'update'
      });
      
      // 👇 NEW: Also emit to all-inventory-updates room for admins and users
      global.io.to('all-inventory-updates').emit('service-update', {
        message: 'Service updated',
        serviceId: service._id,
        serviceName: service.serviceName,  // 👇 NEW: Include service name
        action: 'update',
        clientId: req.auth.clientId
      });
    }

    // Notify admin after service updated
    await notifyAdminOnServiceAction({
      req,
      action: "update",
      serviceName: service.serviceName,
      entryId: service._id,
    });

    res.json({ message: "Service updated", service });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "Duplicate service details" });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Delete
exports.deleteService = async (req, res) => {
  try {
    const service = await Service.findById(req.params.id);
    if (!service) return res.status(404).json({ message: "Service not found" });

    const privileged = ["master", "client", "admin"].includes(req.auth.role);
    const sameTenant = String(service.createdByClient) === req.auth.clientId;
    if (!privileged && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Store service name before deletion for socket emission
    const serviceName = service.serviceName;
    const serviceId = service._id;

    // Notify admin before deleting
    await notifyAdminOnServiceAction({
      req,
      action: "delete",
      serviceName: serviceName,
      entryId: serviceId,
    });

    await service.deleteOne();

    // 👇 FIXED: Emit service update event via socket AFTER deletion
    if (global.io) {
      console.log('📡 Emitting service-update event for client:', req.auth.clientId);
      global.io.to(`client-${req.auth.clientId}`).emit('service-update', {
        message: 'Service deleted',
        serviceId: serviceId,
        serviceName: serviceName,  // 👇 NEW: Include service name for better tracking
        action: 'delete'
      });
      
      // 👇 NEW: Also emit to all-inventory-updates room for admins and users
      global.io.to('all-inventory-updates').emit('service-update', {
        message: 'Service deleted',
        serviceId: serviceId,
        serviceName: serviceName,  // 👇 NEW: Include service name for better tracking
        action: 'delete',
        clientId: req.auth.clientId
      });
    }

    res.json({ message: "Service deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};


exports.getServiceById = async (req, res) => {
  try {
    const doc = await Service.findOne({
      _id: req.params.id,
      createdByClient: req.auth.clientId,
    })
      .populate("company")
      .populate("companies");
    if (!doc) return res.status(404).json({ message: "Service not found" });

    const service = { ...doc.toObject(), name: doc.serviceName };
    res.json({ service });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Download import template
exports.downloadImportTemplate = async (req, res) => {
  try {
    // Create Excel template with headers
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Services Import Template');

    // Define columns
    worksheet.columns = [
      { header: 'Service Name*', key: 'serviceName', width: 25 },
      { header: 'Amount', key: 'amount', width: 15 },
      { header: 'Description', key: 'description', width: 30 },
      { header: 'SAC Code', key: 'sac', width: 15 }
    ];

    // Add sample data row
    worksheet.addRow({
      serviceName: 'Software Development',
      amount: 50000,
      description: 'Custom software development services',
      sac: '998314'
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
    res.setHeader('Content-Disposition', 'attachment; filename="services_import_template.xlsx"');
    res.send(buffer);

  } catch (err) {
    console.error('Error generating template:', err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Import services from Excel/CSV
exports.importServices = async (req, res) => {
  try {
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
              cellValue = cell.hyperlink;
            } else if (cell.value && typeof cell.value === 'object' && cell.value.text) {
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

    const importCompanyIds = normalizeServiceCompanyIds(
      req.body?.companyIds ?? req.body?.companyId ?? req.body?.company
    );

    let importedCount = 0;
    const errors = [];

    console.log(`Starting import of ${rows.length} rows...`);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log(`Processing row ${i + 2}:`, row);
      try {
        // Map columns
        const serviceData = {
          serviceName: row.servicename || row['servicename*'],
          amount: row.amount,
          description: row.description,
          sac: row.sac || row.saccode,
          company: importCompanyIds.length === 1 ? importCompanyIds[0] : undefined,
          companies: importCompanyIds,
          createdByClient: req.auth.clientId,
          createdByUser: req.auth.userId,
        };

        // Validate required fields
        if (!serviceData.serviceName || serviceData.serviceName.toString().trim().length < 2) {
          errors.push(`Row ${i + 2}: Service name is required and must be at least 2 characters`);
          continue;
        }

        // Clean and validate data
        serviceData.serviceName = serviceData.serviceName.toString().trim().toLowerCase();
        if (serviceData.amount !== undefined && serviceData.amount !== null && serviceData.amount !== '') {
          const amount = parseFloat(serviceData.amount);
          if (isNaN(amount) || amount < 0) {
            errors.push(`Row ${i + 2}: Amount must be a valid positive number`);
            continue;
          }
          serviceData.amount = amount;
        } else {
          serviceData.amount = 0;
        }
        if (serviceData.description) serviceData.description = serviceData.description.toString().trim();
        if (serviceData.sac) serviceData.sac = serviceData.sac.toString().trim();

        // Check for duplicate service name within the same client
        const existingService = await Service.findOne({
          serviceName: serviceData.serviceName,
          createdByClient: req.auth.clientId
        });

        if (existingService) {
          errors.push(`Row ${i + 2}: Service "${serviceData.serviceName}" already exists`);
          continue;
        }

        // Create service
        console.log(`Creating service for row ${i + 2}:`, serviceData);
        const createdService = await Service.create(serviceData);
        importedCount++;
        console.log(`Successfully imported row ${i + 2}: ${createdService._id}`);

        // Notify admin (with error handling)
        try {
          await notifyAdminOnServiceAction({
            req,
            action: "create",
            serviceName: serviceData.serviceName,
            entryId: createdService._id,
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
