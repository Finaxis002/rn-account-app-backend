// // // services/whatsapp/whatsapp.service.js - Optimized Version
// const {
//   default: makeWASocket,
//   useMultiFileAuthState,
//   DisconnectReason,
//   Browsers,
// } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const WhatsappSession = require("../../models/WhatsappSession");
const path = require("path");
const fs = require("fs");
let makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers;


class WhatsAppService {
  constructor() {
    this.clients = new Map();
    this.connectionStates = new Map();
    this.qrCallbacks = new Map();
    this.sessionFolders = new Map();

    // 🚨 AGGRESSIVE RATE LIMITING
    this.rateLimiter = new Map();
    // this.MAX_MESSAGES_PER_MINUTE = 2; // Only 2 messages per minute
    // this.MIN_DELAY_BETWEEN_MESSAGES = 30000; // 30 seconds minimum
    // this.lastMessageTime = 0;
    // this.messageCount = 0;
   
    this.MAX_STAFF_MESSAGES_PER_HOUR = 10;
    this.STAFF_MESSAGE_DELAY_MS = 10000; // 10-second delay like Go GST Bill
    this.userRoles = new Map(); // Track clientId -> role
    this.initBaileys();
  }

   async initBaileys() {
    try {
      const baileys = await import('@whiskeysockets/baileys');
      makeWASocket = baileys.default;
      useMultiFileAuthState = baileys.useMultiFileAuthState;
      DisconnectReason = baileys.DisconnectReason;
      Browsers = baileys.Browsers;
      console.log('✅ Baileys ES module loaded successfully');
    } catch (error) {
      console.error('❌ Failed to load Baileys:', error);
      throw error;
    }
  }


  // async initializeClient(clientId, userId) {
  //   try {
  //     if (this.clients.has(clientId)) {
  //       const existingClient = this.clients.get(clientId);
  //       if (existingClient && existingClient.connection === "open") {
  //         return { success: true, message: "WhatsApp already connected" };
  //       }
  //     }

  //     let session = await WhatsappSession.findOne({
  //       clientId,
  //       isActive: true,
  //     });

  //     if (!session) {
  //       session = new WhatsappSession({
  //         clientId,
  //         userId,
  //         sessionId: `wa_${clientId}_${Date.now()}`,
  //         status: "authenticating",
  //       });
  //       await session.save();
  //     }

  //     // Create session folder
  //     const sessionFolder = path.join(
  //       __dirname,
  //       "..",
  //       "..",
  //       "sessions",
  //       session.sessionId
  //     );
  //     if (!fs.existsSync(sessionFolder)) {
  //       fs.mkdirSync(sessionFolder, { recursive: true });
  //     }
  //     this.sessionFolders.set(clientId, sessionFolder);

  //     const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  //     const sock = makeWASocket({
  //       auth: state,
  //       printQRInTerminal: true, // Uses qrcode-terminal internally
  //       browser: Browsers.ubuntu("Chrome"),
  //       syncFullHistory: false,
  //       markOnlineOnConnect: false,
  //     });

  //     this.clients.set(clientId, sock);

  //     //   // QR Code Handler
  //     //   sock.ev.on("connection.update", async (update) => {
  //     //     const {
  //     //       connection,
  //     //       lastDisconnect,
  //     //       qr,
  //     //       isNewLogin,
  //     //       receivedPendingNotifications,
  //     //     } = update;

  //     //     console.log("🔐 WhatsApp Connection Update:", {
  //     //       connection,
  //     //       qr: qr ? "QR Received" : "No QR",
  //     //       isNewLogin,
  //     //       receivedPendingNotifications,
  //     //       lastDisconnect: lastDisconnect ? lastDisconnect.error : "None",
  //     //     });

  //     //     if (qr) {
  //     //       console.log(`\n=== WhatsApp QR Code for Client: ${clientId} ===`);
  //     //       qrcode.generate(qr, { small: true });
  //     //       console.log(`=== Scan the QR code above ===\n`);

  //     //       // Store raw QR code for frontend if needed
  //     //       await WhatsappSession.findByIdAndUpdate(session._id, {
  //     //         qrCode: qr, // Store the raw QR string
  //     //         status: "authenticating",
  //     //       });

  //     //       // Notify frontend (they can generate QR on their side)
  //     //       if (this.qrCallbacks.has(clientId)) {
  //     //         this.qrCallbacks.get(clientId)({ qrString: qr, clientId });
  //     //       }
  //     //     }

  //     //     if (connection === "open") {
  //     //       console.log(`✅ WhatsApp connected for client: ${clientId}`);
  //     //       console.log("📱 User Info:", await sock.user);
  //     //       await WhatsappSession.findByIdAndUpdate(session._id, {
  //     //         status: "authenticated",
  //     //         phoneNumber: sock.user?.id,
  //     //         profileName: sock.user?.name,
  //     //         lastActivity: new Date(),
  //     //         qrCode: null,
  //     //       });

  //     //       this.qrCallbacks.delete(clientId);
  //     //     }

  //     //     if (connection === "close") {
  //     //       console.log("❌ WhatsApp Disconnected:", lastDisconnect?.error);
  //     //       const shouldReconnect =
  //     //         lastDisconnect?.error?.output?.statusCode !==
  //     //         DisconnectReason.loggedOut;
  //     //       console.log(
  //     //         `Connection closed for ${clientId}. Reconnect: ${shouldReconnect}`
  //     //       );

  //     //       if (shouldReconnect) {
  //     //         setTimeout(() => this.initializeClient(clientId, userId), 5000);
  //     //       } else {
  //     //         await WhatsappSession.findByIdAndUpdate(session._id, {
  //     //           status: "disconnected",
  //     //           isActive: false,
  //     //         });
  //     //         this.clients.delete(clientId);
  //     //       }
  //     //     }
  //     //   });

