const nodemailer = require('nodemailer');

const sendCompanyRegistrationEmail = async ({ to, companyName, businessType, registrationNumber }) => {
  try {
    // Create transporter - Gmail defaults are built into nodemailer
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,     // your Gmail address
        pass: process.env.EMAIL_PASSWORD, // your App Password
      },
    });

    // Verify connection
    await transporter.verify();
    console.log('Gmail connection verified');

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:8678';

    // Email content
    const mailOptions = {
      from: process.env.EMAIL_USER, // Use the same email as sender
      to,
      subject: 'Welcome to Vinimay - Company Registration Successful',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
            }
            .container {
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
            }
            .header {
              background-color: #4f46e5;
              color: white;
              padding: 20px;
              text-align: center;
              border-radius: 8px 8px 0 0;
            }
            .content {
              background-color: #f9fafb;
              padding: 30px;
              border: 1px solid #e5e7eb;
              border-radius: 0 0 8px 8px;
            }
            .company-details {
              background-color: white;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
              border: 1px solid #e5e7eb;
            }
            .detail-item {
              margin-bottom: 10px;
            }
            .detail-label {
              font-weight: bold;
              color: #4b5563;
            }
            .detail-value {
              color: #1f2937;
            }
            .footer {
              margin-top: 30px;
              text-align: center;
              color: #6b7280;
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎉 Welcome to Vinimay!</h1>
            </div>
            <div class="content">
              <h2>Dear ${companyName},</h2>
              <p>We are pleased to inform you that your company has been successfully registered on the Vinimay platform.</p>
              
              <div class="company-details">
                <h3 style="margin-top: 0; color: #4f46e5;">Company Registration Details</h3>
                <div class="detail-item">
                  <span class="detail-label">Company Name:</span>
                  <span class="detail-value"> ${companyName}</span>
                </div>
                ${businessType ? `
                <div class="detail-item">
                  <span class="detail-label">Business Type:</span>
                  <span class="detail-value"> ${businessType}</span>
                </div>
                ` : ''}
                ${registrationNumber ? `
                <div class="detail-item">
                  <span class="detail-label">Registration Number:</span>
                  <span class="detail-value"> ${registrationNumber}</span>
                </div>
                ` : ''}
              </div>

              <h3>What's Next?</h3>
              <ul>
                <li>You can now access your company dashboard</li>
                <li>Manage your GST and TDS details</li>
                <li>Track your Sales and Purchase</li>
              </ul>

              <p>If you have any questions or need assistance, please don't hesitate to contact our support team.</p>

              <div style="margin-top: 30px; text-align: center;">
                <a href="${baseUrl}/dashboard" 
                   style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                  Go to Dashboard
                </a>
              </div>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} Vinimay. All rights reserved.</p>
              <p>This is an automated message, please do not reply to this email.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);
    console.log('Registration email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Error sending registration email:', {
      message: error.message,
      code: error.code,
      response: error.response
    });
    throw error;
  }
};

module.exports = {
  sendCompanyRegistrationEmail
};