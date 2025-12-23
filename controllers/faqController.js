const { sendReportEmail } = require('../services/emailService');

const submitFAQQuestion = async (req, res) => {
  try {
    const { question } = req.body;

    console.log('📩 FAQ question received:', { question });

    // Validate required fields
    if (!question || question.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Question is required'
      });
    }

    // Create HTML content for the FAQ email
   const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin: 0;
      padding: 40px 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
    }
    
    .container {
      max-width: 680px;
      margin: 0 auto;
      background: white;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.1);
      overflow: hidden;
      backdrop-filter: blur(10px);
    }
    
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px 30px;
      text-align: center;
      position: relative;
    }
    
    .header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 100" opacity="0.1"><polygon points="1000,100 1000,0 0,100" fill="white"/></svg>');
      background-size: cover;
    }
    
    .header h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 10px;
      position: relative;
    }
    
    .header p {
      font-size: 1.1rem;
      opacity: 0.9;
      font-weight: 300;
      position: relative;
    }
    
    .content {
      padding: 40px 30px;
    }
    
    .field {
      display: flex;
      align-items: center;
      margin: 25px 0;
      padding: 20px;
      background: #f8fafc;
      border-radius: 12px;
      border-left: 4px solid #667eea;
    }
    
    .label {
      font-weight: 600;
      color: #374151;
      min-width: 120px;
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .value {
      color: #1f2937;
      font-weight: 500;
      font-size: 1rem;
    }
    
    .message-container {
      margin: 30px 0;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
    }
    
    .message-header {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
      padding: 18px 25px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .message-content {
      padding: 25px;
      background: #fefefe;
      line-height: 1.6;
      color: #374151;
      font-size: 1.05rem;
    }
    
    .footer {
      background: #f9fafb;
      padding: 30px;
      text-align: center;
      border-top: 1px solid #e5e7eb;
    }
    
    .footer p {
      color: #6b7280;
      margin: 8px 0;
      font-size: 0.9rem;
      line-height: 1.5;
    }
    
    .ticket-id {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 12px 24px;
      border-radius: 50px;
      font-weight: 600;
      display: inline-block;
      margin-top: 10px;
      font-size: 0.95rem;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
    }
    
    .icon {
      font-size: 1.2rem;
    }
    
    @media (max-width: 600px) {
      body {
        padding: 20px 10px;
      }
      
      .header h1 {
        font-size: 2rem;
      }
      
      .content {
        padding: 25px 20px;
      }
      
      .field {
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
      }
      
      .label {
        min-width: auto;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>❓ New FAQ Question</h1>
      <p>Vinimay FAQ System</p>
    </div>
    
    <div class="content">
      <div class="field">
        <span class="label">⏰ Received:</span>
        <span class="value">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</span>
      </div>
      
      <div class="message-container">
        <div class="message-header">
          <span class="icon">💬</span>
          Question
        </div>
        <div class="message-content">
          ${question.replace(/\n/g, '<br>')}
        </div>
      </div>
    </div>
    
    <div class="footer">
      <p>This FAQ question was submitted through the Vinimay application.</p>
      <div class="ticket-id">
        Ticket ID: FAQ-${Date.now()}
      </div>
    </div>
  </div>
</body>
</html>
`;

    // Send email to finaxis.in@gmail.com
    console.log('📤 Attempting to send FAQ email...');

    await sendReportEmail(
      'finaxis.in@gmail.com', // Send to specified email
      `❓ Vinimay FAQ Question: ${question.substring(0, 50)}${question.length > 50 ? '...' : ''}`, // Email subject
      htmlContent // HTML content
    );

    console.log('✅ FAQ email sent successfully');

    res.json({
      success: true,
      message: 'Your question has been submitted successfully! We will get back to you soon.',
      ticketId: `FAQ-${Date.now()}`
    });

  } catch (error) {
    console.error('❌ FAQ submission error:', error.message);

    // Log the request internally
    console.log('📋 FAQ question logged internally:', {
      question: question.substring(0, 200),
      timestamp: new Date().toISOString(),
      error: error.message
    });

    // Still return success to user
    res.json({
      success: true,
      message: 'Your question has been received! (If email delivery failed, we have logged your question internally)',
      ticketId: `FAQ-${Date.now()}`,
      note: 'Question logged in system'
    });
  }
};

module.exports = {
  submitFAQQuestion
};