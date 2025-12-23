// jobs/manualCreateCarryForward.js
const mongoose = require('mongoose');
const DailyStockLedger = require("../models/DailyStockLedger");

async function manualCreateCarryForward() {
  try {
    console.log('🔄 Manually creating carry forward for Company B...');

    const companyId = "692040f2f6c29aaf637cb25e"; // Company B
    const clientId = "691f0b31068a46aa01f040d1";
    
    // For November 23rd, 2025
    const todayIST = new Date('2025-11-23T18:30:00.000Z'); // IST format (00:00 IST Nov 23rd)
    
    console.log('📅 Creating for date:', todayIST.toISOString());

    // Get yesterday's (Nov 22nd) closing stock from Company B
    const yesterdayIST = new Date('2025-11-22T18:30:00.000Z');
    const yesterdayLedger = await DailyStockLedger.findOne({
      companyId: companyId,
      clientId: clientId,
      date: yesterdayIST
    });

    console.log('📊 Yesterday ledger found:', !!yesterdayLedger);
    
    let openingStock = { quantity: 0, amount: 0 };
    
    if (yesterdayLedger && yesterdayLedger.closingStock) {
      openingStock = {
        quantity: yesterdayLedger.closingStock.quantity || 0,
        amount: yesterdayLedger.closingStock.amount || 0
      };
      console.log(`✅ Yesterday's closing: ${openingStock.quantity} units, ₹${openingStock.amount}`);
    } else {
      console.log('⚠️ No yesterday data, using zero opening');
    }

    // Check if document already exists
    const existingLedger = await DailyStockLedger.findOne({
      companyId: companyId,
      clientId: clientId,
      date: todayIST
    });

    if (existingLedger) {
      console.log('⚠️ Document already exists:', existingLedger._id);
      console.log('Updating opening stock...');
      
      existingLedger.openingStock = openingStock;
      existingLedger.closingStock = openingStock; // Reset closing to opening
      existingLedger.totalPurchaseOfTheDay = { quantity: 0, amount: 0 };
      existingLedger.totalSalesOfTheDay = { quantity: 0, amount: 0 };
      existingLedger.totalCOGS = 0;
      
      const updatedLedger = await existingLedger.save();
      console.log('✅ Document updated successfully');
      return updatedLedger;
    }

    // Create today's ledger
    const todayLedger = new DailyStockLedger({
      companyId: companyId,
      clientId: clientId,
      date: todayIST,
      openingStock: openingStock,
      closingStock: openingStock, // Initially same as opening
      totalPurchaseOfTheDay: { quantity: 0, amount: 0 },
      totalSalesOfTheDay: { quantity: 0, amount: 0 },
      totalCOGS: 0
    });

    const savedLedger = await todayLedger.save();
    
    console.log('✅ Successfully created carry forward document:');
    console.log('   Document ID:', savedLedger._id);
    console.log('   Date:', savedLedger.date.toISOString());
    console.log('   Opening Stock:', savedLedger.openingStock);
    console.log('   Closing Stock:', savedLedger.closingStock);

    return savedLedger;

  } catch (error) {
    console.error('❌ Error creating carry forward:', error);
    throw error;
  }
}

// NEW FUNCTION: Create carry forward for November 22nd, 2025
async function createNov22CarryForward() {
  try {
    console.log('🔄 Creating carry forward for November 22nd, 2025...');

    const companyId = "692040f2f6c29aaf637cb25e"; // Company B
    const clientId = "691f0b31068a46aa01f040d1";
    
    // For November 22nd, 2025 - using IST format
    const todayIST = new Date('2025-11-22T18:30:00.000Z');
    
    console.log('📅 Creating for date:', todayIST.toISOString());

    // Get November 21st's closing stock as opening for November 22nd
    const yesterdayIST = new Date('2025-11-21T18:30:00.000Z');
    const yesterdayLedger = await DailyStockLedger.findOne({
      companyId: companyId,
      clientId: clientId,
      date: yesterdayIST
    });

    console.log('📊 November 21st ledger found:', !!yesterdayLedger);
    
    let openingStock = { quantity: 0, amount: 0 };
    
    if (yesterdayLedger && yesterdayLedger.closingStock) {
      openingStock = {
        quantity: yesterdayLedger.closingStock.quantity || 0,
        amount: yesterdayLedger.closingStock.amount || 0
      };
      console.log(`✅ November 21st closing: ${openingStock.quantity} units, ₹${openingStock.amount}`);
    } else {
      console.log('⚠️ No November 21st data, using zero opening');
      openingStock = { quantity: 4, amount: 700 }; // From your document data
      console.log(`📝 Using documented closing: ${openingStock.quantity} units, ₹${openingStock.amount}`);
    }

    // Check if document already exists for Nov 22nd
    const existingLedger = await DailyStockLedger.findOne({
      companyId: companyId,
      clientId: clientId,
      date: todayIST
    });

    if (existingLedger) {
      console.log('⚠️ Document already exists for Nov 22nd:', existingLedger._id);
      console.log('Updating with correct opening stock...');
      
      existingLedger.openingStock = openingStock;
      // Don't reset closing stock if there are transactions
      if (existingLedger.totalPurchaseOfTheDay.quantity === 0 && existingLedger.totalSalesOfTheDay.quantity === 0) {
        existingLedger.closingStock = openingStock;
      }
      
      const updatedLedger = await existingLedger.save();
      console.log('✅ November 22nd document updated successfully');
      return updatedLedger;
    }

    // Create November 22nd ledger
    const newLedger = new DailyStockLedger({
      companyId: companyId,
      clientId: clientId,
      date: todayIST,
      openingStock: openingStock,
      closingStock: openingStock, // Initially same as opening
      totalPurchaseOfTheDay: { quantity: 0, amount: 0 },
      totalSalesOfTheDay: { quantity: 0, amount: 0 },
      totalCOGS: 0
    });

    const savedLedger = await newLedger.save();
    
    console.log('✅ Successfully created November 22nd carry forward document:');
    console.log('   Document ID:', savedLedger._id);
    console.log('   Date:', savedLedger.date.toISOString());
    console.log('   Opening Stock:', savedLedger.openingStock);
    console.log('   Closing Stock:', savedLedger.closingStock);

    return savedLedger;

  } catch (error) {
    console.error('❌ Error creating November 22nd carry forward:', error);
    throw error;
  }
}

// Function to create missing carry forwards for all dates
async function createAllMissingCarryForwards() {
  try {
    console.log('🔄 Creating all missing carry forwards for Company B...');
    
    await createNov22CarryForward(); // Create Nov 22nd
    await manualCreateCarryForward(); // Create Nov 23rd
    
    console.log('✅ All missing carry forwards created successfully');
  } catch (error) {
    console.error('❌ Error creating all carry forwards:', error);
    throw error;
  }
}

// Export all functions
module.exports = { 
  manualCreateCarryForward,
  createNov22CarryForward,
  createAllMissingCarryForwards
};