  //     //   sock.ev.on("creds.update", saveCreds);

  //     // QR Code Handler
  //     sock.ev.on("connection.update", async (update) => {
  //       const {
  //         connection,
  //         lastDisconnect,
  //         qr,
  //         isNewLogin,
  //         receivedPendingNotifications,
  //       } = update;

  //       console.log("🔐 WhatsApp Connection Update:", {
  //         connection,
  //         qr: qr ? "QR Received" : "No QR",
  //         isNewLogin,
  //         receivedPendingNotifications,
  //         lastDisconnect: lastDisconnect ? lastDisconnect.error : "None",
  //       });

  //       if (qr) {
  //         console.log(`\n=== WhatsApp QR Code for Client: ${clientId} ===`);
  //         qrcode.generate(qr, { small: true });
  //         console.log(`=== Scan the QR code above ===\n`);

  //         // Store raw QR code for frontend if needed
  //         await WhatsappSession.findByIdAndUpdate(session._id, {
  //           qrCode: qr, // Store the raw QR string
  //           status: "authenticating",
  //         });

  //         // Notify frontend (they can generate QR on their side)
  //         if (this.qrCallbacks.has(clientId)) {
  //           this.qrCallbacks.get(clientId)({ qrString: qr, clientId });
  //         }
  //       }

  //       if (connection === "open") {
  //         console.log(`✅ WhatsApp connected for client: ${clientId}`);
  //         console.log("📱 User Info:", sock.user);

  //         // Reset rate limiting on new connection
  //         this.rateLimiter.delete(clientId);
  //         this.lastMessageTime = 0;
  //         this.messageCount = 0; // Reset message counter

  //         await WhatsappSession.findByIdAndUpdate(session._id, {
  //           status: "authenticated",
  //           phoneNumber: sock.user?.id,
  //           profileName: sock.user?.name,
  //           lastActivity: new Date(),
  //           qrCode: null,
  //         });

  //         this.qrCallbacks.delete(clientId);

  //         console.log(`✅ Ready to send messages for client: ${clientId}`);
  //         console.log(`📊 Rate limiting reset for new connection`);
  //       }

  //       if (connection === "close") {
  //         console.log("❌ WhatsApp Disconnected:", lastDisconnect?.error);

  //         const statusCode = lastDisconnect?.error?.output?.statusCode;
  //         const isDeviceRemoved =
  //           lastDisconnect?.error?.data?.content?.[0]?.attrs?.type ===
  //           "device_removed";
  //         const isConflict = statusCode === 401;

  //         console.log(`🔍 Disconnect Analysis:`, {
  //           statusCode: statusCode,
  //           isDeviceRemoved: isDeviceRemoved,
  //           isConflict: isConflict,
  //           error: lastDisconnect?.error?.message,
  //         });

  //         // 🚨 CRITICAL: Handle device_removed and conflict errors
  //         if (isDeviceRemoved || isConflict) {
  //           console.log(`🚨 WHATSAPP SECURITY ALERT: Session terminated`);
  //           console.log(
  //             `🚨 Reason: ${isDeviceRemoved ? "device_removed" : "conflict"}`
  //           );
  //           console.log(`🚨 This usually happens due to:`);
  //           console.log(`🚨 1. Sending messages too rapidly`);
  //           console.log(`🚨 2. Sending to unsaved numbers`);
  //           console.log(`🚨 3. Using unofficial API detection`);
  //           console.log(`🚨 4. Multiple simultaneous connections`);

  //           // 🚨 COMPLETE CLEANUP - don't auto-reconnect
  //           await this.cleanupClient(clientId);

  //           // Update session to show manual reconnection required
  //           await WhatsappSession.findByIdAndUpdate(session._id, {
  //             status: "device_removed",
  //             isActive: false,
  //             qrCode: null,
  //             lastActivity: new Date(),
  //           });

  //           console.log(
  //             `🚨 Manual re-initialization required. User must scan QR again.`
  //           );
  //           return;
  //         }

  //         const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

  //         console.log(
  //           `Connection closed for ${clientId}. Reconnect: ${shouldReconnect}`
  //         );

  //         if (shouldReconnect) {
  //           console.log(`🔄 Reconnecting in 10 seconds...`);
  //           setTimeout(() => {
  //             console.log(`🔄 Attempting reconnect for ${clientId}`);
  //             this.initializeClient(clientId, userId).catch((error) => {
  //               console.error(`❌ Reconnect failed: ${error.message}`);
  //             });
  //           }, 10000);
  //         } else {
  //           console.log(`🚪 User logged out, cleaning up...`);
  //           await WhatsappSession.findByIdAndUpdate(session._id, {
  //             status: "disconnected",
  //             isActive: false,
  //           });
  //           this.clients.delete(clientId);
  //         }
  //       }

  //       // Handle connecting state
  //       if (connection === "connecting") {
  //         console.log(`🔄 WhatsApp connecting for client: ${clientId}`);
  //         await WhatsappSession.findByIdAndUpdate(session._id, {
  //           status: "connecting",
  //         });
  //       }
  //     });

  //     sock.ev.on("creds.update", saveCreds);

  //     return {
  //       success: true,
  //       message: "WhatsApp client initialized. Check terminal for QR code.",
  //       sessionId: session._id,
  //     };
  //   } catch (error) {
  //     console.error("❌ Error initializing WhatsApp:", error);
  //     await WhatsappSession.findOneAndUpdate(
  //       { clientId, isActive: true },
  //       { status: "error" }
  //     );
  //     throw error;
  //   }
  // }

  //   async sendAutomatedMessage(
  //     clientId,
  //     vendorPhone,
  //     message,
  //     invoiceData = null
  //   ) {
  //     try {
  //       await this.enforceStrictRateLimit();
  //       console.log(`\n📤 SEND MESSAGE REQUEST: ${clientId} -> ${vendorPhone}`);

