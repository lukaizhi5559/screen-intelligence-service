/**
 * OCR Service
 * Privacy-first OCR with platform-specific implementations
 * - macOS: Apple Vision Framework (2-3s, on-device)
 * - Windows: Windows.Media.Ocr (1-3s, on-device)
 * - Linux: Tesseract.js (8-15s, on-device)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { createWorker } from 'tesseract.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import logger from '../utils/logger.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class OCRService {
  constructor() {
    this.platform = process.platform;
    this.privacyMode = process.env.OCR_PRIVACY_MODE || 'strict'; // strict, balanced, cloud
    this.cache = new Map();
    this.maxCacheSize = 100; // Max cached results
    
    // Path to platform-specific binaries
    this.appleVisionBinary = path.join(__dirname, '../../bin/apple-vision-ocr');
    this.windowsOCRBinary = path.join(__dirname, '../../bin/windows-ocr.exe');
    
    // Check which native OCR engines are available
    this.appleVisionAvailable = this.platform === 'darwin' && 
                                fs.existsSync(this.appleVisionBinary);
    this.windowsOCRAvailable = this.platform === 'win32' && 
                               fs.existsSync(this.windowsOCRBinary);
    
    // Force engine selection via environment variable
    // OCR_ENGINE=tesseract - Force Tesseract (cross-platform fallback)
    // OCR_ENGINE=apple_vision - Force Apple Vision (macOS only)
    // OCR_ENGINE=windows_ocr - Force Windows OCR (Windows only)
    // OCR_ENGINE=auto (default) - Auto-detect based on platform
    this.forcedEngine = process.env.OCR_ENGINE || 'auto';
    
    logger.info('🔍 OCR Service initialized', { 
      platform: this.platform,
      privacyMode: this.privacyMode,
      appleVisionAvailable: this.appleVisionAvailable,
      windowsOCRAvailable: this.windowsOCRAvailable,
      forcedEngine: this.forcedEngine
    });
  }

  /**
   * Analyze image with platform-appropriate OCR
   * @param {string} imagePath - Path to image file
   * @returns {Promise<Object>} OCR results with bounding boxes
   */
  async analyze(imagePath) {
    const startTime = Date.now();
    
    try {
      // Check cache
      const cacheKey = await this.getCacheKey(imagePath);
      if (this.cache.has(cacheKey)) {
        logger.info('✅ OCR cache hit');
        return this.cache.get(cacheKey);
      }

      let result;
      
      // Check for forced engine
      if (this.forcedEngine === 'tesseract') {
        // Force Tesseract (cross-platform fallback)
        logger.info('🔧 Forced engine: Tesseract');
        result = await this.analyzeWithTesseract(imagePath);
      } else if (this.forcedEngine === 'apple_vision') {
        // Force Apple Vision (macOS only)
        if (!this.appleVisionAvailable) {
          throw new Error('Apple Vision not available on this platform');
        }
        logger.info('🔧 Forced engine: Apple Vision');
        result = await this.analyzeWithAppleVision(imagePath);
      } else if (this.forcedEngine === 'windows_ocr') {
        // Force Windows OCR (Windows only)
        if (!this.windowsOCRAvailable) {
          throw new Error('Windows OCR not available on this platform');
        }
        logger.info('🔧 Forced engine: Windows OCR');
        result = await this.analyzeWithWindowsOCR(imagePath);
      } else {
        // Auto-detect based on platform
        if (this.appleVisionAvailable) {
          // macOS: Use Apple Vision
          try {
            result = await this.analyzeWithAppleVision(imagePath);
          } catch (error) {
            logger.warn('⚠️  Apple Vision failed, falling back to Tesseract:', error.message);
            result = await this.analyzeWithTesseract(imagePath);
          }
        } else if (this.windowsOCRAvailable) {
          // Windows: Use Windows.Media.Ocr
          try {
            result = await this.analyzeWithWindowsOCR(imagePath);
          } catch (error) {
            logger.warn('⚠️  Windows OCR failed, falling back to Tesseract:', error.message);
            result = await this.analyzeWithTesseract(imagePath);
          }
        } else {
          // Linux or fallback: Use Tesseract
          result = await this.analyzeWithTesseract(imagePath);
        }
      }

      // Add elapsed time
      result.elapsed = Date.now() - startTime;
      result.privacy = 'on_device';

      // Cache result (with size limit)
      this.cacheResult(cacheKey, result);
      
      return result;
      
    } catch (error) {
      logger.error('❌ OCR analysis failed:', error.message);
      throw error;
    }
  }

  /**
   * Windows: Windows.Media.Ocr via C# binary
   * @param {string} imagePath - Path to image file
   * @returns {Promise<Object>} OCR results
   */
  async analyzeWithWindowsOCR(imagePath) {
    const startTime = Date.now();
    
    try {
      logger.info('🪟 [WINDOWS-OCR] Analyzing image:', imagePath);
      
      // Call C# binary
      const { stdout, stderr } = await execAsync(
        `"${this.windowsOCRBinary}" "${imagePath}"`,
        { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer for large outputs
      );
      
      if (stderr) {
        logger.warn('Windows OCR stderr:', stderr);
      }
      
      // Parse JSON output
      const result = JSON.parse(stdout);
      
      if (result.error) {
        throw new Error(result.error);
      }
      
      const elapsed = Date.now() - startTime;
      logger.info(`✅ [WINDOWS-OCR] Extracted ${result.words.length} words in ${elapsed}ms`);
      
      return {
        success: true,
        words: result.words,
        imageSize: result.imageSize,
        source: 'windows_ocr'
      };
      
    } catch (error) {
      logger.error('❌ [WINDOWS-OCR] Analysis failed:', error.message);
      throw error;
    }
  }

  /**
   * macOS: Apple Vision Framework via Swift binary
   * @param {string} imagePath - Path to image file
   * @returns {Promise<Object>} OCR results
   */
  async analyzeWithAppleVision(imagePath) {
    const startTime = Date.now();
    
    try {
      logger.info('🍎 [APPLE-VISION] Analyzing image:', imagePath);
      
      // Call Swift binary
      const { stdout, stderr } = await execAsync(
        `"${this.appleVisionBinary}" "${imagePath}"`,
        { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer for large outputs
      );
      
      if (stderr) {
        logger.warn('Apple Vision stderr:', stderr);
      }
      
      // Parse JSON output
      const result = JSON.parse(stdout);
      
      if (result.error) {
        throw new Error(result.error);
      }
      
      const elapsed = Date.now() - startTime;
      logger.info(`✅ [APPLE-VISION] Extracted ${result.words.length} words in ${elapsed}ms`);
      
      return {
        success: true,
        words: result.words,
        imageSize: result.imageSize,
        source: 'apple_vision'
      };
      
    } catch (error) {
      logger.error('❌ [APPLE-VISION] Analysis failed:', error.message);
      throw error;
    }
  }

  /**
   * Windows/Linux: Tesseract.js with optimizations
   * @param {string} imagePath - Path to image file
   * @returns {Promise<Object>} OCR results
   */
  async analyzeWithTesseract(imagePath) {
    const startTime = Date.now();
    
    try {
      logger.info('📝 [TESSERACT] Analyzing image:', imagePath);
      
      // Create worker
      const worker = await createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            logger.debug(`Tesseract progress: ${Math.round(m.progress * 100)}%`);
          }
        }
      });
      
      // Recognize text
      const { data } = await worker.recognize(imagePath);
      
      // Terminate worker
      await worker.terminate();
      
      // Convert to our format
      const words = (data.words || [])
        .filter(w => w && w.confidence > 0) // Filter out null/undefined and low-confidence results
        .map(w => ({
          text: w.text,
          bbox: [
            w.bbox.x0,
            w.bbox.y0,
            w.bbox.x1,
            w.bbox.y1
          ],
          confidence: w.confidence / 100 // Normalize to 0-1
        }));
      
      const elapsed = Date.now() - startTime;
      logger.info(`✅ [TESSERACT] Extracted ${words.length} words in ${elapsed}ms`);
      
      return {
        success: true,
        words,
        imageSize: [data.imageWidth || 0, data.imageHeight || 0],
        source: 'tesseract'
      };
      
    } catch (error) {
      logger.error('❌ [TESSERACT] Analysis failed:', error.message);
      throw error;
    }
  }

  /**
   * Generate cache key from image content
   * @param {string} imagePath - Path to image file
   * @returns {Promise<string>} MD5 hash of image
   */
  async getCacheKey(imagePath) {
    try {
      const buffer = fs.readFileSync(imagePath);
      return crypto.createHash('md5').update(buffer).digest('hex');
    } catch (error) {
      // If file read fails, use path + mtime as fallback
      const stats = fs.statSync(imagePath);
      return crypto.createHash('md5')
        .update(`${imagePath}-${stats.mtimeMs}`)
        .digest('hex');
    }
  }

  /**
   * Cache OCR result with size limit
   * @param {string} key - Cache key
   * @param {Object} result - OCR result to cache
   */
  cacheResult(key, result) {
    // Remove oldest entry if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, result);
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    logger.info('🧹 OCR cache cleared');
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      hitRate: this.cacheHits / (this.cacheHits + this.cacheMisses) || 0
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get OCR service singleton
 * @returns {OCRService} OCR service instance
 */
export function getOCRService() {
  if (!instance) {
    instance = new OCRService();
  }
  return instance;
}

export default OCRService;
