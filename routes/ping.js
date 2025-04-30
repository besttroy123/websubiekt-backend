const express = require('express');
const router = express.Router();

// Ping endpoint
router.get('/', (req, res) => {
  res.json({ message: 'pong' });
});

module.exports = router;