  //       const sock = this.clients.get(clientId);
  //       if (!sock || !sock.user) {
  //         throw new Error(
  //           "WhatsApp client not initialized. Please initialize first."
  //         );
  //       }

  //       // ✅ SIMPLIFIED: Just check if user exists (we're authenticated)
  //       if (!sock.user) {
  //         throw new Error(
  //           "WhatsApp not authenticated. Please scan QR code and connect first."
  //         );
  //       }

  //       console.log(`🔍 Connection Status:`, {
  //         phoneNumber: sock.user.id,
  //         isAuthenticated: true,
  //       });

  //       const formattedPhone = this.formatPhoneNumber(vendorPhone);
  //       let finalMessage = message;

  //       if (invoiceData) {
  //         finalMessage = this.generateInvoiceMessage(message, invoiceData);
  //       }

  //       console.log(`📤 Sending to: ${formattedPhone}`);
  //       console.log(`💬 Message length: ${finalMessage.length} chars`);
  //       console.log(`📝 Message preview: ${finalMessage.substring(0, 100)}...`);

  //       // ✅ TRY SENDING DIRECTLY (remove timeouts for now to see actual error)
  //       console.log("🚀 Attempting to send message...");
  //       const result = await sock.sendMessage(formattedPhone, {
  //         text: finalMessage,
  //       });

  //       this.updateRateLimit(clientId);

  //       // Update last activity
  //       await WhatsappSession.findOneAndUpdate(
  //         { clientId, isActive: true },
  //         {
  //           lastActivity: new Date(),
  //           status: "authenticated", // Ensure status is updated
  //         }
  //       );

  //       console.log(`✅ MESSAGE SENT SUCCESSFULLY!`);
  //       console.log(`📨 Message ID: ${result.key.id}`);

  //       return {
  //         success: true,
  //         messageId: result.key.id,
  //         timestamp: Math.floor(Date.now() / 1000),
  //       };
  //     } catch (error) {
  //       console.error("❌ Error sending message:", error);
  //       console.error("🔍 Error details:", {
  //         name: error.name,
  //         message: error.message,
  //         stack: error.stack,
  //       });

  //       throw error;
  //     }
  //   }

   async initializeClient(clientId, userId, role = 'staff') {
     if (!makeWASocket) {
      await this.initBaileys();
    }
    try {
      console.log(`🎯 Initializing WhatsApp for ${role}: ${clientId}`);
      
      if (this.clients.has(clientId)) {
        const existingClient = this.clients.get(clientId);
        if (existingClient && existingClient.user) {
          return { 
            success: true, 
            message: `WhatsApp already connected for ${role}`,
            userType: role
          };
        }
      }

      let session = await WhatsappSession.findOne({
        clientId,
        isActive: true,
      });

      if (!session) {
        session = new WhatsappSession({
          clientId,
          userId,
          sessionId: `wa_${clientId}_${Date.now()}`,
          status: "authenticating",
        });
        await session.save();
      }

      // Create session folder
      const sessionFolder = path.join(
        __dirname,
        "..",
        "..",
        "sessions",
        session.sessionId
      );
      if (!fs.existsSync(sessionFolder)) {
        fs.mkdirSync(sessionFolder, { recursive: true });
      }
      this.sessionFolders.set(clientId, sessionFolder);

      const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      this.clients.set(clientId, sock);
      this.userRoles.set(clientId, role); // Store user role

      // Connection handler
      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        console.log(`🔐 ${role.toUpperCase()} Connection Update:`, {
          connection,
          qr: qr ? "QR Received" : "No QR",
        });

        if (qr) {
          console.log(`\n=== WhatsApp QR Code for ${role.toUpperCase()}: ${clientId} ===`);
          qrcode.generate(qr, { small: true });
          console.log(`=== Scan the QR code above ===\n`);

          await WhatsappSession.findByIdAndUpdate(session._id, {
            qrCode: qr,
            status: "authenticating",
          });

          if (this.qrCallbacks.has(clientId)) {
            this.qrCallbacks.get(clientId)({ qrString: qr, clientId });
          }
        }

        if (connection === "open") {
          console.log(`✅ WhatsApp connected for ${role}: ${clientId}`);
          console.log("📱 User Info:", sock.user);
          
          await WhatsappSession.findByIdAndUpdate(session._id, {
            status: "authenticated",
            phoneNumber: sock.user?.id,
            profileName: sock.user?.name,
            lastActivity: new Date(),
            qrCode: null,
          });

          this.qrCallbacks.delete(clientId);
          console.log(`✅ Ready for ${role} messages`);
        }

        if (connection === "close") {
          console.log(`❌ ${role} WhatsApp Disconnected:`, lastDisconnect?.error);
          
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isDeviceRemoved = lastDisconnect?.error?.data?.content?.[0]?.attrs?.type === 'device_removed';
          
          if (isDeviceRemoved || statusCode === 401) {
            console.log(`🚨 ${role} session terminated (device_removed)`);
            await this.cleanupClient(clientId);
            await WhatsappSession.findByIdAndUpdate(session._id, {
              status: 'device_removed',
              isActive: false,
              qrCode: null,
            });
            return;
          }

          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          if (shouldReconnect) {
            setTimeout(() => this.initializeClient(clientId, userId, role), 10000);
          } else {
            await this.cleanupClient(clientId);
          }
        }
      });

      sock.ev.on("creds.update", saveCreds);

