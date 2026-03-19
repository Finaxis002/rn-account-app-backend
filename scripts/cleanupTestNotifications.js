// scripts/cleanupTestNotifications.js
const mongoose = require('mongoose');
const UpdateNotification = require('../models/UpdateNotification');
require('dotenv').config();

async function cleanupTestNotifications() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Find all update notifications before deletion
    const allNotifications = await UpdateNotification.find({});
    console.log(`Found ${allNotifications.length} update notifications to delete`);

    // DELETE ALL notifications from the collection
    const deleteResult = await UpdateNotification.deleteMany({});
    
    console.log(`✅ Successfully deleted ${deleteResult.deletedCount} update notifications`);
    console.log(`🗑️  Entire UpdateNotification collection cleared`);

  } catch (error) {
    console.error('❌ Error cleaning up notifications:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Only run if this script is executed directly
if (require.main === module) {
  cleanupTestNotifications();
}

module.exports = cleanupTestNotifications;