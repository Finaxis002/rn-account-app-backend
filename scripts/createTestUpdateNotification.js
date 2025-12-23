// Script to create a test update notification
// Run with: node scripts/createTestUpdateNotification.js

const mongoose = require('mongoose');
const UpdateNotification = require('../models/UpdateNotification');
const MasterAdmin = require('../models/MasterAdmin');
require('dotenv').config();

async function createTestNotification() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Find all master admins
    const masterAdmins = await MasterAdmin.find({});
    console.log(`Found ${masterAdmins.length} master admins`);

    if (masterAdmins.length === 0) {
      console.log('No master admins found. Creating a test one...');

      // Create a test master admin (remove this in production)
      const testAdmin = new MasterAdmin({
        userName: 'testmaster',
        email: 'master@test.com',
        // Add other required fields based on your MasterAdmin schema
      });
      await testAdmin.save();
      masterAdmins.push(testAdmin);
    }

    // Create test update notification
    const testNotification = {
      title: "New Dashboard Features Available",
      description: "We've enhanced the dashboard with new analytics and improved navigation",
      version: "v2.0.0",
      features: [
        {
          name: "Advanced Analytics",
          sectionUrl: "/admin/dashboard",
          gifUrl: "https://example.com/analytics-demo.gif",
          description: "View detailed analytics with new charts and metrics"
        },
        {
          name: "Quick Actions",
          sectionUrl: "/admin/dashboard",
          gifUrl: "https://example.com/quick-actions-demo.gif",
          description: "Access common actions directly from the dashboard"
        }
      ]
    };

    // Create notification for each master admin
    for (const admin of masterAdmins) {
      const notification = new UpdateNotification({
        ...testNotification,
        recipient: admin._id
      });
      await notification.save();
      console.log(`Created notification for master  admin: ${admin.userName}`);
    }

    console.log('Test update notification created successfully!');
  } catch (error) {
    console.error('Error creating test notification:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

createTestNotification();