      return {
        success: true,
        message: `WhatsApp client initialized for ${role}. ${role === 'client' ? 'Scan QR code to connect.' : 'Check terminal for QR code.'}`,
        sessionId: session._id,
        userType: role
      };
    } catch (error) {
      console.error(`❌ Error initializing WhatsApp for ${role}:`, error);
      await WhatsappSession.findOneAndUpdate(
        { clientId, isActive: true },
        { status: "error" }
      );
      throw error;
    }
  }

  generateOwnerMessageLink(phone, message) {
    const formattedPhone = this.formatPhoneNumber(phone);
    const encodedMessage = encodeURIComponent(message);
    return `https://web.whatsapp.com/send?phone=${formattedPhone}&text=${encodedMessage}`;
  }


  // async sendAutomatedMessage(
  //   clientId,
  //   vendorPhone,
  //   message,
  //   invoiceData = null
  // ) {
  //   try {
  //     // 🚨 STRICT RATE LIMITING CHECKS
  //     await this.enforceUltraStrictRateLimit(clientId);
  //     await this.checkRateLimit(clientId);

  //     console.log(`\n📤 SEND MESSAGE REQUEST: ${clientId} -> ${vendorPhone}`);

  //     const sock = this.clients.get(clientId);
  //     if (!sock || !sock.user) {
  //       throw new Error("WhatsApp not connected. Please reconnect.");
  //     }

  //     console.log(`🔍 Connection Status:`, {
  //       phoneNumber: sock.user.id,
  //       isAuthenticated: true,
  //     });

  //     const formattedPhone = this.formatPhoneNumber(vendorPhone);
  //     let finalMessage = message;

  //     if (invoiceData) {
  //       finalMessage = this.generateInvoiceMessage(message, invoiceData);
  //     }

  //     console.log(`📤 Sending to: ${formattedPhone}`);
  //     console.log(`💬 Message length: ${finalMessage.length} chars`);
  //     console.log(`📝 Message preview: ${finalMessage.substring(0, 100)}...`);

  //     // 🚨 RANDOMIZED DELAY BETWEEN 15-25 SECONDS
  //     const randomDelay = 15000 + Math.random() * 10000;
  //     console.log(`⏳ Adding safety delay: ${Math.round(randomDelay / 1000)}s`);
  //     await this.delay(randomDelay);

  //     console.log("🚀 Attempting to send message...");
  //     const result = await sock.sendMessage(formattedPhone, {
  //       text: finalMessage,
  //     });

  //     // Update last activity
  //     await WhatsappSession.findOneAndUpdate(
  //       { clientId, isActive: true },
  //       {
  //         lastActivity: new Date(),
  //         status: "authenticated",
  //       }
  //     );

  //     console.log(`✅ MESSAGE SENT SUCCESSFULLY!`);
  //     console.log(`📨 Message ID: ${result.key.id}`);

  //     return {
  //       success: true,
  //       messageId: result.key.id,
  //       timestamp: Math.floor(Date.now() / 1000),
  //     };
  //   } catch (error) {
  //     console.error("❌ Error sending message:", error);
  //     console.error("🔍 Error details:", {
  //       name: error.name,
  //       message: error.message,
  //       stack: error.stack,
  //     });

  //     throw error;
  //   }
  // }

   async sendStaffMessage(clientId, vendorPhone, message, invoiceData = null) {
       if (!makeWASocket) {
      await this.initBaileys();
    }
    try {
      const userRole = this.userRoles.get(clientId);
      
      // 🚨 SAFETY CHECK: Ensure only staff can use automated sending
      if (userRole !== 'staff') {
        throw new Error('Automated sending is only available for staff accounts. Please use manual WhatsApp Web link.');
      }

      // 🎯 ENFORCE 10-SECOND DELAY BETWEEN STAFF MESSAGES
      await this.enforceStaffMessageDelay(clientId);
      
      console.log(`🎯 STAFF sending automated message: ${clientId} -> ${vendorPhone}`);
      
      const sock = this.clients.get(clientId);
      if (!sock || !sock.user) {
        throw new Error('WhatsApp not connected. Please initialize first.');
      }

      const formattedPhone = this.formatPhoneNumber(vendorPhone);
      let finalMessage = message;
      
      if (invoiceData) {
        finalMessage = this.generateInvoiceMessage(message, invoiceData);
      }

      console.log(`📤 Sending to: ${formattedPhone}`);
      console.log(`💬 Message length: ${finalMessage.length} chars`);

      // 🎯 EXACTLY 10-SECOND DELAY LIKE GO GST BILL
      console.log(`⏳ Enforcing 10-second delay between staff messages...`);
      await this.delay(this.STAFF_MESSAGE_DELAY_MS);

      console.log('🚀 Attempting to send automated message...');
      const result = await sock.sendMessage(formattedPhone, { 
        text: finalMessage 
      });
      
      // 🎯 UPDATE STAFF RATE LIMIT
      this.updateStaffRateLimit(clientId);
      
      await WhatsappSession.findOneAndUpdate(
        { clientId, isActive: true },
        { lastActivity: new Date() }
      );

      console.log(`✅ STAFF AUTOMATED MESSAGE SENT SUCCESSFULLY!`);
      
      const rateLimitInfo = this.getStaffRateLimit(clientId);
      
      return { 
        success: true, 
        messageId: result.key.id,
        userType: 'staff',
        automated: true,
        rateLimit: rateLimitInfo,
        nextMessageAvailable: Date.now() + this.STAFF_MESSAGE_DELAY_MS
      };

    } catch (error) {
      console.error('❌ Staff automated message error:', error);
      throw error;
    }
  }


  // 🚨 STRICTER RATE LIMIT ENFORCEMENT
  async enforceUltraStrictRateLimit(clientId) {
    const now = Date.now();

    // Minimum 30 seconds between messages
    if (this.lastMessageTime > 0) {
      const timeSinceLastMessage = now - this.lastMessageTime;
      if (timeSinceLastMessage < this.MIN_DELAY_BETWEEN_MESSAGES) {
        const waitTime = this.MIN_DELAY_BETWEEN_MESSAGES - timeSinceLastMessage;
        console.log(
          `⏳ Enforcing ultra-safe delay: ${Math.ceil(waitTime / 1000)}s`
        );
        await this.delay(waitTime);
      }
    }

    // Maximum 2 messages per minute
    if (this.messageCount >= this.MAX_MESSAGES_PER_MINUTE) {
      const waitTime = 60000; // Wait 1 minute
      console.log(
        `🚨 Maximum messages per minute reached. Waiting ${waitTime / 1000}s`
      );
      await this.delay(waitTime);
      this.messageCount = 0; // Reset counter
    }
  }

  // 🚨 RATE LIMITING METHODS - ADD THESE TO YOUR CLASS

  // Update rate limit counter
  updateRateLimit(clientId) {
    const now = Date.now();
    const clientLimit = this.rateLimiter.get(clientId) || {
      count: 0,
      lastReset: now,
      lastMessageTime: 0,
    };

    // Reset counter every minute
    if (now - clientLimit.lastReset > 60000) {
      clientLimit.count = 0;
      clientLimit.lastReset = now;
    }

    clientLimit.count++;
    clientLimit.lastMessageTime = now;
    this.rateLimiter.set(clientId, clientLimit);

    console.log(
      `📊 Rate limit: ${clientLimit.count}/${this.MAX_MESSAGES_PER_MINUTE} messages this minute`
    );

    // Enforce maximum of 3 messages per minute
    if (clientLimit.count >= this.MAX_MESSAGES_PER_MINUTE) {
      const waitTime = 60000 - (now - clientLimit.lastReset);
      console.log(
        `🚨 Rate limit exceeded. Waiting ${Math.ceil(
          waitTime / 1000
        )} seconds...`
      );
      return waitTime;
    }

    return 0;
  }

  // Check rate limit before sending
  async checkRateLimit(clientId) {
    const waitTime = this.updateRateLimit(clientId);
    if (waitTime > 0) {
      console.log(`⏳ Rate limit cooldown: ${Math.ceil(waitTime / 1000)}s`);
      await this.delay(waitTime);
    }
  }

  // Safety delay method
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  generateManualMessageLink(phone, message) {
    const formattedPhone = this.formatPhoneNumber(phone);
    const encodedMessage = encodeURIComponent(message);
    return `https://web.whatsapp.com/send?phone=${formattedPhone}&text=${encodedMessage}`;
  }

  formatPhoneNumber(phone) {
    const cleaned = phone.toString().replace(/\D/g, "");
    const withoutZero = cleaned.replace(/^0+/, "");

    if (withoutZero.length === 10) {
      return `91${withoutZero}@s.whatsapp.net`;
    }
    return `${withoutZero}@s.whatsapp.net`;
  }

  generateInvoiceMessage(baseMessage, invoiceData) {
    const placeholders = {
      "{{vendor_name}}": invoiceData.vendorName || "",
      "{{invoice_no}}": invoiceData.invoiceNumber || "",
      "{{amount}}": invoiceData.amount || "",
      "{{due_date}}": invoiceData.dueDate || "",
      "{{gst_amount}}": invoiceData.gstAmount || "",
      "{{total_amount}}": invoiceData.totalAmount || "",
    };

    let message = baseMessage;
    Object.keys(placeholders).forEach((key) => {
      message = message.replace(new RegExp(key, "g"), placeholders[key]);
    });
    return message;
  }

  // async getSessionStatus(clientId) {
  //     const session = await WhatsappSession.findOne({
  //         clientId,
  //         isActive: true
  //     }).lean();

  //     if (!session) {
  //         return { status: 'not_initialized' };
  //     }

  //     const sock = this.clients.get(clientId);
  //     const isConnected = sock && sock.connection === 'open';

  //     return {
  //         status: isConnected ? 'authenticated' : session.status,
  //         phoneNumber: session.phoneNumber,
  //         profileName: session.profileName,
  //         lastActivity: session.lastActivity,
  //         qrCode: session.qrCode // Raw QR string
  //     };
  // }

  async getSessionStatus(clientId) {
    try {
      const session = await WhatsappSession.findOne({
        clientId,
        isActive: true,
      }).lean();

      if (!session) {
        return { status: "not_initialized" };
      }

      const sock = this.clients.get(clientId);

      // ✅ CORRECTED: Simple but effective connection check
      const isConnected = !!sock?.user;

      console.log(`🔍 Session Status Check for ${clientId}:`, {
        hasSocket: !!sock,
        hasUser: !!sock?.user,
        phoneNumber: sock?.user?.id,
        isConnected: isConnected,
        sessionStatus: session.status,
      });

      return {
        status: isConnected ? "authenticated" : session.status,
        phoneNumber: session.phoneNumber || sock?.user?.id,
        profileName: session.profileName,
        lastActivity: session.lastActivity,
        qrCode: session.qrCode,
        // Add connection details for debugging
        connectionDetails: {
          hasSocket: !!sock,
          hasUser: !!sock?.user,
          isActuallyConnected: isConnected,
          currentPhoneNumber: sock?.user?.id,
        },
      };
    } catch (error) {
      console.error("Error in getSessionStatus:", error);
      return { status: "error", error: error.message };
    }
  }

  // Add this method to test sending capability
  async testConnection(clientId) {
    try {
      const sock = this.clients.get(clientId);
      if (!sock || !sock.user) {
        return {
          success: false,
          message: "WhatsApp not connected",
          hasSocket: !!sock,
          hasUser: !!sock?.user,
          isReadyForMessages: false,
        };
      }

      console.log(`🧪 Testing connection for ${clientId}`);

      // ✅ SIMPLER TEST: Just check if we can access basic user info
      const user = sock.user;

      return {
        success: true,
        message: "WhatsApp connected and ready",
        phoneNumber: user.id,
        isReadyForMessages: true,
        connectionDetails: {
          hasSocket: true,
          hasUser: true,
          phoneNumber: user.id,
        },
      };
    } catch (error) {
      console.error("Connection test failed:", error);
      return {
        success: false,
        message: "Connection test failed",
        error: error.message,
        isReadyForMessages: false,
      };
    }
  }

  // Add this method to your WhatsAppService class
  async checkConnectionHealth(clientId) {
    try {
      const sock = this.clients.get(clientId);
      if (!sock) {
        return {
          healthy: false,
          reason: "No socket found",
          readyForMessages: false,
        };
      }

      const isHealthy = sock.user && sock.ws && sock.ws.readyState === 1;

      return {
        healthy: isHealthy,
        readyForMessages: isHealthy,
        readyState: sock.ws?.readyState, // 1 = OPEN, 2 = CLOSING, 3 = CLOSED
        hasUser: !!sock.user,
        phoneNumber: sock.user?.id,
        userInfo: sock.user,
      };
    } catch (error) {
      return {
        healthy: false,
        reason: error.message,
        readyForMessages: false,
      };
    }
  }

  registerQrCallback(clientId, callback) {
    this.qrCallbacks.set(clientId, callback);
  }

  // Cleanup client method - ADD THIS TO YOUR CLASS
  async cleanupClient(clientId) {
    console.log(`🧹 Cleaning up client: ${clientId}`);

    const sock = this.clients.get(clientId);
    if (sock) {
      try {
        await sock.end();
        console.log(`✅ Socket ended for ${clientId}`);
      } catch (error) {
        console.error("Error ending socket:", error);
      }
    }

    this.clients.delete(clientId);
    this.connectionStates.delete(clientId);
    this.qrCallbacks.delete(clientId);
    this.sessionFolders.delete(clientId);
    this.rateLimiter.delete(clientId);

    await WhatsappSession.updateMany(
      { clientId, isActive: true },
      {
        isActive: false,
        status: "disconnected",
        qrCode: null,
      }
    );

    console.log(`✅ Client ${clientId} fully cleaned up`);
  }

  async logout(clientId) {
    try {
      const sock = this.clients.get(clientId);
      if (sock) {
        await sock.logout();
        this.clients.delete(clientId);
      }

      const sessionFolder = this.sessionFolders.get(clientId);
      if (sessionFolder && fs.existsSync(sessionFolder)) {
        fs.rmSync(sessionFolder, { recursive: true, force: true });
      }

      await WhatsappSession.updateMany(
        { clientId, isActive: true },
        {
          isActive: false,
          status: "disconnected",
          qrCode: null,
        }
      );

      this.qrCallbacks.delete(clientId);
      this.sessionFolders.delete(clientId);

      return { success: true, message: "WhatsApp session terminated" };
    } catch (error) {
      console.error("Error during logout:", error);
      throw error;
    }
  }
}

