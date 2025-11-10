import express from 'express';
import logger from '../utils/logger.js';
import { getOverlayManager } from '../services/overlay-manager.js';
import { detectScreenContext } from '../utils/window-detector.js';
import { analyzeContext } from '../utils/window-analyzer.js';

const router = express.Router();

/**
 * POST /screen/describe
 * Analyze the current screen with visual feedback using smart window detection
 * 
 * Body:
 * {
 *   "showOverlay": true,
 *   "includeHidden": false
 * }
 */
router.post('/', async (req, res) => {
  try {
    const payload = req.body.payload || req.body;
    const { showOverlay = true, includeHidden = false } = payload;
    
    logger.info('Screen describe request', { showOverlay, includeHidden });

    // Use smart context detection (fullscreen or all windows)
    const context = await detectScreenContext();
    logger.info('Detected context', { 
      strategy: context.strategy, 
      windowCount: context.windows?.length 
    });

    if (!context.windows || context.windows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No windows found to analyze'
      });
    }

    // Analyze the detected context (windows)
    const analysis = await analyzeContext(context, false);
    
    // Show overlay if requested
    if (showOverlay && analysis.elements.length > 0) {
      const overlayManager = getOverlayManager();
      await overlayManager.showDiscoveryMode(analysis.elements);
    }

    // Build response
    const response = {
      success: true,
      platform: process.platform,
      strategy: analysis.strategy,
      windowsAnalyzed: analysis.windowsAnalyzed,
      elementCount: analysis.elements.length,
      elements: analysis.elements.map(el => ({
        role: el.role,
        label: el.label,
        value: el.value,
        bounds: el.bounds,
        confidence: el.confidence || 1.0,
        actions: el.actions || [],
        windowApp: el.windowApp,
        windowTitle: el.windowTitle
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
