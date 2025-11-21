/**
 * OCR-only endpoint
 * Fast, direct OCR without semantic analysis or OWLv2
 * Returns raw OCR results in 2-5s
 */

import express from 'express';
import screenshot from 'screenshot-desktop';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { getOCRService } from '../services/ocrService.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * POST /ocr.analyze
 * Fast OCR-only analysis
 * 
 * Request body:
 * {
 *   "screenshotPath": "optional/path/to/image.png"  // If not provided, captures screen
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "words": [{text, bbox, confidence}],
 *   "wordCount": 201,
 *   "imageSize": [2880, 1800],
 *   "source": "apple_vision",
 *   "elapsed": 2780,
 *   "screenshotTime": 300,
 *   "ocrTime": 2480
 * }
 */
router.post('/ocr.analyze', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { screenshotPath } = req.body;
    
    let imagePath = screenshotPath;
    let screenshotTime = 0;
    
    // Capture screenshot if not provided
    if (!imagePath) {
      const screenshotStart = Date.now();
      
      const tempDir = path.join(os.tmpdir(), 'thinkdrop-ocr');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      imagePath = path.join(tempDir, `screenshot-${Date.now()}.png`);
      
      logger.info('📸 Capturing screenshot for OCR...');
      await screenshot({ filename: imagePath });
      
      screenshotTime = Date.now() - screenshotStart;
      logger.info(`✅ Screenshot captured in ${screenshotTime}ms`);
    }
    
    // Run OCR only (no OWLv2, no semantic analysis)
    const ocrStart = Date.now();
    const ocrService = getOCRService();
    const ocrResult = await ocrService.analyze(imagePath);
    const ocrTime = Date.now() - ocrStart;
    
    const totalTime = Date.now() - startTime;
    
    logger.info(`✅ OCR-only analysis complete in ${totalTime}ms (screenshot: ${screenshotTime}ms, ocr: ${ocrTime}ms)`);
    
    // Return OCR results
    res.json({
      success: true,
      words: ocrResult.words,
      wordCount: ocrResult.words.length,
      imageSize: ocrResult.imageSize,
      source: ocrResult.source,
      elapsed: totalTime,
      screenshotTime,
      ocrTime,
      privacy: 'on_device'
    });
    
  } catch (error) {
    logger.error('❌ OCR analysis failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /ocr.extract
 * Extract text only (no bounding boxes)
 * Even faster response
 */
router.post('/ocr.extract', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { screenshotPath } = req.body;
    
    let imagePath = screenshotPath;
    let screenshotTime = 0;
    
    // Capture screenshot if not provided
    if (!imagePath) {
      const screenshotStart = Date.now();
      
      const tempDir = path.join(os.tmpdir(), 'thinkdrop-ocr');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      imagePath = path.join(tempDir, `screenshot-${Date.now()}.png`);
      
      await screenshot({ filename: imagePath });
      screenshotTime = Date.now() - screenshotStart;
    }
    
    // Run OCR
    const ocrStart = Date.now();
    const ocrService = getOCRService();
    const ocrResult = await ocrService.analyze(imagePath);
    const ocrTime = Date.now() - ocrStart;
    
    const totalTime = Date.now() - startTime;
    
    // Extract text only (no bounding boxes)
    const text = ocrResult.words.map(w => w.text).join(' ');
    const lines = groupWordsIntoLines(ocrResult.words);
    
    res.json({
      success: true,
      text,
      lines,
      wordCount: ocrResult.words.length,
      source: ocrResult.source,
      elapsed: totalTime,
      screenshotTime,
      ocrTime
    });
    
  } catch (error) {
    logger.error('❌ OCR text extraction failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Group words into lines based on Y coordinates
 */
function groupWordsIntoLines(words) {
  if (!words || words.length === 0) return [];
  
  // Sort by Y coordinate
  const sorted = [...words].sort((a, b) => a.bbox[1] - b.bbox[1]);
  
  const lines = [];
  let currentLine = [sorted[0]];
  let currentY = sorted[0].bbox[1];
  
  for (let i = 1; i < sorted.length; i++) {
    const word = sorted[i];
    const yDiff = Math.abs(word.bbox[1] - currentY);
    
    // If Y difference is small, same line
    if (yDiff < 20) {
      currentLine.push(word);
    } else {
      // New line
      lines.push(currentLine.map(w => w.text).join(' '));
      currentLine = [word];
      currentY = word.bbox[1];
    }
  }
  
  // Add last line
  if (currentLine.length > 0) {
    lines.push(currentLine.map(w => w.text).join(' '));
  }
  
  return lines;
}

export default router;
