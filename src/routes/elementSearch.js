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
      minScore = 0.1, // LOWERED: Allow generic queries to match
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
    
    console.log('\n🔍 [ELEMENT_SEARCH] Search Request:');
    console.log(`   Query: "${query}"`);
    console.log(`   K: ${k}`);
    console.log(`   MinScore: ${minScore}`);
    console.log(`   Filters:`, JSON.stringify(filters, null, 2));

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

    // CRITICAL FIX: Filter out results from different apps if app filter was provided
    // This ensures we only return results from the current active window
    if (filters.app) {
      const beforeFilter = results.length;
      console.log(`\n🔍 [ELEMENT_SEARCH] Before app filter: ${beforeFilter} results`);
      if (results.length > 0) {
        console.log(`   Sample result structure:`, {
          id: results[0].id,
          resultType: results[0].resultType,
          score: results[0].score,
          nodeApp: results[0].node?.app,
          nodeKeys: Object.keys(results[0].node || {})
        });
      }
      results = results.filter(r => r.node.metadata?.app === filters.app);
      console.log(`\n🔍 [ELEMENT_SEARCH] After app filter: ${results.length} results`);
      if (results.length < beforeFilter) {
        logger.info(`Filtered out ${beforeFilter - results.length} results from other apps`);
      }
    }

    // NOTE: Overlay filtering is now handled at capture time by hiding the overlay
    // before screen capture, so no post-processing filter is needed here

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
    
    console.log('\n📊 [ELEMENT_SEARCH] Search Results:');
    console.log(`   Total results: ${results.length}`);
    console.log(`   Text elements: ${textElements.length}`);
    console.log(`   Final results: ${finalResults.length}`);
    console.log(`   Search time: ${searchTime}ms`);
    console.log('\n📋 [ELEMENT_SEARCH] Top 10 Results:');
    finalResults.slice(0, 10).forEach((r, i) => {
      console.log(`\n   ${i + 1}. Score: ${r.score?.toFixed(3)} | Type: ${r.node.type}`);
      console.log(`      App: ${r.node.metadata?.app || 'N/A'}`);
      console.log(`      Window: ${r.node.metadata?.windowTitle?.substring(0, 50) || 'N/A'}`);
      console.log(`      Timestamp: ${r.node.timestamp ? new Date(Number(r.node.timestamp)).toISOString() : 'N/A'}`);
      console.log(`      Text: ${r.node.text?.substring(0, 80) || r.node.description?.substring(0, 80) || 'N/A'}...`);
    });
    console.log('\n');

    res.json({
      success: true,
      results: finalResults.map(r => ({
        id: r.node.id,
        type: r.node.type,
        text: r.node.text,
        bbox: r.node.bbox,
        description: r.node.description,
        score: r.score,
        app: r.node.metadata?.app,
        windowTitle: r.node.metadata?.windowTitle,
        timestamp: r.node.timestamp ? Number(r.node.timestamp) : null // Convert BigInt to Number
      })),
      query,
      count: finalResults.length,
      filters: filters,
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
