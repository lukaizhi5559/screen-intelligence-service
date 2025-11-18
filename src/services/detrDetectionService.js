/**
 * DETR Object Detection Service
 * Uses DETR (DEtection TRansformer) for UI element detection
 * Based on ScreenAI research - detects buttons, inputs, icons, etc.
 */

import { pipeline } from '@xenova/transformers';
import sharp from 'sharp';
import fs from 'fs';

/**
 * UI Element types that DETR can detect
 */
const UI_ELEMENT_TYPES = {
  BUTTON: 'button',
  INPUT: 'input',
  TEXT: 'text',
  IMAGE: 'image',
  ICON: 'icon',
  PICTOGRAM: 'pictogram',
  CHECKBOX: 'checkbox',
  RADIO: 'radio',
  DROPDOWN: 'dropdown',
  LINK: 'link',
  DIALOG: 'dialog',
  MODAL: 'modal',
  PANEL: 'panel',
  LIST: 'list',
  LIST_ITEM: 'list_item',
  TAB: 'tab',
  MENU: 'menu',
  MENU_ITEM: 'menu_item',
  CONTAINER: 'container',
  SECTION: 'section'
};

/**
 * COCO labels to UI element type mapping
 * DETR is trained on COCO, we map to UI-specific types
 */
const COCO_TO_UI_MAPPING = {
  // Direct mappings
  'person': 'image',
  'book': 'text',
  'cell phone': 'image',
  'laptop': 'image',
  'keyboard': 'image',
  'mouse': 'icon',
  'remote': 'button',
  'tv': 'image',
  'bottle': 'image',
  'cup': 'image',
  'fork': 'icon',
  'knife': 'icon',
  'spoon': 'icon',
  'bowl': 'image',
  
  // UI-specific heuristics (based on size and position)
  // Will be enhanced with fine-tuned model later
};

class DETRDetectionService {
  constructor() {
    this.detector = null;
    this.modelName = 'Xenova/detr-resnet-50'; // Base DETR model
    this.isInitialized = false;
    this.initPromise = null;
    
    // Detection thresholds
    // NOTE: UI screenshots have lower confidence than natural images (COCO dataset)
    // DETR was trained on COCO, so UI elements may score 0.3-0.6 instead of 0.7+
    this.confidenceThreshold = 0.3; // Minimum confidence for detection (lowered for UI)
    this.iouThreshold = 0.5; // IoU threshold for NMS
  }

