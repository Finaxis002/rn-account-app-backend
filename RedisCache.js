// RedisCache.js
const Redis = require("ioredis");
require("dotenv").config();

let redis;

// ✅ Check if Redis URL is provided (Render or production)
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  console.log("✅ Using Redis from environment URL (Render or Cloud)");
} else {
  // ✅ Fallback to local Redis (for development)
  redis = new Redis({
    host: "127.0.0.1",
    port: 6379,
    // password: "yourpassword", // Uncomment if your local Redis needs auth
    db: 0,
  });
  console.log("✅ Using local Redis instance");
}

// Event listeners
redis.on("connect", () => {
  console.log("🔗 Connected to Redis");
});

redis.on("error", (err) => {
  console.error("❌ Redis error:", err);
});

// ------------------ Cache Utility Functions ------------------

// Get data from Redis cache
const getFromCache = async (key) => {
  try {
    const cachedData = await redis.get(key);
    if (cachedData) {
      console.log("📦 Data fetched from Redis cache");
      return JSON.parse(cachedData);
    }
    return null;
  } catch (error) {
    console.error("Error getting data from Redis:", error);
    return null;
  }
};

// Set data to Redis cache
const setToCache = async (key, value, ttl = 300) => {
  try {
    await redis.setex(key, ttl, JSON.stringify(value));
    console.log(`📝 Data cached with key: ${key} (TTL: ${ttl}s)`);
  } catch (error) {
    console.error("Error setting data to Redis:", error);
  }
};

// Delete data from Redis cache
const deleteFromCache = async (key) => {
  try {
    await redis.del(key);
    console.log(`🗑️ Cache deleted for key: ${key}`);
  } catch (error) {
    console.error("Error deleting cache:", error);
  }
};

// Refresh cache (overwrite with new data)
const refreshCache = async (key, value, ttl = 3600) => {
  try {
    await redis.setex(key, ttl, JSON.stringify(value));
    console.log(`♻️ Cache refreshed for key: ${key}`);
  } catch (error) {
    console.error("Error refreshing cache:", error);
  }
};

// --------------------------------------------------------------

module.exports = {
  redis,
  getFromCache,
  setToCache,
  deleteFromCache,
  refreshCache,
};
