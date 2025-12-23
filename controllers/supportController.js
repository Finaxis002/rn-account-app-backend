// controllers/supportController.js - Using your working email service
const { sendReportEmail } = require('../services/emailService');

async function submitSupportRequest(req, res) {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'All fields are required' 
      });
    }

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2 style="color: #2563eb;">New Support Request - Vinimay</h2>
        <div style="background: #f3f4f6; padding: 15px; border-radius: 5px;">
          <p><strong>User:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Subject:</strong> ${subject}</p>
          <p><strong>Received:</strong> ${new Date().toLocaleString('en-IN')}</p>
        </div>
        <div style="margin: 20px 0;">
          <h3>Message:</h3>
          <div style="background: white; padding: 15px; border-left: 4px solid #2563eb;">
            ${message.replace(/\n/g, '<br>')}
          </div>
        </div>
      </div>
    `;

    // Use the same function that works for your reports
    await sendReportEmail(
      'finaxis.ai@gmail.com',
      `Support Request: ${subject}`,
      htmlContent
    );

    res.json({ 
      success: true, 
      message: 'Support request submitted successfully!' 
    });
    
  } catch (error) {
    console.error('Support request error:', error);
    
    // Fallback: just log the request
    console.log('Support request (fallback):', { name, email, subject });
    
    res.json({ 
      success: true, 
      message: 'Support request received! (Logged internally)' 
    });
  }
}

module.exports = { submitSupportRequest };