module.exports = new WhatsAppService();

// services/whatsapp/whatsapp.service.js - FINAL WORKING VERSION
// const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
// const qrcode = require('qrcode-terminal');
// const WhatsappSession = require('../../models/WhatsappSession');
// const path = require('path');
// const fs = require('fs');

// const globalState = {
//     clients: new Map(),
//     connectionStates: new Map(),
//     qrCallbacks: new Map(),
//     sessionFolders: new Map()
// };

// class WhatsAppService {
//     constructor() {
//         this.clients = new Map();
//         this.connectionStates = new Map();
//         this.qrCallbacks = new Map();
//         this.sessionFolders = new Map();

//         console.log('✅ WhatsApp Service initialized with connection state tracking');
//         console.log('🔄 WhatsApp Service Constructor Called');

//         // ✅ USE GLOBAL STATE - Prevents state loss between requests
//         this.clients = globalState.clients;
//         this.connectionStates = globalState.connectionStates;
//         this.qrCallbacks = globalState.qrCallbacks;
//         this.sessionFolders = globalState.sessionFolders;

//         console.log('✅ WhatsApp Service Initialized with Global State');
//         console.log('📊 Initial State:', {
//             clients: this.clients.size,
//             connectionStates: this.connectionStates.size,
//             sessionFolders: this.sessionFolders.size
//         });
//     }

