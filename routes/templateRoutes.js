// routes/template.js
const express = require('express');
const Template = require('../models/Template');
const verifyClientOrAdmin = require('../middleware/verifyClientOrAdmin'); // Assuming token-based auth
const verifyMasterAdmin = require('../middleware/verifyMasterAdmin');
const router = express.Router();
const Client = require("../models/Client")

router.post('/settings/default-template', verifyClientOrAdmin, async (req, res) => {
  const { defaultTemplate } = req.body;
  const { clientId } = req.auth; // Extract clientId from req.auth (set by middleware)

  try {
    // Check if a template exists for this client
    const existingTemplate = await Template.findOne({ clientId });

    if (existingTemplate) {
      // Update the existing template for this client
      existingTemplate.defaultTemplate = defaultTemplate;
      await existingTemplate.save();
      return res.status(200).json({ message: 'Default template updated successfully' });
    } else {
      // Create a new template for this client
      const newTemplate = new Template({ defaultTemplate, clientId });
      await newTemplate.save();
      return res.status(201).json({ message: 'Default template set successfully' });
    }
  } catch (error) {
    console.error('Error saving template:', error);
    return res.status(500).json({ error: 'Failed to save template setting' });
  }
});

// GET endpoint to fetch the default template
router.get('/settings/default-template', verifyClientOrAdmin, async (req, res) => {
  const { clientId } = req.auth;  // Extract clientId from decoded JWT token
  console.log("Client ID from token:", clientId);

  try {
    // Find the template for the current client
    const template = await Template.findOne({ clientId });
    console.log("Template fetched from DB:", template);

    if (!template) {
      return res.status(404).json({ message: 'Template not found for this client' });
    }

    return res.status(200).json({ defaultTemplate: template.defaultTemplate });
  } catch (error) {
    console.error('Error fetching template:', error);
    return res.status(500).json({ error: 'Failed to fetch template' });
  }
});

const path = require("path");

router.get("/services/import/template", async (req, res) => {
  try {
    const filePath = path.join(__dirname, "../templates/service-import-template.xlsx");
    return res.download(filePath, "service-import-template.xlsx");
  } catch (error) {
    console.error("Template download error:", error);
    return res.status(500).json({ message: "Failed to download template" });
  }
});
// // PUT endpoint to explicitly update the default template
// router.put('/settings/default-template', verifyMasterAdmin, async (req, res) => {
//   const { defaultTemplate } = req.body;
//   const clientId = req.user._id; // Extract clientId from decoded JWT token

//   try {
//     // Find the template for the current client
//     const template = await Template.findOne({ clientId });

//     if (!template) {
//       return res.status(404).json({ message: 'Template not found for this client' });
//     }

//     // Update the existing template for this client
//     template.defaultTemplate = defaultTemplate;
//     await template.save();

//     return res.status(200).json({ message: 'Default template updated successfully' });
//   } catch (error) {
//     console.error('Error updating template:', error);
//     return res.status(500).json({ error: 'Failed to update template' });
//   }
// });


module.exports = router;
