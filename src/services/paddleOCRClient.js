/**
 * PaddleOCR Client
 * Calls the Python PaddleOCR sidecar service
 */

import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import logger from '../utils/logger.js';

class PaddleOCRClient {
  constructor() {
    this.baseUrl = process.env.PADDLEOCR_URL || 'http://127.0.0.1:3009';
    this.timeout = 30000; // 30 second timeout
    this.isAvailable = false;
    
    logger.info('🐼 PaddleOCR Client initialized', { baseUrl: this.baseUrl });
  }

  /**
   * Check if PaddleOCR service is available
   */
  async checkHealth() {
    try {
      const response = await axios.get(`${this.baseUrl}/health`, {
        timeout: 5000
      });
      this.isAvailable = response.data.ready === true;
      return this.isAvailable;
    } catch (error) {
      this.isAvailable = false;
      logger.warn('⚠️  PaddleOCR service not available:', error.message);
      return false;
    }
  }

  /**
   * Analyze image with PaddleOCR
   * @param {string} imagePath - Path to image file
   * @returns {Promise<Object>} OCR results with bounding boxes
   */
  async analyze(imagePath) {
    try {
      // Check if service is available
      if (!this.isAvailable) {
        await this.checkHealth();
        if (!this.isAvailable) {
          throw new Error('PaddleOCR service not available');
        }
      }

      logger.info('🔍 [PADDLE-OCR] Analyzing image:', imagePath);
      const startTime = Date.now();

      // Create form data
      const formData = new FormData();
      formData.append('file', fs.createReadStream(imagePath));

      // Call PaddleOCR service
      const response = await axios.post(
        `${this.baseUrl}/ocr.analyze`,
        formData,
        {
          headers: formData.getHeaders(),
          timeout: this.timeout,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );

      const elapsed = Date.now() - startTime;
      const { words, image_size } = response.data;

      logger.info(`✅ [PADDLE-OCR] Extracted ${words.length} words in ${elapsed}ms`);

      // Convert to format compatible with existing code
      return {
        success: true,
        words: words.map(w => ({
          text: w.text,
          bbox: w.bbox, // [x1, y1, x2, y2]
          confidence: w.confidence
        })),
        imageSize: image_size,
        elapsed,
        source: 'paddleocr'
      };

    } catch (error) {
      logger.error('❌ [PADDLE-OCR] Analysis failed:', error.message);
      
      // Mark service as unavailable on error
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        this.isAvailable = false;
      }
      
      throw error;
    }
  }

  /**
   * Analyze specific region of image
   * @param {string} imagePath - Path to image file
   * @param {Array<number>} region - [x1, y1, x2, y2]
   * @returns {Promise<Object>} OCR results for region
   */
  async analyzeRegion(imagePath, region) {
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(imagePath));
      formData.append('region', JSON.stringify(region));

      const response = await axios.post(
        `${this.baseUrl}/ocr.region`,
        formData,
        {
          headers: formData.getHeaders(),
          timeout: this.timeout
        }
      );

      return response.data;

    } catch (error) {
      logger.error('❌ [PADDLE-OCR] Region analysis failed:', error.message);
      throw error;
    }
  }
}

// Singleton instance
let instance = null;

export function getPaddleOCRClient() {
  if (!instance) {
    instance = new PaddleOCRClient();
  }
  return instance;
}

export default PaddleOCRClient;
