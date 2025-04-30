const express = require('express');
const router = express.Router();

/**
 * API endpoint to set update interval for both inventory and sales-report
 * This allows changing the interval time without restarting the application
 */
router.get('/set-interval', (req, res) => {
  try {
    const newInterval = req.query.interval;
    
    if (!newInterval || isNaN(parseInt(newInterval))) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid interval value. Please provide a valid number in milliseconds.' 
      });
    }
    
    // Update the environment variable
    process.env.API_UPDATE_INTERVAL = newInterval;
    
    // Clear existing intervals in both modules if they exist
    // This will be handled by the respective modules on their next execution
    
    res.json({ 
      success: true, 
      message: `Update interval for all APIs changed to ${newInterval} ms. Will take effect immediately on next execution.` 
    });
  } catch (error) {
    console.error('Error changing API update interval:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to change API update interval',
      error: error.message
    });
  }
});

/**
 * Get current API settings
 */
router.get('/', (req, res) => {
  try {
    const currentInterval = process.env.API_UPDATE_INTERVAL || '300000';
    
    res.json({
      update_interval: currentInterval,
      update_interval_readable: `${Math.floor(parseInt(currentInterval) / 60000)} minutes ${(parseInt(currentInterval) % 60000) / 1000} seconds`
    });
  } catch (error) {
    console.error('Error fetching API settings:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch API settings',
      error: error.message
    });
  }
});

module.exports = router;