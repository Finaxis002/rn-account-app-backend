const express = require('express');
const router = express.Router();
const { submitFAQQuestion } = require('../controllers/faqController');

// Route for submitting FAQ questions (no auth required for public FAQ)
router.post('/submit', submitFAQQuestion);

module.exports = router;