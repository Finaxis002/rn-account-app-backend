// controllers/journalController.js
const JournalEntry = require("../models/JournalEntry");
const Company = require("../models/Company");
const User = require("../models/User");
const { getEffectivePermissions } = require("../services/effectivePermissions");
// const { getFromCache, setToCache } = require('../RedisCache');
// const { deleteJournalEntryCache, deleteJournalEntryCacheByUser } = require("../utils/cacheHelpers");
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");


const PRIV_ROLES = new Set(["master", "client", "admin"]);

function sameTenant(a, b) {
  return String(a) === String(b);
}
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

  // backfill staff names only (not clients)
  if (req.auth.role !== "client" && !req.auth.userName && req.auth.userId) {
    const userDoc = await User.findById(req.auth.userId)
      .select("displayName fullName name userName username email")
      .lean();
    req.auth.userName =
      userDoc?.displayName ||
      userDoc?.fullName ||
      userDoc?.name ||
      userDoc?.userName ||
      userDoc?.username ||
      userDoc?.email ||
      undefined; // no "Unknown"
  }
}


function companyAllowedForUser(req, companyId) {
  if (userIsPriv(req)) return true;
  const allowed = Array.isArray(req.auth.allowedCompanies)
    ? req.auth.allowedCompanies.map(String)
    : [];
  return allowed.length === 0 || allowed.includes(String(companyId));
}

function companyFilterForUser(req, requestedCompanyId) {
  const allowed = Array.isArray(req.auth.allowedCompanies)
    ? req.auth.allowedCompanies.map(String)
    : null;

  if (requestedCompanyId) {
    if (!allowed || allowed.length === 0 || allowed.includes(String(requestedCompanyId))) {
      return { company: requestedCompanyId };
    }
    return { company: { $in: [] } }; // not allowed → empty result
  }
  if (allowed && allowed.length > 0 && !userIsPriv(req)) {
    return { company: { $in: allowed } };
  }
  return {};
}


// ---------- Helpers: actor + admin notification (journal) ----------

// Message builder for journal module
function buildJournalNotificationMessage(action, { actorName, companyName, oldAmount, newAmount }) {
  const cName = companyName || "Unknown Company";
  switch (action) {
    case "create":
      return `New journal entry created by ${actorName} for company ${cName}` +
        (newAmount != null ? ` of ₹${newAmount}.` : ".");
    case "update":
      return (oldAmount != null && newAmount != null)
        ? `Journal entry updated by ${actorName} for company ${cName}. Amount changed from ₹${oldAmount} to ₹${newAmount}.`
        : `Journal entry updated by ${actorName} for company ${cName}.`;
    case "delete":
      return `Journal entry deleted by ${actorName} for company ${cName}` +
        (oldAmount != null ? ` (₹${oldAmount}).` : ".");
    default:
      return `Journal entry ${action} by ${actorName} for company ${cName}.`;
  }
}

// Unified notifier for journal
async function notifyAdminOnJournalAction({ req, action, companyName, entryId, companyId, oldAmount, newAmount }) {
  const actor = await resolveActor(req);
  const adminUser = await findAdminUser(companyId);
  if (!adminUser) {
    console.warn("notifyAdminOnJournalAction: no admin user found");
    return;
  }

  const message = buildJournalNotificationMessage(action, {
    actorName: actor.name,
    companyName,
    oldAmount,
    newAmount,
  });

  await createNotification(
    message,
    adminUser._id,    // recipient
    actor.id,         // actor id (user OR client)
    action,           // "create" | "update" | "delete"
    "journal",        // category
    entryId,          // journal _id
    req.auth.clientId
  );
}


