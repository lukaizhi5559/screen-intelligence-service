import express from 'express';
import logger from '../utils/logger.js';
import { getOverlayManager } from '../services/overlay-manager.js';
import { detectScreenContext } from '../utils/window-detector.js';
import { analyzeContext, getSelectedText } from '../utils/window-analyzer.js';
import { VisionAnalyzer } from '../utils/visionAnalyzer.js';
import { NutJsAnalyzer } from '../utils/nutJsAnalyzer.js';
import { OCRAnalyzer } from '../utils/ocrAnalyzer.js';
import { HybridAnalyzer } from '../utils/hybridAnalyzer.js';
import { getSemanticAnalyzer } from '../utils/semanticAnalyzer.js';

// Initialize analyzers
const visionAnalyzer = new VisionAnalyzer();
const nutJsAnalyzer = new NutJsAnalyzer();
const ocrAnalyzer = new OCRAnalyzer();
const hybridAnalyzer = new HybridAnalyzer();
const semanticAnalyzer = getSemanticAnalyzer();

// Initialize analyzers
nutJsAnalyzer.init().catch(err => {
  logger.error('Failed to initialize NutJS analyzer:', err);
});

ocrAnalyzer.init().catch(err => {
  logger.error('Failed to initialize OCR analyzer:', err);
});

hybridAnalyzer.init().catch(err => {
  logger.error('Failed to initialize Hybrid analyzer:', err);
});

semanticAnalyzer.init().catch(err => {
  logger.error('Failed to initialize Semantic analyzer:', err);
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
    const { query, showOverlay = false, includeScreenshot = false, method = 'auto' } = payload;
    
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }
    
    logger.info('Screen analysis', { query, showOverlay, includeScreenshot, method });

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
    
    // CRITICAL: For semantic analysis, always use the primary/frontmost window
    // context.windows may contain background windows that aren't actually visible
    const targetWindow = context.primary || context.windows[0];
    logger.info('Target window for analysis', { 
      app: targetWindow.appName, 
      title: targetWindow.title 
    });

    // 2. Get selected text from frontmost app (if any)
    const selectedText = await getSelectedText();
    if (selectedText) {
      logger.info('Found selected text', { length: selectedText.length });
    }

    // 3. Run analysis with selected method (auto/nutjs/ocr/semantic)
    logger.info(`🚀 Running ${method} analysis...`);
    const startTime = Date.now();
    
    let analysisResult;
    let selectedMethod = method;
    
    if (method === 'semantic') {
      // NEW: Use SemanticAnalyzer (DETR + CLIP + DuckDB)
      analysisResult = await semanticAnalyzer.captureAndAnalyze({
        debounce: true,
        windowInfo: targetWindow
      });
      selectedMethod = 'semantic';
    } else if (method === 'auto') {
      // Use HybridAnalyzer for intelligent selection
      analysisResult = await hybridAnalyzer.analyze({
        method: 'auto',
        fallback: true,
        windowInfo: targetWindow
      });
      selectedMethod = analysisResult?.selectedMethod || 'nutjs';
    } else if (method === 'ocr') {
      // Force OCR
      analysisResult = await ocrAnalyzer.captureAndAnalyze({
        debounce: true,
        windowInfo: context.windows[0] || {}
      });
      selectedMethod = 'ocr';
    } else {
      // Force NutJS (default)
      analysisResult = await nutJsAnalyzer.captureAndAnalyze({
        debounce: true,
        usePrintFallback: false,
        windowInfo: context.windows[0] || {}
      });
      selectedMethod = 'nutjs';
    }

    if (!analysisResult) {
      return res.status(500).json({
        success: false,
        error: `Failed to capture screen with ${method} method`
      });
    }

    const elapsed = Date.now() - startTime;

    // 4. Convert to elements format
    const elements = analysisResult.elements.map(el => ({
      role: el.type,
      label: el.text,
      value: el.text,
      confidence: analysisResult.confidence || 0.9,
      source: selectedMethod,
      position: el.position,
      dimensions: el.dimensions,
      style: el.style
    }));

    // 5. Build response with separate plain text and structured data
    const response = {
      success: true,
      query,
      strategy: `${selectedMethod}-analysis`,
      method: analysisResult.method || selectedMethod,
      selectedMethod,
      fallbackUsed: analysisResult.fallbackUsed || false,
      screenId: analysisResult.screenId || null, // Include screen ID for semantic search filtering
      windowsAnalyzed: context.windows.map(w => ({
        app: w.appName,
        title: w.title
      })),
      selectedText: selectedText || null,
      
      // Plain text content for natural language processing
      plainText: {
        content: analysisResult.capturedText,
        length: analysisResult.capturedText.length,
        docType: analysisResult.docType,
        stats: analysisResult.stats
      },
      
      // Structured data for UI understanding and automation
      structuredData: {
        elements,
        structures: analysisResult.structures,
        zones: analysisResult.zones,
        reconstruction: analysisResult.reconstruction,
        confidence: analysisResult.confidence
      },
      
      // Legacy fields for backward compatibility
      capturedText: analysisResult.capturedText,
      docType: analysisResult.docType,
      structures: analysisResult.structures,
      zones: analysisResult.zones,
      stats: analysisResult.stats,
      elements,
      reconstruction: analysisResult.reconstruction,
      confidence: analysisResult.confidence,
      
      fromCache: analysisResult.fromCache || false,
      model: 'local-inference',
      provider: selectedMethod,
      elapsed,
      timestamp: new Date().toISOString()
    };

    logger.info(`✅ ${selectedMethod.toUpperCase()} analysis complete`, { 
      windows: context.windows.length,
      elapsed,
      docType: analysisResult.docType,
      elements: elements.length,
      fromCache: analysisResult.fromCache,
      fallbackUsed: analysisResult.fallbackUsed
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
