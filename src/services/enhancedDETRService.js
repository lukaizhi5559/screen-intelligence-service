/**
 * Enhanced DETR Service with Icon Classification
 * Combines DETR object detection with CLIP icon classification
 * Based on ScreenAI architecture
 */

import { getDETRDetectionService } from './detrDetectionService.js';
import { getIconClassificationService } from './iconClassificationService.js';

class EnhancedDETRService {
  constructor() {
    this.detrService = getDETRDetectionService();
    this.iconClassifier = getIconClassificationService();
    this.isInitialized = false;
    
    // Icon detection settings
    this.iconSizeThreshold = 0.01; // Elements < 1% of screen are likely icons
    this.iconAspectRatioRange = [0.5, 2.0]; // Square-ish elements
  }

  /**
   * Initialize both DETR and icon classifier
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      console.log('🚀 Initializing enhanced DETR service...');
      
      // Initialize DETR
      await this.detrService.initialize();
      
      // Initialize icon classifier
      await this.iconClassifier.initialize();
      
      this.isInitialized = true;
      console.log('✅ Enhanced DETR service initialized');
    } catch (error) {
      console.error('❌ Failed to initialize enhanced DETR:', error);
      throw error;
    }
  }

  /**
   * Detect elements with icon classification
   * @param {string|Buffer} imagePath - Image path or buffer
   * @param {Array} ocrWords - OCR word results
   * @param {Object} options - Detection options
   * @returns {Promise<Array>} Elements with icon classifications
   */
  async detectAndClassify(imagePath, ocrWords = [], options = {}) {
    await this.initialize();

    try {
      console.log('🎯 Running enhanced detection (DETR + Icon Classification)...');

      // 1. Run DETR detection and merge with OCR
      const elements = await this.detrService.detectAndMerge(imagePath, ocrWords, options);

      // 2. Identify potential icons
      const iconElements = this._identifyIconElements(elements, options);

      console.log(`🎨 Found ${iconElements.length} potential icons`);

      // 3. Classify icons
      if (iconElements.length > 0 && options.classifyIcons !== false) {
        await this._classifyIcons(imagePath, iconElements);
      }

      console.log(`✅ Enhanced detection complete: ${elements.length} elements`);
      return elements;
    } catch (error) {
      console.error('❌ Enhanced detection failed:', error);
      // Fallback to basic DETR
      return await this.detrService.detectAndMerge(imagePath, ocrWords, options);
    }
  }

  /**
   * Identify which elements are likely icons
   * @private
   */
  _identifyIconElements(elements, options) {
    const iconElements = [];

    for (const element of elements) {
      // Skip if already classified as icon
      if (element.type === 'icon' || element.type === 'pictogram') {
        iconElements.push(element);
        continue;
      }

      // Check if element matches icon characteristics
      if (this._isLikelyIcon(element, options)) {
        element.type = 'icon'; // Update type
        iconElements.push(element);
      }
    }

    return iconElements;
  }

  /**
   * Check if element is likely an icon
   * @private
   */
  _isLikelyIcon(element, options) {
    const [x1, y1, x2, y2] = element.bbox;
    const width = x2 - x1;
    const height = y2 - y1;
    const area = width * height;
    const aspectRatio = width / height;

    // Get screen dimensions from options or assume default
    const screenWidth = options.screenWidth || 1920;
    const screenHeight = options.screenHeight || 1080;
    const screenArea = screenWidth * screenHeight;

    // Criteria for icons:
    // 1. Small size (< 1% of screen)
    const isSmall = area < (screenArea * this.iconSizeThreshold);

    // 2. Square-ish aspect ratio
    const isSquareish = aspectRatio >= this.iconAspectRatioRange[0] && 
                        aspectRatio <= this.iconAspectRatioRange[1];

    // 3. No text or very short text (icons usually have no text or 1-2 chars)
    const hasMinimalText = !element.text || element.text.length <= 2;

    // 4. Small absolute size (< 100px in any dimension)
    const isAbsolutelySmall = width < 100 && height < 100;

    return (isSmall && isSquareish) || (isAbsolutelySmall && hasMinimalText);
  }

  /**
   * Classify icons using CLIP
   * @private
   */
  async _classifyIcons(imagePath, iconElements) {
    console.log(`🎨 Classifying ${iconElements.length} icons...`);

    for (const element of iconElements) {
      try {
        // Classify icon from bounding box
        const classification = await this.iconClassifier.classifyIconFromBbox(
          imagePath,
          element.bbox
        );

        // Add icon classification to element
        element.iconType = classification.iconType;
        element.iconConfidence = classification.confidence;
        element.iconCategory = classification.category;
        element.iconDescription = classification.description;
        element.iconAlternatives = classification.alternatives;

        // Update metadata
        element.metadata = element.metadata || {};
        element.metadata.iconClassification = classification;

        console.log(`  ✅ ${element.iconType} (${(classification.confidence * 100).toFixed(0)}%)`);
      } catch (error) {
        console.error(`  ❌ Failed to classify icon:`, error.message);
        element.iconType = 'unknown';
        element.iconConfidence = 0;
      }
    }
  }

  /**
   * Get statistics about detected icons
   * @param {Array} elements - Detected elements
   * @returns {Object} Icon statistics
   */
  getIconStats(elements) {
    const icons = elements.filter(e => e.type === 'icon' || e.type === 'pictogram');
    
    const iconTypes = {};
    const iconCategories = {};
    
    for (const icon of icons) {
      if (icon.iconType) {
        iconTypes[icon.iconType] = (iconTypes[icon.iconType] || 0) + 1;
      }
      if (icon.iconCategory) {
        iconCategories[icon.iconCategory] = (iconCategories[icon.iconCategory] || 0) + 1;
      }
    }

    return {
      totalIcons: icons.length,
      iconTypes: iconTypes,
      iconCategories: iconCategories,
      averageConfidence: icons.reduce((sum, i) => sum + (i.iconConfidence || 0), 0) / Math.max(icons.length, 1)
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    await this.detrService.cleanup();
    await this.iconClassifier.cleanup();
    this.isInitialized = false;
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton enhanced DETR service instance
 */
function getEnhancedDETRService() {
  if (!instance) {
    instance = new EnhancedDETRService();
  }
  return instance;
}

export {
  EnhancedDETRService,
  getEnhancedDETRService
};
