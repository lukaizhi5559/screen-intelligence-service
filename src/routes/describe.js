import express from 'express';
import logger from '../utils/logger.js';
import { getAccessibilityAdapter } from '../adapters/accessibility/index.js';
import { getOverlayManager } from '../services/overlay-manager.js';

const router = express.Router();

/**
 * POST /screen/describe
 * Analyze the current screen with visual feedback
 * 
 * Body:
 * {
 *   "showOverlay": true,
 *   "includeHidden": false
 * }
 */
router.post('/', async (req, res) => {
  try {
    const { showOverlay = true, includeHidden = false } = req.body;
    
    logger.info('Screen describe request', { showOverlay, includeHidden });

    // Get accessibility adapter
    const adapter = getAccessibilityAdapter();
    
    // Get all UI elements
    const elements = await adapter.getAllElements({ includeHidden });
    
    // Show overlay if requested
    if (showOverlay) {
      const overlayManager = getOverlayManager();
      await overlayManager.showDiscoveryMode(elements);
    }

    // Build response
    const response = {
      success: true,
      platform: process.platform,
      elementCount: elements.length,
      elements: elements.map(el => ({
        role: el.role,
        label: el.label,
        value: el.value,
        bounds: el.bounds,
        confidence: el.confidence || 1.0,
        actions: el.actions || []
      })),
      timestamp: new Date().toISOString()
    };

    res.json(response);
  } catch (error) {
    logger.error('Screen describe failed', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
