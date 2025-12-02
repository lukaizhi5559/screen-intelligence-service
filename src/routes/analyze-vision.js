import express from 'express';
import logger from '../utils/logger.js';
import screenshot from 'screenshot-desktop';
import fetch from 'node-fetch';

const router = express.Router();

/**
 * POST /screen/analyze-vision (or /screen.analyze-vision)
 * Backend-based screen analysis using Claude/OpenAI/Grok vision APIs
 * This is the new primary method for online mode
 * 
 * Body:
 * {
 *   "query": "List all the email titles on my screen",
 *   "includeScreenshot": true
 * }
 */
router.post('/', async (req, res) => {
  console.log('🚨 [ANALYZE-VISION] Route hit! Request received');
  logger.info('🚨 [ANALYZE-VISION] Route hit! Request received');
  
  try {
    // Support both MCP envelope format and direct payload
    const payload = req.body.payload || req.body;
    const { query } = payload;
    
    console.log('🚨 [ANALYZE-VISION] Payload extracted:', { query });
    logger.info('🚨 [ANALYZE-VISION] Payload extracted:', { query });
    
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }
    
    logger.info('Backend vision analysis', { query });
    
    // 1. Capture screenshot as base64
    logger.info('📸 Capturing screenshot...');
    const screenshotBuffer = await screenshot({ format: 'png' });
    const base64Screenshot = screenshotBuffer.toString('base64');
    
    logger.info('✅ Screenshot captured', { 
      size: base64Screenshot.length,
      sizeKB: Math.round(base64Screenshot.length / 1024)
    });
    
    // 2. Call backend vision API
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';
    const backendApiKey = process.env.BACKEND_API_KEY || 'test-api-key-123';
    const apiUrl = `${backendUrl}/api/vision/analyze`;
    
    logger.info('🌐 Calling backend vision API', { url: apiUrl });
    
    const startTime = Date.now();
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': backendApiKey
      },
      body: JSON.stringify({
        screenshot: {
          base64: base64Screenshot,
          mimeType: 'image/png'
        },
        query
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Backend vision API failed', { 
        status: response.status,
        error: errorText 
      });
      
      return res.status(response.status).json({
        success: false,
        error: 'Backend vision API failed',
        details: errorText
      });
    }
    
    const result = await response.json();
    const elapsed = Date.now() - startTime;
    
    logger.info('✅ Backend vision analysis complete', {
      provider: result.provider,
      latencyMs: result.latencyMs,
      totalElapsed: elapsed,
      textLength: result.text?.length || 0
    });
    
    // 3. Return formatted response for overlay system
    res.json({
      success: true,
      query,
      analysis: result.text || result.analysis || '',
      provider: result.provider || 'unknown',
      latencyMs: result.latencyMs || elapsed,
      timestamp: new Date().toISOString(),
      // Include raw result for debugging
      raw: result
    });
    
  } catch (error) {
    logger.error('Backend vision analysis failed', { 
      error: error.message, 
      stack: error.stack 
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
