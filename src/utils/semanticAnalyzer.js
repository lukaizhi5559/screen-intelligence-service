/**
 * Semantic Analyzer
 * Integrates YOLOv8 object detection + CLIP embeddings + DuckDB vector store
 * This is the NEW analyzer that replaces pure OCR for semantic understanding
 */

import logger from '../utils/logger.js';
import { getOWLv2DetectionService } from '../services/owlv2DetectionService.js';
import { getCVDetectionService } from '../services/cvDetectionService.js';
import { getPersistentSemanticIndex } from '../services/persistentSemanticIndex.js';
import SemanticDescriptionGenerator from './semanticDescriptionGenerator.js';
import { OCRAnalyzer } from './ocrAnalyzer.js';
import { getPaddleOCRClient } from '../services/paddleOCRClient.js';
import crypto from 'crypto';
import screenshot from 'screenshot-desktop';
import path from 'path';
import os from 'os';
import fs from 'fs';

class SemanticAnalyzer {
  constructor() {
    this.owlv2Service = null;
    this.cvService = null;
    this.semanticIndex = null;
    this.ocrAnalyzer = new OCRAnalyzer(); // Tesseract fallback
    this.paddleOCR = getPaddleOCRClient(); // PaddleOCR (preferred)
    this.descriptionGenerator = new SemanticDescriptionGenerator();
    this.initialized = false;
    this.usePaddleOCR = process.env.USE_PADDLE_OCR !== 'false'; // Default: true
    this.tempDir = path.join(os.tmpdir(), 'thinkdrop-semantic-capture');
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    
    logger.info('🧠 Semantic Analyzer created', { 
      usePaddleOCR: this.usePaddleOCR 
    });
  }

  async init() {
    if (this.initialized) return;

    try {
      logger.info('🚀 Initializing Semantic Analyzer...');
      
      // Initialize OWLv2 service (zero-shot UI detection)
      this.owlv2Service = getOWLv2DetectionService();
      await this.owlv2Service.initialize();
      
      // Initialize CV fallback service
      this.cvService = getCVDetectionService();
      await this.cvService.initialize();
      
      // Initialize persistent semantic index (DuckDB + CLIP)
      this.semanticIndex = getPersistentSemanticIndex();
      await this.semanticIndex.initialize();
      
      this.initialized = true;
      logger.info('✅ Semantic Analyzer initialized');
    } catch (error) {
      logger.error('❌ Failed to initialize Semantic Analyzer:', error);
      throw error;
    }
  }

  /**
   * Capture screenshot
   * @private
   */
  async captureScreenshot(windowInfo = null) {
    try {
      const timestamp = Date.now();
      const screenshotPath = path.join(this.tempDir, `screenshot-${timestamp}.png`);
      
      logger.info('📸 Capturing screenshot...');
      
      // CRITICAL: Wait 300ms to allow UI overlays (ThinkDrop panel) to hide
      // Main app hides the guide window before calling this service
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Capture full screen
      // Note: We capture full screen because:
      // 1. The main app already hides ThinkDrop AI panel before calling this
      // 2. Full screen gives better context for semantic understanding
      // 3. OWLv2 and OCR work better with full screen context
      await screenshot({ filename: screenshotPath });
      
      logger.info(`💾 Screenshot saved: ${screenshotPath}`);
      return screenshotPath;
    } catch (error) {
      logger.error('❌ Screenshot capture failed:', error);
      return null;
    }
  }

