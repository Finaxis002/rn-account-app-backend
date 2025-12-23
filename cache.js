// cache.js
const NodeCache = require("node-cache");

// Default TTL = 5 minutes; don't deep-clone large arrays/objects for speed
const myCache = new NodeCache({ stdTTL: 300, checkperiod: 60, useClones: false });

// Centralized keys so we don't mistype strings in controllers
const key = {
  clientsList: (masterId) => `clients:list:${masterId}`,
  client: (masterId, clientId) => `clients:one:${masterId}:${clientId}`,
};

// Helpers to invalidate the right keys after writes
function invalidateClientsForMaster(masterId) {
  myCache.del(key.clientsList(masterId));
}

function invalidateClient(masterId, clientId) {
  myCache.del([key.client(masterId, clientId), key.clientsList(masterId)]);
}

module.exports = { myCache, key, invalidateClientsForMaster, invalidateClient };
