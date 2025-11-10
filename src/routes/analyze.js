import express from 'express';
import logger from '../utils/logger.js';
import { getOverlayManager } from '../services/overlay-manager.js';
import { detectScreenContext } from '../utils/window-detector.js';
import { analyzeContext, getSelectedText } from '../utils/window-analyzer.js';

const router = express.Router();

/**
 * POST /screen/analyze
 * Context-aware screen analysis - detects which window to analyze based on query
 * 
 * Body:
 * {
 *   "query": "How many files on my desktop?",
 *   "showOverlay": true,
 *   "includeScreenshot": false
 * }
 */
router.post('/', async (req, res) => {
  try {
    // Support both MCP envelope format and direct payload
    const payload = req.body.payload || req.body;
    const { query, showOverlay = false, includeScreenshot = false } = payload;
    
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }
    
    logger.info('Context-aware screen analysis', { query, showOverlay, includeScreenshot });

    // 1. Detect screen context (fullscreen or all windows)
    // Note: Query is stored for response but not used for window detection
    // AI will filter relevant windows from the returned set based on query
    const context = await detectScreenContext();
    logger.info('Detected context', context);
    
    if (!context.windows || context.windows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No suitable window found for analysis',
        strategy: context.strategy
      });
    }

    // 2. Get selected text from frontmost app (if any)
    const selectedText = await getSelectedText();
    if (selectedText) {
      logger.info('Found selected text', { length: selectedText.length });
    }

    // 3. Analyze the detected context (windows)
    const analysis = await analyzeContext(context, includeScreenshot);

    // 4. Show overlay if requested
    if (showOverlay && analysis.elements.length > 0) {
      const overlayManager = getOverlayManager();
      await overlayManager.showDiscoveryMode(analysis.elements);
    }

    // 5. Build response
    const response = {
      success: true,
      query,
      strategy: analysis.strategy,
      windowsAnalyzed: analysis.windowsAnalyzed,
      elementCount: analysis.elements.length,
      selectedText: selectedText || null, // Include selected text if found
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
      screenshots: analysis.screenshots.map(s => s.toString('base64')),
      timestamp: new Date().toISOString()
    };

    logger.info('Analysis complete', { 
      windows: analysis.windowsAnalyzed.length,
      elements: analysis.elements.length 
    });
    
    res.json(response);

  } catch (error) {
    logger.error('Screen analysis failed', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