  /**
   * Capture and analyze screen with semantic understanding
   * @param {Object} options - Analysis options
   * @param {string} options.userQuery - Optional user query to guide detection
   * @returns {Promise<Object>} Analysis result with semantic elements
   */
  async captureAndAnalyze(options = {}) {
    await this.init();

    const startTime = Date.now();
    const { windowInfo = {}, debounce = true, userQuery = null } = options;

    try {
      logger.info('📸 Capturing screen for semantic analysis...');
      
      // 1. Capture screenshot
      const screenshotStart = Date.now();
      const screenshotPath = await this.captureScreenshot(windowInfo);
      const screenshotTime = Date.now() - screenshotStart;
      logger.info(`⏱️  Screenshot captured in ${screenshotTime}ms`);
      if (!screenshotPath) {
        throw new Error('Failed to capture screenshot');
      }

      // 2. Run OCR to extract text (PaddleOCR with Tesseract fallback)
      const ocrStart = Date.now();
      logger.info('📝 Running OCR to extract text...');
      let ocrWords = [];
      let ocrTime = 0;
      let ocrMethod = 'none';
      
      try {
        let ocrResult = null;
        
        // Try PaddleOCR first (fast + accurate bounding boxes)
        if (this.usePaddleOCR) {
          try {
            logger.info('🐼 Trying PaddleOCR...');
            ocrResult = await this.paddleOCR.analyze(screenshotPath);
            ocrMethod = 'paddleocr';
            logger.info(`✅ PaddleOCR succeeded`);
          } catch (paddleError) {
            logger.warn('⚠️  PaddleOCR failed, falling back to Tesseract:', paddleError.message);
            // Fall through to Tesseract
          }
        }
        
        // Fallback to Tesseract if PaddleOCR failed or disabled
        if (!ocrResult) {
          logger.info('📖 Using Tesseract OCR...');
          await this.ocrAnalyzer.init();
          ocrResult = await this.ocrAnalyzer.analyze(screenshotPath);
          ocrMethod = 'tesseract';
        }
        
        // Convert OCR result to word format
        if (ocrResult && ocrResult.words && ocrResult.words.length > 0) {
          ocrWords = ocrResult.words.map(word => ({
            text: word.text,
            bbox: word.bbox,
            confidence: word.confidence
          }));
          ocrTime = Date.now() - ocrStart;
          logger.info(`✅ OCR extracted ${ocrWords.length} words in ${ocrTime}ms (method: ${ocrMethod})`);
        } else {
          logger.warn('⚠️  OCR found no text');
        }
      } catch (ocrError) {
        logger.warn('⚠️  All OCR methods failed, continuing without text:', ocrError.message);
      }

      // 3. Run OWLv2 zero-shot UI element detection (with CV fallback)
      const owlStart = Date.now();
      let detections = [];
      let detectionMethod = 'owlv2';
      let owlTime = 0;
      
      if (this.owlv2Service.isInitialized) {
        logger.info('🦉 Running OWLv2 zero-shot UI detection...');
        
        // If user query provided, use adaptive detection
        if (userQuery) {
          logger.info(`💬 User query: "${userQuery}"`);
          detections = await this.owlv2Service.detectFromQuery(screenshotPath, userQuery, {
            confidenceThreshold: 0.25,
            maxDetections: 30
          });
        } else {
          // Default: detect standard UI elements
          detections = await this.owlv2Service.detectElements(screenshotPath, {
            confidenceThreshold: 0.25,
            maxDetections: 30
          });
        }
        
        owlTime = Date.now() - owlStart;
        logger.info(`✅ OWLv2 detected ${detections.length} elements in ${owlTime}ms`);
      }
      
      // Fallback to CV detection if OWLv2 unavailable or found nothing
      if (detections.length === 0) {
        logger.info('🎨 Falling back to CV-based detection...');
        detections = await this.cvService.detectElements(screenshotPath);
        detectionMethod = 'cv-detection';
        logger.info(`✅ CV detection found ${detections.length} elements`);
      }
      
      if (detections.length === 0) {
        logger.warn('⚠️  No UI elements detected by any method');
        return {
          success: false,
          elements: [],
          capturedText: '',
          docType: 'unknown',
          confidence: 0,
          method: `semantic-${detectionMethod}`,
          elapsed: Date.now() - startTime
        };
      }

      // 4. Merge OCR text with UI element detections
      const mergeStart = Date.now();
      const elements = this._mergeOCRWithElements(detections, ocrWords);
      const mergeTime = Date.now() - mergeStart;
      logger.info(`⏱️  Merged OCR+OWLv2 in ${mergeTime}ms (${elements.length} total elements)`);

      // 5. Build screen state for indexing
      const buildStart = Date.now();
      const screenState = await this._buildScreenState(elements, windowInfo);
      const buildTime = Date.now() - buildStart;
      logger.info(`⏱️  Built screen state in ${buildTime}ms`);

      // 6. Index in DuckDB vector store (with CLIP embeddings)
      const indexStart = Date.now();
      logger.info('💾 Indexing elements in vector store...');
      await this.semanticIndex.indexScreenState(screenState);
      const indexTime = Date.now() - indexStart;
      logger.info(`⏱️  Indexed in DuckDB in ${indexTime}ms`);

      // 7. Build response
      const capturedText = elements.map(el => el.text).filter(Boolean).join('\n');
      const elapsed = Date.now() - startTime;

      logger.info(`✅ Semantic analysis complete in ${elapsed}ms`);
      logger.info(`📊 Timing breakdown: Screenshot=${screenshotTime}ms, OCR=${ocrTime}ms, OWLv2=${owlTime}ms, Merge=${mergeTime}ms, Build=${buildTime}ms, Index=${indexTime}ms`);

      return {
        success: true,
        screenId: screenState.id, // Include screen ID for semantic search filtering
        elements,
        capturedText,
        docType: this._inferDocType(elements),
        structures: this._extractStructures(elements),
        zones: this._extractZones(elements),
        stats: {
          totalElements: elements.length,
          clickable: elements.filter(el => el.clickable).length,
          withText: elements.filter(el => el.text).length
        },
        reconstruction: capturedText,
        confidence: this._calculateConfidence(detections),
        method: 'semantic-detr',
        fromCache: false,
        elapsed,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error('❌ Semantic analysis failed:', error);
      throw error;
    }
  }

  /**
   * Build screen state object for semantic indexing
   * @private
   */
  async _buildScreenState(elements, windowInfo) {
    const screenId = crypto.randomUUID();
    const timestamp = Date.now();

    // Convert elements to nodes map
    const nodes = new Map();
    elements.forEach(el => {
      nodes.set(el.id, {
        id: el.id,
        type: el.type,
        text: el.text,
        bbox: el.bbox,
        description: el.description,
        clickable: el.clickable,
        confidence: el.confidence,
        // embedding will be added by semanticIndex
        embedding: null
      });
    });

    // Build screen-level description
    const screenDescription = `Screen with ${elements.length} UI elements: ${
      elements.map(el => el.type).slice(0, 10).join(', ')
    }`;

    return {
      id: screenId,
      timestamp,
      app: windowInfo.appName || 'Unknown',
      windowTitle: windowInfo.title || '',
      url: windowInfo.url || null,
      screenDimensions: {
        width: windowInfo.width || 1920,
        height: windowInfo.height || 1080
      },
      screenshotPath: null, // Will be set by caller if needed
      nodes,
      subtrees: [], // Could group related elements later
      description: screenDescription,
      embedding: null // Will be added by semanticIndex
    };
  }

  /**
   * Merge OCR text with UI element detections based on spatial overlap
   * @private
   */
  _mergeOCRWithElements(detections, ocrWords) {
    if (!ocrWords || ocrWords.length === 0) {
      return detections; // No OCR text to merge
    }

    // Check if OCR words have valid bboxes (not all zeros)
    const hasValidBboxes = ocrWords.some(word => {
      if (!word.bbox) return false;
      const [x1, y1, x2, y2] = word.bbox;
      return x1 !== 0 || y1 !== 0 || x2 !== 0 || y2 !== 0;
    });

    if (!hasValidBboxes) {
      // OCR has no bbox data (raw text parsing fallback)
      // Add all OCR text as a single text element
      const allText = ocrWords.map(w => w.text).filter(Boolean).join(' ');
      logger.info(`📝 OCR has no bbox data, adding ${ocrWords.length} words as text element`);
      
      return [
        ...detections,
        {
          id: 'ocr-text-fallback',
          type: 'text',
          text: allText,
          description: `OCR text (${ocrWords.length} words)`,
          bbox: [0, 0, 0, 0],
          confidence: 0.8,
          clickable: false,
          source: 'ocr-fallback'
        }
      ];
    }

    // Normal path: merge based on spatial overlap
    return detections.map(element => {
      // Find OCR words that overlap with this element's bounding box
      const overlappingWords = ocrWords.filter(word => {
        if (!word.bbox || !element.bbox) return false;
        return this._bboxOverlaps(element.bbox, word.bbox);
      });

      // Combine overlapping words into text
      const text = overlappingWords
        .map(w => w.text)
        .filter(Boolean)
        .join(' ');

      // Create enhanced description with text content
      let description = element.description || `${element.type}`;
      if (text) {
        description = `${element.type}: "${text}"`;
      }

      return {
        ...element,
        text: text || element.text || '',
        description
      };
    });
  }

  /**
   * Check if two bounding boxes overlap
   * @private
   */
  _bboxOverlaps(bbox1, bbox2) {
    // bbox format: [x1, y1, x2, y2]
    const [x1a, y1a, x2a, y2a] = bbox1;
    const [x1b, y1b, x2b, y2b] = bbox2;

    // Check if boxes overlap
    return !(x2a < x1b || x2b < x1a || y2a < y1b || y2b < y1a);
  }

  /**
   * Determine if element type is clickable
   * @private
   */
  _isClickable(type) {
    const clickableTypes = ['button', 'link', 'checkbox', 'radio', 'combobox', 'dropdown', 'icon', 'menu', 'textfield', 'input'];
    return clickableTypes.includes(type.toLowerCase());
  }

  /**
   * Infer document type from elements
   * @private
   */
  _inferDocType(elements) {
    const types = elements.map(el => el.type);
    
    if (types.includes('table')) return 'spreadsheet';
    if (types.filter(t => t === 'text').length > 10) return 'document';
    if (types.filter(t => t === 'button').length > 5) return 'application';
    
    return 'webpage';
  }

  /**
   * Extract structural information
   * @private
   */
  _extractStructures(elements) {
    return {
      tables: elements.filter(el => el.type === 'table').length,
      lists: elements.filter(el => el.type === 'list').length,
      forms: elements.filter(el => el.type === 'textfield' || el.type === 'checkbox').length,
      navbars: elements.filter(el => el.type === 'toolbar' || el.type === 'menu').length,
      headers: elements.filter(el => {
        if (el.type !== 'text') return false;
        // Check position.y if available, otherwise use bbox
        if (el.position && typeof el.position.y === 'number') {
          return el.position.y < 100;
        }
        if (el.bbox && el.bbox.length >= 2) {
          return el.bbox[1] < 100; // y1 coordinate
        }
        return false;
      }).length,
      grids: 0
    };
  }

  /**
   * Extract spatial zones
   * @private
   */
  _extractZones(elements) {
    // Simple quadrant-based zoning
    const zones = { topLeft: [], topRight: [], bottomLeft: [], bottomRight: [] };
    
    elements.forEach(el => {
      // Elements have bbox [x1, y1, x2, y2], not position
      if (!el.bbox || el.bbox.length < 2) return;
      
      const x = el.bbox[0]; // x1
      const y = el.bbox[1]; // y1
      
      if (x < 720 && y < 450) zones.topLeft.push(el);
      else if (x >= 720 && y < 450) zones.topRight.push(el);
      else if (x < 720 && y >= 450) zones.bottomLeft.push(el);
      else zones.bottomRight.push(el);
    });

    return zones;
  }

  /**
   * Calculate overall confidence
   * @private
   */
  _calculateConfidence(detections) {
    if (detections.length === 0) return 0;
    const avgScore = detections.reduce((sum, d) => sum + d.score, 0) / detections.length;
    return Math.round(avgScore * 100) / 100;
  }
}

// Singleton instance
let instance = null;

export function getSemanticAnalyzer() {
  if (!instance) {
    instance = new SemanticAnalyzer();
  }
  return instance;
}

export default SemanticAnalyzer;
