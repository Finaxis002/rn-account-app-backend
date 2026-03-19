// generate-deploy-token.js
// Run with: node scripts/generate-deploy-token.js

const jwt = require('jsonwebtoken');
require('dotenv').config();

function generateDeployToken() {
  // Use your master admin ID from the token you showed earlier
  const masterAdminId = '688b1f5b7cbb3b59a45007d9';

  if (!process.env.JWT_SECRET) {
    console.error('❌ JWT_SECRET not found in environment variables');
    process.exit(1);
  }

  const token = jwt.sign(
    {
      id: masterAdminId,
      role: 'master',
      type: 'deployment' // Optional: mark as deployment token
    },
    process.env.JWT_SECRET,
    { expiresIn: '365d' } // 1 year expiration
  );

  console.log('🚀 Deployment Token Generated Successfully!');
  console.log('📅 Expires: 1 year from now');
  console.log('🔑 Token:', token);
  console.log('');
  console.log('📋 Add this token to GitHub Secrets as MASTER_TOKEN');
  console.log('⚠️  Keep this token secure - it has master admin privileges');
}

generateDeployToken();