/** CREATE */
exports.createJournal = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    if (!userIsPriv(req) && !req.auth.caps?.canCreateJournalEntries) {
      return res.status(403).json({ message: "Not allowed to create journal entries" });
    }

    const { debitAccount, creditAccount, date, amount, narration, company: companyId } = req.body;

    if (!companyAllowedForUser(req, companyId)) {
      return res.status(403).json({ message: "You are not allowed to use this company" });
    }

    const companyDoc = await Company.findOne({ _id: companyId, client: req.auth.clientId });
    if (!companyDoc) return res.status(400).json({ message: "Invalid company selected" });

    const journal = await JournalEntry.create({
      debitAccount,
      creditAccount,
      date,
      amount,
      narration,
      company: companyDoc._id,
      client: req.auth.clientId,
      createdByUser: req.auth.userId, // if present in schema
    });

    // NEW: Create notification for admin after journal entry is created
    const companyName =
      companyDoc?.businessName || companyDoc?.name || companyDoc?.companyName || "Unknown Company";

    await notifyAdminOnJournalAction({
      req,
      action: "create",
      companyName,
      entryId: journal._id,
      companyId: companyDoc._id.toString(),
      newAmount: amount,
    });


    // Access clientId and companyId after creation
    const clientId = journal.client.toString();

    // Call the cache deletion function
    // await deleteJournalEntryCache(clientId, companyId);
    // await deleteJournalEntryCacheByUser(clientId, companyId);

    res.status(201).json({ message: "Journal entry created", journal });
  } catch (err) {
    console.error("createJournal error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

/** LIST (tenant-scoped, filters + pagination) */
exports.getJournals = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const {
      q,            // search in narration / debitAccount / creditAccount
      companyId,
      dateFrom,
      dateTo,
      page: pageRaw = '1',
      limit: limitRaw = '100',
    } = req.query;

    const page = Math.max(parseInt(pageRaw, 10) || 1, 1);
    const perPage = Math.min(parseInt(limitRaw, 10) || 100, 500);
    const skip = (page - 1) * perPage;

    const where = {
      client: req.auth.clientId,
      ...companyFilterForUser(req, companyId),
    };

    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) where.date.$gte = new Date(dateFrom);
      if (dateTo) where.date.$lte = new Date(dateTo);
    }

    if (q) {
      const regex = new RegExp(String(q), 'i');
      where.$or = [
        { narration: regex },
        { debitAccount: regex },
        { creditAccount: regex },
      ];
    }

    // // ✅ Standardize key fields (use "client" not "clientId") and include all filters
    // const cacheKey = `journalEntries:${JSON.stringify({
    //   clientId: req.auth.clientId,
    //   companyId: companyId || null
    // })}`;

    // // Try cache
    // const cached = await getFromCache(cacheKey);
    // if (cached) {
    //   return res.status(200).json({
    //     success: true,
    //     total: cached.total,
    //     page,
    //     limit: perPage,
    //     data: cached.data,
    //   });
    // }

    const query = JournalEntry.find(where)
      .sort({ date: -1, _id: -1 })
      .skip(skip)
      .limit(perPage)
      .populate({ path: "company", select: "businessName" })
      .lean();

    const [data, total] = await Promise.all([
      query,
      JournalEntry.countDocuments(where),
    ]);

    // ✅ cache the right variable and keep shape consistent
    // await setToCache(cacheKey, { data, total });

    return res.status(200).json({
      success: true,
      total,
      page,
      limit: perPage,
      data,
    });
  } catch (err) {
    console.error("getJournals error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};


/** UPDATE */
exports.updateJournal = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const journal = await JournalEntry.findById(req.params.id);
    if (!journal) return res.status(404).json({ message: "Journal not found" });

    if (!userIsPriv(req) && !sameTenant(journal.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { company: newCompanyId, ...rest } = req.body;

    // Get company info for notification
    let companyDoc;
    if (newCompanyId) {
      if (!companyAllowedForUser(req, newCompanyId)) {
        return res.status(403).json({ message: "You are not allowed to use this company" });
      }
      companyDoc = await Company.findOne({ _id: newCompanyId, client: req.auth.clientId });
      if (!companyDoc) return res.status(400).json({ message: "Invalid company selected" });
      journal.company = companyDoc._id;
    } else {
      // Get company info if not changing
      companyDoc = await Company.findById(journal.company);
    }

    Object.assign(journal, rest);
    await journal.save();

    // NEW: Create notification for admin after journal entry is updated
    const companyName =
      companyDoc?.businessName || companyDoc?.name || companyDoc?.companyName || "Unknown Company";
      
    // Access clientId and companyId after creation
    const companyId = journal.company ? (journal.company._id || journal.company).toString() : null;
    const clientId = journal.client.toString();

    await notifyAdminOnJournalAction({
      req,
      action: "update",
      companyName,
      entryId: journal._id,
      companyId,
    });


    // Call the cache deletion function
    // await deleteJournalEntryCache(clientId, companyId);
    // await deleteJournalEntryCacheByUser(clientId, companyId);

    res.json({ message: "Journal updated", journal });
  } catch (err) {
    console.error("updateJournal error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

/** DELETE */
exports.deleteJournal = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const journal = await JournalEntry.findById(req.params.id);
    if (!journal) return res.status(404).json({ message: "Journal not found" });

    if (!userIsPriv(req) && !sameTenant(journal.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // NEW: Get company info before deletion for notification
    const companyDoc = await Company.findById(journal.company);

    const companyName =
      companyDoc?.businessName || companyDoc?.name || companyDoc?.companyName || "Unknown Company";
    const oldAmount = Number(journal.amount ?? NaN);

    await journal.deleteOne();

    await notifyAdminOnJournalAction({
      req,
      action: "delete",
      companyName,
      entryId: journal._id,  // ok to reference deleted id
      companyId: journal.company ? (journal.company._id || journal.company).toString() : null,
      oldAmount: isNaN(oldAmount) ? undefined : oldAmount,
    });

    // Access clientId and companyId after creation
    const companyId = journal.company ? (journal.company._id || journal.company).toString() : null;
    const clientId = journal.client.toString();

    // Call the cache deletion function
    // await deleteJournalEntryCache(clientId, companyId);
    // await deleteJournalEntryCacheByUser(clientId, companyId);

    res.json({ message: "Journal deleted" });
  } catch (err) {
    console.error("deleteJournal error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

/** ADMIN/MASTER: list by client (optional company + pagination) */
exports.getJournalsByClient = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const { clientId } = req.params;
    const { companyId, page = 1, limit = 100 } = req.query;

    // Check if the user is authorized to access this data
    if (!userIsPriv(req)) {
      return res.status(403).json({ message: "Not authorized" });
    }


    // Construct the query to filter journals by client
    const where = { client: clientId };
    if (companyId) where.company = companyId;

    const perPage = Math.min(Number(limit) || 100, 500);
    const skip = (Number(page) - 1) * perPage;

    // // Construct a cache key based on clientId and query parameters
    // const cacheKey = `journalEntriesByClient:${JSON.stringify({ clientId, companyId })}`;

    // // Check if the data is cached in Redis
    // const cachedEntries = await getFromCache(cacheKey);
    // if (cachedEntries) {
    //   // If cached, return the data directly
    //   return res.status(200).json({
    //     success: true,
    //     count: cachedEntries.length,
    //     data: cachedEntries,
    //   });
    // }

    // Fetch journal entries from the database
    const [data, total] = await Promise.all([
      JournalEntry.find(where)
        .sort({ date: -1 })  // Sorting by date in descending order
        .skip(skip)  // Pagination: skip records for the current page
        .limit(perPage)  // Limit the number of records returned per page
        .populate({ path: "company", select: "businessName" })  // Populate company details
        .lean(),  // Convert the result to plain JavaScript objects
      JournalEntry.countDocuments(where),  // Get the total count of journal entries
    ]);

    // Cache the fetched data for future use
    // await setToCache(cacheKey, data);

    // Respond with the data, including pagination information
    res.status(200).json({
      success: true,
      total,
      page: Number(page),
      limit: perPage,
      data,
    });
  } catch (err) {
    console.error("getJournalsByClient error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

