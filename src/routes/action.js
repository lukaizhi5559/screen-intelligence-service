import express from 'express';
import logger from '../utils/logger.js';
import { getActionEngine } from '../services/action-engine.js';
import { getOverlayManager } from '../services/overlay-manager.js';

const router = express.Router();

/**
 * POST /screen/action/click
 * Click an element with guide overlay
 */
router.post('/click', async (req, res) => {
  try {
    const payload = req.body.payload || req.body;
    const { target, showGuide = true } = payload;
    
    if (!target) {
      return res.status(400).json({
        success: false,
        error: 'Target is required'
      });
    }

    logger.info('Screen click request', { target, showGuide });

    const actionEngine = getActionEngine();
    const overlayManager = getOverlayManager();

    // Show guide overlay
    if (showGuide) {
      await overlayManager.showActionGuide({
        action: 'click',
        target,
        step: 1,
        total: 1
      });
    }

    // Perform click
    const result = await actionEngine.click(target);

    // Show confirmation
    if (showGuide) {
      await overlayManager.showToast({
        message: `Clicked: ${target}`,
        type: 'success',
        duration: 2000
      });
    }

    res.json({
      success: true,
      action: 'click',
      target,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Screen click failed', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /screen/action/type
 * Type text with visual confirmation
 */
router.post('/type', async (req, res) => {
  try {
    const payload = req.body.payload || req.body;
    const { target, text, showConfirmation = true } = payload;
    
    if (!target || !text) {
      return res.status(400).json({
        success: false,
        error: 'Target and text are required'
      });
    }

    logger.info('Screen type request', { target, textLength: text.length, showConfirmation });

    const actionEngine = getActionEngine();
    const overlayManager = getOverlayManager();

    // Show typing overlay
    if (showConfirmation) {
      await overlayManager.showActionGuide({
        action: 'type',
        target,
        text: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
        step: 1,
        total: 1
      });
    }

    // Perform typing
    const result = await actionEngine.type(target, text);

    // Show confirmation
    if (showConfirmation) {
      await overlayManager.showToast({
        message: `Typed ${text.length} characters`,
        type: 'success',
        duration: 2000
      });
    }

    res.json({
      success: true,
      action: 'type',
      target,
      textLength: text.length,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Screen type failed', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