//     async initializeClient(clientId, userId) {
//         try {
//             console.log(`\n🚀 INITIALIZING WHATSAPP FOR CLIENT: ${clientId}`);

//             // Always start fresh - cleanup any existing connection
//             await this.cleanupClient(clientId);

//             let session = await WhatsappSession.findOne({
//                 clientId,
//                 isActive: true
//             });

//             if (!session) {
//                 console.log(`📝 Creating new session for client: ${clientId}`);
//                 session = new WhatsappSession({
//                     clientId,
//                     userId,
//                     sessionId: `wa_${clientId}_${Date.now()}`,
//                     status: 'authenticating'
//                 });
//                 await session.save();
//             } else {
//                 console.log(`📂 Using existing session: ${session.sessionId}`);
//             }

//             // Create session folder
//             const sessionFolder = path.join(__dirname, '..', '..', 'sessions', session.sessionId);
//             if (!fs.existsSync(sessionFolder)) {
//                 fs.mkdirSync(sessionFolder, { recursive: true });
//             }
//             this.sessionFolders.set(clientId, sessionFolder);

//             console.log(`📁 Session folder: ${sessionFolder}`);

//             const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

//             console.log(`🔐 Auth state loaded:`, {
//                 registered: state.creds.registered,
//                 me: state.creds.me?.id
//             });

//             // Create WhatsApp socket
//             const sock = makeWASocket({
//                 auth: state,
//                 // printQRInTerminal is deprecated - we handle QR manually
//                 browser: Browsers.ubuntu('Chrome'),
//                 syncFullHistory: false,
//                 markOnlineOnConnect: false,
//                 logger: {
//                     level: 'silent' // Reduce noise
//                 }
//             });

