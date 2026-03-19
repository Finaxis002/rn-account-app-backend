// const twilio = require('twilio');
// require('dotenv').config();  // Load environment variables

// // Get your Twilio Account SID and Auth Token from the environment variables
// const accountSid = process.env.TWILIO_ACCOUNT_SID;
// const authToken = process.env.TWILIO_AUTH_TOKEN;
// const client = twilio(accountSid, authToken);

// function generateInvoiceMessage(transactionDetails) {
//   return `Dear ${transactionDetails.partyName},\n\n` +
//          `Thank you for choosing **${transactionDetails.companyName}**. Here are the details of your recent transaction:\n\n` +
//          `**Invoice Number**: ${transactionDetails.invoiceNumber}\n` +
//          `**Transaction Date**: ${transactionDetails.date}\n` +
//          `**Total Amount**: ₹${transactionDetails.totalAmount}\n` +
//          `**GST Amount**: ₹${transactionDetails.gstAmount}\n` +
//          `**Payment Method**: ${transactionDetails.paymentMethod}\n\n` +
//          `For any queries, please contact us at ${transactionDetails.contactInfo}\n\n` +
//          `Thank you for your business!\n\n` +
//          `Best regards,\n` +
//          `**${transactionDetails.companyName}**`;
// }


// // Send WhatsApp message
// const sendMessage = async (req, res) => {
//   const { phoneNumber, transactionDetails } = req.body;  // Extract phoneNumber and message from request body
//      const message = generateInvoiceMessage(transactionDetails);
//   // Ensure phoneNumber is properly formatted with the 'whatsapp:' prefix
//   const formattedPhoneNumber = `whatsapp:+${phoneNumber}`;

//   try {
//     // Send the WhatsApp message using Twilio
//     const response = await client.messages.create({
//       body: message,  // Message to send (e.g., the invoice link)
//       from: 'whatsapp:+14155238886',  // Twilio sandbox number or your WhatsApp business number
//       to: formattedPhoneNumber,       // Customer's phone number in international format
//     });

//     // If the message is sent successfully
//     res.status(200).send({
//       message: "Message sent successfully!",
//       data: response,
//     });
//   } catch (error) {
//     console.error("Error sending message:", error);
//     res.status(500).send({
//       message: "Failed to send message",
//       error: error.message,
//     });
//   }
// };

// module.exports = { sendMessage };





const twilio = require('twilio');
require('dotenv').config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

function generateInvoiceMessage(transactionDetails) {
  let message = `📄 *INVOICE - ${transactionDetails.companyName}*\n\n`;
  message += `*Invoice No:* ${transactionDetails.invoiceNumber}\n`;
  message += `*Date:* ${new Date(transactionDetails.date).toLocaleDateString()}\n`;
  message += `*Customer:* ${transactionDetails.partyName}\n\n`;
  
  message += `*ITEMS:*\n`;
  message += '────────────────\n';
  
  // Add each item to the message
  transactionDetails.items.forEach((item, index) => {
    message += `${index + 1}. ${item.name}\n`;
    message += `   Qty: ${item.quantity || 1} × ₹${item.price || 0} = ₹${item.amount}\n`;
  });
  
  message += '────────────────\n';
  message += `*Subtotal:* ₹${transactionDetails.subTotal}\n`;
  message += `*Tax:* ₹${transactionDetails.taxAmount}\n`;
  message += `*TOTAL:* ₹${transactionDetails.totalAmount}\n\n`;
  
  message += `Thank you for your business! 🎉\n\n`;
  message += `Best regards,\n`;
  message += `*${transactionDetails.companyName}*`;
  
  return message;
}

// Handle different message types
function generateMessage(transactionDetails, messageType) {
  if (messageType === "detailed_invoice") {
    return generateInvoiceMessage(transactionDetails);
  } else {
    // Fallback to simple message
    return `Your invoice ${transactionDetails.invoiceNumber} for ₹${transactionDetails.totalAmount} has been generated. Thank you!`;
  }
}

// Send WhatsApp message
const sendMessage = async (req, res) => {
  const { phoneNumber, transactionDetails, messageType } = req.body;
  
  // Validate required fields
  if (!phoneNumber || !transactionDetails) {
    return res.status(400).send({
      message: "Phone number and transaction details are required",
    });
  }

  try {
    const message = generateMessage(transactionDetails, messageType);
    const formattedPhoneNumber = `whatsapp:+${phoneNumber.replace(/\D/g, '')}`; // Remove non-digits

    // Send the WhatsApp message using Twilio
    const response = await client.messages.create({
      body: message,
      from: 'whatsapp:+14155238886',  // Twilio sandbox number
      to: formattedPhoneNumber,
    });

    res.status(200).send({
      message: "WhatsApp message sent successfully!",
      data: response,
      formattedMessage: message // Optional: for debugging
    });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).send({
      message: "Failed to send WhatsApp message",
      error: error.message,
    });
  }
};

module.exports = { sendMessage };
