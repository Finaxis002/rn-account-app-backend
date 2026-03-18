// controllers/transactionsController.js
const mongoose = require("mongoose");
const SalesEntry = require("../models/SalesEntry");
const PurchaseEntry = require("../models/PurchaseEntry");
const ProformaEntry = require("../models/ProformaEntry");
const ReceiptEntry = require("../models/ReceiptEntry");
const PaymentEntry = require("../models/PaymentEntry");
const JournalEntry = require("../models/JournalEntry");
const Company = require("../models/Company");
const Party = require("../models/Party");
const Vendor = require("../models/Vendor");
const { getEffectivePermissions } = require("../services/effectivePermissions");
const User = require("../models/User");

const PRIV_ROLES = new Set(["master", "client", "admin"]);

async function ensureAuthCaps(req) {
  // Normalize auth
  if (!req.auth && req.user) {
    req.auth = {
      clientId: req.user.id,
      userId: req.user.userId || req.user.id,
      role: req.user.role,
      caps: req.user.caps,
      allowedCompanies: req.user.allowedCompanies,
      userName: req.user.userName || "Unknown",
      clientName: req.user.contactName,
    };
  }

  if (!req.auth.caps || !Array.isArray(req.auth.allowedCompanies)) {
    const { caps, allowedCompanies } = await getEffectivePermissions({
      clientId: req.auth.clientId,
      userId: req.auth.userId,
    });
    req.auth.caps = req.auth.caps || caps;
    req.auth.allowedCompanies = req.auth.allowedCompanies || allowedCompanies;
  }

  if (req.auth.role !== "client" && !req.auth.userName && req.auth.userId) {
    const user = await User.findById(req.auth.userId)
      .select("displayName fullName name userName username email")
      .lean();
    req.auth.userName =
      user?.displayName ||
      user?.fullName ||
      user?.name ||
      user?.userName ||
      user?.username ||
      user?.email ||
      undefined;
  }
}

function userIsPriv(req) {
  return PRIV_ROLES.has(req.auth.role);
}

function canBypassCompanyScope(req) {
  return req.auth?.role === "master" || req.auth?.role === "client";
}

function companyAllowedForUser(req, companyId) {
  if (canBypassCompanyScope(req)) return true;
  const allowed = Array.isArray(req.auth.allowedCompanies)
    ? req.auth.allowedCompanies.map(String)
    : [];
  return allowed.includes(String(companyId));
}

const TRANSACTION_TYPE_ALIASES = Object.freeze({
  all: "all",
  sales: "sales",
  sale: "sales",
  purchases: "purchases",
  purchase: "purchases",
  proforma: "proforma",
  receipts: "receipt",
  receipt: "receipt",
  payments: "payment",
  payment: "payment",
  journals: "journal",
  journal: "journal",
});

const SEARCHABLE_TRANSACTION_TYPES = [
  "sales",
  "purchases",
  "proforma",
  "receipt",
  "payment",
  "journal",
];

const TRANSACTION_TYPE_CONFIG = {
  sales: {
    Model: SalesEntry,
    select:
      "_id date dueDate totalAmount amount invoiceNumber referenceNumber description narration status paymentMethod company party client products services bank shippingAddress notes gstin gstPercentage createdAt updatedAt",
    populate: [
      { path: "party", select: "name email contactNumber" },
      { path: "company", select: "businessName" },
      { path: "bank" },
      { path: "shippingAddress" },
    ],
    populateProducts: true,
    servicePath: "services.service",
  },
  purchases: {
    Model: PurchaseEntry,
    select:
      "_id date dueDate totalAmount amount invoiceNumber referenceNumber description narration status paymentMethod company vendor client products services bank notes gstin gstPercentage createdAt updatedAt",
    populate: [
      { path: "vendor", select: "vendorName email contactNumber" },
      { path: "company", select: "businessName" },
      { path: "bank" },
    ],
    populateProducts: true,
    servicePath: "services.serviceName",
  },
  proforma: {
    Model: ProformaEntry,
    select:
      "_id date dueDate totalAmount amount invoiceNumber referenceNumber description narration status paymentMethod company party client products services bank shippingAddress notes gstin gstPercentage createdAt updatedAt",
    populate: [
      { path: "party", select: "name email contactNumber" },
      { path: "company", select: "businessName" },
      { path: "bank" },
      { path: "shippingAddress" },
    ],
    populateProducts: true,
    servicePath: "services.service",
  },
  receipt: {
    Model: ReceiptEntry,
    select:
      "_id date amount totalAmount description narration referenceNumber status paymentMethod company party client createdAt updatedAt",
    populate: [
      { path: "party", select: "name email contactNumber" },
      { path: "company", select: "businessName" },
    ],
  },
  payment: {
    Model: PaymentEntry,
    select:
      "_id date amount totalAmount description narration referenceNumber status paymentMethod company vendor expense isExpense client createdAt updatedAt",
    populate: [
      { path: "vendor", select: "vendorName email contactNumber" },
      { path: "expense", select: "name" },
      { path: "company", select: "businessName" },
    ],
  },
  journal: {
    Model: JournalEntry,
    select:
      "_id date amount totalAmount description narration referenceNumber debitAccount creditAccount company client createdAt updatedAt",
    populate: [{ path: "company", select: "businessName" }],
  },
};

const parseTimestamp = (value) => {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseObjectIdTimestamp = (value) => {
  const raw = String(value || "");
  if (!/^[0-9a-fA-F]{24}$/.test(raw)) return 0;
  return parseInt(raw.slice(0, 8), 16) * 1000;
};

const sortTransactionsByRecency = (items, sortOrder = "desc") =>
  [...items].sort((a, b) => {
    const recencyA =
      parseTimestamp(a.createdAt) ||
      parseTimestamp(a.updatedAt) ||
      parseTimestamp(a.displayDate || a.date) ||
      parseObjectIdTimestamp(a._id);
    const recencyB =
      parseTimestamp(b.createdAt) ||
      parseTimestamp(b.updatedAt) ||
      parseTimestamp(b.displayDate || b.date) ||
      parseObjectIdTimestamp(b._id);

    if (recencyA !== recencyB) {
      return sortOrder === "desc" ? recencyB - recencyA : recencyA - recencyB;
    }

    const dateA = parseTimestamp(a.displayDate || a.date);
    const dateB = parseTimestamp(b.displayDate || b.date);
    return sortOrder === "desc" ? dateB - dateA : dateA - dateB;
  });

const resolveRequestedTransactionType = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "all";
  return TRANSACTION_TYPE_ALIASES[normalized] || null;
};

