import express from 'express';
import logger from '../utils/logger.js';
import { getOverlayManager } from '../services/overlay-manager.js';
import { detectScreenContext } from '../utils/window-detector.js';
import { analyzeContext, getSelectedText } from '../utils/window-analyzer.js';
import { NutJsAnalyzer } from '../utils/nutJsAnalyzer.js';
import { OCRAnalyzer } from '../utils/ocrAnalyzer.js';
import { HybridAnalyzer } from '../utils/hybridAnalyzer.js';
import { getSemanticAnalyzer } from '../utils/semanticAnalyzer.js';

// Initialize analyzers
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
 * POST /screen/analyze
 * Context-aware screen analysis - detects which window to analyze based on query
 * 
 * Body:
 * {
 *   "query": "How many files on my desktop?",
 *   "showOverlay": true,
 *   "includeScreenshot": false,
 *   "method": "auto" | "semantic" | "ocr" | "nutjs"
 * }
 * 
 * Methods:
 * - "auto" (default): HybridAnalyzer intelligently selects best method
 * - "semantic": OWLv2 + OCR + DuckDB (best for UI understanding, slower)
 * - "ocr": Tesseract OCR only (text extraction)
 * - "nutjs": Native text capture (fastest, accessibility-based)
 * 
 * Note: This endpoint performs on-demand analysis. For continuous streaming,
 * use the ScreenWatcher service (Phase 2) which auto-indexes to DuckDB.
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

// REMOVED: /screen/analyze-fast endpoint
// Use main /screen/analyze with method='nutjs' instead

// REMOVED: /screen/analyze-hybrid endpoint
// Use main /screen/analyze with method='auto' instead (HybridAnalyzer handles this)

export default router;
