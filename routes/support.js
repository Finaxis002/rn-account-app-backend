// routes/support.js - FINAL VERSION
const express = require("express");
const router = express.Router();
const { sendReportEmail } = require('../services/emailService'); // Use your working email service

// Test route to check environment variables
router.get('/test-env', (req, res) => {
  res.json({
    emailUser: process.env.EMAIL_USER || 'NOT_SET',
    emailPassword: process.env.EMAIL_PASSWORD ? 'SET' : 'NOT_SET',
    nodeEnv: process.env.NODE_ENV || 'NOT_SET'
  });
});

// Support route with email using your working report system
router.post('/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    
    console.log('📩 Support request received:', { name, email, subject });
    
    // Validate required fields
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'All fields are required' 
      });
    }

    // Create HTML content for the support email
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; background: #f8fafc; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
          .header { background: #2563eb; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
          .content { padding: 20px; }
          .field { margin: 10px 0; }
          .label { font-weight: bold; color: #374151; }
          .message { background: #f3f4f6; padding: 15px; border-radius: 4px; margin: 15px 0; }
          .footer { margin-top: 20px; padding-top: 15px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔧 New Support Request</h1>
            <p>AccountTech Pro Support System</p>
          </div>
          <div class="content">
            <div class="field"><span class="label">👤 User:</span> ${name}</div>
            <div class="field"><span class="label">📧 Email:</span> ${email}</div>
            <div class="field"><span class="label">📋 Subject:</span> ${subject}</div>
            <div class="field"><span class="label">⏰ Received:</span> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</div>
            
            <div class="message">
              <div class="label">💬 Message:</div>
              ${message.replace(/\n/g, '<br>')}
            </div>
          </div>
          <div class="footer">
            <p>This support request was submitted through the AccountTech Pro application.</p>
            <p>Ticket ID: SUP-${Date.now()}</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Use the SAME email service that works for your reports
    console.log('📤 Attempting to send support email...');
    
    await sendReportEmail(
       'shardaassociates.in@gmail.com', // Send to support email
      `🔧 Support Ticket: ${subject}`, // Email subject
      htmlContent // HTML content
    );

    console.log('✅ Support email sent successfully');

    res.json({ 
      success: true, 
      message: 'Support request submitted successfully! We will get back to you soon.',
      ticketId: `SUP-${Date.now()}`
    });
    
  } catch (error) {
    console.error('❌ Support request error:', error.message);
    
    // Even if email fails, log the request and respond successfully
    console.log('📋 Support request logged internally:', {
      name,
      email,
      subject,
      message: message.substring(0, 200),
      timestamp: new Date().toISOString(),
      error: error.message
    });

    // Still return success to user, but indicate email may not have been sent
    res.json({ 
      success: true, 
      message: 'Support request received! (If email delivery failed, we have logged your request internally)',
      ticketId: `SUP-${Date.now()}`,
      note: 'Request logged in system'
    });
  }
});

module.exports = router;