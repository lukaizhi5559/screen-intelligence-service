/**
 * Cleanup Route
 * Manual cleanup and storage stats endpoints
 */

import express from 'express';
import { getCleanupManager } from '../utils/cleanupManager.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /cleanup/stats
 * Get current storage usage statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const cleanupManager = getCleanupManager();
    const stats = await cleanupManager.getStorageStats();
    
    res.json({
      success: true,
      stats,
      config: {
        screenshotMaxAge: `${cleanupManager.config.screenshotMaxAge / 1000}s`,
        screenshotCleanupFrequency: `${cleanupManager.config.screenshotCleanupFrequency / 1000}s`,
        maxLogSize: `${cleanupManager.config.maxLogSize / (1024 * 1024)}MB`,
        maxLogFiles: cleanupManager.config.maxLogFiles
      }
    });
  } catch (error) {
    logger.error('Failed to get storage stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cleanup/force
 * Force immediate cleanup of old files
 */
router.post('/force', async (req, res) => {
  try {
    const cleanupManager = getCleanupManager();
    const result = await cleanupManager.forceCleanup();
    
    res.json({
      success: true,
      message: 'Cleanup completed',
      result
    });
  } catch (error) {
    logger.error('Failed to force cleanup:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cleanup/screenshots
 * Clean up old screenshots only
 */
router.post('/screenshots', async (req, res) => {
  try {
    const cleanupManager = getCleanupManager();
    const result = await cleanupManager.cleanupScreenshots();
    
    res.json({
      success: true,
      message: 'Screenshot cleanup completed',
      deleted: result.deleted,
      freedSpace: `${(result.freedSpace / (1024 * 1024)).toFixed(2)}MB`
    });
  } catch (error) {
    logger.error('Failed to cleanup screenshots:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cleanup/logs
 * Rotate logs if needed
 */
router.post('/logs', async (req, res) => {
  try {
    const cleanupManager = getCleanupManager();
    await cleanupManager.rotateLogsIfNeeded();
    
    res.json({
      success: true,
      message: 'Log rotation completed'
    });
  } catch (error) {
    logger.error('Failed to rotate logs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
