/**
 * Screen Watcher Control Endpoints
 * 
 * API routes for controlling the continuous vision streaming service
 */

import express from 'express';
import logger from '../utils/logger.js';
import { getScreenWatcher } from '../services/screenWatcher.js';

const router = express.Router();

/**
 * POST /watcher/start
 * Start the continuous screen watcher
 * 
 * Body (optional):
 * {
 *   "fps": 2,
 *   "captureOnChange": true,
 *   "minChangeThreshold": 0.05
 * }
 */
router.post('/start', async (req, res) => {
  try {
    const options = req.body.payload || req.body;
    
    logger.info('🚀 Starting ScreenWatcher', options);
    
    const watcher = getScreenWatcher(options);
    const result = await watcher.start();
    
    res.json(result);
    
  } catch (error) {
    logger.error('Failed to start ScreenWatcher', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /watcher/stop
 * Stop the continuous screen watcher
 */
router.post('/stop', async (req, res) => {
  try {
    logger.info('⏹️  Stopping ScreenWatcher');
    
    const watcher = getScreenWatcher();
    const result = watcher.stop();
    
    res.json(result);
    
  } catch (error) {
    logger.error('Failed to stop ScreenWatcher', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /watcher/pause
 * Pause the screen watcher (keeps running but skips captures)
 */
router.post('/pause', async (req, res) => {
  try {
    logger.info('⏸️  Pausing ScreenWatcher');
    
    const watcher = getScreenWatcher();
    const result = watcher.pause();
    
    res.json(result);
    
  } catch (error) {
    logger.error('Failed to pause ScreenWatcher', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /watcher/resume
 * Resume the paused screen watcher
 */
router.post('/resume', async (req, res) => {
  try {
    logger.info('▶️  Resuming ScreenWatcher');
    
    const watcher = getScreenWatcher();
    const result = watcher.resume();
    
    res.json(result);
    
  } catch (error) {
    logger.error('Failed to resume ScreenWatcher', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /watcher/status
 * Get current status and statistics
 */
router.get('/status', (req, res) => {
  try {
    const watcher = getScreenWatcher();
    const status = watcher.getStatus();
    
    res.json({
      success: true,
      ...status,
    });
    
  } catch (error) {
    logger.error('Failed to get ScreenWatcher status', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /watcher/config
 * Update watcher configuration on the fly
 * 
 * Body:
 * {
 *   "fps": 3,
 *   "captureOnChange": true,
 *   "minChangeThreshold": 0.1
 * }
 */
router.post('/config', (req, res) => {
  try {
    const newConfig = req.body.payload || req.body;
    
    logger.info('🔧 Updating ScreenWatcher config', newConfig);
    
    const watcher = getScreenWatcher();
    const result = watcher.updateConfig(newConfig);
    
    res.json(result);
    
  } catch (error) {
    logger.error('Failed to update ScreenWatcher config', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /watcher/capture
 * Force an immediate capture (bypasses pause and triggers)
 */
router.post('/capture', async (req, res) => {
  try {
    logger.info('📸 Manual capture requested');
    
    const watcher = getScreenWatcher();
    const result = await watcher.captureNow();
    
    res.json(result);
    
  } catch (error) {
    logger.error('Failed to capture', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
