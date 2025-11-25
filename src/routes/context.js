import express from 'express';
import { detectScreenContext } from '../utils/window-detector.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * POST /screen/context
 * Get current active window context
 * 
 * Response:
 * {
 *   "windows": [
 *     {
 *       "appName": "Google Chrome",
 *       "title": "Gmail - Inbox",
 *       "bounds": { "x": 0, "y": 0, "width": 1920, "height": 1080 }
 *     }
 *   ]
 * }
 */
router.post('/', async (req, res) => {
  try {
    const context = await detectScreenContext();
    
    res.json({
      success: true,
      data: context
    });
  } catch (error) {
    logger.error('Failed to detect screen context:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
