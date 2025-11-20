/**
 * Screen Change Detector
 * 
 * Detects when screen content changes (scrolling, typing, window switching, etc.)
 * to trigger smart captures only when needed.
 * 
 * Methods:
 * 1. Pixel Difference: Compare screenshots pixel-by-pixel
 * 2. Hash Comparison: Fast perceptual hashing
 * 3. Region Sampling: Check key screen regions for changes
 */

import { screen } from '@nut-tree-fork/nut-js';
import sharp from 'sharp';
import crypto from 'crypto';
import logger from './logger.js';

export class ScreenChangeDetector {
  constructor(options = {}) {
    this.config = {
      // Threshold for considering screen "changed" (0.0 - 1.0)
      changeThreshold: options.changeThreshold || 0.05, // 5% pixels changed
      
      // Downscale factor for faster comparison (1 = full res, 4 = 1/4 size)
      downscaleFactor: options.downscaleFactor || 4,
      
      // Sample regions instead of full screen (faster)
      useSampling: options.useSampling !== false,
      sampleRegions: options.sampleRegions || 16, // 4x4 grid
      
      // Hash-based detection (fastest, less accurate)
      useHashing: options.useHashing || false,
      
      // Debounce rapid changes (ms)
      debounceMs: options.debounceMs || 100,
    };
    
    // State
    this.lastScreenshot = null;
    this.lastHash = null;
    this.lastChangeTime = null;
    this.changeCount = 0;
    this.stats = {
      totalComparisons: 0,
      changesDetected: 0,
      averageChangePercent: 0,
      averageComparisonTime: 0,
    };
    
    logger.info('🔍 ScreenChangeDetector initialized', this.config);
  }
  
  /**
   * Check if screen has changed since last check
   * @returns {Promise<{changed: boolean, changePercent: number, method: string}>}
   */
  async hasChanged() {
    const startTime = Date.now();
    this.stats.totalComparisons++;
    
    try {
      // Capture current screenshot
      const currentScreenshot = await this._captureForComparison();
      
      // First capture - always consider changed
      if (!this.lastScreenshot) {
        this.lastScreenshot = currentScreenshot;
        this.lastHash = this._computeHash(currentScreenshot.buffer);
        this.lastChangeTime = Date.now();
        this.stats.changesDetected++;
        
        return {
          changed: true,
          changePercent: 1.0,
          method: 'first-capture',
          comparisonTime: Date.now() - startTime,
        };
      }
      
      // Debounce rapid changes
      if (this.config.debounceMs > 0) {
        const timeSinceLastChange = Date.now() - this.lastChangeTime;
        if (timeSinceLastChange < this.config.debounceMs) {
          return {
            changed: false,
            changePercent: 0,
            method: 'debounced',
            comparisonTime: Date.now() - startTime,
          };
        }
      }
      
      let result;
      
      // Method 1: Hash-based (fastest, ~5-10ms)
      if (this.config.useHashing) {
        result = await this._compareByHash(currentScreenshot);
      }
      // Method 2: Sampling (fast, ~20-50ms)
      else if (this.config.useSampling) {
        result = await this._compareBySampling(currentScreenshot);
      }
      // Method 3: Full pixel diff (accurate, ~100-200ms)
      else {
        result = await this._compareByPixels(currentScreenshot);
      }
      
      // Update state if changed
      if (result.changed) {
        this.lastScreenshot = currentScreenshot;
        this.lastHash = this._computeHash(currentScreenshot.buffer);
        this.lastChangeTime = Date.now();
        this.changeCount++;
        this.stats.changesDetected++;
        
        // Update average change percent
        this.stats.averageChangePercent = 
          (this.stats.averageChangePercent * (this.stats.changesDetected - 1) + result.changePercent) / 
          this.stats.changesDetected;
      }
      
      // Update average comparison time
      const comparisonTime = Date.now() - startTime;
      this.stats.averageComparisonTime = 
        (this.stats.averageComparisonTime * (this.stats.totalComparisons - 1) + comparisonTime) / 
        this.stats.totalComparisons;
      
      return {
        ...result,
        comparisonTime,
      };
      
    } catch (error) {
      logger.error('❌ Screen change detection failed:', error);
      return {
        changed: true, // Assume changed on error to avoid missing updates
        changePercent: 1.0,
        method: 'error-fallback',
        error: error.message,
      };
    }
  }
  
  /**
   * Reset detector state (useful after manual capture)
   */
  reset() {
    this.lastScreenshot = null;
    this.lastHash = null;
    this.lastChangeTime = null;
    logger.debug('🔄 ScreenChangeDetector reset');
  }
  
  /**
   * Get detection statistics
   */
  getStats() {
    return {
      ...this.stats,
      changeRate: this.stats.totalComparisons > 0 
        ? (this.stats.changesDetected / this.stats.totalComparisons * 100).toFixed(1) + '%'
        : 'N/A',
    };
  }
  
