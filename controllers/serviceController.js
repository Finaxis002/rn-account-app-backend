const Service = require("../models/Service");
const { resolveClientId } = require("./common/tenant");
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");


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
    const { serviceName, amount, description, sac } = req.body;
    const service = await Service.create({
      serviceName,
      amount,
      description,
      sac,
      createdByClient: req.auth.clientId,  // TENANT
      createdByUser: req.auth.userId,    // ACTOR (remove if not in schema)
    });

    await service.save();

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
 if (companyId) {

 where.company = companyId; 
 }
 const perPage = Math.min(Number(limit) || 100, 500);
 const skip = (Number(page) - 1) * perPage;
 const [items, total] = await Promise.all([
 Service.find(where).sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),
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

    const { serviceName, amount, description, sac } = req.body;
    if (serviceName) service.serviceName = serviceName;
    if (typeof amount === "number" && amount >= 0) service.amount = amount;
    if (typeof description === "string") service.description = description;
    if (sac !== undefined) service.sac = sac;

    await service.save();

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

    // Notify admin before deleting
    await notifyAdminOnServiceAction({
      req,
      action: "delete",
      serviceName: service.serviceName,
      entryId: service._id,
    });

    await service.deleteOne();
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
    });
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