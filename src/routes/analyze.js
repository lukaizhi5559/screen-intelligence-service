import express from 'express';
import logger from '../utils/logger.js';
import { getOverlayManager } from '../services/overlay-manager.js';
import { detectScreenContext } from '../utils/window-detector.js';
import { analyzeContext, getSelectedText } from '../utils/window-analyzer.js';
import { VisionAnalyzer } from '../utils/visionAnalyzer.js';
import { NutJsAnalyzer } from '../utils/nutJsAnalyzer.js';

// Initialize analyzers
const visionAnalyzer = new VisionAnalyzer();
const nutJsAnalyzer = new NutJsAnalyzer();

// Initialize NutJS analyzer
nutJsAnalyzer.init().catch(err => {
  logger.error('Failed to initialize NutJS analyzer:', err);
});

const router = express.Router();

/**
 * Convert vision data to elements format for backward compatibility
 * @param {Object} visionData - Vision analysis result
 * @returns {Array} Elements array
 */
function convertVisionToElements(visionData) {
  const elements = [];
  
  // Add email list items as email elements (HIGH PRIORITY for Gmail)
  if (visionData.emails && Array.isArray(visionData.emails)) {
    visionData.emails.forEach((email) => {
      // Handle both string and object formats
      const emailText = typeof email === 'string' ? email : 
        `From: ${email.from} | Subject: ${email.subject} | Time: ${email.time}`;
      
      elements.push({
        role: 'email',
        label: emailText,
        value: emailText,
        confidence: 0.95,
        source: 'vision',
        actions: ['open', 'read']
      });
    });
  }
  
  // Add desktop files as file elements (PRIORITY)
  if (visionData.desktopFiles && Array.isArray(visionData.desktopFiles)) {
    visionData.desktopFiles.forEach((file) => {
      elements.push({
        role: 'file',
        label: file,
        value: file,
        confidence: 0.95,
        source: 'vision',
        actions: ['open']
      });
    });
  }
  
  // Add main content as full_text_content element
  if (visionData.mainContent) {
    elements.push({
      role: 'full_text_content',
      label: 'Screen Content',
      value: visionData.mainContent,
      confidence: 1.0,
      source: 'vision',
      actions: []
    });
  }
  
  // Add UI elements as interactive elements
  if (visionData.uiElements && Array.isArray(visionData.uiElements)) {
    visionData.uiElements.forEach((uiElement, index) => {
      elements.push({
        role: 'button',
        label: uiElement,
        value: uiElement,
        confidence: 0.9,
        source: 'vision',
        actions: ['click']
      });
    });
  }
  
  // Add summary as metadata element
  if (visionData.summary) {
    elements.push({
      role: 'metadata',
      label: 'Summary',
      value: visionData.summary,
      confidence: 1.0,
      source: 'vision',
      actions: []
    });
  }
  
  return elements;
}

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
    
    logger.info('Vision-based screen analysis', { query, showOverlay, includeScreenshot });

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

    // 3. Run NutJS fast analysis (NEW DEFAULT - Vision disabled)
    logger.info('🚀 Running NutJS fast analysis...');
    const startTime = Date.now();
    
    const nutJsResult = await nutJsAnalyzer.captureAndAnalyze({
      debounce: true,
      usePrintFallback: false,
      windowInfo: context.windows[0] || {}
    });

    if (!nutJsResult) {
      return res.status(500).json({
        success: false,
        error: 'Failed to capture screen text with NutJS'
      });
    }

    const elapsed = Date.now() - startTime;

    // 4. Convert to elements format
    const elements = nutJsResult.elements.map(el => ({
      role: el.type,
      label: el.text,
      value: el.text,
      confidence: nutJsResult.confidence || 0.9,
      source: 'nutjs',
      position: el.position,
      dimensions: el.dimensions,
      style: el.style
    }));

    // 5. Build response with separate plain text and structured data
    const response = {
      success: true,
      query,
      strategy: 'nutjs-fast',
      method: 'text-capture-v2',
      windowsAnalyzed: context.windows.map(w => ({
        app: w.appName,
        title: w.title
      })),
      selectedText: selectedText || null,
      
      // Plain text content for natural language processing
      plainText: {
        content: nutJsResult.capturedText,
        length: nutJsResult.capturedText.length,
        docType: nutJsResult.docType,
        stats: nutJsResult.stats
      },
      
      // Structured data for UI understanding and automation
      structuredData: {
        elements,
        structures: nutJsResult.structures,
        zones: nutJsResult.zones,
        reconstruction: nutJsResult.reconstruction,
        confidence: nutJsResult.confidence
      },
      
      // Legacy fields for backward compatibility
      capturedText: nutJsResult.capturedText,
      docType: nutJsResult.docType,
      structures: nutJsResult.structures,
      zones: nutJsResult.zones,
      stats: nutJsResult.stats,
      elements,
      reconstruction: nutJsResult.reconstruction,
      confidence: nutJsResult.confidence,
      
      fromCache: nutJsResult.fromCache || false,
      model: 'local-inference',
      provider: 'nutjs',
      elapsed,
      timestamp: new Date().toISOString()
    };

    logger.info('✅ NutJS analysis complete', { 
      windows: context.windows.length,
      elapsed,
      docType: nutJsResult.docType,
      elements: elements.length,
      fromCache: nutJsResult.fromCache
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

/**
 * POST /screen/analyze-fast
 * Fast local screen analysis using NutJS text capture
 * No API calls, completely local and instant
 */
router.post('/screen/analyze-fast', async (req, res) => {
  try {
    const { query = 'analyze screen', usePrintFallback = false } = req.body;
    
    logger.info('🚀 Fast screen analysis requested', { query, usePrintFallback });

    // 1. Detect screen context
    const context = await detectScreenContext();
    logger.info('Screen context detected', { 
      windows: context.windows.length,
      activeApp: context.windows[0]?.appName 
    });

    // 2. Capture and analyze with NutJS
    const startTime = Date.now();
    const nutJsResult = await nutJsAnalyzer.captureAndAnalyze({
      debounce: true,
      usePrintFallback,
      windowInfo: context.windows[0] || {}
    });

    if (!nutJsResult) {
      return res.status(500).json({
        success: false,
        error: 'Failed to capture screen text'
      });
    }

    const elapsed = Date.now() - startTime;

    // 3. Convert to elements format
    const elements = nutJsResult.elements.map(el => ({
      role: el.type,
      label: el.text,
      value: el.text,
      confidence: 0.9,
      source: 'nutjs',
      position: el.position,
      dimensions: el.dimensions,
      style: el.style
    }));

    // 4. Build response with separated formats
    const response = {
      success: true,
      query,
      strategy: 'nutjs-fast',
      method: 'text-capture',
      windowsAnalyzed: context.windows.map(w => ({
        app: w.appName,
        title: w.title
      })),
      
      // Plain text content for natural language processing
      plainText: {
        content: nutJsResult.capturedText,
        length: nutJsResult.capturedText.length,
        stats: nutJsResult.stats
      },
      
      // Structured data for UI understanding and automation
      structuredData: {
        elements,
        reconstruction: nutJsResult.reconstruction
      },
      
      // Legacy fields for backward compatibility
      capturedText: nutJsResult.capturedText,
      stats: nutJsResult.stats,
      elements,
      reconstruction: nutJsResult.reconstruction,
      
      model: 'local-inference',
      provider: 'nutjs',
      elapsed,
      timestamp: new Date().toISOString()
    };

    logger.info('✅ Fast analysis complete', { 
      elapsed,
      elements: elements.length,
      textLength: nutJsResult.capturedText.length
    });
    
    res.json(response);

  } catch (error) {
    logger.error('Fast screen analysis failed', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /screen/analyze-hybrid
 * Hybrid approach: Try fast NutJS first, fall back to vision if needed
 */
router.post('/screen/analyze-hybrid', async (req, res) => {
  try {
    const { query = 'analyze screen', forceVision = false } = req.body;
    
    logger.info('🔀 Hybrid screen analysis requested', { query, forceVision });

    // 1. Try fast path first (unless forced to use vision)
    if (!forceVision) {
      logger.info('⚡ Attempting fast NutJS capture...');
      const nutJsResult = await nutJsAnalyzer.captureAndAnalyze({
        debounce: true,
        usePrintFallback: false
      });

      // If we got good text, use it
      if (nutJsResult && nutJsResult.capturedText.length > 100) {
        logger.info('✅ Fast path succeeded, using NutJS result');
        
        const elements = nutJsResult.elements.map(el => ({
          role: el.type,
          label: el.text,
          value: el.text,
          confidence: 0.9,
          source: 'nutjs'
        }));

        return res.json({
          success: true,
          query,
          strategy: 'hybrid-fast',
          elements,
          stats: nutJsResult.stats,
          elapsed: 1000,
          timestamp: new Date().toISOString()
        });
      }
    }

    // 2. Fall back to vision API for complex screens
    logger.info('🔍 Falling back to vision analysis...');
    
    if (!visionAnalyzer.enabled) {
      return res.status(503).json({
        success: false,
        error: 'Vision API not configured and fast capture failed'
      });
    }

    const visionResult = await visionAnalyzer.analyzeScreen(query);
    
    const response = {
      success: true,
      query,
      strategy: 'hybrid-vision',
      visionData: visionResult.visionData,
      elements: convertVisionToElements(visionResult.visionData),
      model: visionResult.model,
      provider: visionResult.provider,
      elapsed: visionResult.elapsed,
      timestamp: new Date().toISOString()
    };

    logger.info('✅ Hybrid analysis complete (vision fallback)', { 
      elapsed: visionResult.elapsed
    });
    
    res.json(response);

  } catch (error) {
    logger.error('Hybrid screen analysis failed', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
