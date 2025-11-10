import express from 'express';
import logger from '../utils/logger.js';
import { getOverlayManager } from '../services/overlay-manager.js';

const router = express.Router();

// Helper to call Electron IPC (when running in Electron context)
async function callElectronIPC(channel, data) {
  // Check if we're running in Electron context
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
    try {
      const { ipcRenderer } = require('electron');
      return await ipcRenderer.invoke(channel, data);
    } catch (error) {
      logger.debug('Not in Electron renderer context, skipping IPC call');
    }
  }
  return null;
}

/**
 * POST /screen/overlay/highlight
 * Show element highlight
 */
router.post('/highlight', async (req, res) => {
  try {
    const payload = req.body.payload || req.body;
    const { element, duration = 3000 } = payload;
    
    if (!element) {
      return res.status(400).json({
        success: false,
        error: 'Element is required'
      });
    }

    logger.info('Overlay highlight request', { element, duration });

    const overlayManager = getOverlayManager();
    await overlayManager.highlightElements([element], duration);

    res.json({
      success: true,
      action: 'highlight',
      duration,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Overlay highlight failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /screen/overlay/toast
 * Show notification overlay
 */
router.post('/toast', async (req, res) => {
  try {
    const payload = req.body.payload || req.body;
    const { message, type = 'info', duration = 3000 } = payload;
    
    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    logger.info('Overlay toast request', { message, type, duration });

    const overlayManager = getOverlayManager();
    await overlayManager.showToast({ message, type, duration });

    res.json({
      success: true,
      action: 'toast',
      message,
      type,
      duration,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Overlay toast failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /screen/overlay/clear
 * Clear all overlays
 */
router.post('/clear', async (req, res) => {
  try {
    logger.info('Overlay clear request');

    const overlayManager = getOverlayManager();
    await overlayManager.clearAll();

    res.json({
      success: true,
      action: 'clear',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Overlay clear failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
