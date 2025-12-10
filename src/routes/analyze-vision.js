import express from 'express';
import logger from '../utils/logger.js';
import screenshot from 'screenshot-desktop';
import fetch from 'node-fetch';
import sharp from 'sharp';

const router = express.Router();

/**
 * POST /screen/analyze-vision (or /screen.analyze-vision)
 * Backend-based screen analysis using Claude/OpenAI/Grok vision APIs
 * This is the new primary method for online mode
 * 
 * Optimizations for sub-1-second response:
 * - Image compression: Resize to 1280x720 (50-70% latency reduction)
 * - speedMode: 'fast' for faster processing (1-2s)
 * - Streaming support for real-time results
 * - Still maintains accuracy for UI analysis and text reading
 * 
 * Body:
 * {
 *   "query": "List all the email titles on my screen",
 *   "speedMode": "fast" | "balanced" | "accurate" (optional, default: "fast"),
 *   "stream": true | false (optional, default: false)
 * }
 */
router.post('/', async (req, res) => {
  console.log('🚨 [ANALYZE-VISION] Route hit! Request received');
  logger.info('🚨 [ANALYZE-VISION] Route hit! Request received');
  
  try {
    // Support both MCP envelope format and direct payload
    const payload = req.body.payload || req.body;
    const { query, speedMode = 'fast', stream = false, provider = 'openai' } = payload;
    
    console.log('🚨 [ANALYZE-VISION] Payload extracted:', { query, speedMode, stream });
    logger.info('🚨 [ANALYZE-VISION] Payload extracted:', { query, speedMode, stream });
    
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }
    
    logger.info('Backend vision analysis', { query, speedMode, stream });
    
    // 1. Capture screenshot
    logger.info('📸 Capturing screenshot...');
    const screenshotBuffer = await screenshot({ format: 'png' });
    
    // 2. Compress and resize image for faster upload/processing
    // Resize to 1280x720 (or proportional) - optimal for UI analysis
    // This reduces latency by 50-70% while maintaining accuracy
    logger.info('🗜️  Compressing screenshot...');
    const compressedBuffer = await sharp(screenshotBuffer)
      .resize(1280, 720, {
        fit: 'inside', // Maintain aspect ratio
        withoutEnlargement: true // Don't upscale smaller images
      })
      .png({ quality: 85, compressionLevel: 6 }) // Good balance of quality/size
      .toBuffer();
    
    const base64Screenshot = compressedBuffer.toString('base64');
    
    logger.info('✅ Screenshot compressed', { 
      originalKB: Math.round(screenshotBuffer.length / 1024),
      compressedKB: Math.round(compressedBuffer.length / 1024),
      reduction: `${Math.round((1 - compressedBuffer.length / screenshotBuffer.length) * 100)}%`
    });
    
    // 3. Call backend vision API
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
        query,
        speedMode, // 'fast' (1-2s), 'balanced' (2-3s), or 'accurate' (3-5s)
        stream,     // Enable streaming for real-time results
        provider // model provider (claude, openai, grok)
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
    
    // Handle streaming response
    if (stream) {
      logger.info('📡 Streaming response from backend...');
      
      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      
      let fullText = '';
      let provider = 'unknown';
      
      // Parse SSE stream from backend
      const reader = response.body;
      reader.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            
            if (data.type === 'chunk') {
              fullText += data.content;
              // Forward chunk to client
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } else if (data.type === 'done') {
              provider = data.provider;
              const elapsed = Date.now() - startTime;
              
              logger.info('✅ Streaming complete', {
                provider,
                latencyMs: data.latencyMs,
                totalElapsed: elapsed,
                textLength: fullText.length
              });
              
              // Send done event
              res.write(`data: ${JSON.stringify({
                type: 'done',
                provider,
                latencyMs: data.latencyMs || elapsed,
                timestamp: new Date().toISOString()
              })}\n\n`);
              
              res.end();
            } else if (data.type === 'error') {
              logger.error('Streaming error:', data.error);
              res.write(`data: ${JSON.stringify(data)}\n\n`);
              res.end();
            }
          }
        }
      });
      
      reader.on('error', (error) => {
        logger.error('Stream error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();
      });
      
      return;
    }
    
    // Handle non-streaming response
    const result = await response.json();
    const elapsed = Date.now() - startTime;
    
    logger.info('✅ Backend vision analysis complete', {
      provider: result.provider,
      latencyMs: result.latencyMs,
      totalElapsed: elapsed,
      textLength: result.text?.length || 0,
      speedMode
    });
    
    // 3. Return formatted response for overlay system
    res.json({
      success: true,
      query,
      analysis: result.text || result.analysis || '',
      provider: result.provider || 'unknown',
      latencyMs: result.latencyMs || elapsed,
      timestamp: new Date().toISOString(),
      speedMode,
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