const getAllowedTransactionTypes = (req) => {
  const userCaps = req.auth?.caps || {};
  const userRole = req.auth?.role;

  if (userRole === "master" || userRole === "admin" || userRole === "client") {
    return [...SEARCHABLE_TRANSACTION_TYPES];
  }

  const allowedTypes = [];
  if (userRole === "user") {
    if (userCaps?.canCreateSaleEntries) allowedTypes.push("sales");
    if (userCaps?.canCreatePurchaseEntries) allowedTypes.push("purchases");
    if (userCaps?.canCreateSaleEntries || userCaps?.canCreateProformaEntries) {
      allowedTypes.push("proforma");
    }
    if (userCaps?.canCreateReceiptEntries) allowedTypes.push("receipt");
    if (userCaps?.canCreatePaymentEntries) allowedTypes.push("payment");
    if (userCaps?.canCreateJournalEntries) allowedTypes.push("journal");
  }

  return Array.from(new Set(allowedTypes));
};

const buildScopedTransactionFilter = (req, { companyId, startDate, endDate }) => {
  const userRole = req.auth?.role;
  const filter = {};
  const requestedClientId = String(
    req.query?.clientId ?? req.body?.clientId ?? ""
  ).trim();
  const shouldScopeMasterToClient =
    userRole === "master" &&
    requestedClientId &&
    requestedClientId.toLowerCase() !== "all";

  if (req.auth?.clientId && (userRole !== "master" || shouldScopeMasterToClient)) {
    filter.client = req.auth.clientId;
  }

  if (companyId && companyId !== "all" && companyId !== "undefined") {
    if (!companyAllowedForUser(req, companyId)) {
      return {
        error: { status: 403, message: "Access denied to this company" },
      };
    }
    filter.company = companyId;
  } else if (userRole !== "client" && userRole !== "master") {
    const allowedCompanies = Array.isArray(req.auth?.allowedCompanies)
      ? req.auth.allowedCompanies
      : [];

    if (allowedCompanies.length === 0) {
      return { empty: true, filter };
    }

    filter.company = { $in: allowedCompanies.map(String) };
  }

  if (startDate || endDate) {
    filter.date = {};
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      filter.date.$gte = start;
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.date.$lte = end;
    }
  }

  return { filter };
};

const transformTransactionRecord = (item, type) => {
  const transformed = {
    ...item,
    type,
    displayAmount: item.totalAmount || item.amount || 0,
    displayDate: item.date,
    description:
      type === "journal" && item.narration ? item.narration : item.description || "",
    companyName: item.company?.businessName || item.company?.name || "N/A",
  };

  if (type === "purchases" && item.vendor) {
    transformed.counterpartyName = item.vendor?.vendorName || "N/A";
    transformed.counterpartyType = "vendor";
  } else if (type === "payment") {
    if (item.isExpense && item.expense) {
      transformed.counterpartyName = item.expense?.name || "Expense";
      transformed.counterpartyType = "expense";
      transformed.expense = item.expense;
      transformed.isExpense = true;
    } else if (item.vendor) {
      transformed.counterpartyName = item.vendor?.vendorName || "N/A";
      transformed.counterpartyType = "vendor";
    }
  } else if (item.party) {
    transformed.counterpartyName = item.party?.name || "N/A";
    transformed.counterpartyType = "party";
  } else if (type === "journal") {
    transformed.counterpartyName = "Journal Entry";
    transformed.counterpartyType = "journal";
  }

  if (Array.isArray(item.products)) {
    transformed.items = item.products.map((product) => ({
      name: product?.product?.name || "Unknown Product",
      quantity: product?.quantity || 0,
      price: product?.pricePerUnit || 0,
      total: product?.amount || 0,
      hsn: product?.product?.hsn || product?.hsn || "",
    }));
  }

  if (Array.isArray(item.services)) {
    if (!Array.isArray(transformed.items)) transformed.items = [];
    for (const service of item.services) {
      if (type === "purchases") {
        transformed.items.push({
          name: service?.serviceName?.serviceName || service?.description || "Service",
          quantity: service?.quantity || 1,
          price: service?.pricePerUnit || 0,
          total: service?.amount || 0,
          sac: service?.serviceName?.sac || service?.sac || "",
        });
      } else {
        transformed.items.push({
          name: service?.service?.serviceName || service?.description || "Service",
          quantity: service?.quantity || 1,
          price: service?.pricePerUnit || 0,
          total: service?.amount || 0,
          sac: service?.service?.sac || service?.sac || "",
        });
      }
    }
  }

  return transformed;
};

const fetchTransactionsByType = async (type, filter, sortSpec) => {
  const config = TRANSACTION_TYPE_CONFIG[type];
  if (!config) return [];

  let query = config.Model.find(filter).select(config.select).sort(sortSpec);

  if (config.populateProducts) {
    query = query.populate({
      path: "products.product",
      select: "name hsn",
    });
  }

  if (config.servicePath) {
    query = query.populate({
      path: config.servicePath,
      select: "serviceName sac",
    });
  }

  if (Array.isArray(config.populate)) {
    for (const populate of config.populate) {
      query = query.populate(populate);
    }
  }

  const rows = await query.lean();
  return rows.map((row) => transformTransactionRecord(row, type));
};

const normalizeSearchText = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const tokenizeSearchQuery = (value) =>
  normalizeSearchText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

const normalizeAmountSearchText = (value) =>
  normalizeSearchText(value).replace(/[,\u20B9]/g, "");

const buildSearchDocumentForTransaction = (transaction) => {
  const parts = [
    transaction?.type,
    transaction?.invoiceNumber,
    transaction?.referenceNumber,
    transaction?.amount,
    transaction?.totalAmount,
    transaction?.displayAmount,
    transaction?.description,
    transaction?.narration,
    transaction?.debitAccount,
    transaction?.creditAccount,
    transaction?.paymentMethod,
    transaction?.counterpartyName,
    transaction?.counterpartyType,
    transaction?.companyName,
    transaction?.party?.name,
    transaction?.vendor?.vendorName,
    transaction?.expense?.name,
  ];

  if (Array.isArray(transaction?.items)) {
    for (const line of transaction.items) {
      parts.push(
        line?.name,
        line?.description,
        line?.hsn,
        line?.sac,
        line?.quantity,
        line?.price,
        line?.total
      );
    }
  }

  return parts.map(normalizeSearchText).filter(Boolean).join(" ");
};

