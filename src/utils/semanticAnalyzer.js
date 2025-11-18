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
    this.ocrAnalyzer = new OCRAnalyzer();
    this.descriptionGenerator = new SemanticDescriptionGenerator();
    this.initialized = false;
    this.tempDir = path.join(os.tmpdir(), 'thinkdrop-semantic-capture');
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    
    logger.info('🧠 Semantic Analyzer created');
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
      
      // Capture full screen (DETR works best with full screen)
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
      const screenshotPath = await this.captureScreenshot(windowInfo);
      if (!screenshotPath) {
        throw new Error('Failed to capture screenshot');
      }

      // 2. Run OCR to extract text
      logger.info('📝 Running OCR to extract text...');
      let ocrWords = [];
      try {
        await this.ocrAnalyzer.init();
        const ocrResult = await this.ocrAnalyzer.analyze(screenshotPath);
        // Convert OCR result to word format expected by DETR
        if (ocrResult.words && ocrResult.words.length > 0) {
          ocrWords = ocrResult.words.map(word => ({
            text: word.text,
            bbox: word.bbox,
            confidence: word.confidence
          }));
          logger.info(`✅ OCR extracted ${ocrWords.length} words`);
        } else {
          logger.warn('⚠️  OCR found no text');
        }
      } catch (ocrError) {
        logger.warn('⚠️  OCR failed, continuing without text:', ocrError.message);
      }

      // 3. Run OWLv2 zero-shot UI element detection (with CV fallback)
      let detections = [];
      let detectionMethod = 'owlv2';
      
      if (this.owlv2Service.isInitialized) {
        logger.info('🦉 Running OWLv2 zero-shot UI detection...');
        
        // If user query provided, use adaptive detection
        if (userQuery) {
          logger.info(`💬 User query: "${userQuery}"`);
          detections = await this.owlv2Service.detectFromQuery(screenshotPath, userQuery, {
            confidenceThreshold: 0.15,
            maxDetections: 100
          });
        } else {
          // Default: detect standard UI elements
          detections = await this.owlv2Service.detectElements(screenshotPath, {
            confidenceThreshold: 0.15,
            maxDetections: 100
          });
        }
        
        logger.info(`✅ OWLv2 detected ${detections.length} elements`);
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

      // 4. Use detections as elements (already in correct format)
      const elements = detections;

      // 4. Build screen state for indexing
      const screenState = await this._buildScreenState(elements, windowInfo);

      // 5. Index in DuckDB vector store (with CLIP embeddings)
      logger.info('💾 Indexing elements in vector store...');
      await this.semanticIndex.indexScreenState(screenState);

      // 6. Build response
      const capturedText = elements.map(el => el.text).filter(Boolean).join('\n');
      const elapsed = Date.now() - startTime;

      logger.info(`✅ Semantic analysis complete in ${elapsed}ms`);

      return {
        success: true,
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
   * Convert DETR detections to semantic UI elements
   * @private
   */
  async _convertDetectionsToElements(detections, screenshotPath) {
    const elements = [];

    for (const detection of detections) {
      // DETR service already returns processed elements with bbox, type, confidence
      const { type, bbox, confidence, text = '', cocoLabel } = detection;
      const [x1, y1, x2, y2] = bbox;

      // Generate simple semantic description
      const description = `${type} element detected at position (${Math.round((x1+x2)/2)}, ${Math.round((y1+y2)/2)}) with confidence ${confidence.toFixed(2)}`;

      elements.push({
        id: crypto.randomUUID(),
        type: type,
        role: this._mapTypeToRole(type), // Add role field for orchestrator compatibility
        text: text,
        label: text || type, // Add label field for UI display
        bbox: bbox,
        position: {
          x: Math.round((x1 + x2) / 2),
          y: Math.round((y1 + y2) / 2)
        },
        dimensions: {
          width: Math.round(x2 - x1),
          height: Math.round(y2 - y1)
        },
        bounds: { // Add bounds field for orchestrator compatibility
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1
        },
        confidence: confidence,
        clickable: this._isClickable(type),
        description,
        source: 'detr',
        cocoLabel: cocoLabel
      });
    }

    return elements;
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
      headers: elements.filter(el => el.type === 'text' && el.position.y < 100).length,
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
   * Map OWLv2 detection type to orchestrator-compatible role
   * @private
   */
  _mapTypeToRole(type) {
    const typeLower = type.toLowerCase();
    
    // Map to orchestrator roles
    if (typeLower.includes('button') || typeLower.includes('icon')) return 'button';
    if (typeLower.includes('link') || typeLower.includes('hyperlink')) return 'link';
    if (typeLower.includes('image') || typeLower.includes('picture') || typeLower.includes('photo')) return 'image';
    if (typeLower.includes('input') || typeLower.includes('text box') || typeLower.includes('textarea')) return 'textarea';
    if (typeLower.includes('dropdown') || typeLower.includes('select')) return 'dropdown';
    if (typeLower.includes('checkbox')) return 'checkbox';
    if (typeLower.includes('radio')) return 'radio';
    if (typeLower.includes('menu') || typeLower.includes('navigation')) return 'menu';
    if (typeLower.includes('tab')) return 'tab';
    if (typeLower.includes('dialog') || typeLower.includes('modal')) return 'modal';
    if (typeLower.includes('panel')) return 'panel';
    if (typeLower.includes('search')) return 'search';
    
    // Default to generic UI element
    return 'ui_element';
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
