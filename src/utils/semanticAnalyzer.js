/**
 * Semantic Analyzer
 * Integrates YOLOv8 object detection + CLIP embeddings + DuckDB vector store
 * This is the NEW analyzer that replaces pure OCR for semantic understanding
 */

import logger from '../utils/logger.js';
import { getPersistentSemanticIndex } from '../services/persistentSemanticIndex.js';
import SemanticDescriptionGenerator from './semanticDescriptionGenerator.js';
import { OCRAnalyzer } from './ocrAnalyzer.js';
import { getOCRService } from '../services/ocrService.js';
import crypto from 'crypto';
import screenshot from 'screenshot-desktop';
import path from 'path';
import os from 'os';
import fs from 'fs';

class SemanticAnalyzer {
  constructor() {
    this.semanticIndex = null;
    this.ocrAnalyzer = new OCRAnalyzer(); // Legacy Tesseract fallback
    this.ocrService = getOCRService(); // New OCR service (Apple Vision + Windows OCR)
    this.useNewOCR = true; // Use new OCR service by default
    this.initialized = false;
    this.descriptionGenerator = new SemanticDescriptionGenerator();
    this.tempDir = path.join(os.tmpdir(), 'thinkdrop-semantic-capture');
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    
    logger.info('🧠 Semantic Analyzer created', { 
      useNewOCR: this.useNewOCR 
    });
  }