const transactionMatchesTokens = (transaction, tokens) => {
  if (!tokens.length) return true;
  const haystack = buildSearchDocumentForTransaction(transaction);
  if (!haystack) return false;
  const amountComparableHaystack = normalizeAmountSearchText(haystack);
  return tokens.every((token) => {
    if (haystack.includes(token)) return true;

    // For numeric tokens, compare with formatting removed from both sides.
    const hasNumericText = /[0-9]/.test(token);
    if (!hasNumericText) return false;
    const normalizedAmountToken = normalizeAmountSearchText(token);
    if (!normalizedAmountToken) return false;

    return amountComparableHaystack.includes(normalizedAmountToken);
  });
};

exports.searchTransactions = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const {
      q = "",
      tab,
      type,
      page = 1,
      limit = 20,
      companyId,
      startDate,
      endDate,
      sortBy = "date",
      sortOrder = "desc",
    } = req.query;

    const searchText = String(q || "").trim();
    if (!searchText) {
      return res.status(200).json({
        success: true,
        data: [],
        total: 0,
        page: 1,
        limit: Math.max(1, parseInt(limit, 10) || 20),
        totalPages: 0,
      });
    }

    const requestedType = resolveRequestedTransactionType(type || tab);
    if (requestedType === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid transaction type for search.",
      });
    }

    const allowedTypes = getAllowedTransactionTypes(req);
    if (allowedTypes.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        total: 0,
        page: 1,
        limit: Math.max(1, parseInt(limit, 10) || 20),
        totalPages: 0,
      });
    }

    const scopedTypes =
      requestedType && requestedType !== "all"
        ? allowedTypes.filter((candidate) => candidate === requestedType)
        : allowedTypes;

    if (scopedTypes.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        total: 0,
        page: 1,
        limit: Math.max(1, parseInt(limit, 10) || 20),
        totalPages: 0,
      });
    }

    const scopedFilterResult = buildScopedTransactionFilter(req, {
      companyId,
      startDate,
      endDate,
    });

    if (scopedFilterResult.error) {
      return res.status(scopedFilterResult.error.status).json({
        success: false,
        message: scopedFilterResult.error.message,
      });
    }

    if (scopedFilterResult.empty) {
      return res.status(200).json({
        success: true,
        data: [],
        total: 0,
        page: 1,
        limit: Math.max(1, parseInt(limit, 10) || 20),
        totalPages: 0,
      });
    }

    const sortDirection = sortOrder === "desc" ? -1 : 1;
    const sortSpec = {
      [sortBy]: sortDirection,
      createdAt: sortDirection,
      _id: sortDirection,
    };

    const searchTokens = tokenizeSearchQuery(searchText);
    const perPage = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
    const currentPage = Math.max(1, parseInt(page, 10) || 1);

    const groupedData = await Promise.all(
      scopedTypes.map((transactionType) =>
        fetchTransactionsByType(transactionType, scopedFilterResult.filter, sortSpec)
      )
    );

    const mergedData = groupedData.flat();
    const filtered = mergedData.filter((entry) =>
      transactionMatchesTokens(entry, searchTokens)
    );
    const sorted = sortTransactionsByRecency(filtered, sortOrder);

    const total = sorted.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
    const start = (currentPage - 1) * perPage;
    const paginatedData = sorted.slice(start, start + perPage);

    return res.status(200).json({
      success: true,
      data: paginatedData,
      total,
      page: currentPage,
      limit: perPage,
      totalPages,
      allowedTypes: scopedTypes,
    });
  } catch (err) {
    console.error("Error in searchTransactions:", err.message, err.stack);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to search transactions.",
    });
  }
};


/**
 * UPDATED: Get all transactions with pagination - FIXED with product population
 */
// exports.getAllTransactions = async (req, res) => {
//   try {
//     await ensureAuthCaps(req);

//     const {
//       page = 1,
//       limit = 20,
//       companyId,
//       startDate,
//       endDate,
//       search,
//       sortBy = 'date',
//       sortOrder = 'desc'
//     } = req.query;

//     const skip = (page - 1) * limit;
//     const user = req.user;

//     console.log("🔍 /api/transactions/all called for user:", user.id);

//     // --- Build base filter ---
//     const baseFilter = { client: user.id };

//     // Company filter
//     if (companyId && companyId !== 'all') {
//       if (!companyAllowedForUser(req, companyId)) {
//         return res.status(403).json({
//           success: false,
//           message: "Access denied to this company"
//         });
//       }
//       baseFilter.company = companyId;
//     }

//     // Date filter
//     if (startDate || endDate) {
//       baseFilter.date = {};
//       if (startDate) {
//         const start = new Date(startDate);
//         start.setHours(0, 0, 0, 0);
//         baseFilter.date.$gte = start;
//       }
//       if (endDate) {
//         const end = new Date(endDate);
//         end.setHours(23, 59, 59, 999);
//         baseFilter.date.$lte = end;
//       }
//     }

//     // Search filter
//     if (search) {
//       baseFilter.$or = [
//         { invoiceNumber: { $regex: search, $options: 'i' } },
//         { referenceNumber: { $regex: search, $options: 'i' } },
//         { description: { $regex: search, $options: 'i' } },
//         { narration: { $regex: search, $options: 'i' } }
//       ];
//     }

//     // --- Get user permissions ---
//     const allowedTypes = [];
//     const userCaps = req.auth.caps || {};

//     if (user.role === "master" || user.role === "client" || (userCaps && userCaps.canViewSaleEntries)) {
//       allowedTypes.push('sales');
//     }
//     if (user.role === "master" || user.role === "client" || (userCaps && userCaps.canViewPurchaseEntries)) {
//       allowedTypes.push('purchases');
//     }
//     if (user.role === "master" || user.role === "client" || (userCaps && userCaps.canViewProformaEntries)) {
//       allowedTypes.push('proforma');
//     }
//     if (user.role === "master" || user.role === "client" || (userCaps && userCaps.canViewReceiptEntries)) {
//       allowedTypes.push('receipt');
//     }
//     if (user.role === "master" || user.role === "client" || (userCaps && userCaps.canViewPaymentEntries)) {
//       allowedTypes.push('payment');
//     }
//     if (user.role === "master" || user.role === "client" || (userCaps && userCaps.canViewJournalEntries)) {
//       allowedTypes.push('journal');
//     }

//     console.log("✅ Allowed transaction types:", allowedTypes);

//     // If no permissions, return empty
//     if (allowedTypes.length === 0) {
//       return res.status(200).json({
//         success: true,
//         data: [],
//         total: 0,
//         page: 1,
//         limit,
//         totalPages: 0
//       });
//     }