//             // ✅ CRITICAL: Store socket and initialize connection state
//             this.clients.set(clientId, sock);
//             this.connectionStates.set(clientId, 'connecting');

//             console.log(`🔌 WhatsApp socket created and stored for ${clientId}`);
//             console.log(`📊 Initial connection state set to: connecting`);

//             // Connection event handler
//             sock.ev.on('connection.update', async (update) => {
//                 const { connection, lastDisconnect, qr } = update;

//                 console.log(`🔄 Connection update for ${clientId}: ${connection}`);

//                 // ✅ CRITICAL: Update connection state in the Map
//                 if (connection) {
//                     this.connectionStates.set(clientId, connection);
//                     console.log(`📊 Connection state updated to: ${connection}`);
//                 }

//                 if (qr) {
//                     console.log(`\n📱 QR CODE GENERATED FOR ${clientId}`);
//                     console.log('==========================================');
//                     qrcode.generate(qr, { small: true });
//                     console.log('==========================================\n');

//                     await WhatsappSession.findByIdAndUpdate(session._id, {
//                         qrCode: qr,
//                         status: 'authenticating'
//                     });

//                     if (this.qrCallbacks.has(clientId)) {
//                         this.qrCallbacks.get(clientId)({ qrString: qr, clientId });
//                     }
//                 }

//                 if (connection === 'open') {
//                     console.log(`🎉 WHATSAPP CONNECTED SUCCESSFULLY: ${clientId}`);

//                     const user = sock.user;
//                     console.log(`📱 Connected as: ${user?.name || user?.id}`);

//                     await WhatsappSession.findByIdAndUpdate(session._id, {
//                         status: 'authenticated',
//                         phoneNumber: user?.id,
//                         profileName: user?.name,
//                         lastActivity: new Date(),
//                         qrCode: null
//                     });

//                     this.qrCallbacks.delete(clientId);

//                     console.log(`✅ Ready to send messages for client: ${clientId}`);
//                 }

//                 if (connection === 'close') {
//                     console.log(`❌ Connection closed: ${clientId}`);

//                     const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

//                     if (shouldReconnect) {
//                         console.log(`🔄 Reconnecting in 5 seconds...`);
//                         setTimeout(() => {
//                             console.log(`🔄 Attempting reconnect for ${clientId}`);
//                             this.initializeClient(clientId, userId).catch(error => {
//                                 console.error(`❌ Reconnect failed: ${error.message}`);
//                             });
//                         }, 5000);
//                     } else {
//                         console.log(`🚪 User logged out, cleaning up...`);
//                         await this.cleanupClient(clientId);
//                     }
//                 }
//             });

//             sock.ev.on('creds.update', saveCreds);

//             return {
//                 success: true,
//                 message: 'WhatsApp client initialized. Scan the QR code in terminal.',
//                 sessionId: session._id
//             };

//         } catch (error) {
//             console.error('❌ Error initializing WhatsApp:', error);
//             this.connectionStates.set(clientId, 'error');

//             await WhatsappSession.findOneAndUpdate(
//                 { clientId, isActive: true },
//                 { status: 'error' }
//             );

//             throw error;
//         }
//     }

//     // ✅ FIXED: sendAutomatedMessage with proper connection checking
//     async sendAutomatedMessage(clientId, vendorPhone, message, invoiceData = null) {
//         try {
//             console.log(`\n📤 SEND MESSAGE REQUEST: ${clientId} -> ${vendorPhone}`);

//             // ✅ Get current connection state
//             const connectionState = this.connectionStates.get(clientId);
//             const sock = this.clients.get(clientId);

//             console.log(`🔍 Connection check:`, {
//                 connectionState: connectionState,
//                 hasSocket: !!sock,
//                 hasUser: !!(sock?.user),
//                 connectionStatesMap: Array.from(this.connectionStates.entries())
//             });

//             // If connection state is undefined but we have a socket, check if it's actually connected
//             if (!connectionState && sock && sock.user) {
//                 console.log(`🔄 Connection state was undefined but socket exists with user, updating state to 'open'`);
//                 this.connectionStates.set(clientId, 'open');
//             }

//             const currentState = this.connectionStates.get(clientId);

//             if (currentState !== 'open') {
//                 throw new Error(`WhatsApp not ready. State: ${currentState || 'undefined'}. Please reconnect.`);
//             }

//             if (!sock) {
//                 throw new Error('WhatsApp socket not found. Please initialize WhatsApp first.');
//             }

//             const formattedPhone = this.formatPhoneNumber(vendorPhone);
//             let finalMessage = message;

//             if (invoiceData) {
//                 finalMessage = this.generateInvoiceMessage(message, invoiceData);
//             }

//             console.log(`📤 Sending to: ${formattedPhone}`);
//             console.log(`💬 Message length: ${finalMessage.length} characters`);

//             const result = await sock.sendMessage(formattedPhone, {
//                 text: finalMessage
//             });

//             // Update last activity
//             await WhatsappSession.findOneAndUpdate(
//                 { clientId, isActive: true },
//                 { lastActivity: new Date() }
//             );

//             console.log(`✅ MESSAGE SENT SUCCESSFULLY! Message ID: ${result.key.id}`);

//             return {
//                 success: true,
//                 messageId: result.key.id,
//                 timestamp: Math.floor(Date.now() / 1000)
//             };

//         } catch (error) {
//             console.error('❌ Error sending message:', error);

//             // If connection error, update state
//             if (error.message.includes('not ready') || error.message.includes('socket')) {
//                 this.connectionStates.set(clientId, 'disconnected');
//             }

//             throw error;
//         }
//     }

//     // ✅ FIXED: getSessionStatus with proper state checking
//     async getSessionStatus(clientId) {
//         try {
//             const session = await WhatsappSession.findOne({
//                 clientId,
//                 isActive: true
//             }).lean();

//             if (!session) {
//                 return { status: 'not_initialized' };
//             }

