/**
 * OCR with Bounding Boxes using Tesseract.js
 * Extracts text AND spatial coordinates for non-browser apps
 * 
 * This gives us spatial awareness for code editors, terminals, etc.
 * where we don't have DOM structure like browsers
 */

import logger from './logger.js';

/**
 * Extract text with bounding boxes from screenshot
 * Returns elements with text content AND coordinates
 * 
 * @param {Buffer} screenshotBuffer - Screenshot image buffer
 * @returns {Promise<Array>} Array of elements with text and bounds
 */
export async function extractTextWithBounds(screenshotBuffer) {
  try {
    // Dynamically import Tesseract.js
    const { createWorker } = await import('tesseract.js');
    
    logger.info('Starting OCR with bounding box extraction...');
    const startTime = Date.now();
    
    // Create Tesseract worker with explicit configuration
    const worker = await createWorker('eng', 1, {
      logger: () => {} // Suppress Tesseract internal logs
    });
    
    // Perform OCR and get hierarchical structure (blocks -> paragraphs -> lines -> words)
    // CRITICAL: Must explicitly request 'blocks' output format to get bounding boxes
    const result = await worker.recognize(screenshotBuffer, {
      rotateAuto: true,
    }, { blocks: true });
    
    // Validate result structure
    if (!result || !result.data) {
      logger.error('Invalid Tesseract result structure', { hasResult: !!result });
      await worker.terminate();
      return { words: [], lines: [], fullText: '' };
    }
    
    const data = result.data;
    
    // Parse words from data object - navigate through blocks -> paragraphs -> lines -> words
    const elements = [];
    const lines = [];
    
    logger.info('Tesseract OCR data structure', {
      hasBlocks: !!data.blocks,
      blocksLength: data.blocks?.length || 0,
      hasText: !!data.text,
      textLength: data.text?.length || 0,
      confidence: data.confidence
    });
    
    // Terminate worker
    await worker.terminate();
    
    // Navigate through the hierarchy: blocks -> paragraphs -> lines -> words
    if (data.blocks && Array.isArray(data.blocks) && data.blocks.length > 0) {
      logger.info('Processing blocks structure', { blockCount: data.blocks.length });
      
      for (const block of data.blocks) {
        if (!block || !block.paragraphs) continue;
        
        for (const paragraph of block.paragraphs) {
          if (!paragraph.lines) continue;
          
          for (const line of paragraph.lines) {
            // Add line with bounding box
            if (line.text && line.text.trim().length > 0 && line.confidence > 50) {
              lines.push({
                role: 'text_line',
                label: line.text,
                value: line.text,
                bounds: {
                  x: line.bbox.x0,
                  y: line.bbox.y0,
                  width: line.bbox.x1 - line.bbox.x0,
                  height: line.bbox.y1 - line.bbox.y0
                },
                confidence: line.confidence / 100,
                source: 'ocr_with_bounds',
                actions: []
              });
            }
            
            // Extract words from line
            if (line.words && Array.isArray(line.words)) {
              for (const word of line.words) {
                if (word.text && word.text.trim().length > 0 && word.confidence > 50) {
                  elements.push({
                    role: 'text',
                    label: word.text,
                    value: word.text,
                    bounds: {
                      x: word.bbox.x0,
                      y: word.bbox.y0,
                      width: word.bbox.x1 - word.bbox.x0,
                      height: word.bbox.y1 - word.bbox.y0
                    },
                    confidence: word.confidence / 100,
                    source: 'ocr_with_bounds',
                    actions: []
                  });
                }
              }
            }
          }
        }
      }
    }
    
    // If no structured data was extracted, log warning
    if (elements.length === 0 && lines.length === 0) {
      logger.warn('No structured OCR data extracted - blocks array was empty', {
        hasText: !!data.text,
        textLength: data.text?.length || 0
      });
      
      // As a fallback, return the full text as a single element
      // This at least gives us the content, even without precise bounds
      if (data.text && data.text.trim().length > 0) {
        logger.info('Using fallback: full text as single element');
        elements.push({
          role: 'full_text_content',
          label: 'Screen Text Content',
          value: data.text.trim(),
          bounds: null, // No precise bounds available
          confidence: data.confidence / 100,
          source: 'ocr_fallback',
          actions: []
        });
      }
    }
    
    const duration = Date.now() - startTime;
    logger.info('OCR with bounds extraction complete', { 
      words: elements.length,
      lines: lines.length,
      durationMs: duration 
    });
    
    // Return both words and lines for flexibility
    return {
      words: elements,
      lines: lines,
      fullText: data.text.trim()
    };
    
  } catch (error) {
    logger.error('OCR with bounds extraction failed', { 
      error: error.message,
      stack: error.stack,
      errorType: error.constructor.name
    });
    return {
      words: [],
      lines: [],
      fullText: ''
    };
  }
}

/**
 * Extract text with bounding boxes and add spatial metadata
 * Adds region labels like "upper left", "lower right", etc.
 * 
 * @param {Buffer} screenshotBuffer - Screenshot image buffer
 * @param {Object} windowBounds - Window bounds { x, y, width, height }
 * @returns {Promise<Array>} Array of elements with text, bounds, and regions
 */
export async function extractTextWithSpatialContext(screenshotBuffer, windowBounds) {
  const { words, lines, fullText } = await extractTextWithBounds(screenshotBuffer);
  
  // Add spatial region labels based on position
  const addRegionLabel = (element) => {
    // Skip elements without bounds (e.g., fallback full text)
    if (!element.bounds) {
      return {
        ...element,
        region: null
      };
    }
    
    const centerX = element.bounds.x + element.bounds.width / 2;
    const centerY = element.bounds.y + element.bounds.height / 2;
    
    const width = windowBounds?.width || 1920;
    const height = windowBounds?.height || 1080;
    
    // Determine horizontal region
    let horizontal = 'center';
    if (centerX < width * 0.33) horizontal = 'left';
    else if (centerX > width * 0.67) horizontal = 'right';
    
    // Determine vertical region
    let vertical = 'middle';
    if (centerY < height * 0.33) vertical = 'upper';
    else if (centerY > height * 0.67) vertical = 'lower';
    
    return {
      ...element,
      region: `${vertical} ${horizontal}`.trim()
    };
  };
  
  return {
    words: words.map(addRegionLabel),
    lines: lines.map(addRegionLabel),
    fullText
  };
}
