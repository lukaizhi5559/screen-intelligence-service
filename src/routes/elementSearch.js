/**
 * Element Search Route
 * 
 * ⚡ FAST QUERY ENDPOINT - Queries pre-indexed DuckDB (no heavy vision)
 * 
 * This endpoint searches the continuously updated screen state maintained by
 * ScreenWatcher. It does NOT re-run OWLv2/OCR - it queries the DuckDB vector
 * store that's kept fresh by the background streaming service.
 * 
 * Expected performance: <100ms
 * 
 * Prerequisites:
 * - ScreenWatcher must be running (POST /watcher/start)
 * - DuckDB must have indexed screen states
 * 
 * Use cases:
 * - "Find the save button"
 * - "Get email body text"
 * - "Locate search box"
 * - "Polish up this email" (get email text for LLM)
 */

import express from 'express';
import logger from '../utils/logger.js';
import { getPersistentSemanticIndex } from '../services/persistentSemanticIndex.js';

const router = express.Router();

/**
 * POST /element.search
 * Search for UI elements using semantic search
 * 
 * Request body:
 * {
 *   query: string,           // Search query (e.g., "save button", "email from Alice")
 *   k: number,              // Number of results to return (default: 3)
 *   minScore: number,       // Minimum similarity score (default: 0.5)
 *   filters: {              // Optional filters
 *     types: string[],      // Filter by element types
 *     clickableOnly: boolean
 *   },
 *   screenContext: object   // Optional screen context for better search
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   results: [
 *     {
 *       id: string,
 *       type: string,
 *       text: string,
 *       bbox: [x1, y1, x2, y2],
 *       description: string,
 *       score: number
 *     }
 *   ],
 *   query: string,
 *   count: number
 * }
 */
router.post('/element.search', async (req, res, next) => {
  try {
    // Extract from MCP protocol payload
    const payload = req.body.payload || req.body;
    
    const {
      query,
      k = 3,
      minScore = 0.5,
      filters = {}
    } = payload;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query parameter is required'
      });
    }

    logger.info('Element search request', {
      query,
      k,
      minScore,
      filters
    });

    // Get semantic index
    const semanticIndex = getPersistentSemanticIndex();
    await semanticIndex.initialize();

    // Perform search
    const searchStart = Date.now();
    let results = await semanticIndex.search({
      query,
      filters,
      k: k + 5, // Request extra results to find text elements
      minScore: Math.min(minScore, 0.2) // Lower threshold to catch text elements
    });
    const searchTime = Date.now() - searchStart;

    // CRITICAL FIX: Always include OCR text elements (type='text') in results
    // These contain the actual screen content but may score lower than UI containers
    const textElements = results.filter(r => r.node.type === 'text');
    const nonTextElements = results.filter(r => r.node.type !== 'text');
    
    // Prioritize text elements, then take remaining slots with other elements
    const finalResults = [
      ...textElements,
      ...nonTextElements.slice(0, Math.max(0, k - textElements.length))
    ].slice(0, k);

    logger.info('Element search completed', {
      query,
      totalResults: results.length,
      textElements: textElements.length,
      finalResults: finalResults.length,
      searchTime: `${searchTime}ms`
    });

    res.json({
      success: true,
      results: finalResults.map(r => ({
        id: r.node.id,
        type: r.node.type,
        text: r.node.text,
        bbox: r.node.bbox,
        description: r.node.description,
        score: r.score
      })),
      query,
      count: finalResults.length,
      performance: {
        searchTime: `${searchTime}ms`,
        fast: searchTime < 100, // Flag if query was fast (<100ms)
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Element search failed', {
      error: error.message,
      stack: error.stack
    });
    next(error);
  }
});

export default router;