//             const connectionState = this.connectionStates.get(clientId);
//             const sock = this.clients.get(clientId);

//             // Check if actually connected
//             const isActuallyConnected = connectionState === 'open' && sock && sock.user;

//             console.log(`🔍 REAL Session status for ${clientId}:`, {
//                 dbStatus: session.status,
//                 connectionState: connectionState,
//                 hasSocket: !!sock,
//                 hasUser: !!(sock?.user),
//                 isActuallyConnected: isActuallyConnected,
//                 allConnectionStates: Array.from(this.connectionStates.entries())
//             });

//             return {
//                 status: isActuallyConnected ? 'authenticated' : session.status,
//                 phoneNumber: session.phoneNumber,
//                 profileName: session.profileName,
//                 lastActivity: session.lastActivity,
//                 qrCode: session.qrCode,
//                 connectionState: connectionState,
//                 hasSocket: !!sock,
//                 isActuallyConnected: isActuallyConnected
//             };
//         } catch (error) {
//             console.error('Error in getSessionStatus:', error);
//             return { status: 'error' };
//         }
//     }

//     // Cleanup client
//     async cleanupClient(clientId) {
//         console.log(`🧹 Cleaning up client: ${clientId}`);

//         const sock = this.clients.get(clientId);
//         if (sock) {
//             try {
//                 await sock.end();
//                 console.log(`✅ Socket ended for ${clientId}`);
//             } catch (error) {
//                 console.error('Error ending socket:', error);
//             }
//         }

//         this.clients.delete(clientId);
//         this.connectionStates.delete(clientId);
//         this.qrCallbacks.delete(clientId);
//         this.sessionFolders.delete(clientId);

//         await WhatsappSession.updateMany(
//             { clientId, isActive: true },
//             {
//                 isActive: false,
//                 status: 'disconnected',
//                 qrCode: null
//             }
//         );

//         console.log(`✅ Client ${clientId} fully cleaned up`);
//     }

//     // Force reinitialize
//     async forceReinitialize(clientId, userId) {
//         console.log(`🔄 FORCE REINITIALIZE: ${clientId}`);
//         await this.cleanupClient(clientId);
//         return await this.initializeClient(clientId, userId);
//     }

//     // Utility methods
//     generateManualMessageLink(phone, message) {
//         const formattedPhone = this.formatPhoneNumber(phone);
//         const encodedMessage = encodeURIComponent(message);
//         return `https://web.whatsapp.com/send?phone=${formattedPhone}&text=${encodedMessage}`;
//     }

//     formatPhoneNumber(phone) {
//         const cleaned = phone.toString().replace(/\D/g, '');
//         const withoutZero = cleaned.replace(/^0+/, '');

//         if (withoutZero.length === 10) {
//             return `91${withoutZero}@s.whatsapp.net`;
//         }
//         return `${withoutZero}@s.whatsapp.net`;
//     }

//     generateInvoiceMessage(baseMessage, invoiceData) {
//         const placeholders = {
//             '{{vendor_name}}': invoiceData.vendorName || '',
//             '{{invoice_no}}': invoiceData.invoiceNumber || '',
//             '{{amount}}': invoiceData.amount || '',
//             '{{due_date}}': invoiceData.dueDate || '',
//             '{{gst_amount}}': invoiceData.gstAmount || '',
//             '{{total_amount}}': invoiceData.totalAmount || '',
//             '{{party_name}}': invoiceData.partyName || ''
//         };

//         let message = baseMessage;
//         Object.keys(placeholders).forEach(key => {
//             message = message.replace(new RegExp(key, 'g'), placeholders[key]);
//         });
//         return message;
//     }

//     registerQrCallback(clientId, callback) {
//         this.qrCallbacks.set(clientId, callback);
//     }

//     async logout(clientId) {
//         return await this.cleanupClient(clientId);
//     }

//     // Debug method
//     // Add this method to your WhatsAppService class
// debugServiceState() {
//     console.log('🔍 SERVICE STATE DEBUG:');
//     console.log('📊 Service Instance:', this);
//     console.log('👥 Clients Map Size:', this.clients.size);
//     console.log('🔗 Connection States Size:', this.connectionStates.size);
//     console.log('📁 Session Folders Size:', this.sessionFolders.size);

//     const clients = Array.from(this.clients.entries()).map(([key, value]) => ({
//         clientId: key,
//         hasSocket: !!value,
//         hasUser: !!(value?.user)
//     }));

//     const connectionStates = Array.from(this.connectionStates.entries());

//     return {
//         serviceInstance: `WhatsAppService@${this.constructor.name}`,
//         clients: clients,
//         connectionStates: connectionStates,
//         sessionFolders: Array.from(this.sessionFolders.keys()),
//         maps: {
//             clientsSize: this.clients.size,
//             connectionStatesSize: this.connectionStates.size,
//             sessionFoldersSize: this.sessionFolders.size
//         }
//     };
// }

// // Add this method to your WhatsAppService class
// checkStatePersistence() {
//     console.log('🔍 STATE PERSISTENCE CHECK:');
//     console.log('📊 Current State:', {
//         clients: this.clients.size,
//         connectionStates: this.connectionStates.size,
//         sessionFolders: this.sessionFolders.size,
//         isSameInstance: this.clients === globalState.clients
//     });

//     // Log all connected clients
//     if (this.connectionStates.size > 0) {
//         console.log('🔗 Active Connections:');
//         for (const [clientId, state] of this.connectionStates.entries()) {
//             console.log(`  - ${clientId}: ${state}`);
//         }
//     }

//     return {
//         clients: this.clients.size,
//         connectionStates: this.connectionStates.size,
//         sessionFolders: this.sessionFolders.size,
//         isUsingGlobalState: this.clients === globalState.clients
//     };
// }

// }

// module.exports = new WhatsAppService();
