// scripts/fixStockCarryForward.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function fixStockCarryForward() {
  try {
    console.log('🔧 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('dailystockledgers');

    const companyId = new mongoose.Types.ObjectId("691f0b9f068a46aa01f040de");
    const clientId = new mongoose.Types.ObjectId("691f0b31068a46aa01f040d1");

    // Your existing document has date: "2025-11-20T18:30:00.000Z" (which represents 21st Nov IST)
    // So:
    // - 20th Nov operations → "2025-11-19T18:30:00.000Z" 
    // - 21st Nov operations → "2025-11-20T18:30:00.000Z" (YOUR EXISTING DOCUMENT)
    // - 22nd Nov operations → "2025-11-21T18:30:00.000Z" (MISSING - WE NEED TO CREATE THIS)

    console.log('📅 Analyzing existing documents...');
    
    // Find all documents for this company/client
    const allDocs = await collection.find({
      companyId: companyId,
      clientId: clientId
    }).sort({ date: 1 }).toArray();

    console.log(`📊 Found ${allDocs.length} existing documents:`);
    allDocs.forEach(doc => {
      console.log(`   ${doc.date.toISOString()} - Closing: ${doc.closingStock.quantity} units`);
    });

    // Your latest document is for 21st Nov (date: 2025-11-20T18:30:00.000Z)
    const latestDoc = allDocs[allDocs.length - 1];
    console.log('\n📈 Latest document:', latestDoc.date.toISOString());
    console.log('📦 Latest closing stock:', latestDoc.closingStock);

    // Create document for 22nd Nov (today - 21st Nov in real world)
    const todayIST = new Date("2025-11-21T18:30:00.000Z"); // Represents 22nd Nov 00:00 IST
    
    console.log(`\n🚀 Creating document for: ${todayIST.toISOString()}`);
    
    const newDoc = {
      companyId: companyId,
      clientId: clientId,
      date: todayIST,
      openingStock: latestDoc.closingStock, // Carry forward from yesterday
      closingStock: latestDoc.closingStock, // Initially same
      totalPurchaseOfTheDay: { quantity: 0, amount: 0 },
      totalSalesOfTheDay: { quantity: 0, amount: 0 },
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0
    };

    // Check if today's document already exists
    const existingToday = await collection.findOne({
      companyId: companyId,
      clientId: clientId,
      date: todayIST
    });

    if (existingToday) {
      console.log('⚠️  Today document already exists, updating opening stock...');
      await collection.updateOne(
        { _id: existingToday._id },
        { 
          $set: { 
            openingStock: latestDoc.closingStock,
            updatedAt: new Date()
          } 
        }
      );
      console.log('✅ Today document updated');
    } else {
      const result = await collection.insertOne(newDoc);
      console.log('✅ Today document created with ID:', result.insertedId);
    }

    // Verify the new document
    const verifiedDoc = await collection.findOne({
      companyId: companyId,
      clientId: clientId,
      date: todayIST
    });

    console.log('\n🎉 SUCCESS!');
    console.log('📊 Today opening stock:', verifiedDoc.openingStock);
    console.log('📅 Date:', verifiedDoc.date.toISOString());
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔚 MongoDB connection closed');
  }
}

fixStockCarryForward();