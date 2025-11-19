import Tesseract from 'tesseract.js';
import { screen, Region } from '@nut-tree-fork/nut-js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import LayoutInferenceEngine from './layoutInferenceEngine.js';

/**
 * OCR-based screen analysis using Tesseract.js
 * Parallel to NutJsAnalyzer but uses OCR instead of text capture
 */
export class OCRAnalyzer {
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'thinkdrop-ocr-capture');
    this.testResultsDir = path.join(process.cwd(), 'test-results', 'ocr');
    this.debounceTimer = null;
    this.lastCaptureTime = 0;
    this.minCaptureInterval = 1000; // 1 second minimum between captures
    this.inferenceEngine = new LayoutInferenceEngine();
    this.cache = new Map(); // Cache for image hash -> OCR result
    this.overlayCallback = null; // Callback to show visual overlay
    this.worker = null; // Tesseract worker (reusable)
    this.isInitialized = false;
  }

  /**
   * Initialize OCR worker and temp directories
   */
  async init() {
    try {
      // Create directories
      await fs.mkdir(this.tempDir, { recursive: true });
      console.log('📁 [OCR] Temp directory created:', this.tempDir);
      
      await fs.mkdir(this.testResultsDir, { recursive: true });
      console.log('📁 [OCR] Test results directory created:', this.testResultsDir);

      // Initialize Tesseract worker (reusable for better performance)
      console.log('🔧 [OCR] Initializing Tesseract worker...');
      this.worker = await Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            // console.log(`📊 [OCR] Progress: ${(m.progress * 100).toFixed(1)}%`);
          }
        }
      });
      
      // Configure for word-level extraction with full hierarchy
      await this.worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.AUTO, // Automatic page segmentation
        tessedit_char_whitelist: '', // Allow all characters
        preserve_interword_spaces: '1', // Preserve spaces between words
      });
      
      this.isInitialized = true;
      console.log('✅ [OCR] Tesseract worker initialized');
    } catch (error) {
      console.error('❌ [OCR] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Cleanup worker on shutdown
   */
  async cleanup() {
    if (this.worker) {
      await this.worker.terminate();
      console.log('🧹 [OCR] Tesseract worker terminated');
    }
  }

  /**
   * Capture screenshot and perform OCR analysis with debouncing
   * @param {Object} options - Capture options
   * @returns {Promise<Object>} Analysis result
   */
  async captureAndAnalyze(options = {}) {
    const { 
      debounce = true,
      region = null, // Optional region to capture (x, y, width, height)
      windowInfo = {} 
    } = options;

    // Debounce rapid captures
    if (debounce) {
      const now = Date.now();
      if (now - this.lastCaptureTime < this.minCaptureInterval) {
        console.log('⏭️  [OCR] Skipping capture (debounced)');
        return null;
      }
      this.lastCaptureTime = now;
    }

    if (!this.isInitialized) {
      console.warn('⚠️  [OCR] Worker not initialized, initializing now...');
      await this.init();
    }

    try {
      console.log('🎯 [OCR] Starting screenshot capture...');
      
      // Show overlay
      await this.showOverlay('📸 Capturing screenshot for OCR...');

      // Use window bounds if provided, otherwise fallback to screen size
      let captureRegion = region;
      if (!captureRegion && windowInfo && windowInfo.x !== undefined) {
        // Capture only the focused window
        captureRegion = {
          x: windowInfo.x,
          y: windowInfo.y,
          width: windowInfo.width,
          height: windowInfo.height
        };
        console.log(`🎯 [OCR] Using focused window bounds: ${captureRegion.width}x${captureRegion.height}`);
      } else if (!captureRegion) {
        // Fallback to full screen
        const screenWidth = await screen.width();
        const screenHeight = await screen.height();
        captureRegion = { width: screenWidth, height: screenHeight };
        console.log('📐 [OCR] Using full screen:', captureRegion);
      }

      // Capture screenshot (focused window or full screen)
      const screenshot = await this.captureScreenshot(captureRegion);
      
      if (!screenshot) {
        console.log('⚠️  [OCR] No screenshot captured');
        await this.hideOverlay();
        return null;
      }

      console.log(`📸 [OCR] Screenshot captured: ${screenshot.path}`);

      // Update overlay
      await this.showOverlay('🔍 Performing OCR analysis...');

      // Use screenshot dimensions as screen size for analysis
      const screenSize = {
        width: screenshot.width,
        height: screenshot.height
      };

      // Perform OCR analysis
      const analysis = await this.analyzeAndReconstruct(screenshot, {
        screenSize,
        windowInfo
      });

      await this.hideOverlay();
      return analysis;

    } catch (error) {
      console.error('❌ [OCR] Capture failed:', error);
      await this.hideOverlay();
      return null;
    }
  }

  /**
   * Capture screenshot of focused window only (not entire screen)
   * @param {Object} windowInfo - Window info with bounds {x, y, width, height}
   * @returns {Promise<Object>} Screenshot info {path, buffer, hash}
   */
  async captureScreenshot(windowInfo = null) {
    try {
      const timestamp = Date.now();
      const screenshotPath = path.join(this.tempDir, `screenshot-${timestamp}.png`);

      // If window bounds provided, capture only that region
      if (windowInfo && windowInfo.x !== undefined) {
        const { x, y, width, height } = windowInfo;
        console.log(`📸 [OCR] Capturing focused window region: ${width}x${height} at (${x}, ${y})`);
        
        // Capture specific region using nut.js (requires Region instance)
        const regionObj = new Region(x, y, width, height);
        const region = await screen.grabRegion(regionObj);
        const buffer = Buffer.from(region.data);
        
        // Save using sharp
        await sharp(buffer, {
          raw: {
            width: region.width,
            height: region.height,
            channels: 4 // RGBA
          }
        })
        .png()
        .toFile(screenshotPath);
        
        console.log('💾 [OCR] Focused window screenshot saved to:', screenshotPath);
        
        const hash = this.hashBuffer(buffer);
        return {
          path: screenshotPath,
          buffer,
          hash,
          width: region.width,
          height: region.height
        };
      }
      
      // Fallback: Capture entire screen if no window bounds
      console.log('📸 [OCR] No window bounds, capturing entire screen');
      const img = await screen.grab();
      
      // Convert to buffer and save
      const buffer = Buffer.from(img.data);
      
      // Use sharp to process and save the image
      await sharp(buffer, {
        raw: {
          width: img.width,
          height: img.height,
          channels: 4 // RGBA
        }
      })
      .png()
      .toFile(screenshotPath);

      console.log('💾 [OCR] Screenshot saved to:', screenshotPath);

      // Generate hash for caching
      const hash = this.hashBuffer(buffer);

      return {
        path: screenshotPath,
        buffer,
        hash,
        width: img.width,
        height: img.height
      };

    } catch (error) {
      console.error('❌ [OCR] Screenshot capture failed:', error);
      return null;
    }
  }

  /**
   * Set overlay callback for visual feedback
   */
  setOverlayCallback(callback) {
    this.overlayCallback = callback;
  }

  /**
   * Show visual overlay during processing
   */
  async showOverlay(message) {
    if (this.overlayCallback) {
      await this.overlayCallback({ type: 'show', message });
    }
  }

  /**
   * Hide visual overlay
   */
  async hideOverlay() {
    if (this.overlayCallback) {
      await this.overlayCallback({ type: 'hide' });
    }
  }

  /**
   * Simple OCR analysis - just extract words from image
   * @param {string} imagePath - Path to screenshot
   * @returns {Promise<Object>} { words: [{text, bbox, confidence}], text: string }
   */
  async analyze(imagePath) {
    if (!this.isInitialized) {
      await this.init();
    }

    try {
      const startTime = Date.now();
      console.log('🔍 [OCR] Analyzing image:', imagePath);
      // Request word-level data explicitly with proper output format
      // Tesseract.js v6 requires explicit output level in recognize() options
      const result = await this.worker.recognize(imagePath, {
        // Request TSV for word-level bounding boxes (Tesseract.js v6 method)
        blocks: true,
        hocr: true,   // Enable HOCR for structured output
        tsv: true,    // Enable TSV for bounding boxes
        box: false,
        unlv: false,
        osd: false,
        pdf: false
      });
      const data = result.data;
      const ocrAnalyzingTime = Date.now() - startTime;

      console.log(`⏱️  [OCR] Recognition Analyzing completed in ${ocrAnalyzingTime}ms`);
      
      // Debug: log data structure
      console.log('🐛 [OCR] Data keys:', Object.keys(data));
      console.log('🐛 [OCR] Has words?', !!data.words, 'Count:', data.words?.length || 0);
      console.log('🐛 [OCR] Has lines?', !!data.lines, 'Count:', data.lines?.length || 0);
      console.log('🐛 [OCR] Has blocks?', !!data.blocks, 'Count:', data.blocks?.length || 0);
      console.log('🐛 [OCR] Text length:', data.text?.length || 0);
      
      // CRITICAL: Tesseract.js v6 uses hocr/tsv strings, not blocks objects
      // We need to parse the TSV output to get word bboxes
      console.log('🐛 [OCR] Has TSV?', !!data.tsv, 'Length:', data.tsv?.length || 0);
      console.log('🐛 [OCR] Has HOCR?', !!data.hocr, 'Length:', data.hocr?.length || 0);
      
      if (data.tsv && data.tsv.length > 100) {
        console.log('🐛 [OCR] TSV preview (first 500 chars):', data.tsv.substring(0, 500));
      }
      
      let words = [];
      
      // PRIORITY 1: Parse TSV output (Tesseract.js v6 primary method)
      if (data.tsv && data.tsv.length > 100) {
        console.log('🔍 [OCR] Parsing TSV output for word bboxes...');
        try {
          const lines = data.tsv.split('\n');
          // TSV format: level page_num block_num par_num line_num word_num left top width height conf text
          for (let i = 1; i < lines.length; i++) { // Skip header
            const parts = lines[i].split('\t');
            if (parts.length >= 12) {
              const level = parseInt(parts[0]);
              const text = parts[11]?.trim();
              const conf = parseFloat(parts[10]);
              
              // Level 5 = word level
              if (level === 5 && text && text.length > 0 && conf > 0) {
                const left = parseInt(parts[6]);
                const top = parseInt(parts[7]);
                const width = parseInt(parts[8]);
                const height = parseInt(parts[9]);
                
                words.push({
                  text: text,
                  bbox: [left, top, left + width, top + height],
                  confidence: conf / 100 // Normalize to 0-1
                });
              }
            }
          }
          console.log(`✅ [OCR] Extracted ${words.length} words from TSV with bboxes`);
        } catch (err) {
          console.error('⚠️  [OCR] TSV parsing failed:', err.message);
        }
      }
      
      // PRIORITY 2: Try word-level extraction (if TSV didn't work)
      if (words.length === 0 && data.words && data.words.length > 0) {
        words = data.words
          .filter(word => word.text && word.text.trim().length > 0)
          .map(word => ({
            text: word.text.trim(),
            bbox: [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1],
            confidence: word.confidence / 100 // Normalize to 0-1
          }));
        console.log(`✅ [OCR] Extracted ${words.length} words from top-level word array`);
      } 
      // Fallback 1: extract words from lines if word-level data is missing
      else if (words.length === 0 && data.lines && data.lines.length > 0) {
        console.log('⚠️  [OCR] No top-level words, extracting from lines...');
        data.lines.forEach(line => {
          if (line.words && line.words.length > 0) {
            line.words.forEach(word => {
              if (word.text && word.text.trim().length > 0) {
                words.push({
                  text: word.text.trim(),
                  bbox: [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1],
                  confidence: word.confidence / 100
                });
              }
            });
          }
        });
        console.log(`✅ [OCR] Extracted ${words.length} words from lines`);
      }
      // Fallback 2: extract from blocks > paragraphs > lines > words hierarchy
      else if (words.length === 0 && data.blocks && data.blocks.length > 0) {
        console.log('⚠️  [OCR] No lines, extracting from blocks hierarchy...');
        data.blocks.forEach(block => {
          if (block.paragraphs && block.paragraphs.length > 0) {
            block.paragraphs.forEach(para => {
              if (para.lines && para.lines.length > 0) {
                para.lines.forEach(line => {
                  if (line.words && line.words.length > 0) {
                    line.words.forEach(word => {
                      if (word.text && word.text.trim().length > 0) {
                        words.push({
                          text: word.text.trim(),
                          bbox: [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1],
                          confidence: word.confidence / 100
                        });
                      }
                    });
                  }
                });
              }
            });
          }
        });
        console.log(`✅ [OCR] Extracted ${words.length} words from blocks hierarchy`);
      }
      // Last resort: parse raw text into words without bounding boxes
      else if (words.length === 0 && data.text && data.text.trim().length > 0) {
        console.warn(`⚠️  [OCR] No structured data at all, parsing raw text: ${data.text.length} chars`);
        const rawWords = data.text.split(/\s+/).filter(w => w.trim().length > 0);
        words = rawWords.map(text => ({
          text: text.trim(),
          bbox: [0, 0, 0, 0], // No bbox available
          confidence: (data.confidence || 0) / 100
        }));
        console.log(`✅ [OCR] Extracted ${words.length} words from raw text (no bboxes)`);
      } else {
        console.warn(`⚠️  [OCR] No text data available at all`);
      }
      
      return {
        words,
        text: data.text || '',
        confidence: (data.confidence || 0) / 100
      };
    } catch (error) {
      console.error('❌ [OCR] Analysis failed:', error);
      throw error;
    }
  }

  /**
   * Perform OCR and reconstruct spatial layout
   * @param {Object} screenshot - Screenshot info
   * @param {Object} context - Screen and window context
   * @returns {Promise<Object>} Analysis with reconstructed layout
   */
  async analyzeAndReconstruct(screenshot, context) {
    console.log('🔍 [OCR] Analyzing screenshot with Tesseract...');

    const { screenSize, windowInfo } = context;
    
    // Check cache first
    const cacheKey = `${windowInfo.url || windowInfo.app}-${screenshot.hash}`;
    
    if (this.cache.has(cacheKey)) {
      console.log('⚡ [OCR] Cache hit! Returning cached OCR result');
      const cached = this.cache.get(cacheKey);
      cached.fromCache = true;
      return cached;
    }
    
    try {
      // Perform OCR with Tesseract
      const startTime = Date.now();
      const { data } = await this.worker.recognize(screenshot.path);
      const ocrTime = Date.now() - startTime;

      console.log(`⏱️  [OCR] Recognition completed in ${ocrTime}ms`);
      console.log(`📝 [OCR] Extracted text: ${data.text.length} characters`);
      console.log(`📊 [OCR] Confidence: ${data.confidence.toFixed(1)}%`);
      console.log(`🪟 [OCR] Active Window: ${windowInfo.app || 'Unknown'}${windowInfo.url ? ` (${windowInfo.url})` : ''}`);

      // Extract text and word-level data
      const text = data.text;
      const words = data.words || [];
      const lines = data.lines || [];
      const blocks = data.blocks || [];

      // Build elements from OCR data with spatial information
      const elements = this.buildElementsFromOCR(data, screenSize);

      // Use inference engine for advanced layout detection
      const inferredLayout = this.inferenceEngine.inferLayout(text, {
        screenSize,
        url: windowInfo.url,
        app: windowInfo.app,
        ocrData: data // Pass OCR data for better inference
      });

      console.log(`🧠 [OCR] Inference complete: ${inferredLayout.docType}, confidence: ${(inferredLayout.metadata.confidence * 100).toFixed(1)}%`);

      // Merge OCR elements with inferred elements
      const mergedElements = this.mergeElements(elements, inferredLayout.elements);

      // Build spatial reconstruction
      const reconstruction = this.buildSpatialReconstruction({
        ...inferredLayout,
        elements: mergedElements
      }, {
        screenSize,
        windowInfo,
        ocrData: data
      });

      const result = {
        success: true,
        method: 'tesseract-ocr',
        capturedText: text,
        screenshotPath: screenshot.path,
        // Active window context - CRITICAL for AI to know what app/browser is being analyzed
        activeWindow: {
          app: windowInfo.app || 'Unknown',
          url: windowInfo.url || null,
          title: windowInfo.title || null,
          bounds: windowInfo.x !== undefined ? {
            x: windowInfo.x,
            y: windowInfo.y,
            width: windowInfo.width,
            height: windowInfo.height
          } : null,
          isBrowser: !!(windowInfo.url),
          displayName: windowInfo.url 
            ? `${windowInfo.app}: ${windowInfo.url}` 
            : windowInfo.app || 'Unknown'
        },
        stats: {
          textLength: text.length,
          wordCount: words.length,
          lineCount: lines.length,
          blockCount: blocks.length,
          confidence: data.confidence,
          ocrTime,
          screenSize
        },
        docType: inferredLayout.docType,
        structures: inferredLayout.structures,
        zones: inferredLayout.zones,
        elements: mergedElements,
        ocrData: {
          words: words.map(w => ({
            text: w.text,
            confidence: w.confidence,
            bbox: w.bbox
          })),
          lines: lines.map(l => ({
            text: l.text,
            confidence: l.confidence,
            bbox: l.bbox
          })),
          blocks: blocks.map(b => ({
            text: b.text,
            confidence: b.confidence,
            bbox: b.bbox
          }))
        },
        reconstruction,
        confidence: data.confidence / 100, // Normalize to 0-1
        timestamp: Date.now(),
        fromCache: false
      };

      // Save analysis results to files for testing/debugging
      await this.saveAnalysisResults(result);

      // Cache the result
      this.cache.set(cacheKey, result);
      console.log(`💾 [OCR] Cached result for: ${cacheKey}`);

      // Clean old cache entries (keep last 50)
      if (this.cache.size > 50) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
        console.log('🧹 [OCR] Cleaned old cache entry');
      }

      return result;

    } catch (error) {
      console.error('❌ [OCR] Analysis failed:', error);
      throw error;
    }
  }

  /**
   * Build elements from OCR data with spatial information
   * @param {Object} ocrData - Tesseract OCR data
   * @param {Object} screenSize - Screen dimensions
   * @returns {Array} Elements with positions
   */
  buildElementsFromOCR(ocrData, screenSize) {
    const elements = [];

    // Process words with bounding boxes
    if (ocrData.words) {
      ocrData.words.forEach((word, idx) => {
        if (word.text.trim().length > 0) {
          elements.push({
            type: 'text',
            text: word.text,
            confidence: word.confidence / 100,
            position: {
              x: word.bbox.x0,
              y: word.bbox.y0,
              width: word.bbox.x1 - word.bbox.x0,
              height: word.bbox.y1 - word.bbox.y0
            },
            wordIndex: idx,
            source: 'ocr'
          });
        }
      });
    }

    // Process lines for paragraph detection
    if (ocrData.lines) {
      ocrData.lines.forEach((line, idx) => {
        if (line.text.trim().length > 0) {
          elements.push({
            type: 'line',
            text: line.text,
            confidence: line.confidence / 100,
            position: {
              x: line.bbox.x0,
              y: line.bbox.y0,
              width: line.bbox.x1 - line.bbox.x0,
              height: line.bbox.y1 - line.bbox.y0
            },
            lineIndex: idx,
            source: 'ocr'
          });
        }
      });
    }

    console.log(`🔨 [OCR] Built ${elements.length} elements from OCR data`);
    return elements;
  }

  /**
   * Merge OCR elements with inferred elements
   * @param {Array} ocrElements - Elements from OCR
   * @param {Array} inferredElements - Elements from inference engine
   * @returns {Array} Merged elements
   */
  mergeElements(ocrElements, inferredElements) {
    // Start with OCR elements (they have precise spatial data)
    const merged = [...ocrElements];

    // Add inferred elements that don't overlap with OCR
    inferredElements.forEach(inferred => {
      // Check if this inferred element overlaps with OCR elements
      const hasOverlap = ocrElements.some(ocr => {
        if (!ocr.position || !inferred.position) return false;
        return this.doElementsOverlap(ocr.position, inferred.position);
      });

      if (!hasOverlap) {
        merged.push({
          ...inferred,
          source: 'inferred'
        });
      }
    });

    console.log(`🔗 [OCR] Merged ${merged.length} elements (${ocrElements.length} OCR + ${merged.length - ocrElements.length} inferred)`);
    return merged;
  }

  /**
   * Check if two elements overlap spatially
   */
  doElementsOverlap(pos1, pos2) {
    return !(
      pos1.x + pos1.width < pos2.x ||
      pos2.x + pos2.width < pos1.x ||
      pos1.y + pos1.height < pos2.y ||
      pos2.y + pos2.height < pos1.y
    );
  }

  /**
   * Build spatial reconstruction HTML
   * Similar to NutJsAnalyzer but with OCR-specific data
   */
  buildSpatialReconstruction(layout, context) {
    const { screenSize, windowInfo, ocrData } = context;
    const { elements, structures, zones } = layout;

    const isBrowser = !!(windowInfo.url);
    const displayName = windowInfo.url 
      ? `${windowInfo.app}: ${windowInfo.url}` 
      : windowInfo.app || 'Unknown';

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OCR Screen Analysis - ${displayName}</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f5f5;
    }
    .container {
      max-width: ${screenSize.width}px;
      margin: 0 auto;
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .header {
      border-bottom: 2px solid #e0e0e0;
      padding-bottom: 10px;
      margin-bottom: 20px;
    }
    .active-window-badge {
      display: inline-block;
      padding: 8px 16px;
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      color: white;
      border-radius: 8px;
      font-weight: 600;
      margin-bottom: 12px;
      font-size: 14px;
    }
    .browser-badge {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
    }
    .paragraph {
      margin: 12px 0;
      line-height: 1.6;
    }
    .ocr-word {
      display: inline;
      padding: 2px 4px;
      margin: 0 2px;
      background: rgba(59, 130, 246, 0.1);
      border-radius: 3px;
    }
    .low-confidence {
      background: rgba(239, 68, 68, 0.1);
    }
    .interactive {
      position: absolute;
      padding: 8px 16px;
      background: #3b82f6;
      color: white;
      border-radius: 6px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📸 OCR Screen Analysis</h1>
      <div class="active-window-badge ${isBrowser ? 'browser-badge' : ''}">
        ${isBrowser ? '🌐' : '💻'} ${displayName}
      </div>
      <p><strong>Application:</strong> ${windowInfo.app || 'Unknown'}</p>
      ${windowInfo.url ? `<p><strong>URL:</strong> ${windowInfo.url}</p>` : ''}
      ${windowInfo.title ? `<p><strong>Window Title:</strong> ${windowInfo.title}</p>` : ''}
      <p><strong>Method:</strong> Tesseract.js OCR</p>
      <p><strong>Confidence:</strong> ${ocrData ? (ocrData.confidence || 0).toFixed(1) : 0}%</p>
      <p><strong>Words:</strong> ${ocrData?.words?.length || 0}</p>
    </div>
`;

    // Render text elements with confidence indicators
    const textElements = elements.filter(el => el.type === 'text' || el.type === 'line');
    
    if (textElements.length > 0) {
      html += '<div class="content">';
      
      // Group by lines for natural flow
      const lineGroups = new Map();
      textElements.forEach(el => {
        const lineY = Math.floor(el.position?.y / 20) * 20; // Group by ~20px vertical bands
        if (!lineGroups.has(lineY)) {
          lineGroups.set(lineY, []);
        }
        lineGroups.get(lineY).push(el);
      });

      // Render lines in order
      Array.from(lineGroups.entries())
        .sort((a, b) => a[0] - b[0])
        .forEach(([lineY, words]) => {
          html += '<p class="paragraph">';
          words
            .sort((a, b) => (a.position?.x || 0) - (b.position?.x || 0))
            .forEach(word => {
              const confidenceClass = word.confidence < 0.7 ? 'low-confidence' : '';
              html += `<span class="ocr-word ${confidenceClass}" title="Confidence: ${(word.confidence * 100).toFixed(1)}%">${word.text}</span>`;
            });
          html += '</p>';
        });
      
      html += '</div>';
    }

    html += `
  </div>
</body>
</html>`;

    return {
      html,
      plainText: elements.map(el => el.text).join(' '),
      elementCount: elements.length
    };
  }

  /**
   * Save analysis results to files
   */
  async saveAnalysisResults(result) {
    try {
      // await fs.mkdir(this.testResultsDir, { recursive: true });
      // const timestamp = Date.now();
      // const baseName = `ocr-analysis-${timestamp}`;
      
      // Save complete analysis result as JSON
                                                                                                                                                                            const analysisFile = path.join(this.testResultsDir, `${baseName}.json`);
      const analysisData = {
        ...result,
        capturedText: result.capturedText.substring(0, 1000) + '...' // Truncate for file size
      };
      // await fs.writeFile(analysisFile, JSON.stringify(analysisData, null, 2), 'utf-8');
      result.analysisFile = analysisFile;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             
      console.log('💾 [OCR] Analysis JSON saved to:', analysisFile);
      
      // Save HTML reconstruction as separate file
      const htmlFile = path.join(this.testResultsDir, `${baseName}.html`);
      await fs.writeFile(htmlFile, result.reconstruction.html, 'utf-8');
      result.htmlFile = htmlFile;
      console.log('💾 [OCR] HTML reconstruction saved to:', htmlFile);
      
    } catch (saveError) {
      console.warn('⚠️  [OCR] Failed to save analysis files:', saveError.message);
    }
  }

  /**
   * Generate hash for text content (for caching)
   */
  hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /**
   * Generate hash for buffer (for caching)
   */
  hashBuffer(buffer) {
    let hash = 0;
    const sample = buffer.slice(0, 1000); // Sample first 1000 bytes
    for (let i = 0; i < sample.length; i++) {
      hash = ((hash << 5) - hash) + sample[i];
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    console.log('🧹 [OCR] Cache cleared');
  }

  /**
   * Get cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }
}

export default OCRAnalyzer;