  /**
   * Capture screenshot optimized for comparison
   * @private
   */
  async _captureForComparison() {
    const screenshot = await screen.grab();
    
    // Validate screenshot (nut.js returns object with 'data' property)
    if (!screenshot || !screenshot.data) {
      throw new Error('screen.grab() returned invalid data: ' + JSON.stringify({
        hasScreenshot: !!screenshot,
        hasData: screenshot?.data ? true : false,
        width: screenshot?.width,
        height: screenshot?.height,
        keys: screenshot ? Object.keys(screenshot) : []
      }));
    }
    
    // Convert nut.js data to Buffer
    const imageBuffer = Buffer.from(screenshot.data);
    
    // Downscale for faster comparison
    if (this.config.downscaleFactor > 1) {
      const width = Math.floor(screenshot.width / this.config.downscaleFactor);
      const height = Math.floor(screenshot.height / this.config.downscaleFactor);
      
      const buffer = await sharp(imageBuffer, {
        raw: {
          width: screenshot.width,
          height: screenshot.height,
          channels: 4, // RGBA
        }
      })
      .resize(width, height, { kernel: 'nearest' })
      .raw()
      .toBuffer();
      
      return {
        buffer,
        width,
        height,
      };
    }
    
    // No downscaling - return original buffer
    return {
      buffer: imageBuffer,
      width: screenshot.width,
      height: screenshot.height,
    };
  }
  
  /**
   * Compare by perceptual hash (fastest)
   * @private
   */
  async _compareByHash(currentScreenshot) {
    const currentHash = this._computeHash(currentScreenshot.buffer);
    const changed = currentHash !== this.lastHash;
    
    return {
      changed,
      changePercent: changed ? 1.0 : 0.0,
      method: 'hash',
    };
  }
  
  /**
   * Compare by sampling key regions (fast)
   * @private
   */
  async _compareBySampling(currentScreenshot) {
    const { buffer: currentBuffer, width, height } = currentScreenshot;
    const { buffer: lastBuffer } = this.lastScreenshot;
    
    const regionsPerSide = Math.sqrt(this.config.sampleRegions);
    const regionWidth = Math.floor(width / regionsPerSide);
    const regionHeight = Math.floor(height / regionsPerSide);
    
    let changedRegions = 0;
    
    // Sample regions in a grid
    for (let row = 0; row < regionsPerSide; row++) {
      for (let col = 0; col < regionsPerSide; col++) {
        const x = col * regionWidth;
        const y = row * regionHeight;
        
        // Sample center pixel of region
        const centerX = x + Math.floor(regionWidth / 2);
        const centerY = y + Math.floor(regionHeight / 2);
        const pixelIndex = (centerY * width + centerX) * 4;
        
        // Compare RGB values (ignore alpha)
        const currentR = currentBuffer[pixelIndex];
        const currentG = currentBuffer[pixelIndex + 1];
        const currentB = currentBuffer[pixelIndex + 2];
        
        const lastR = lastBuffer[pixelIndex];
        const lastG = lastBuffer[pixelIndex + 1];
        const lastB = lastBuffer[pixelIndex + 2];
        
        // Check if region changed (threshold: 10 per channel)
        const diff = Math.abs(currentR - lastR) + Math.abs(currentG - lastG) + Math.abs(currentB - lastB);
        if (diff > 30) {
          changedRegions++;
        }
      }
    }
    
    const changePercent = changedRegions / this.config.sampleRegions;
    const changed = changePercent >= this.config.changeThreshold;
    
    return {
      changed,
      changePercent,
      method: 'sampling',
    };
  }
  
  /**
   * Compare by full pixel difference (most accurate)
   * @private
   */
  async _compareByPixels(currentScreenshot) {
    const { buffer: currentBuffer, width, height } = currentScreenshot;
    const { buffer: lastBuffer } = this.lastScreenshot;
    
    const totalPixels = width * height;
    let changedPixels = 0;
    
    // Compare every pixel (RGBA)
    for (let i = 0; i < currentBuffer.length; i += 4) {
      const currentR = currentBuffer[i];
      const currentG = currentBuffer[i + 1];
      const currentB = currentBuffer[i + 2];
      
      const lastR = lastBuffer[i];
      const lastG = lastBuffer[i + 1];
      const lastB = lastBuffer[i + 2];
      
      // Check if pixel changed (threshold: 10 per channel)
      const diff = Math.abs(currentR - lastR) + Math.abs(currentG - lastG) + Math.abs(currentB - lastB);
      if (diff > 30) {
        changedPixels++;
      }
    }
    
    const changePercent = changedPixels / totalPixels;
    const changed = changePercent >= this.config.changeThreshold;
    
    return {
      changed,
      changePercent,
      method: 'pixels',
    };
  }
  
  /**
   * Compute perceptual hash of screenshot
   * @private
   */
  _computeHash(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex');
  }
}

// Singleton instance
let detectorInstance = null;

/**
 * Get or create the ScreenChangeDetector singleton
 */
export function getScreenChangeDetector(options = {}) {
  if (!detectorInstance) {
    detectorInstance = new ScreenChangeDetector(options);
  }
  return detectorInstance;
}

/**
 * Reset the singleton (useful for testing)
 */
export function resetScreenChangeDetector() {
  detectorInstance = null;
}