//     // --- Define model configurations with CORRECT field names and POPULATIONS ---
//     const modelConfigs = [
//       {
//         type: 'sales',
//         Model: SalesEntry,
//         refField: 'party',
//         refSelect: 'name email',
//         selectFields: '_id date totalAmount invoiceNumber referenceNumber description status paymentMethod company party client products',
//         amountField: 'totalAmount',
//         needsProductPopulation: true  // Sales also have products
//       },
//       {
//         type: 'purchases',
//         Model: PurchaseEntry,
//         refField: 'vendor',
//         refSelect: 'vendorName email',
//         selectFields: '_id date totalAmount invoiceNumber referenceNumber description status paymentMethod company vendor client products',
//         amountField: 'totalAmount',
//         needsProductPopulation: true
//       },
//       {
//         type: 'proforma',
//         Model: ProformaEntry,
//         refField: 'party',
//         refSelect: 'name email',
//         selectFields: '_id date totalAmount invoiceNumber referenceNumber description status paymentMethod company party client products',
//         amountField: 'totalAmount',
//         needsProductPopulation: true
//       },
//       {
//         type: 'receipt',
//         Model: ReceiptEntry,
//         refField: 'party',
//         refSelect: 'name email',
//         selectFields: '_id date amount referenceNumber description status paymentMethod company party client',
//         amountField: 'amount',
//         needsProductPopulation: false
//       },
//       {
//         type: 'payment',
//         Model: PaymentEntry,
//         refField: 'party',
//         refSelect: 'name email',
//         selectFields: '_id date amount referenceNumber description status paymentMethod company party client',
//         amountField: 'amount',
//         needsProductPopulation: false
//       },
//       {
//         type: 'journal',
//         Model: JournalEntry,
//         refField: null,
//         refSelect: null,
//         selectFields: '_id date amount referenceNumber narration debitAccount creditAccount company client',
//         amountField: 'amount',
//         needsProductPopulation: false
//       }
//     ];

//     // Filter to only allowed types
//     const allowedConfigs = modelConfigs.filter(config => allowedTypes.includes(config.type));

//     // --- Fetch data for each allowed type in parallel ---
//     const fetchPromises = allowedConfigs.map(async (config) => {
//       try {
//         const { type, Model, refField, refSelect, selectFields, amountField, needsProductPopulation } = config;

//         // Count total
//         const total = await Model.countDocuments(baseFilter);

//         if (total === 0) {
//           return { type, data: [], total: 0 };
//         }

//         // Build query
//         let query = Model.find(baseFilter)
//           .select(selectFields)
//           .skip(skip)
//           .limit(parseInt(limit))
//           .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
//           .populate('company', 'businessName name');

//         // Add reference population if exists
//         if (refField && refSelect) {
//           query = query.populate(refField, refSelect);
//         }

//         // FIX: Populate products if needed
//         if (needsProductPopulation) {
//           query = query.populate({
//             path: 'products.product',
//             select: 'name hsn'
//           });
//         }

//         // Execute query
//         const data = await query.lean();

//         // Transform data for consistent frontend display
//         const transformedData = data.map(item => {
//           const transformed = {
//             ...item,
//             type,
//             displayAmount: item[amountField] || 0,
//             displayDate: item.date,
//             description: type === 'journal' && item.narration ? item.narration : item.description || '',
//             companyName: item.company?.businessName || item.company?.name || 'N/A'
//           };

//           // FIXED: Handle vendor/party naming consistently
//           if (type === 'purchases' && item.vendor) {
//             // For purchases, vendor has 'vendorName' field
//             transformed.counterpartyName = item.vendor?.vendorName || 'N/A';
//             transformed.counterpartyType = 'vendor';
//           } else if (item.party) {
//             // For other types, party has 'name' field
//             transformed.counterpartyName = item.party?.name || 'N/A';
//             transformed.counterpartyType = 'party';
//           } else if (type === 'journal') {
//             transformed.counterpartyName = 'Journal Entry';
//             transformed.counterpartyType = 'journal';
//           }

//           // FIXED: Include items/products if they exist (now with populated product names)
//           if (item.products && Array.isArray(item.products)) {
//             transformed.items = item.products.map(product => ({
//               name: product.product?.name || product.productName || 'Unknown Product',
//               quantity: product.quantity || 0,
//               price: product.pricePerUnit || 0,
//               total: product.amount || product.lineTotal || 0,
//               hsn: product.product?.hsn || ''
//             }));
//           }

//           // FIXED: Also for sales/proforma, check for services
//           if (item.services && Array.isArray(item.services)) {
//             if (!transformed.items) transformed.items = [];
//             item.services.forEach(service => {
//               transformed.items.push({
//                 name: service.service?.name || service.description || 'Service',
//                 quantity: service.quantity || 0,
//                 price: service.pricePerUnit || 0,
//                 total: service.amount || 0,
//                 hsn: service.hsn || ''
//               });
//             });
//           }

//           return transformed;
//         });

//         console.log(`✅ Fetched ${transformedData.length} ${type} entries (total: ${total})`);
//         if (transformedData.length > 0 && transformedData[0].items) {
//           console.log(`📦 Sample items in ${type}:`, transformedData[0].items.slice(0, 2));
//         }

//         return {
//           type,
//           data: transformedData,
//           total
//         };

//       } catch (err) {
//         console.error(`❌ Error fetching ${config.type}:`, err.message, err.stack);
//         return { type: config.type, data: [], total: 0 };
//       }
//     });

//     // Execute all queries
//     const results = await Promise.all(fetchPromises);

//     // Combine and sort data
//     let allData = [];
//     let total = 0;

//     results.forEach(result => {
//       allData = [...allData, ...result.data];
//       total += result.total;
//     });

//     // Sort by date
//     allData.sort((a, b) => {
//       const dateA = new Date(a.displayDate || a.date).getTime();
//       const dateB = new Date(b.displayDate || b.date).getTime();
//       return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
//     });

//     // Apply pagination
//     const startIndex = skip;
//     const paginatedData = allData.slice(startIndex, startIndex + parseInt(limit));

//     // Log sample for debugging
//     console.log(`📊 Final: ${paginatedData.length} transactions (total: ${total})`);
//     if (paginatedData.length > 0) {
//       const sample = paginatedData[0];
//       console.log("📋 Sample transaction:", {
//         type: sample.type,
//         id: sample._id,
//         counterparty: sample.counterpartyName,
//         itemsCount: sample.items?.length || 0,
//         items: sample.items?.slice(0, 2) || []
//       });
//     }

