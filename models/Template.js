// models/Template.js
const mongoose = require('mongoose');

// Assuming you have a Client model
const Client = require('./Client'); // Adjust the path as necessary

const templateSchema = new mongoose.Schema(
  {
    defaultTemplate: {
      type: String,
      required: true,
      trim: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client', // Reference to the Client model
    },
  },
  { timestamps: true }
);

const Template = mongoose.model('Template', templateSchema);

module.exports = Template;
