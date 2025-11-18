/**
 * YOLOv8 UI Element Detection Service
 * Uses YOLOv8 ONNX model for UI element detection with bounding boxes
 * Replaces DETR (which was trained on COCO objects, not UI elements)
 */

import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * YOLOv8 Detection Service
 * Detects UI elements (buttons, inputs, icons, etc.) in screenshots
 */
class YOLOv8DetectionService {
  constructor() {
    this.session = null;
    this.isInitialized = false;
    this.modelPath = path.join(__dirname, '../../models/yolov8-ui.onnx');
    
    // UI element class names (will be loaded from model metadata or config)
    this.classNames = [
      'button', 'input', 'text', 'icon', 'checkbox', 'radio',
      'dropdown', 'link', 'image', 'label', 'menu', 'toolbar',
      'dialog', 'panel', 'card', 'list', 'table', 'form'
    ];
    
    // Detection parameters
    this.inputSize = 640; // YOLOv8 default input size
    this.confidenceThreshold = 0.25;
    this.iouThreshold = 0.45;
  }

  /**
   * Initialize the YOLOv8 model
   */
  async initialize() {
    if (this.isInitialized) {
      return;
    }

    try {
      console.log('🔧 [YOLOv8] Initializing ONNX Runtime session...');
      
      // Check if model file exists
      if (!fs.existsSync(this.modelPath)) {
        console.warn(`⚠️  [YOLOv8] Model not found at ${this.modelPath}`);
        console.warn('   Please download a YOLOv8-UI ONNX model and place it in the models/ directory');
        console.warn('   For now, detection will be skipped');
        return;
      }

      // Create ONNX Runtime session
      this.session = await ort.InferenceSession.create(this.modelPath, {
        executionProviders: ['cpu'], // Can use 'cuda' if GPU available
        graphOptimizationLevel: 'all'
      });

      this.isInitialized = true;
      console.log('✅ [YOLOv8] Model initialized successfully');
      console.log(`   Input size: ${this.inputSize}x${this.inputSize}`);
      console.log(`   Classes: ${this.classNames.length}`);
      
    } catch (error) {
      console.error('❌ [YOLOv8] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Detect UI elements in an image
   * @param {string|Buffer} imagePath - Path to image or image buffer
   * @param {Object} options - Detection options
   * @returns {Promise<Array>} Detected elements with bounding boxes
   */
  async detectElements(imagePath, options = {}) {
    if (!this.isInitialized) {
      console.warn('⚠️  [YOLOv8] Model not initialized, skipping detection');
      return [];
    }

    try {
      console.log('🔍 [YOLOv8] Running UI element detection...');
      console.log(`📁 Image path: ${imagePath}`);
      
      // Validate image exists
      if (typeof imagePath === 'string' && !fs.existsSync(imagePath)) {
        console.error(`❌ Image file not found: ${imagePath}`);
        return [];
      }

      // Preprocess image
      const { input, originalWidth, originalHeight } = await this.preprocessImage(imagePath);
      
      console.log(`📐 Image dimensions: ${originalWidth}x${originalHeight}`);
      console.log(`🔄 Resized to: ${this.inputSize}x${this.inputSize}`);

      // Run inference
      console.log('🤖 Running YOLOv8 inference...');
      const startTime = Date.now();
      
      const feeds = { images: input };
      const results = await this.session.run(feeds);
      
      const inferenceTime = Date.now() - startTime;
      console.log(`⚡ Inference completed in ${inferenceTime}ms`);

      // Post-process results
      const detections = this.postProcess(
        results.output0.data,
        originalWidth,
        originalHeight,
        options
      );

      console.log(`✅ Detected ${detections.length} UI elements`);
      
      // Log top detections
      if (detections.length > 0) {
        console.log('📊 Top detections:');
        detections.slice(0, 10).forEach((det, i) => {
          console.log(`   ${i+1}. ${det.type} (${(det.confidence * 100).toFixed(1)}%) at [${det.bbox.map(v => Math.round(v)).join(', ')}]`);
        });
      }

      return detections;
      
    } catch (error) {
      console.error('❌ [YOLOv8] Detection failed:', error);
      return [];
    }
  }

  /**
   * Preprocess image for YOLOv8 input
   * @private
   */
  async preprocessImage(imagePath) {
    // Load and resize image
    const imageBuffer = typeof imagePath === 'string' 
      ? fs.readFileSync(imagePath)
      : imagePath;

    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;

    // Resize to model input size (letterbox padding)
    const { data, info } = await image
      .resize(this.inputSize, this.inputSize, {
        fit: 'contain',
        background: { r: 114, g: 114, b: 114 }
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Convert to float32 and normalize to [0, 1]
    const float32Data = new Float32Array(3 * this.inputSize * this.inputSize);
    
    for (let i = 0; i < this.inputSize * this.inputSize; i++) {
      float32Data[i] = data[i * 3] / 255.0; // R
      float32Data[this.inputSize * this.inputSize + i] = data[i * 3 + 1] / 255.0; // G
      float32Data[2 * this.inputSize * this.inputSize + i] = data[i * 3 + 2] / 255.0; // B
    }

    // Create tensor
    const input = new ort.Tensor('float32', float32Data, [1, 3, this.inputSize, this.inputSize]);

    return { input, originalWidth, originalHeight };
  }

  /**
   * Post-process YOLOv8 output
   * @private
   */
  postProcess(output, originalWidth, originalHeight, options = {}) {
    const confidenceThreshold = options.confidenceThreshold || this.confidenceThreshold;
    const iouThreshold = options.iouThreshold || this.iouThreshold;

    // YOLOv8 output format: [1, 84, 8400] for 80 classes
    // [x, y, w, h, class1_conf, class2_conf, ..., classN_conf]
    const numClasses = this.classNames.length;
    const numDetections = 8400; // YOLOv8 default

    const boxes = [];
    
    // Parse detections
    for (let i = 0; i < numDetections; i++) {
      // Get box coordinates (center format)
      const x = output[i];
      const y = output[numDetections + i];
      const w = output[2 * numDetections + i];
      const h = output[3 * numDetections + i];

      // Get class scores
      let maxScore = 0;
      let maxClass = 0;
      
      for (let c = 0; c < numClasses; c++) {
        const score = output[(4 + c) * numDetections + i];
        if (score > maxScore) {
          maxScore = score;
          maxClass = c;
        }
      }

      // Filter by confidence
      if (maxScore < confidenceThreshold) {
        continue;
      }

      // Convert to corner format and scale to original image size
      const scaleX = originalWidth / this.inputSize;
      const scaleY = originalHeight / this.inputSize;

      const x1 = (x - w / 2) * scaleX;
      const y1 = (y - h / 2) * scaleY;
      const x2 = (x + w / 2) * scaleX;
      const y2 = (y + h / 2) * scaleY;

      boxes.push({
        bbox: [x1, y1, x2, y2],
        type: this.classNames[maxClass] || 'unknown',
        confidence: maxScore,
        classId: maxClass
      });
    }

    // Apply Non-Maximum Suppression (NMS)
    const filteredBoxes = this.nonMaxSuppression(boxes, iouThreshold);

    // Convert to final format
    return filteredBoxes.map(box => ({
      id: this.generateId(),
      type: box.type,
      bbox: box.bbox,
      confidence: box.confidence,
      clickable: this.isClickableType(box.type),
      description: `${box.type} element`,
      source: 'yolov8'
    }));
  }

  /**
   * Non-Maximum Suppression to remove overlapping boxes
   * @private
   */
  nonMaxSuppression(boxes, iouThreshold) {
    // Sort by confidence (descending)
    boxes.sort((a, b) => b.confidence - a.confidence);

    const keep = [];
    const suppressed = new Set();

    for (let i = 0; i < boxes.length; i++) {
      if (suppressed.has(i)) continue;

      keep.push(boxes[i]);

      for (let j = i + 1; j < boxes.length; j++) {
        if (suppressed.has(j)) continue;

        const iou = this.calculateIoU(boxes[i].bbox, boxes[j].bbox);
        if (iou > iouThreshold) {
          suppressed.add(j);
        }
      }
    }

    return keep;
  }

  /**
   * Calculate Intersection over Union (IoU)
   * @private
   */
  calculateIoU(box1, box2) {
    const [x1_1, y1_1, x2_1, y2_1] = box1;
    const [x1_2, y1_2, x2_2, y2_2] = box2;

    const x1 = Math.max(x1_1, x1_2);
    const y1 = Math.max(y1_1, y1_2);
    const x2 = Math.min(x2_1, x2_2);
    const y2 = Math.min(y2_1, y2_2);

    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const area1 = (x2_1 - x1_1) * (y2_1 - y1_1);
    const area2 = (x2_2 - x1_2) * (y2_2 - y1_2);
    const union = area1 + area2 - intersection;

    return intersection / union;
  }

  /**
   * Check if element type is typically clickable
   * @private
   */
  isClickableType(type) {
    const clickableTypes = ['button', 'link', 'checkbox', 'radio', 'dropdown', 'menu', 'icon'];
    return clickableTypes.includes(type.toLowerCase());
  }

  /**
   * Generate unique ID
   * @private
   */
  generateId() {
    return `yolo-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.session) {
      this.session = null;
      this.isInitialized = false;
      console.log('🧹 [YOLOv8] Cleaned up');
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton YOLOv8 detection service instance
 */
export function getYOLOv8DetectionService() {
  if (!instance) {
    instance = new YOLOv8DetectionService();
  }
  return instance;
}

export default YOLOv8DetectionService;