  async init() {
    if (this.initialized) return;

    try {
      logger.info('🚀 Initializing Semantic Analyzer...');
      
      // Initialize OCR service (Apple Vision on macOS, Windows OCR on Windows, Tesseract fallback)
      if (this.useNewOCR) {
        console.log('🔍 Initializing new OCR service (Apple Vision/Windows OCR)...');
        // OCR service doesn't need explicit initialization, but log that it's available
        const platform = process.platform;
        if (platform === 'darwin') {
          console.log('🍎 Apple Vision OCR available');
        } else if (platform === 'win32') {
          console.log('🪟 Windows OCR available');
        } else {
          console.log('🐧 Tesseract OCR fallback (Linux)');
        }
      }
      
      // OCR-only mode for fast, reliable text extraction
      console.log('✅ Using OCR-only mode (Apple Vision/Tesseract)');
      
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
      // 3. OCR works better with full screen context
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
   * @param {string} options.userQuery - Optional user query for context
   * @returns {Promise<Object>} Analysis result with semantic elements
   */
  async captureAndAnalyze(options = {}) {
    await this.init();

    const startTime = Date.now();
    const { windowInfo = {}, debounce = true, userQuery = null, skipEmbedding = false } = options;

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

      // 2. Run OCR to extract text (Apple Vision on macOS, Tesseract on Windows/Linux)
      const ocrStart = Date.now();
      logger.info('📝 Running OCR to extract text...');
      let ocrWords = [];
      let ocrTime = 0;
      let ocrMethod = 'none';
      
      try {
        let ocrResult = null;
        
        // Use new OCR service (Apple Vision + Windows OCR + Tesseract)
        if (this.useNewOCR) {
          try {
            console.log('🔍 Using new OCR service (Apple Vision/Windows OCR/Tesseract)...');
            ocrResult = await this.ocrService.analyze(screenshotPath);
            ocrMethod = ocrResult.source || 'unknown';
            console.log(`✅ OCR succeeded with ${ocrMethod}`);
            console.log('[OCR_RESULT] ocrResult', ocrResult);
            
          } catch (newOCRError) {
            console.log('⚠️  New OCR service failed, falling back to legacy Tesseract:', newOCRError.message);
            // Fall through to legacy Tesseract
          }
        }
        
        // Fallback to legacy Tesseract if new OCR failed or disabled
        if (!ocrResult) {
          logger.info('📖 Using legacy Tesseract OCR...');
          await this.ocrAnalyzer.init();
          ocrResult = await this.ocrAnalyzer.analyze(screenshotPath);
          ocrMethod = 'tesseract_legacy';
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

      // 3. OCR-only mode - no visual detection needed
      // Elements are inferred from OCR text + heuristics
      const detections = [];
      const detectionMethod = 'ocr-heuristic';
      logger.info('📝 Using OCR + heuristic-based element classification');

      // 4. Create elements from OCR words with heuristic classification
      const mergeStart = Date.now();
      const elements = this._createElementsFromOCR(ocrWords);
      const mergeTime = Date.now() - mergeStart;
      logger.info(`⏱️  Created ${elements.length} elements from OCR in ${mergeTime}ms`);

      // 5. Build screen state for indexing
      const buildStart = Date.now();
      console.log('🏗️  [BEFORE BUILD] About to call _buildScreenState with windowInfo:', JSON.stringify(windowInfo, null, 2));
      console.log('🏗️  [BEFORE BUILD] Elements count:', elements.length);
      const screenState = await this._buildScreenState(elements, windowInfo);
      console.log('🏗️  [AFTER BUILD] screenState.app:', screenState.app);
      console.log('🏗️  [AFTER BUILD] screenState.windowTitle:', screenState.windowTitle);
      const buildTime = Date.now() - buildStart;
      logger.info(`⏱️  Built screen state in ${buildTime}ms`);

      // 6. Index in DuckDB vector store (with CLIP embeddings)
      // OPTIMIZATION: Two-tier caching strategy
      // - Always cache OCR results + llmContext (fast)
      // - Generate embeddings on-demand when semantic search is needed (slow)
      let indexTime = 0;
      if (skipEmbedding) {
        logger.info('⚡ Skipping embedding generation (simple context mode)');
        logger.info('💡 OCR results cached - embeddings will be generated on-demand if needed');
        
        // Store screenState in memory cache for potential embedding generation later
        // This allows follow-up semantic queries to generate embeddings without re-running OCR
        if (!this.ocrCache) this.ocrCache = new Map();
        this.ocrCache.set(screenState.id, {
          screenState,
          timestamp: Date.now(),
          hasEmbeddings: false
        });
        
        // Clean old cache entries (> 60 seconds)
        for (const [id, entry] of this.ocrCache.entries()) {
          if (Date.now() - entry.timestamp > 60000) {
            this.ocrCache.delete(id);
          }
        }
      } else {
        const indexStart = Date.now();
        logger.info('💾 Indexing elements in vector store...');
        await this.semanticIndex.indexScreenState(screenState);
        indexTime = Date.now() - indexStart;
        logger.info(`⏱️  Indexed in DuckDB in ${indexTime}ms`);
        
        // Mark as having embeddings in cache
        if (!this.ocrCache) this.ocrCache = new Map();
        this.ocrCache.set(screenState.id, {
          screenState,
          timestamp: Date.now(),
          hasEmbeddings: true
        });
      }

      // 7. Build response
      const capturedText = elements.map(el => el.text).filter(Boolean).join('\n');
      const elapsed = Date.now() - startTime;

      logger.info(`✅ Semantic analysis complete in ${elapsed}ms`);
      logger.info(`📊 Timing breakdown: Screenshot=${screenshotTime}ms, OCR=${ocrTime}ms, Classification=${mergeTime}ms, Build=${buildTime}ms, Index=${indexTime}ms`);

      // 🧪 DEBUG: Save OCR result to JSON file for testing
      try {
        // Use path.dirname to get current directory in ES modules
        const currentDir = path.dirname(new URL(import.meta.url).pathname);
        const testDir = path.join(currentDir, '../../test-results/ocr');
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(testDir)) {
          fs.mkdirSync(testDir, { recursive: true });
        }
        
        // Save with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `ocr-result-${timestamp}.json`;
        const filepath = path.join(testDir, filename);
        
        fs.writeFileSync(filepath, 
          JSON.stringify({ 
            ...screenState, 
            nodes: screenState.nodes.map(node => ({ ...node, embedding: [] }))
          }, null, 2));
        console.log(`🧪 [DEBUG] OCR result saved to: ${filepath}`);
      } catch (saveError) {
        console.warn('⚠️  Failed to save OCR debug file:', saveError.message);
      }

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
        // LLM-friendly context (simple text, no embeddings needed)
        llmContext: this._buildLLMContext(elements, windowInfo),
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
   * Generate embeddings for cached OCR results (on-demand)
   * This is called when a follow-up semantic query needs embeddings
   * but we already have OCR results cached
   * 
   * @param {string} screenId - Screen ID from previous OCR capture
   * @returns {Promise<boolean>} - True if embeddings were generated
   */
  async generateEmbeddingsForCachedScreen(screenId) {
    if (!this.ocrCache || !this.ocrCache.has(screenId)) {
      logger.warn(`⚠️  No cached OCR results found for screen ${screenId}`);
      return false;
    }

    const cacheEntry = this.ocrCache.get(screenId);
    
    // Check if embeddings already exist
    if (cacheEntry.hasEmbeddings) {
      logger.info(`✅ Embeddings already exist for screen ${screenId}`);
      return true;
    }

    // Check cache age (don't generate embeddings for stale data)
    const age = Date.now() - cacheEntry.timestamp;
    if (age > 60000) {
      logger.warn(`⚠️  Cached OCR results too old (${Math.round(age/1000)}s), skipping embedding generation`);
      this.ocrCache.delete(screenId);
      return false;
    }

    try {
      logger.info(`⚡ Generating embeddings on-demand for cached screen ${screenId} (${Math.round(age/1000)}s old)`);
      const startTime = Date.now();
      
      await this.semanticIndex.indexScreenState(cacheEntry.screenState);
      
      const elapsed = Date.now() - startTime;
      logger.info(`✅ Generated embeddings in ${elapsed}ms (saved ~${Math.round(age/1000)}s by reusing OCR)`);
      
      // Update cache to mark embeddings as generated
      cacheEntry.hasEmbeddings = true;
      
      return true;
    } catch (error) {
      logger.error('❌ Failed to generate embeddings for cached screen:', error);
      return false;
    }
  }

  /**
   * Build screen state object for semantic indexing
   * @private
   */
  async _buildScreenState(elements, windowInfo) {
    const screenId = crypto.randomUUID();
    const timestamp = Date.now();

    console.log('🏗️  [BUILD_SCREEN_STATE] INSIDE METHOD - windowInfo:', JSON.stringify(windowInfo, null, 2));
    logger.info('🏗️  [BUILD_SCREEN_STATE] windowInfo:', JSON.stringify(windowInfo, null, 2));

    // Convert elements to nodes array (the semantic index expects elements array)
    const nodes = elements.map(el => ({
      id: el.id,
      type: el.type,
      text: el.text,
      description: el.description || `${el.type}: "${el.text}"`,
      bbox: el.bbox,
      normalizedBbox: el.normalizedBbox,
      clickable: el.clickable,
      interactive: el.interactive,
      visible: el.visible,
      confidence: el.confidence,
      ocrConfidence: el.ocrConfidence,
      detectionConfidence: el.detectionConfidence,
      parentId: el.parentId,
      children: el.children,
      attributes: el.attributes,
      screenRegion: el.screenRegion,
      zIndex: el.zIndex,
      iconType: el.iconType,
      imageCaption: el.imageCaption,
      embedding: null // Will be added by semanticIndex
    }));

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
      nodes, // Array of element nodes
      elements: nodes, // Also provide as 'elements' for compatibility
      subtrees: [], // Could group related elements later
      description: screenDescription,
      embedding: null // Will be added by semanticIndex
    };
  }

  /**
   * Create UI elements from OCR words using heuristic classification
   * @private
   */
  _createElementsFromOCR(ocrWords) {
    if (!ocrWords || ocrWords.length === 0) {
      return []; // No OCR text to merge
    }

    // Check if OCR words have valid bboxes (not all zeros)
    const hasValidBboxes = ocrWords.some(word => {
      if (!word.bbox) return false;
      const [x1, y1, x2, y2] = word.bbox;
      return x1 !== 0 || y1 !== 0 || x2 !== 0 || y2 !== 0;
    });

    if (!hasValidBboxes) {
      // OCR has no bbox data (raw text parsing fallback)
      // Add all OCR text as a single text element with UNIQUE ID
      const allText = ocrWords.map(w => w.text).filter(Boolean).join(' ');
      logger.info(`📝 OCR has no bbox data, adding ${ocrWords.length} words as text element`);
      const uniqueId = `ocr-fallback-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      
      return [
        {
          id: uniqueId,
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

    // Create elements from OCR words with enhanced heuristic classification
    logger.info(`📝 Creating ${ocrWords.length} elements from OCR words`);
    return ocrWords.map((word, index) => {
      const inferredType = this._inferElementTypeFromOCR(word);
      const isClickable = this._isLikelyClickableFromOCR(word);
      const text = word.text || '';
      
      return {
        id: `ocr-word-${Date.now()}-${index}`,
        type: inferredType,
        text: text,
        description: `${inferredType}: "${text.substring(0, 50)}"`,
        bbox: word.bbox,
        normalizedBbox: this._normalizeBbox(word.bbox),
        confidence: word.confidence || 0.5,
        clickable: isClickable,
        interactive: isClickable,
        visible: true,
        parentId: null,
        children: [],
        attributes: {},
        screenRegion: null,
        zIndex: 0,
        ocrConfidence: word.confidence || 0.5,
        detectionConfidence: null,
        iconType: null,
        imageCaption: null
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
   * Build LLM-friendly context from elements
   * Simple text aggregation - no embeddings needed for LLM responses
   * @private
   */
  _buildLLMContext(elements, windowInfo) {
    // Sort elements top-to-bottom, left-to-right
    const sortedElements = [...elements].sort((a, b) => {
      const yDiff = (a.bbox?.[1] || 0) - (b.bbox?.[1] || 0);
      if (Math.abs(yDiff) > 10) return yDiff; // Different rows
      return (a.bbox?.[0] || 0) - (b.bbox?.[0] || 0); // Same row, sort by x
    });

    // Group elements by type for structured context
    const byType = {
      menuItems: elements.filter(el => el.type === 'menu-item'),
      buttons: elements.filter(el => el.type === 'button'),
      links: elements.filter(el => el.type === 'link'),
      inputs: elements.filter(el => el.type === 'input'),
      headings: elements.filter(el => el.type === 'heading'),
      text: elements.filter(el => el.type === 'text')
    };

    return {
      // Application context
      app: windowInfo.appName || 'Unknown',
      windowTitle: windowInfo.title || '',
      
      // Simple text reconstruction (pipe-separated for easy parsing)
      fullText: sortedElements.map(el => el.text).filter(t => t).join(' | '),
      
      // Structured by type (easier for LLM to understand)
      structured: {
        menuItems: byType.menuItems.map(el => el.text).filter(t => t),
        buttons: byType.buttons.map(el => el.text).filter(t => t),
        links: byType.links.map(el => el.text).filter(t => t),
        inputs: byType.inputs.map(el => el.text).filter(t => t),
        headings: byType.headings.map(el => el.text).filter(t => t)
      },
      
      // Clickable elements (for action suggestions)
      clickableElements: elements
        .filter(el => el.clickable)
        .map(el => ({ type: el.type, text: el.text })),
      
      // Summary stats
      summary: {
        totalElements: elements.length,
        clickableCount: elements.filter(el => el.clickable).length,
        hasMenuBar: byType.menuItems.length > 0,
        hasButtons: byType.buttons.length > 0,
        hasInputs: byType.inputs.length > 0
      }
    };
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

  /**
   * Infer element type from OCR word based on text patterns and bbox dimensions
   * @private
   */
  _inferElementTypeFromOCR(word) {
    const text = (word.text || '').trim();
    const textLower = text.toLowerCase();
    
    // Calculate bbox dimensions if available
    let width = 0, height = 0, aspectRatio = 1;
    if (word.bbox && word.bbox.length === 4) {
      const [x1, y1, x2, y2] = word.bbox;
      width = x2 - x1;
      height = y2 - y1;
      aspectRatio = height > 0 ? width / height : 1;
    }
    
    // ═══════════════════════════════════════════════════════════
    // ENHANCED HEURISTIC CLASSIFICATION
    // ═══════════════════════════════════════════════════════════
    
    // 1. BUTTON - Action words with compact bbox
    const buttonPatterns = [
      /^(sign in|log in|login|sign up|signup|register|submit|send|save|delete|cancel|ok|yes|no|confirm|continue|next|back|close|done|finish|create|add|remove|edit|update|apply|search|go|start|stop|play|pause|download|upload|share|copy|paste|cut|print|export|import)$/i,
      /^(buy now|add to cart|checkout|subscribe|join|follow|like|comment|reply|post|publish|preview|learn more|get started|try free|view all)$/i
    ];
    if (buttonPatterns.some(pattern => pattern.test(text))) {
      // Buttons usually have compact, rectangular bbox (aspect ratio 2-8)
      if (aspectRatio >= 1.5 && aspectRatio <= 10 && width >= 40 && width <= 300) {
        return 'button';
      }
      return 'button'; // Still classify as button even if bbox doesn't match
    }
    
    // 2. INPUT FIELD - Placeholder text or empty field indicators
    const inputPlaceholders = /^(enter|type|search|find|filter|your|my|email|password|username|name|address|phone|message|comment)$/i;
    if (inputPlaceholders.test(textLower)) {
      // Input fields are usually wide and short (high aspect ratio)
      if (aspectRatio > 3 && height < 50) {
        return 'input';
      }
    }
    
    // 3. DROPDOWN/SELECT - Common dropdown indicators
    const dropdownPatterns = /^(select|choose|pick|all|any|none|---)$/i;
    const hasDropdownSymbol = text.includes('▼') || text.includes('▽') || text.includes('⌄') || text.includes('˅');
    if (dropdownPatterns.test(textLower) || hasDropdownSymbol) {
      return 'dropdown';
    }
    
    // 4. CHECKBOX/RADIO - Single character or very short text
    if (text.length === 1 && /[✓✗☐☑☒◯●]/.test(text)) {
      return 'checkbox';
    }
    
    // 5. LINK - URLs, emails, or underlined text indicators
    const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const urlPattern = /^(https?:\/\/|www\.)/i;
    if (urlPattern.test(text) || 
        textLower.includes('.com') || 
        textLower.includes('.org') ||
        textLower.includes('.net') ||
        emailPattern.test(text)) {
      return 'link';
    }
    
    // 6. NAVIGATION/MENU - Short capitalized words in header area
    // Common menu bar items (File, Edit, View, etc.) and navigation
    // IMPORTANT: Only match EXACT single words to avoid false positives like "File cabinet" or "Data in the store"
    const isTopArea = word.bbox && word.bbox[1] < 50; // Top 50px of screen
    const isSingleWord = !/\s/.test(text); // No spaces = single word
    const isShortText = text.length <= 15; // Menu items are usually short
    
    if (isSingleWord && isShortText) {
      // Menu bar items - only exact matches
      const menuBarPatterns = ['File', 'Edit', 'View', 'Window', 'Help', 'Tools', 'Format', 'Insert', 'Table', 'Data', 'Extensions', 'Preferences'];
      if (menuBarPatterns.includes(text) && isTopArea) {
        return 'menu-item';
      }
      
      // Navigation items - can appear anywhere but must be exact matches
      const navPatterns = ['Home', 'About', 'Contact', 'Services', 'Products', 'Blog', 'Support', 'Settings', 'Profile', 'Dashboard', 'Account', 'Menu', 'More', 'Tab', 'Blocks', 'Drive'];
      if (navPatterns.includes(text)) {
        return 'menu-item';
      }
      
      // Generic: Single capitalized word in top area with compact bbox (likely menu item)
      if (/^[A-Z][a-z]{2,12}$/.test(text) && isTopArea && width > 20 && width < 100) {
        return 'menu-item';
      }
    }
    
    // 7. LABEL - Ends with colon or common form labels
    if (textLower.endsWith(':') || 
        /^(email|password|username|name|first name|last name|address|phone|zip|city|state|country|company|title|message|subject|description)$/i.test(textLower)) {
      return 'label';
    }
    
    // 8. HEADING - Short, capitalized, larger bbox
    if (text.length <= 60 && height > 20 && /^[A-Z]/.test(text)) {
      // Headings are usually wider than tall
      if (aspectRatio > 2) {
        return 'heading';
      }
    }
    
    // 9. ICON TEXT - Very short text (1-3 chars) with small bbox
    if (text.length <= 3 && width < 50 && height < 50) {
      return 'icon';
    }
    
    // 10. NUMBER/BADGE - Pure numbers or number with unit
    if (/^\d+(\.\d+)?(%|px|em|rem|pt|°|$)?$/i.test(text)) {
      return 'badge';
    }
    
    // Default to text
    return 'text';
  }

  /**
   * Check if OCR word is likely clickable based on text and bbox
   * @private
   */
  _isLikelyClickableFromOCR(word) {
    const text = (word.text || '').trim();
    const textLower = text.toLowerCase();
    
    // Menu bar items are always clickable
    const menuBarPatterns = ['File', 'Edit', 'View', 'Window', 'Help', 'Tools', 'Format', 'Insert', 'Table', 'Data', 'Extensions', 'Preferences', 'Tab', 'Blocks', 'Drive'];
    if (menuBarPatterns.includes(text)) {
      return true;
    }
    
    // Clickable keywords
    const clickableKeywords = [
      'button', 'link', 'click', 'submit', 'send', 'save', 'delete', 'cancel', 'ok', 
      'sign in', 'log in', 'sign up', 'register', 'buy', 'add', 'remove', 'edit', 
      'update', 'close', 'confirm', 'continue', 'next', 'back', 'search', 'go',
      'download', 'upload', 'share', 'subscribe', 'join', 'follow', 'like', 'comment',
      'home', 'about', 'contact', 'menu', 'more', 'settings', 'profile', 'dashboard'
    ];
    
    // Check if text contains any clickable keywords
    if (clickableKeywords.some(keyword => textLower.includes(keyword))) {
      return true;
    }
    
    // Check if it's a URL
    if (textLower.includes('http') || textLower.includes('www.') || textLower.includes('.com')) {
      return true;
    }
    
    // Check bbox dimensions - buttons/links are usually compact
    if (word.bbox && word.bbox.length === 4) {
      const [x1, y1, x2, y2] = word.bbox;
      const width = x2 - x1;
      const height = y2 - y1;
      const aspectRatio = width / height;
      
      // Typical button dimensions: width 50-300px, height 20-60px, aspect ratio 2:1 to 8:1
      if (width >= 50 && width <= 300 && height >= 20 && height <= 60 && aspectRatio >= 2 && aspectRatio <= 8) {
        // If it's short text (1-3 words) with button-like dimensions, likely clickable
        const wordCount = text.split(/\s+/).length;
        if (wordCount >= 1 && wordCount <= 3) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Normalize bbox coordinates to 0-1 range
   * @private
   */
  _normalizeBbox(bbox) {
    if (!bbox || bbox.length !== 4) {
      return [0, 0, 0, 0];
    }
    
    // Assume standard screen dimensions (will be overridden by actual screen size if available)
    const screenWidth = 2880;  // Default to common retina display
    const screenHeight = 1800;
    
    const [x1, y1, x2, y2] = bbox;
    
    return [
      x1 / screenWidth,
      y1 / screenHeight,
      x2 / screenWidth,
      y2 / screenHeight
    ];
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