  /**
   * Initialize the DETR model
   */
  async initialize() {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        console.log('🎯 Initializing DETR object detection model...');
        console.log(`   Model: ${this.modelName}`);
        
        // Load object detection pipeline
        this.detector = await pipeline('object-detection', this.modelName, {
          quantized: true, // Use quantized model for speed
        });

        this.isInitialized = true;
        console.log('✅ DETR model initialized');
      } catch (error) {
        console.error('❌ Failed to initialize DETR model:', error);
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Detect UI elements in an image
   * @param {string|Buffer} imagePath - Path to image or image buffer
   * @param {Object} options - Detection options
   * @returns {Promise<Array>} Detected elements with bounding boxes and types
   */
  async detectElements(imagePath, options = {}) {
    await this.initialize();

    try {
      console.log('🔍 Running DETR detection...');
      console.log(`📁 Image path: ${imagePath}`);
      
      // Validate image exists
      if (!fs.existsSync(imagePath)) {
        console.error(`❌ Image file not found: ${imagePath}`);
        return [];
      }
      
      // Load and preprocess image to get dimensions
      const imageBuffer = await this._loadImage(imagePath);
      const { data, info } = await sharp(imageBuffer)
        .raw()
        .toBuffer({ resolveWithObject: true });
      
      console.log(`📐 Image dimensions: ${info.width}x${info.height}, channels: ${info.channels}`);

      // Run detection with LOWER threshold to see raw results
      console.log('🤖 Running DETR model inference...');
      const detections = await this.detector(imagePath, {
        threshold: 0.1, // Use very low threshold to see all detections
        percentage: false, // Return absolute coordinates
      });
      
      console.log(`✅ DETR model returned ${detections.length} raw detections`);

      console.log(`🔍 DETR raw detections: ${detections.length} objects (threshold: 0.1)`);
      
      // Log top 10 detections with scores
      if (detections.length > 0) {
        console.log('📊 Top detections:');
        detections.slice(0, 10).forEach((det, i) => {
          console.log(`   ${i+1}. ${det.label} (score: ${det.score.toFixed(3)}) - box: [${det.box.xmin.toFixed(0)}, ${det.box.ymin.toFixed(0)}, ${det.box.xmax.toFixed(0)}, ${det.box.ymax.toFixed(0)}]`);
        });
      } else {
        console.warn('⚠️  No detections at all - model may not be working correctly');
      }

      console.log(`✅ DETR detected ${detections.length} objects (before filtering)`);

      // Post-process detections
      const elements = this._postProcessDetections(detections, info.width, info.height, options);

      return elements;
    } catch (error) {
      console.error('❌ DETR detection failed:', error);
      return []; // Return empty array on failure (fallback to OCR)
    }
  }

  /**
   * Detect UI elements and merge with OCR results
   * @param {string|Buffer} imagePath - Image path or buffer
   * @param {Array} ocrWords - OCR word results
   * @param {Object} options - Detection options
   * @returns {Promise<Array>} Combined detections
   */
  async detectAndMerge(imagePath, ocrWords = [], options = {}) {
    await this.initialize();

    try {
      // Run DETR detection
      const detrElements = await this.detectElements(imagePath, options);

      // Merge with OCR results
      const mergedElements = this._mergeWithOCR(detrElements, ocrWords);

      console.log(`✅ Merged: ${mergedElements.length} total elements`);
      return mergedElements;
    } catch (error) {
      console.error('❌ Detection and merge failed:', error);
      // Fallback to OCR-only
      return this._ocrToElements(ocrWords);
    }
  }

  /**
   * Classify UI element type based on visual features
   * @param {Object} detection - DETR detection result
   * @param {number} imageWidth - Image width
   * @param {number} imageHeight - Image height
   * @returns {string} UI element type
   */
  _classifyUIElement(detection, imageWidth, imageHeight) {
    const { box, label, score } = detection;
    const x1 = box.xmin;
    const y1 = box.ymin;
    const x2 = box.xmax;
    const y2 = box.ymax;
    
    const width = x2 - x1;
    const height = y2 - y1;
    const area = width * height;
    const aspectRatio = width / height;

    // Check COCO label mapping first
    if (COCO_TO_UI_MAPPING[label]) {
      return COCO_TO_UI_MAPPING[label];
    }

    // Heuristic classification based on size and aspect ratio
    // These are rough heuristics - will be improved with fine-tuned model

    // Very small elements (< 1% of screen) - likely icons
    if (area < (imageWidth * imageHeight * 0.01)) {
      return UI_ELEMENT_TYPES.ICON;
    }

    // Wide, short elements - likely buttons or inputs
    if (aspectRatio > 2 && height < 100) {
      // Check if it's near text (likely button)
      return UI_ELEMENT_TYPES.BUTTON;
    }

    // Tall, narrow elements - likely scrollbars or sidebars
    if (aspectRatio < 0.5 && width < 100) {
      return UI_ELEMENT_TYPES.CONTAINER;
    }

    // Square-ish small elements - likely checkboxes or radio buttons
    if (aspectRatio > 0.8 && aspectRatio < 1.2 && width < 50 && height < 50) {
      return UI_ELEMENT_TYPES.CHECKBOX;
    }

    // Large elements - likely panels or containers
    if (area > (imageWidth * imageHeight * 0.2)) {
      return UI_ELEMENT_TYPES.PANEL;
    }

    // Default to generic types based on COCO label
    if (label === 'person' || label.includes('image')) {
      return UI_ELEMENT_TYPES.IMAGE;
    }

    // Default fallback
    return UI_ELEMENT_TYPES.CONTAINER;
  }

  /**
   * Post-process DETR detections
   * @private
   */
  _postProcessDetections(detections, imageWidth, imageHeight, options) {
    const elements = [];
    let filteredCount = 0;

    for (const detection of detections) {
      const { box, label, score } = detection;

      // Skip low-confidence detections
      if (score < this.confidenceThreshold) {
        filteredCount++;
        continue;
      }

      // Convert box format [x1, y1, x2, y2]
      const bbox = [
        Math.round(box.xmin),
        Math.round(box.ymin),
        Math.round(box.xmax),
        Math.round(box.ymax)
      ];

      // Classify UI element type
      const uiType = this._classifyUIElement(detection, imageWidth, imageHeight);

      elements.push({
        type: uiType,
        bbox: bbox,
        confidence: score,
        cocoLabel: label,
        source: 'detr',
        text: '', // Will be filled by OCR merge
        metadata: {
          detectionConfidence: score,
          originalLabel: label
        }
      });
    }

    console.log(`🔍 Post-processing: ${filteredCount} filtered (< ${this.confidenceThreshold}), ${elements.length} kept`);

    // Apply Non-Maximum Suppression (NMS) to remove overlapping boxes
    const nmsElements = this._applyNMS(elements, this.iouThreshold);
    
    console.log(`🔍 After NMS: ${nmsElements.length} final elements`);

    return nmsElements;
  }

  /**
   * Merge DETR detections with OCR results
   * @private
   */
  _mergeWithOCR(detrElements, ocrWords) {
    const merged = [];

    // Add all DETR elements
    for (const element of detrElements) {
      // Find OCR words that overlap with this element
      const overlappingWords = ocrWords.filter(word => 
        this._calculateIOU(element.bbox, word.bbox || [word.x0, word.y0, word.x1, word.y1]) > 0.3
      );

      // Combine text from overlapping words
      if (overlappingWords.length > 0) {
        element.text = overlappingWords.map(w => w.text).join(' ');
        element.ocrConfidence = overlappingWords.reduce((sum, w) => sum + (w.confidence || 0), 0) / overlappingWords.length;
      }

      merged.push(element);
    }

    // Add OCR words that don't overlap with any DETR detection (pure text elements)
    for (const word of ocrWords) {
      const wordBox = word.bbox || [word.x0, word.y0, word.x1, word.y1];
      const overlapsWithDETR = detrElements.some(elem => 
        this._calculateIOU(elem.bbox, wordBox) > 0.3
      );

      if (!overlapsWithDETR) {
        merged.push({
          type: UI_ELEMENT_TYPES.TEXT,
          bbox: wordBox,
          confidence: word.confidence || 0.9,
          text: word.text,
          source: 'ocr',
          metadata: {
            ocrConfidence: word.confidence
          }
        });
      }
    }

    return merged;
  }

  /**
   * Convert OCR-only results to elements (fallback)
   * @private
   */
  _ocrToElements(ocrWords) {
    return ocrWords.map(word => ({
      type: UI_ELEMENT_TYPES.TEXT,
      bbox: word.bbox || [word.x0, word.y0, word.x1, word.y1],
      confidence: word.confidence || 0.9,
      text: word.text,
      source: 'ocr',
      metadata: {
        ocrConfidence: word.confidence
      }
    }));
  }

  /**
   * Apply Non-Maximum Suppression
   * @private
   */
  _applyNMS(elements, iouThreshold) {
    // Sort by confidence descending
    const sorted = [...elements].sort((a, b) => b.confidence - a.confidence);
    const keep = [];

    while (sorted.length > 0) {
      const current = sorted.shift();
      keep.push(current);

      // Remove elements with high IoU overlap
      const remaining = sorted.filter(elem => 
        this._calculateIOU(current.bbox, elem.bbox) < iouThreshold
      );

      sorted.length = 0;
      sorted.push(...remaining);
    }

    return keep;
  }

  /**
   * Calculate Intersection over Union (IoU)
   * @private
   */
  _calculateIOU(box1, box2) {
    const [x1_1, y1_1, x2_1, y2_1] = box1;
    const [x1_2, y1_2, x2_2, y2_2] = box2;

    // Calculate intersection
    const x1_i = Math.max(x1_1, x1_2);
    const y1_i = Math.max(y1_1, y1_2);
    const x2_i = Math.min(x2_1, x2_2);
    const y2_i = Math.min(y2_1, y2_2);

    if (x2_i < x1_i || y2_i < y1_i) {
      return 0; // No intersection
    }

    const intersectionArea = (x2_i - x1_i) * (y2_i - y1_i);

    // Calculate union
    const area1 = (x2_1 - x1_1) * (y2_1 - y1_1);
    const area2 = (x2_2 - x1_2) * (y2_2 - y1_2);
    const unionArea = area1 + area2 - intersectionArea;

    return intersectionArea / unionArea;
  }

  /**
   * Load image from path or buffer
   * @private
   */
  async _loadImage(imagePath) {
    if (Buffer.isBuffer(imagePath)) {
      return imagePath;
    }
    
    return fs.readFileSync(imagePath);
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.detector) {
      this.detector = null;
      this.isInitialized = false;
      console.log('🧹 DETR detector cleaned up');
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton DETR detection service instance
 */
function getDETRDetectionService() {
  if (!instance) {
    instance = new DETRDetectionService();
  }
  return instance;
}

export {
  DETRDetectionService,
  getDETRDetectionService,
  UI_ELEMENT_TYPES
};
