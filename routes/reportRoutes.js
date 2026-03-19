const express = require("express")
const router = express.Router()
const { getDailyReport, getMonthlyReport } = require('../controllers/reportController');

router.get('/daily', getDailyReport);
router.get('/monthly', getMonthlyReport);


module.exports = router;