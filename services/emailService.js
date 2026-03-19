// services/emailService.js
const nodemailer = require('nodemailer');
const { _internal } = require("../controllers/integrations/gmailController");
const Client = require("../models/Client");

// Create a system-level transporter for reports
function createSystemTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER, // Your system email
      pass: process.env.EMAIL_PASSWORD // Your system email password
    }
  });
}

async function sendReportEmail(to, subject, htmlContent) {
  try {
    // Try using system email first (fallback method)
    const transporter = createSystemTransporter();
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: to,
      subject: subject,
      html: htmlContent
    };

    const result = await transporter.sendMail(mailOptions);
    console.log(`Report email sent to ${to}: ${result.messageId}`);
    return result;
    
  } catch (error) {
    console.error('System email sending failed:', error);
    
    // Fallback: Try to find a client with Gmail connected
    try {
      // Find any client that has Gmail connected
      const clientWithGmail = await Client.findOne({
        'emailIntegrations.connected': true
      });
      
      if (clientWithGmail) {
        const result = await _internal.sendWithClientGmail({
          clientId: clientWithGmail._id,
          fromName: 'Sales Report System',
          to,
          subject,
          html: htmlContent
        });
        console.log(`Report email sent via client Gmail to ${to}: ${result.messageId}`);
        return result;
      }
      
      throw new Error('No clients have Gmail connected');
      
    } catch (fallbackError) {
      console.error('All email methods failed:', fallbackError);
      throw new Error('Email sending failed: ' + fallbackError.message);
    }
  }
}


// services/emailService.js - Update the sendCreditReminderEmail function
// async function sendCreditReminderEmail({ 
//   to, 
//   customerName, 
//   companyName, 
//   invoiceNumber, 
//   invoiceDate, 
//   daysOverdue, 
//   pendingAmount,
//   companyEmail,
//   customSubject,
//   customContent 
// }) {
//   try {
//     console.log('🔧 sendCreditReminderEmail called with:', { to, customerName, companyName });

//     const subject = customSubject || `Payment Reminder - Invoice ${invoiceNumber}`;
    
//     let htmlContent;
//     if (customContent) {
//       htmlContent = `
//         <!DOCTYPE html>
//         <html>
//         <head>
//           <style>
//             body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
//             .content { white-space: pre-wrap; }
//           </style>
//         </head>
//         <body>
//           <div class="content">${customContent.replace(/\n/g, '<br>')}</div>
//         </body>
//         </html>
//       `;
//     } else {
//       htmlContent = generateDefaultReminderHTML({
//         customerName,
//         companyName,
//         invoiceNumber,
//         invoiceDate,
//         daysOverdue,
//         pendingAmount,
//         companyEmail
//       });
//     }

//     console.log('📧 Attempting to send email to:', to);
//     console.log('📧 Email subject:', subject);

//     // Try using system email first
//     try {
//       console.log('🔧 Attempting system email...');
//       const transporter = createSystemTransporter();
      
//       const mailOptions = {
//         from: process.env.EMAIL_USER,
//         to: to,
//         subject: subject,
//         html: htmlContent
//       };

//       console.log('🔧 Mail options:', { 
//         from: process.env.EMAIL_USER, 
//         to: to,
//         subject: subject 
//       });

//       const result = await transporter.sendMail(mailOptions);
//       console.log('✅ System email sent successfully:', result.messageId);
//       console.log('✅ Email sent to:', to);
//       return result;
      
//     } catch (systemError) {
//       console.error('❌ System email failed:', systemError.message);
      
//       // Fallback to client's Gmail
//       console.log('🔧 Attempting client Gmail fallback...');
//       const clientWithGmail = await Client.findOne({
//         'emailIntegrations.connected': true
//       });
      
//       if (clientWithGmail) {
//         console.log('🔧 Found client with Gmail:', clientWithGmail._id);
//         const result = await _internal.sendWithClientGmail({
//           clientId: clientWithGmail._id,
//           fromName: companyName,
//           to,
//           subject,
//           html: htmlContent
//         });
//         console.log('✅ Client Gmail email sent successfully');
//         return result;
//       }
      
//       console.error('❌ No clients have Gmail connected');
//       throw new Error('No email service available');
//     }
    
//   } catch (error) {
//     console.error('❌ Error in sendCreditReminderEmail:', error);
//     throw new Error('Failed to send credit reminder: ' + error.message);
//   }
// }

async function sendCreditReminderEmail({ 
  to, 
  customerName, 
  companyName, 
  invoiceNumber, 
  invoiceDate, 
  daysOverdue, 
  pendingAmount,
  companyEmail,
  companyId, // Add companyId to identify which client to send from
  clientId, // Alternative: direct client ID
  customSubject,
  customContent 
}) {
  try {
    console.log('🔧 sendCreditReminderEmail called with:', { 
      to, 
      customerName, 
      companyName,
      companyId,
      clientId 
    });

    const subject = customSubject || `Payment Reminder - Invoice ${invoiceNumber}`;
    
    let htmlContent;
    if (customContent) {
      htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
            .content { white-space: pre-wrap; }
          </style>
        </head>
        <body>
          <div class="content">${customContent.replace(/\n/g, '<br>')}</div>
        </body>
        </html>
      `;
    } else {
      htmlContent = generateDefaultReminderHTML({
        customerName,
        companyName,
        invoiceNumber,
        invoiceDate,
        daysOverdue,
        pendingAmount,
        companyEmail
      });
    }

    console.log('📧 Attempting to send email to:', to);
    console.log('📧 Email subject:', subject);

    // Try using client's Gmail first
    try {
      console.log('🔧 Attempting to send from client Gmail...');
      
      // Determine the client ID to use for sending
      let senderClientId = clientId;
      
      // If clientId not provided but companyId is, find the company owner
      if (!senderClientId && companyId) {
        const company = await Company.findById(companyId).select('owner').lean();
        if (company?.owner) {
          senderClientId = company.owner;
          console.log('🔧 Found client from company owner:', senderClientId);
        }
      }
      
      // If still no clientId, try to find any client with Gmail connected
      if (!senderClientId) {
        const clientWithGmail = await EmailIntegration.findOne({
          connected: true
        });
        
        if (clientWithGmail) {
          senderClientId = clientWithGmail.client;
          console.log('🔧 Found client with Gmail integration:', senderClientId);
        }
      }
      
      if (senderClientId) {
        const result = await _internal.sendWithClientGmail({
          clientId: senderClientId,
          fromName: companyName,
          to,
          subject,
          html: htmlContent
        });
        console.log('✅ Client Gmail email sent successfully');
        return result;
      } else {
        console.log('🔧 No client Gmail found, falling back to system email');
        throw new Error('No client Gmail available');
      }
      
    } catch (clientGmailError) {
      console.error('❌ Client Gmail failed:', clientGmailError.message);
      
      // Fallback to system email
      console.log('🔧 Attempting system email fallback...');
      const transporter = createSystemTransporter();
      
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: to,
        subject: subject,
        html: htmlContent
      };

      console.log('🔧 System mail options:', { 
        from: process.env.EMAIL_USER, 
        to: to,
        subject: subject 
      });

      const result = await transporter.sendMail(mailOptions);
      console.log('✅ System email sent successfully:', result.messageId);
      console.log('✅ Email sent to:', to);
      return result;
    }
    
  } catch (error) {
    console.error('❌ Error in sendCreditReminderEmail:', error);
    throw new Error('Failed to send credit reminder: ' + error.message);
  }
}


module.exports = {
  createSystemTransporter,
  sendReportEmail,
  sendCreditReminderEmail
};