//     res.status(200).json({
//       success: true,
//       data: paginatedData,
//       total,
//       page: parseInt(page),
//       limit: parseInt(limit),
//       totalPages: Math.ceil(total / limit),
//       allowedTypes
//     });

//   } catch (err) {
//     console.error("❌ Error in getAllTransactions:", err.message, err.stack);
//     res.status(500).json({
//       success: false,
//       error: err.message
//     });
//   }
// };

/**
 * FIXED: Get all transactions with correct pagination logic
 */
exports.getAllTransactions = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const {
      page = 1,
      limit = 20,
      companyId,
      startDate,
      endDate,
      search,
      sortBy = "date",
      sortOrder = "desc",
    } = req.query;

    const user = req.user;

    const userCaps = req.auth.caps || {};
    const userRole = req.auth.role;
    const allowedCompanies = req.auth.allowedCompanies || [];
    const userId = req.auth.userId;
    // console.log("👤 Auth role:", userRole);
    // console.log("👤 User ID:", userId);
    // console.log("👤 Allowed companies:", allowedCompanies);
    // console.log("👤 User caps:", userCaps);

    // ── DETERMINE ALLOWED TYPES USING SHOW PERMISSIONS ──
    const allowedTypes = [];

    // MASTER/ADMIN/CLIENT - can see everything
    if (
      userRole === "master" ||
      userRole === "admin" ||
      userRole === "client"
    ) {
      allowedTypes.push(
        "sales",
        "purchases",
        "proforma",
        "receipt",
        "payment",
        "journal",
      );
    }
    // USER role - check show permissions
    else if (userRole === "user") {
      // Check show permissions first (these determine if user sees ALL or only their own)
      // console.log("🔍 PROCESSING USER SHOW PERMISSIONS");
      // console.log("🔍 canShowSaleEntries:", userCaps?.canShowSaleEntries);
      // console.log("🔍 canShowPurchaseEntries:", userCaps?.canShowPurchaseEntries);
      // console.log("🔍 canShowReceiptEntries:", userCaps?.canShowReceiptEntries);
      // console.log("🔍 canShowPaymentEntries:", userCaps?.canShowPaymentEntries);
      // console.log("🔍 canShowJournalEntries:", userCaps?.canShowJournalEntries);

      // A user can see a tab if they have EITHER create OR show permission
      if (userCaps?.canCreateSaleEntries || userCaps?.canShowSaleEntries) {
        allowedTypes.push("sales");
      }
      if (
        userCaps?.canCreatePurchaseEntries ||
        userCaps?.canShowPurchaseEntries
      ) {
        allowedTypes.push("purchases");
      }
      if (
        userCaps?.canCreateProformaEntries ||
        userCaps?.canShowProformaEntries
      ) {
        allowedTypes.push("proforma");
      }
      if (
        userCaps?.canCreateReceiptEntries ||
        userCaps?.canShowReceiptEntries
      ) {
        allowedTypes.push("receipt");
      }
      if (
        userCaps?.canCreatePaymentEntries ||
        userCaps?.canShowPaymentEntries
      ) {
        allowedTypes.push("payment");
      }
      if (
        userCaps?.canCreateJournalEntries ||
        userCaps?.canShowJournalEntries
      ) {
        allowedTypes.push("journal");
      }
    }

    if (allowedTypes.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        total: 0,
        page: 1,
        limit,
        totalPages: 0,
      });
    }

    const sortDirection = sortOrder === 'desc' ? -1 : 1;
    const sortSpec = { [sortBy]: sortDirection, createdAt: sortDirection, _id: sortDirection };

    // --- Build base filter ---
    const baseFilter = {};

    // Add tenant filter for all non-master roles
    if (userRole !== "master" && req.auth.clientId) {
      baseFilter.client = req.auth.clientId;
      console.log("Client filter added for tenant:", req.auth.clientId);
    }

    // Company filter - EXACTLY like sales controller
    if (companyId && companyId !== "all" && companyId !== "undefined") {
      if (!companyAllowedForUser(req, companyId)) {
        return res.status(403).json({
          success: false,
          message: "Access denied to this company",
        });
      }
      baseFilter.company = companyId;
      console.log("🏢 Filtering by specific company:", companyId);
    } else {
      // For users with company restrictions when no specific company selected
      if (userRole !== "client" && userRole !== "master") {
        const allowedCompanies = req.auth.allowedCompanies || [];
        if (allowedCompanies.length > 0) {
          baseFilter.company = { $in: allowedCompanies.map(String) };
          console.log(
            "🏢 Filtering by user's allowed companies:",
            allowedCompanies,
          );
        } else {
          // No companies assigned - return empty
          console.log("⚠️ User has no companies assigned - returning empty");
          return res.status(200).json({
            success: true,
            data: [],
            total: 0,
            page: 1,
            limit,
            totalPages: 0,
          });
        }
      }
    }

    // Date filter
    if (startDate || endDate) {
      baseFilter.date = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        baseFilter.date.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        baseFilter.date.$lte = end;
      }
    }

    // Search filter
    if (search) {
      baseFilter.$or = [
        { invoiceNumber: { $regex: search, $options: "i" } },
        { referenceNumber: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { narration: { $regex: search, $options: "i" } },
      ];
    }

    console.log("✅ Allowed transaction types:", allowedTypes);

    const fetchAllData = async (type, filter) => {
      console.log(
        `🔍 Fetching ${type} with base filter:`,
        JSON.stringify(filter),
      );
      if (!allowedTypes.includes(type)) {
        console.log(`⏭️ Skipping ${type} - not in allowed types`);
        return [];
      }

      const typeFilter = { ...filter };

      if (userRole === "user") {
        let canShowAll = false;

        switch (type) {
          case "sales":
            canShowAll = userCaps?.canShowSaleEntries === true;
            break;
          case "proforma":
            canShowAll = userCaps?.canShowProformaEntries === true;
            break;
          case "purchases":
            canShowAll = userCaps?.canShowPurchaseEntries === true;
            break;
          case "receipt":
            canShowAll = userCaps?.canShowReceiptEntries === true;
            break;
          case "payment":
            canShowAll = userCaps?.canShowPaymentEntries === true;
            break;
          case "journal":
            canShowAll = userCaps?.canShowJournalEntries === true;
            break;
        }

        console.log(`🔍 ${type} - canShowAll:`, canShowAll);

        if (!canShowAll) {
          typeFilter.createdByUser = userId;
          console.log(`🔍 ${type} - Adding createdByUser filter:`, userId);
        }
      }

      let Model, populateFields, selectFields;

      switch (type) {
        case "sales":
          Model = SalesEntry;
          populateFields = [
            { path: "party", select: "name email" },
            { path: "company", select: "businessName" },
            { path: "bank" },
            { path: "shippingAddress" },
            { path: "services.service", select: "serviceName sac" },
          ];
          selectFields =
            "_id date dueDate totalAmount invoiceNumber referenceNumber description status paymentMethod company party client products services bank shippingAddress notes gstin gstPercentage createdByUser stockImpact invoiceYearYY";
          break;
        case "purchases":
          Model = PurchaseEntry;
          populateFields = [
            { path: "vendor", select: "vendorName email" },
            { path: "company", select: "businessName" },
            { path: "bank" },
            { path: "services.serviceName", select: "serviceName sac" },
          ];
          selectFields =
            "_id date dueDate totalAmount invoiceNumber referenceNumber description status paymentMethod company vendor client products services bank notes gstin gstPercentage createdByUser";
          console.log(
            `🔍 Fetching purchases with filter:`,
            JSON.stringify(typeFilter),
          );
          break;
        case "proforma":
          Model = ProformaEntry;
          populateFields = [
            { path: "party", select: "name email" },
            { path: "company", select: "businessName" },
            { path: "bank" },
            { path: "shippingAddress" },
            { path: "services.service", select: "serviceName sac" },
          ];
          selectFields =
            "_id date dueDate totalAmount invoiceNumber referenceNumber description status paymentMethod company party client products services bank shippingAddress notes gstin gstPercentage createdByUser";
          break;
        case "receipt":
          Model = ReceiptEntry;
          populateFields = [
            { path: "party", select: "name email" },
            { path: "company", select: "businessName" },
          ];
          selectFields =
            "_id date amount description referenceNumber status paymentMethod company party client createdByUser";
          break;
        case "payment":
          Model = PaymentEntry;
          populateFields = [
            { path: "vendor", select: "vendorName email" },
            { path: "expense", select: "name" },
            { path: "company", select: "businessName" },
          ];
          selectFields =
            "_id date amount description referenceNumber status paymentMethod company party client expense isExpense createdByUser";
          break;
        case "journal":
          Model = JournalEntry;
          populateFields = [{ path: "company", select: "businessName" }];
          selectFields =
            "_id date amount description referenceNumber narration debitAccount creditAccount company client createdByUser";
          break;
        default:
          return [];
      }

      try {
        let query = Model.find(filter)
          .select(selectFields)
          .sort(sortSpec);
        console.log(`📊 ${type} count before query:`, await Model.countDocuments(filter));
        // Apply population
        populateFields.forEach(populate => {
          query = query.populate(populate);
        });

        // // Populate products if needed
        // if (type === 'sales' || type === 'purchases' || type === 'proforma') {
        //   query = query.populate({
        //     path: 'products.product',
        //     select: 'name hsn'
        //   })
        //     .populate({  // ✅ ADD THIS - populate services
        //       path: 'services.service',
        //       select: 'serviceName sac'
        //     });
        // }

        // const data = await query.lean();
        // console.log(`📦 ${type} found: ${data.length} records`); // ✅ ADD THIS
        // if (data.length > 0) {
        //   console.log(`📋 First ${type} record:`, {
        //     _id: data[0]._id,
        //     date: data[0].date,
        //     totalAmount: data[0].totalAmount,
        //     vendor: data[0].vendor,
        //     productsCount: data[0].products?.length,
        //     servicesCount: data[0].services?.length
        //   });
        // }
        // // Transform data
        // return data.map(item => {
        //   const transformed = {
        //     ...item,
        //     type,
        //     displayAmount: item.totalAmount || item.amount || 0,
        //     displayDate: item.date,
        //     description: type === 'journal' && item.narration ? item.narration : item.description || '',
        //     companyName: item.company?.businessName || item.company?.name || 'N/A'
        //   };

        //   // Handle vendor/party naming
        //   if (type === 'purchases' && item.vendor) {
        //     transformed.counterpartyName = item.vendor?.vendorName || 'N/A';
        //     transformed.counterpartyType = 'vendor';
        //   }
        //   //         else if (type === 'payment' && item.vendor) {
        //   //   transformed.counterpartyName = item.vendor?.vendorName || 'N/A'; // Handle payment vendor
        //   //   transformed.counterpartyType = 'vendor';
        //   // } 
        //   else if (type === 'payment') {
        //     // ✅ FIXED: Handle expense payments
        //     if (item.isExpense && item.expense) {
        //       transformed.counterpartyName = item.expense?.name || 'Expense';
        //       transformed.counterpartyType = 'expense';
        //       // ✅ IMPORTANT: Keep the expense data
        //       transformed.expense = item.expense;
        //       transformed.isExpense = true;
        //     } else if (item.vendor) {
        //       transformed.counterpartyName = item.vendor?.vendorName || 'N/A';
        //       transformed.counterpartyType = 'vendor';
        //     }
        //   }
        //   else if (item.party) {
        //     transformed.counterpartyName = item.party?.name || 'N/A';
        //     transformed.counterpartyType = 'party';
        //   } else if (type === 'journal') {
        //     transformed.counterpartyName = 'Journal Entry';
        //     transformed.counterpartyType = 'journal';
        //   }

        //   // Include items/products if they exist
        //   if (item.products && Array.isArray(item.products)) {
        //     transformed.items = item.products.map(product => ({
        //       name: product.product?.name || 'Unknown Product',
        //       quantity: product.quantity || 0,
        //       price: product.pricePerUnit || 0,
        //       total: product.amount || 0
        //     }));
        //   }

        //   // ✅ ADD THIS - Include services in items for purchases
        //   if (item.services && Array.isArray(item.services)) {
        //     if (!transformed.items) transformed.items = [];
        //     item.services.forEach(service => {
        //       transformed.items.push({
        //         // name: service.service?.serviceName || service.description || 'Service',
        //          name: service.serviceName?.serviceName || service.description || 'Service',
        //         quantity: service.quantity || 1,
        //         price: service.pricePerUnit || 0,
        //         total: service.amount || 0,
        //         // sac: service.service?.sac || service.sac || ''
        //           sac: service.serviceName?.sac || service.sac || ''
        //       });
        //     });
        //   }

        //   return transformed;
        // });

        // Populate products and services if needed
        if (type === 'sales' || type === 'purchases' || type === 'proforma') {
          // Start with base query
          // let query = Model.find(baseFilter)
          let query = Model.find(typeFilter)
            .select(selectFields)
            .sort(sortSpec);

          // Always populate products
          query = query.populate({
            path: "products.product",
            select: "name hsn",
          });

          // Populate services with correct path based on type
          if (type === "purchases") {
            // Purchases use 'serviceName' path
            query = query.populate({
              path: "services.serviceName",
              select: "serviceName sac",
            });
          } else if (type === "sales" || type === "proforma") {
            // Sales/Proforma use 'service' path
            query = query.populate({
              path: "services.service",
              select: "serviceName sac",
            });
          }

          // Apply other populate fields (vendor, party, company, expense etc)
          populateFields.forEach((populate) => {
            query = query.populate(populate);
          });

          // Execute query
          const data = await query.lean();
          console.log(`📦 ${type} found: ${data.length} records`);

          // Transform data
          return data.map((item) => {
            const transformed = {
              ...item,
              type,
              displayAmount: item.totalAmount || item.amount || 0,
              displayDate: item.date,
              description:
                type === "journal" && item.narration
                  ? item.narration
                  : item.description || "",
              companyName:
                item.company?.businessName || item.company?.name || "N/A",
            };

            // Handle vendor/party naming
            if (type === "purchases" && item.vendor) {
              transformed.counterpartyName = item.vendor?.vendorName || "N/A";
              transformed.counterpartyType = "vendor";
            } else if (type === "payment") {
              if (item.isExpense && item.expense) {
                transformed.counterpartyName = item.expense?.name || "Expense";
                transformed.counterpartyType = "expense";
                transformed.expense = item.expense;
                transformed.isExpense = true;
              } else if (item.vendor) {
                transformed.counterpartyName = item.vendor?.vendorName || "N/A";
                transformed.counterpartyType = "vendor";
              }
            } else if (item.party) {
              transformed.counterpartyName = item.party?.name || "N/A";
              transformed.counterpartyType = "party";
            } else if (type === "journal") {
              transformed.counterpartyName = "Journal Entry";
              transformed.counterpartyType = "journal";
            }

            // Include items/products if they exist
            if (item.products && Array.isArray(item.products)) {
              transformed.items = item.products.map((product) => ({
                name: product.product?.name || "Unknown Product",
                quantity: product.quantity || 0,
                price: product.pricePerUnit || 0,
                total: product.amount || 0,
                hsn: product.product?.hsn || "",
              }));
            }

            // Include services in items
            if (item.services && Array.isArray(item.services)) {
              if (!transformed.items) transformed.items = [];

              item.services.forEach((service) => {
                if (type === "purchases") {
                  // Purchases: service is in serviceName field
                  transformed.items.push({
                    name:
                      service.serviceName?.serviceName ||
                      service.description ||
                      "Service",
                    quantity: service.quantity || 1,
                    price: service.pricePerUnit || 0,
                    total: service.amount || 0,
                    sac: service.serviceName?.sac || service.sac || "",
                  });
                } else {
                  // Sales/Proforma: service is in service field
                  transformed.items.push({
                    name:
                      service.service?.serviceName ||
                      service.description ||
                      "Service",
                    quantity: service.quantity || 1,
                    price: service.pricePerUnit || 0,
                    total: service.amount || 0,
                    sac: service.service?.sac || service.sac || "",
                  });
                }
              });
            }

            return transformed;
          });
        }
        // For types without products/services (receipt, payment, journal)
        else {
          let query = Model.find(typeFilter)
            .select(selectFields)
            .sort(sortSpec);

          // Apply populate fields
          populateFields.forEach((populate) => {
            query = query.populate(populate);
          });

          const data = await query.lean();
          console.log(`📦 ${type} found: ${data.length} records`);

          // Transform data for non-product types
          return data.map((item) => {
            const transformed = {
              ...item,
              type,
              displayAmount: item.amount || 0,
              displayDate: item.date,
              description: item.description || item.narration || "",
              companyName:
                item.company?.businessName || item.company?.name || "N/A",
            };

            // Handle counterparty naming
            if (type === "payment" && item.isExpense && item.expense) {
              transformed.counterpartyName = item.expense?.name || "Expense";
              transformed.counterpartyType = "expense";
              transformed.expense = item.expense;
              transformed.isExpense = true;
            } else if (item.party) {
              transformed.counterpartyName = item.party?.name || "N/A";
              transformed.counterpartyType = "party";
            } else if (type === "payment" && item.vendor) {
              transformed.counterpartyName = item.vendor?.vendorName || "N/A";
              transformed.counterpartyType = "vendor";
            } else if (type === "journal") {
              transformed.counterpartyName = "Journal Entry";
              transformed.counterpartyType = "journal";
            }

            return transformed;
          });
        }
      } catch (err) {
        console.error(`❌ Error fetching ${type}:`, err.message);
        return [];
      }
    };

    // Fetch data for all allowed types in parallel
    const fetchPromises = allowedTypes.map((type) =>
      fetchAllData(type, baseFilter),
    );
    const results = await Promise.all(fetchPromises);

    // Combine all data
    let allData = [];
    results.forEach((data, index) => {
      allData = [...allData, ...data];
    });



    const parseTimestamp = (value) => {
      if (!value) return 0;
      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const parseObjectIdTimestamp = (value) => {
      const raw = String(value || "");
      if (!/^[0-9a-fA-F]{24}$/.test(raw)) return 0;
      return parseInt(raw.slice(0, 8), 16) * 1000;
    };

    allData.sort((a, b) => {
      const recencyA =
        parseTimestamp(a.createdAt) ||
        parseTimestamp(a.updatedAt) ||
        parseTimestamp(a.displayDate || a.date) ||
        parseObjectIdTimestamp(a._id);
      const recencyB =
        parseTimestamp(b.createdAt) ||
        parseTimestamp(b.updatedAt) ||
        parseTimestamp(b.displayDate || b.date) ||
        parseObjectIdTimestamp(b._id);

      if (recencyA !== recencyB) {
        return sortOrder === 'desc' ? recencyB - recencyA : recencyA - recencyB;
      }

      const dateA = parseTimestamp(a.displayDate || a.date);
      const dateB = parseTimestamp(b.displayDate || b.date);
      return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
    });

    // Calculate totals
    const total = allData.length;
    const totalPages = Math.ceil(total / limit);
    const currentPage = parseInt(page);
    const skip = (currentPage - 1) * limit;

    // Apply pagination
    const paginatedData = allData.slice(skip, skip + parseInt(limit));

    // console.log(
    //   `📊 ALL TAB - Found ${total} total transactions across all types`,
    // );
    // console.log(`📊 Breakdown by type:`, {
    //   sales: allData.filter((d) => d.type === "sales").length,
    //   purchases: allData.filter((d) => d.type === "purchases").length,
    //   proforma: allData.filter((d) => d.type === "proforma").length,
    //   receipts: allData.filter((d) => d.type === "receipt").length,
    //   payments: allData.filter((d) => d.type === "payment").length,
    //   journals: allData.filter((d) => d.type === "journal").length,
    // });

    res.status(200).json({
      success: true,
      data: paginatedData,
      total,
      page: currentPage,
      limit: parseInt(limit),
      totalPages,
      allowedTypes,
    });
  } catch (err) {
    console.error("❌ Error in getAllTransactions:", err.message, err.stack);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};

/**
 * Alternative aggregation approach for better performance
 */
exports.getAllTransactionsAggregated = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const { page = 1, limit = 20, companyId, startDate, endDate } = req.query;

    const skip = (page - 1) * limit;
    const user = req.user;

    console.log("🔍 Aggregated endpoint called for user:", user.id);

    // Build match stage
    const matchStage = { $match: {} };

    // Client filter
    if (user.role === "client" || user.role === "customer") {
      matchStage.$match.client = mongoose.Types.ObjectId(user.id);
    }

    // Company filter
    if (companyId && companyId !== "all") {
      matchStage.$match.company = mongoose.Types.ObjectId(companyId);
    }

    // Date filter
    if (startDate || endDate) {
      matchStage.$match.date = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        matchStage.$match.date.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        matchStage.$match.date.$lte = end;
      }
    }

    // Complete aggregation pipeline with ALL transaction types
    const pipeline = [
      // Start with empty collection
      { $match: { _id: { $exists: false } } },

      // Sales entries
      {
        $unionWith: {
          coll: "salesentries",
          pipeline: [
            matchStage,
            { $addFields: { type: "sales" } },
            {
              $lookup: {
                from: "parties",
                localField: "party",
                foreignField: "_id",
                as: "party",
              },
            },
            { $unwind: { path: "$party", preserveNullAndEmptyArrays: true } },
          ],
        },
      },

      // Purchase entries
      {
        $unionWith: {
          coll: "purchaseentries",
          pipeline: [
            matchStage,
            { $addFields: { type: "purchases" } },
            {
              $lookup: {
                from: "vendors",
                localField: "vendor",
                foreignField: "_id",
                as: "vendor",
              },
            },
            { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
          ],
        },
      },

      // Proforma entries
      {
        $unionWith: {
          coll: "proformaentries",
          pipeline: [
            matchStage,
            { $addFields: { type: "proforma" } },
            {
              $lookup: {
                from: "parties",
                localField: "party",
                foreignField: "_id",
                as: "party",
              },
            },
            { $unwind: { path: "$party", preserveNullAndEmptyArrays: true } },
          ],
        },
      },

      // Receipt entries
      {
        $unionWith: {
          coll: "receiptentries",
          pipeline: [
            matchStage,
            { $addFields: { type: "receipt" } },
            {
              $lookup: {
                from: "parties",
                localField: "party",
                foreignField: "_id",
                as: "party",
              },
            },
            { $unwind: { path: "$party", preserveNullAndEmptyArrays: true } },
          ],
        },
      },

      // Payment entries
      {
        $unionWith: {
          coll: "paymententries",
          pipeline: [
            matchStage,
            { $addFields: { type: "payment" } },
            {
              $lookup: {
                from: "parties",
                localField: "party",
                foreignField: "_id",
                as: "party",
              },
            },
            { $unwind: { path: "$party", preserveNullAndEmptyArrays: true } },
          ],
        },
      },

      // Journal entries
      {
        $unionWith: {
          coll: "journalentries",
          pipeline: [matchStage, { $addFields: { type: "journal" } }],
        },
      },

      // Sort by date
      { $sort: { date: -1, _id: -1 } },

      // Lookup company for all
      {
        $lookup: {
          from: "companies",
          localField: "company",
          foreignField: "_id",
          as: "company",
        },
      },
      { $unwind: { path: "$company", preserveNullAndEmptyArrays: true } },

      // Get total count and paginated data
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            { $skip: skip },
            { $limit: parseInt(limit) },
            // Project final fields
            {
              $project: {
                _id: 1,
                date: 1,
                totalAmount: 1,
                amount: 1,
                invoiceNumber: 1,
                referenceNumber: 1,
                description: 1,
                narration: 1,
                status: 1,
                paymentMethod: 1,
                type: 1,
                "party.name": 1,
                "party.email": 1,
                "vendor.name": 1,
                "vendor.email": 1,
                "company.businessName": 1,
                "company._id": 1,
              },
            },
          ],
        },
      },
    ];

    // Execute aggregation
    const result = await SalesEntry.aggregate(pipeline);

    const data = result[0]?.data || [];
    const total = result[0]?.metadata[0]?.total || 0;
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      data,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages,
    });
  } catch (err) {
    console.error("❌ Aggregation error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};

/**
 * Test endpoint to verify data exists
 */
exports.testTransactions = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const user = req.user;

    // Test counts for each type
    const [
      salesCount,
      purchasesCount,
      proformaCount,
      receiptsCount,
      paymentsCount,
      journalsCount,
    ] = await Promise.all([
      SalesEntry.countDocuments({ client: user.id }),
      PurchaseEntry.countDocuments({ client: user.id }),
      ProformaEntry.countDocuments({ client: user.id }),
      ReceiptEntry.countDocuments({ client: user.id }),
      PaymentEntry.countDocuments({ client: user.id }),
      JournalEntry.countDocuments({ client: user.id }),
    ]);

    // Get sample from each type
    const sampleSales = await SalesEntry.find({ client: user.id })
      .limit(2)
      .populate("party", "name")
      .populate("company", "businessName")
      .lean();

    const samplePurchases = await PurchaseEntry.find({ client: user.id })
      .limit(2)
      .populate("vendor", "name")
      .populate("company", "businessName")
      .lean();

    res.status(200).json({
      success: true,
      counts: {
        sales: salesCount,
        purchases: purchasesCount,
        proforma: proformaCount,
        receipts: receiptsCount,
        payments: paymentsCount,
        journals: journalsCount,
        total:
          salesCount +
          purchasesCount +
          proformaCount +
          receiptsCount +
          paymentsCount +
          journalsCount,
      },
      samples: {
        sales: sampleSales,
        purchases: samplePurchases,
      },
      message: "Test completed successfully",
    });
  } catch (err) {
    console.error("❌ Test error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};
