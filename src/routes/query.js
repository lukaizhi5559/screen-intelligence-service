import express from 'express';
import logger from '../utils/logger.js';
import { getAccessibilityAdapter } from '../adapters/accessibility/index.js';
import { getOverlayManager } from '../services/overlay-manager.js';

const router = express.Router();

/**
 * POST /screen/query
 * Find elements matching query with highlighting
 * 
 * Body:
 * {
 *   "query": "Send button",
 *   "role": "button",  // optional
 *   "highlight": true
 * }
 */
router.post('/', async (req, res) => {
  try {
    const payload = req.body.payload || req.body;
    const { query, role, highlight = true } = payload;
    
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    logger.info('Screen query request', { query, role, highlight });

    // Get accessibility adapter
    const adapter = getAccessibilityAdapter();
    
    // Query elements
    const elements = await adapter.queryElements({ query, role });
    
    // Highlight if requested
    if (highlight && elements.length > 0) {
      const overlayManager = getOverlayManager();
      await overlayManager.highlightElements(elements);
    }

    // Build response
    const response = {
      success: true,
      query,
      matchCount: elements.length,
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
    logger.error('Screen query failed', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
