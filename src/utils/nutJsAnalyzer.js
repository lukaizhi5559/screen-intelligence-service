import { mouse, keyboard, Key, Button, screen, Region, clipboard } from '@nut-tree-fork/nut-js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import LayoutInferenceEngine from './layoutInferenceEngine.js';

/**
 * Fast local screen analysis using Nut.js text capture and spatial reconstruction
 * Alternative to expensive vision API calls
 */
export class NutJsAnalyzer {
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'thinkdrop-screen-capture');
    this.testResultsDir = path.join(process.cwd(), 'test-results');
    this.debounceTimer = null;
    this.lastCaptureTime = 0;
    this.minCaptureInterval = 1000; // 1 second minimum between captures
    this.inferenceEngine = new LayoutInferenceEngine();
    this.cache = new Map(); // Cache for text hash -> layout
    this.overlayCallback = null; // Callback to show visual overlay
  }

  /**
   * Initialize temp directory for captured text
   */
  async init() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      console.log('📁 [NUTJS] Temp directory created:', this.tempDir);
      
      await fs.mkdir(this.testResultsDir, { recursive: true });
      console.log('📁 [NUTJS] Test results directory created:', this.testResultsDir);
    } catch (error) {
      console.error('❌ [NUTJS] Failed to create directories:', error);
    }
  }

  /**
   * Capture screen text with debouncing
   * @param {Object} options - Capture options
   * @returns {Promise<Object>} Analysis result
   */
  async captureAndAnalyze(options = {}) {
    const { 
      debounce = true,
      usePrintFallback = false,
      windowInfo = {} 
    } = options;

    // Debounce rapid captures
    if (debounce) {
      const now = Date.now();
      if (now - this.lastCaptureTime < this.minCaptureInterval) {
        console.log('⏭️  [NUTJS] Skipping capture (debounced)');
        return null;
      }
      this.lastCaptureTime = now;
    }

    try {
      console.log('🎯 [NUTJS] Starting text capture...');
      
      // Get screen dimensions
      const screenSize = await screen.width().then(w => ({ 
        width: w, 
        height: screen.height() 
      }));
      console.log('📐 [NUTJS] Screen size:', screenSize);

      // Capture text using appropriate method
      const capturedText = usePrintFallback 
        ? await this.captureViaPrintDialog()
        : await this.captureViaSelectAll();

      if (!capturedText || capturedText.trim().length === 0) {
        console.log('⚠️  [NUTJS] No text captured');
        return null;
      }

      console.log(`📝 [NUTJS] Captured ${capturedText.length} characters`);

      // Save to temp file
      const tempFile = path.join(this.tempDir, `capture-${Date.now()}.txt`);
      await fs.writeFile(tempFile, capturedText, 'utf-8');
      console.log('💾 [NUTJS] Saved to:', tempFile);

      // Analyze and reconstruct
      const analysis = await this.analyzeAndReconstruct(capturedText, {
        screenSize,
        windowInfo,
        tempFile
      });

      return analysis;

    } catch (error) {
      console.error('❌ [NUTJS] Capture failed:', error);
      return null;
    }
  }

  /**
   * Capture text via select all (Cmd+A) and copy (Cmd+C)
   * Non-invasive: Restores mouse position, clipboard, and deselects text
   */
  async captureViaSelectAll() {
    let originalMousePos = null;
    let originalClipboard = null;
    
    try {
      const isMac = process.platform === 'darwin';
      
      console.log('🎯 [NUTJS] Starting text capture...');

      // 1. Save original mouse position
      originalMousePos = await mouse.getPosition();
      console.log('💾 [NUTJS] Saved mouse position:', originalMousePos);

      // 2. Save original clipboard content
      try {
        originalClipboard = await clipboard.getContent();
        console.log('💾 [NUTJS] Saved clipboard content');
      } catch (e) {
        console.log('⚠️  [NUTJS] No clipboard content to save');
      }

      // Get screen size
      const screenWidth = await screen.width();
      const screenHeight = await screen.height();
      const screenSize = { width: screenWidth, height: screenHeight };
      console.log('📐 [NUTJS] Screen size:', screenSize);

      // Move to center of screen to ensure focus
      const centerX = Math.floor(screenSize.width / 2);
      const centerY = Math.floor(screenSize.height / 2);
      console.log('🖱️  [NUTJS] Moving to center:', centerX, centerY);
      await mouse.setPosition({ x: centerX, y: centerY });
      await new Promise(resolve => setTimeout(resolve, 100));

      // Select all text
      console.log('⌨️  [NUTJS] Selecting all (Cmd+A)');
      if (isMac) {
        await keyboard.pressKey(Key.LeftCmd);
        await keyboard.type(Key.A);
        await keyboard.releaseKey(Key.LeftCmd);
      } else {
        await keyboard.pressKey(Key.LeftControl);
        await keyboard.type(Key.A);
        await keyboard.releaseKey(Key.LeftControl);
      }
      await new Promise(resolve => setTimeout(resolve, 200));

      // Copy to clipboard
      console.log('📋 [NUTJS] Copying (Cmd+C)');
      if (isMac) {
        await keyboard.pressKey(Key.LeftCmd);
        await keyboard.type(Key.C);
        await keyboard.releaseKey(Key.LeftCmd);
      } else {
        await keyboard.pressKey(Key.LeftControl);
        await keyboard.type(Key.C);
        await keyboard.releaseKey(Key.LeftControl);
      }
      await new Promise(resolve => setTimeout(resolve, 200));

      // Read from clipboard using nut.js clipboard API
      let text = await clipboard.getContent();
      
      // Limit text length to prevent memory overflow (max 100K chars)
      const MAX_TEXT_LENGTH = 100000;
      if (text.length > MAX_TEXT_LENGTH) {
        console.warn(`⚠️  [NUTJS] Text too long (${text.length} chars), truncating to ${MAX_TEXT_LENGTH}`);
        text = text.substring(0, MAX_TEXT_LENGTH);
      }

      // 3. Deselect text (click or Escape)
      console.log('🔄 [NUTJS] Deselecting text (Esc)');
      await keyboard.type(Key.Escape);
      await new Promise(resolve => setTimeout(resolve, 100));

      // 4. Restore original clipboard
      if (originalClipboard) {
        console.log('🔄 [NUTJS] Restoring clipboard');
        await clipboard.setContent(originalClipboard);
      }

      // 5. Restore original mouse position
      console.log('🔄 [NUTJS] Restoring mouse position:', originalMousePos);
      await mouse.setPosition(originalMousePos);
      
      return text;

    } catch (error) {
      console.error('❌ [NUTJS] Select all capture failed:', error);
      
      // Attempt cleanup even on error
      try {
        if (originalMousePos) {
          await mouse.setPosition(originalMousePos);
        }
        if (originalClipboard) {
          await clipboard.setContent(originalClipboard);
        }
        await keyboard.type(Key.Escape);
      } catch (cleanupError) {
        console.error('⚠️  [NUTJS] Cleanup failed:', cleanupError);
      }
      
      throw error;
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
   * Method B: Capture via print dialog (Gmail, etc.)
   * Non-invasive: saves/restores mouse position and clipboard
   */
  async captureViaPrintDialog() {
    let originalMousePos = null;
    let originalClipboard = null;

    try {
      const isMac = process.platform === 'darwin';

      // 1. Save original mouse position
      originalMousePos = await mouse.getPosition();
      console.log('💾 [NUTJS] Saved mouse position (print):', originalMousePos);

      // 2. Save original clipboard content
      try {
        originalClipboard = await clipboard.getContent();
        console.log('💾 [NUTJS] Saved clipboard content (print)');
      } catch (e) {
        console.log('⚠️  [NUTJS] No clipboard content to save (print)');
      }

      // Show overlay
      await this.showOverlay('🔍 Analyzing screen (Cmd+P method)...');

      // Open print dialog
      console.log('🖨️  [NUTJS] Opening print dialog (Cmd+P)');
      if (isMac) {
        await keyboard.pressKey(Key.LeftCmd);
        await keyboard.type(Key.P);
        await keyboard.releaseKey(Key.LeftCmd);
      } else {
        await keyboard.pressKey(Key.LeftControl);
        await keyboard.type(Key.P);
        await keyboard.releaseKey(Key.LeftControl);
      }
      await new Promise(resolve => setTimeout(resolve, 500));

      // Click center and select all
      const screenWidth = await screen.width();
      const screenHeight = await screen.height();
      await mouse.setPosition({
        x: Math.floor(screenWidth / 2),
        y: Math.floor(screenHeight / 2)
      });
      await mouse.click(Button.LEFT);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Select and copy
      if (isMac) {
        await keyboard.pressKey(Key.LeftCmd);
        await keyboard.type(Key.A);
        await keyboard.releaseKey(Key.LeftCmd);
        await new Promise(resolve => setTimeout(resolve, 200));

        await keyboard.pressKey(Key.LeftCmd);
        await keyboard.type(Key.C);
        await keyboard.releaseKey(Key.LeftCmd);
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Cancel print dialog
      console.log('❌ [NUTJS] Canceling print dialog (Esc)');
      await keyboard.type(Key.Escape);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Read clipboard using nut.js clipboard API
      let text = await clipboard.getContent();

      // Limit text length to prevent memory overflow (max 100K chars)
      const MAX_TEXT_LENGTH = 100000;
      if (text.length > MAX_TEXT_LENGTH) {
        console.warn(`⚠️  [NUTJS] Text too long (${text.length} chars), truncating to ${MAX_TEXT_LENGTH}`);
        text = text.substring(0, MAX_TEXT_LENGTH);
      }

      // Hide overlay
      await this.hideOverlay();

      // Restore clipboard
      if (originalClipboard) {
        console.log('🔄 [NUTJS] Restoring clipboard (print)');
        await clipboard.setContent(originalClipboard);
      }

      // Restore mouse position
      if (originalMousePos) {
        console.log('🔄 [NUTJS] Restoring mouse position (print):', originalMousePos);
        await mouse.setPosition(originalMousePos);
      }

      return text;

    } catch (error) {
      console.error('❌ [NUTJS] Print dialog capture failed:', error);

      try {
        await this.hideOverlay();
        if (originalClipboard) {
          await clipboard.setContent(originalClipboard);
        }
        if (originalMousePos) {
          await mouse.setPosition(originalMousePos);
        }
      } catch (cleanupError) {
        console.error('⚠️  [NUTJS] Cleanup failed (print):', cleanupError);
      }

      throw error;
    }
  }

  /**
   * Analyze captured text and reconstruct spatial layout
   * @param {string} text - Captured text
   * @param {Object} context - Screen and window context
   * @returns {Promise<Object>} Analysis with reconstructed layout
   */
  async analyzeAndReconstruct(text, context) {
    console.log('🔍 [NUTJS] Analyzing text and reconstructing layout...');

    const { screenSize, windowInfo, tempFile } = context;
    
    // Check cache first
    const textHash = this.hashText(text);
    const cacheKey = `${windowInfo.url || windowInfo.app}-${textHash}`;
    
    if (this.cache.has(cacheKey)) {
      console.log('⚡ [NUTJS] Cache hit! Returning cached layout');
      const cached = this.cache.get(cacheKey);
      cached.fromCache = true;
      return cached;
    }
    
    // Split into words and analyze
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const totalWords = words.length;
    const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / totalWords;

    console.log(`📊 [NUTJS] Stats: ${totalWords} words, avg length ${avgWordLength.toFixed(1)}`);

    // Use inference engine for advanced layout detection
    const inferredLayout = this.inferenceEngine.inferLayout(text, {
      screenSize,
      url: windowInfo.url,
      app: windowInfo.app
    });

    console.log(`🧠 [NUTJS] Inference complete: ${inferredLayout.docType}, confidence: ${(inferredLayout.metadata.confidence * 100).toFixed(1)}%`);

    // Build spatial reconstruction with inferred structures
    const reconstruction = this.buildSpatialReconstructionV2(inferredLayout, {
      screenSize,
      totalWords,
      avgWordLength,
      windowInfo
    });

    const result = {
      success: true,
      method: 'nutjs-text-capture-v2',
      capturedText: text,
      tempFile,
      stats: {
        totalWords,
        avgWordLength,
        textLength: text.length,
        screenSize
      },
      docType: inferredLayout.docType,
      structures: inferredLayout.structures,
      zones: inferredLayout.zones,
      elements: inferredLayout.elements,
      reconstruction,
      confidence: inferredLayout.metadata.confidence,
      timestamp: Date.now(),
      fromCache: false
    };

    // Save analysis results to files for testing/debugging
    try {
      await fs.mkdir(this.testResultsDir, { recursive: true });
      const timestamp = Date.now();
      const baseName = `analysis-${timestamp}`;
      
      // Save complete analysis result as JSON
      const analysisFile = path.join(this.testResultsDir, `${baseName}.json`);
      const analysisData = {
        ...result,
        capturedText: result.capturedText.substring(0, 1000) + '...' // Truncate for file size
      };
      await fs.writeFile(analysisFile, JSON.stringify(analysisData, null, 2), 'utf-8');
      result.analysisFile = analysisFile;
      console.log('💾 [NUTJS] Analysis JSON saved to:', analysisFile);
      
      // Save HTML reconstruction as separate file
      const htmlFile = path.join(this.testResultsDir, `${baseName}.html`);
      await fs.writeFile(htmlFile, reconstruction.html, 'utf-8');
      result.htmlFile = htmlFile;
      console.log('💾 [NUTJS] HTML reconstruction saved to:', htmlFile);
      
    } catch (saveError) {
      console.warn('⚠️  [NUTJS] Failed to save analysis files:', saveError.message);
    }

    // Cache the result
    this.cache.set(cacheKey, result);
    console.log(`💾 [NUTJS] Cached layout for: ${cacheKey}`);

    // Clean old cache entries (keep last 50)
    if (this.cache.size > 50) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    return result;
  }

  /**
   * Hash text for caching
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
   * Infer UI elements from text patterns
   * @param {Array<string>} words - Array of words
   * @param {Object} screenSize - Screen dimensions
   * @returns {Promise<Array>} Inferred UI elements
   */
  async inferUIElements(words, screenSize) {
    const elements = [];
    let currentY = 50; // Start from top with padding

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const element = {
        text: word,
        type: 'text',
        position: { x: 0, y: currentY },
        dimensions: { width: 0, height: 0 },
        style: {}
      };

      // Pattern matching for element types
      if (this.isButton(word)) {
        element.type = 'button';
        element.style = {
          padding: '12px 24px',
          borderRadius: '6px',
          backgroundColor: '#007bff',
          color: 'white',
          fontWeight: 'bold'
        };
        element.dimensions = { width: 120, height: 40 };
      } 
      else if (this.isURL(word)) {
        element.type = 'link';
        element.style = {
          color: '#0066cc',
          textDecoration: 'underline'
        };
        element.dimensions = { width: word.length * 8, height: 20 };
      }
      else if (this.isEmail(word)) {
        element.type = 'email';
        element.style = {
          color: '#0066cc',
          textDecoration: 'underline'
        };
        element.dimensions = { width: word.length * 8, height: 20 };
      }
      else if (this.isPrice(word)) {
        element.type = 'price';
        element.style = {
          fontWeight: 'bold',
          fontSize: '18px',
          color: '#2d3748'
        };
        element.dimensions = { width: word.length * 10, height: 24 };
      }
      else if (this.isYouTubeCard(word, words, i)) {
        element.type = 'youtube-card';
        element.style = {
          display: 'flex',
          flexDirection: 'column',
          width: '320px',
          height: '240px',
          borderRadius: '12px',
          overflow: 'hidden'
        };
        element.dimensions = { width: 320, height: 240 };
        currentY += 250; // Extra spacing for cards
      }
      else {
        // Regular text
        element.dimensions = { width: word.length * 8, height: 16 };
      }

      // Calculate X position (simple left-to-right flow)
      const prevElement = elements[elements.length - 1];
      if (prevElement && prevElement.position.y === currentY) {
        element.position.x = prevElement.position.x + prevElement.dimensions.width + 10;
      } else {
        element.position.x = 20; // Left margin
      }

      // Wrap to next line if exceeds screen width
      if (element.position.x + element.dimensions.width > screenSize.width - 20) {
        currentY += 30;
        element.position.x = 20;
        element.position.y = currentY;
      }

      elements.push(element);
    }

    console.log(`🎨 [NUTJS] Inferred ${elements.length} UI elements`);
    return elements;
  }

  /**
   * Build spatial reconstruction HTML/CSS (V2 with inference engine)
   */
  buildSpatialReconstructionV2(inferredLayout, context) {
    const { screenSize, totalWords, windowInfo } = context;
    const { elements, zones, structures, docType } = inferredLayout;

    // Generate advanced HTML with zones and structures
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Screen Reconstruction - ${docType}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      width: ${screenSize.width}px;
      height: ${screenSize.height}px;
      position: relative;
      background: #ffffff;
      overflow: hidden;
    }
    
    /* Zone styles */
    ${zones.header ? `
    .zone-header {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: ${zones.header.height}px;
      background: #f8f9fa;
      border-bottom: 1px solid #dee2e6;
      z-index: 1000;
      display: flex;
      align-items: center;
      padding: 0 20px;
    }` : ''}
    
    ${zones.sidebar ? `
    .zone-sidebar {
      position: fixed;
      left: 0;
      top: ${zones.header ? zones.header.height : 0}px;
      width: ${zones.sidebar.width}px;
      height: calc(100vh - ${zones.header ? zones.header.height : 0}px);
      background: #f8f9fa;
      border-right: 1px solid #dee2e6;
      overflow-y: auto;
      padding: 20px;
    }` : ''}
    
    .zone-main {
      margin-left: ${zones.sidebar ? zones.sidebar.width : 0}px;
      margin-top: ${zones.header ? zones.header.height : 0}px;
      padding: 20px;
      min-height: calc(100vh - ${zones.header ? zones.header.height : 0}px);
    }
    
    /* Table styles */
    .table-container {
      width: 100%;
      overflow-x: auto;
      margin-bottom: 30px;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #dee2e6;
      background: white;
    }
    
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #dee2e6;
    }
    
    th {
      background: #f8f9fa;
      font-weight: 600;
      color: #495057;
    }
    
    td.number, td.price {
      text-align: right;
      font-family: 'SF Mono', Monaco, monospace;
    }
    
    /* Navbar styles */
    .navbar {
      display: flex;
      gap: 20px;
      align-items: center;
    }
    
    .navbar-item {
      color: #495057;
      text-decoration: none;
      padding: 8px 12px;
      border-radius: 4px;
      transition: background 0.2s;
    }
    
    .navbar-item:hover {
      background: rgba(0,0,0,0.05);
    }
    
    /* Text styles */
    .paragraph {
      line-height: 1.6;
      margin-bottom: 15px;
      color: #212529;
    }
    
    .header-1 {
      font-size: 32px;
      font-weight: bold;
      margin-bottom: 20px;
      color: #1a202c;
    }
    
    .header-2 {
      font-size: 24px;
      font-weight: bold;
      margin-bottom: 15px;
      color: #2d3748;
    }
    
    /* List styles */
    .list {
      margin-bottom: 20px;
      padding-left: 20px;
    }
    
    .list-item {
      margin-bottom: 8px;
      line-height: 1.5;
    }
    
    /* Grid styles */
    .grid {
      display: grid;
      gap: 20px;
      margin-bottom: 30px;
    }
    
    .grid-item {
      background: white;
      border: 1px solid #dee2e6;
      border-radius: 8px;
      padding: 15px;
      transition: box-shadow 0.2s;
    }
    
    .grid-item:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
  </style>
</head>
<body>
  ${zones.header ? '<div class="zone-header">' : ''}
  ${structures.navbars.filter(n => n.position === 'top').map(nav => `
    <nav class="navbar">
      ${nav.items.map(item => `<a href="#" class="navbar-item">${item}</a>`).join('')}
    </nav>
  `).join('')}
  ${zones.header ? '</div>' : ''}
  
  ${zones.sidebar ? '<div class="zone-sidebar">Sidebar Content</div>' : ''}
  
  <div class="zone-main">
    ${this.renderElements(elements, structures)}
  </div>
</body>
</html>
    `.trim();

    return {
      html,
      elementCount: elements.length,
      screenSize,
      docType,
      confidence: inferredLayout.metadata.confidence,
      metadata: {
        totalWords,
        windowInfo,
        structures: {
          tables: structures.tables.length,
          navbars: structures.navbars.length,
          headers: structures.headers.length,
          lists: structures.lists.length,
          grids: structures.grids.length
        },
        generatedAt: new Date().toISOString()
      }
    };
  }

  /**
   * Render elements as HTML
   */
  renderElements(elements, structures) {
    let html = '';

    // Render tables
    structures.tables.forEach(table => {
      html += '<div class="table-container"><table>';
      table.rows.forEach((row, idx) => {
        html += '<tr>';
        row.columns.forEach(col => {
          const tag = idx === 0 ? 'th' : 'td';
          html += `<${tag} class="${col.type}">${col.text}</${tag}>`;
        });
        html += '</tr>';
      });
      html += '</table></div>';
    });

    // Render headers
    structures.headers.forEach(header => {
      html += `<div class="header-${header.level}">${header.text}</div>`;
    });

    // Render lists
    structures.lists.forEach(list => {
      const listType = list.type === 'numbered' ? 'ol' : 'ul';
      html += `<${listType} class="list">`;
      list.items.forEach(item => {
        html += `<li class="list-item">${item.text}</li>`;
      });
      html += `</${listType}>`;
    });

    // Render grids
    structures.grids.forEach(grid => {
      html += `<div class="grid" style="grid-template-columns: repeat(${grid.columns}, 1fr);">`;
      grid.items.forEach(item => {
        html += `<div class="grid-item">
          <strong>${item.title}</strong>
          ${item.metadata ? `<div style="color: #6c757d; font-size: 14px; margin-top: 8px;">${item.metadata}</div>` : ''}
        </div>`;
      });
      html += '</div>';
    });

    // Group regular text elements into paragraphs for natural flow
    const regularTextElements = elements.filter(el => 
      el.type === 'text' || el.wordIndex !== undefined
    );

    if (regularTextElements.length > 0) {
      // Group words into sentences/paragraphs (simple heuristic)
      const paragraphs = [];
      let currentParagraph = [];
      
      regularTextElements.forEach((el, idx) => {
        currentParagraph.push(el.text);
        
        // End paragraph at sentence boundaries or every ~20 words
        const isSentenceEnd = el.text.includes('.') || el.text.includes('!') || el.text.includes('?');
        const isParagraphBreak = currentParagraph.length >= 20 || isSentenceEnd;
        
        if (isParagraphBreak || idx === regularTextElements.length - 1) {
          paragraphs.push(currentParagraph.join(' '));
          currentParagraph = [];
        }
      });

      // Render paragraphs with natural text flow
      paragraphs.forEach(paragraph => {
        html += `<p class="paragraph">${paragraph}</p>`;
      });
    }

    // Render interactive elements (buttons, links) with absolute positioning only if they have valid positions
    const interactiveElements = elements.filter(el => 
      ['button', 'link', 'email', 'price', 'youtube-card'].includes(el.type) &&
      el.position && 
      typeof el.position.x === 'number' && 
      typeof el.position.y === 'number' &&
      !isNaN(el.position.x) && 
      !isNaN(el.position.y)
    );

    interactiveElements.forEach(el => {
      const style = `
        position: absolute;
        left: ${el.position.x}px;
        top: ${el.position.y}px;
        ${el.style ? Object.entries(el.style).map(([k, v]) => `${k}: ${v};`).join(' ') : ''}
      `.trim();
      
      html += `<span style="${style}" data-type="${el.type}">${el.text}</span>`;
    });

    return html;
  }

  /**
   * Build spatial reconstruction HTML/CSS (legacy V1)
   */
  buildSpatialReconstruction(elements, context) {
    const { screenSize, totalWords, windowInfo } = context;

    // Generate HTML representation
    const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      width: ${screenSize.width}px;
      height: ${screenSize.height}px;
      position: relative;
    }
    .element {
      position: absolute;
      box-sizing: border-box;
    }
  </style>
</head>
<body>
  ${elements.map((el, idx) => `
    <div class="element" style="
      left: ${el.position.x}px;
      top: ${el.position.y}px;
      width: ${el.dimensions.width}px;
      height: ${el.dimensions.height}px;
      ${Object.entries(el.style).map(([k, v]) => `${k}: ${v};`).join(' ')}
    " data-type="${el.type}">
      ${el.text}
    </div>
  `).join('\n')}
</body>
</html>
    `.trim();

    return {
      html,
      elementCount: elements.length,
      screenSize,
      metadata: {
        totalWords,
        windowInfo,
        generatedAt: new Date().toISOString()
      }
    };
  }

  // Pattern detection helpers
  isButton(word) {
    const buttonWords = ['login', 'signup', 'submit', 'send', 'save', 'cancel', 'ok', 'yes', 'no', 'continue', 'next', 'back'];
    return buttonWords.includes(word.toLowerCase());
  }

  isURL(word) {
    return /^(https?:\/\/|www\.)[^\s]+/.test(word) || word.includes('.com') || word.includes('.org');
  }

  isEmail(word) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(word);
  }

  isPrice(word) {
    return /^\$?\d+(\.\d{2})?$/.test(word) || /^\d+(\.\d{2})?\s?(USD|EUR|GBP)$/.test(word);
  }

  isYouTubeCard(word, words, index) {
    // Check if near "youtube.com" and looks like a title
    const nearbyWords = words.slice(Math.max(0, index - 5), index + 5).join(' ').toLowerCase();
    return nearbyWords.includes('youtube') && word.length > 10;
  }

  /**
   * Cleanup temp files
   */
  async cleanup() {
    try {
      const files = await fs.readdir(this.tempDir);
      for (const file of files) {
        await fs.unlink(path.join(this.tempDir, file));
      }
      console.log('🧹 [NUTJS] Cleaned up temp files');
    } catch (error) {
      console.error('❌ [NUTJS] Cleanup failed:', error);
    }
  }
}

export default NutJsAnalyzer;
