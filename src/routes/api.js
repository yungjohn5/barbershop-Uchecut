const express = require('express');
const { apiLimiter } = require('../middleware/rateLimits');

const router = express.Router();
router.use(apiLimiter);

// Endpoints: /zones, /services, /slots (Phase 2).

module.exports = router;
