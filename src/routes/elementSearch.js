/**
 * Element Search Route
 * 
 * Provides semantic search for UI elements using the persistent semantic index
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
      filters = {},
      screenContext
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
    const results = await semanticIndex.search({
      query,
      filters,
      k,
      minScore
    });
    const searchTime = Date.now() - searchStart;

    logger.info('Element search completed', {
      query,
      resultsCount: results.length,
      searchTime: `${searchTime}ms`
    });

    res.json({
      success: true,
      results: results.map(r => ({
        id: r.node.id,
        type: r.node.type,
        text: r.node.text,
        bbox: r.node.bbox,
        description: r.node.description,
        score: r.score
      })),
      query,
      count: results.length
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
