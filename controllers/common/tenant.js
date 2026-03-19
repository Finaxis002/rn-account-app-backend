// controllers/common/tenant.js
const User = require("../../models/User");

/**
 * Resolve the tenant (client) id for the current request.
 * Works for:
 * - master/client tokens (use their own id as tenant)
 * - other roles (user/admin/manager) => use createdByClient from token
 *   or fetch from DB if the token didn’t include it.
 */
async function resolveClientId(req) {
    // Prefer explicit fields if your JWT provides them
    const tokenClientId = req.user?.createdByClient || req.user?.clientId;
    if (tokenClientId) return tokenClientId;

    // For master/client, the tenant is the user itself
    const role = (req.user?.role || "").toLowerCase();
    if (role === "master" || role === "client") return req.user.id || req.user.sub;

    // Fallback: look up the user to get createdByClient
    if (!req.user?.id && !req.user?.sub) throw new Error("Missing user id in token");
    const userId = req.user.id || req.user.sub;

    const userDoc = await User.findById(userId).select("createdByClient").lean();
    if (!userDoc?.createdByClient) {
        throw new Error("Could not resolve client (tenant) id for this user");
    }
    return userDoc.createdByClient.toString();
}

function getUserId(req) {
    return req.auth?.userId || req.user?.id || req.user?._id || req.user?.sub;
}
function getClientId(req) {
    return req.auth?.clientId;
}

module.exports = { resolveClientId, getUserId, getClientId };
