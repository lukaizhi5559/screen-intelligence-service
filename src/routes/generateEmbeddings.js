import express from 'express';
import logger from '../utils/logger.js';
import { getSemanticAnalyzer } from '../utils/semanticAnalyzer.js';

const router = express.Router();
const semanticAnalyzer = getSemanticAnalyzer();

/**
 * POST /screen/generateEmbeddings
 * Generate embeddings on-demand for cached OCR results
 * 
 * Body:
 * {
 *   "screenId": "uuid-of-cached-screen"
 * }
 */
router.post('/screen.generateEmbeddings', async (req, res) => {
  try {
    const { screenId } = req.body;
    
    if (!screenId) {
      return res.status(400).json({
        success: false,
        error: 'screenId is required'
      });
    }
    
    logger.info(`⚡ Generating embeddings on-demand for screen: ${screenId}`);
    
    const success = await semanticAnalyzer.generateEmbeddingsForCachedScreen(screenId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Embeddings generated successfully',
        screenId
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'No cached OCR results found or embeddings already exist',
        screenId
      });
    }
  } catch (error) {
    logger.error('❌ Failed to generate embeddings:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
