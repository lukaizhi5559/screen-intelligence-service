/**
 * Computer Vision-based UI Element Detection
 * Uses OpenCV-style contour detection + heuristics to find UI elements
 * This is a lightweight alternative to ML models for basic UI detection
 */

import sharp from 'sharp';
import fs from 'fs';

/**
 * CV-based UI element detector
 * Finds rectangles, buttons, text boxes, and panels using image processing
 */
class CVDetectionService {
  constructor() {
    this.isInitialized = false;
    console.log('🎨 [CV-DETECT] Computer Vision detector initialized');
  }

  async initialize() {
    this.isInitialized = true;
    console.log('✅ [CV-DETECT] Ready for detection');
  }

  /**
   * Detect UI elements using computer vision techniques
   * @param {string|Buffer} imagePath - Screenshot path or buffer
   * @returns {Promise<Array>} Detected UI elements with bounding boxes
   */
  async detectElements(imagePath) {
    try {
      console.log('🔍 [CV-DETECT] Analyzing screenshot...');
      
      // Load image
      const imageBuffer = typeof imagePath === 'string' 
        ? fs.readFileSync(imagePath)
        : imagePath;

      const image = sharp(imageBuffer);
      const metadata = await image.metadata();
      const { width, height } = metadata;

      console.log(`📐 [CV-DETECT] Image size: ${width}x${height}`);

      // Convert to grayscale and get pixel data
      const { data, info } = await image
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Detect edges using simple gradient detection
      const edges = this.detectEdges(data, info.width, info.height);
      
      // Find contours (connected edge regions)
      const contours = this.findContours(edges, info.width, info.height);
      
      // Filter and classify contours as UI elements
      const elements = this.classifyContours(contours, width, height);

      console.log(`✅ [CV-DETECT] Found ${elements.length} UI elements`);
      
      return elements;
      
    } catch (error) {
      console.error('❌ [CV-DETECT] Detection failed:', error);
      return [];
    }
  }

  /**
   * Simple edge detection using Sobel-like gradient
   * @private
   */
  detectEdges(data, width, height) {
    const edges = new Uint8Array(width * height);
    const threshold = 30; // Edge strength threshold

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        
        // Sobel X gradient
        const gx = 
          -data[(y-1)*width + (x-1)] + data[(y-1)*width + (x+1)] +
          -2*data[y*width + (x-1)] + 2*data[y*width + (x+1)] +
          -data[(y+1)*width + (x-1)] + data[(y+1)*width + (x+1)];
        
        // Sobel Y gradient
        const gy =
          -data[(y-1)*width + (x-1)] - 2*data[(y-1)*width + x] - data[(y-1)*width + (x+1)] +
          data[(y+1)*width + (x-1)] + 2*data[(y+1)*width + x] + data[(y+1)*width + (x+1)];
        
        // Gradient magnitude
        const magnitude = Math.sqrt(gx*gx + gy*gy);
        edges[idx] = magnitude > threshold ? 255 : 0;
      }
    }

    return edges;
  }

  /**
   * Find rectangular contours in edge image
   * @private
   */
  findContours(edges, width, height) {
    const contours = [];
    const visited = new Uint8Array(width * height);
    const minArea = 100; // Minimum area for a UI element
    const maxArea = (width * height) * 0.8; // Maximum 80% of screen

    // Scan for edge regions
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        
        if (edges[idx] === 255 && !visited[idx]) {
          // Found an edge pixel, trace the region
          const region = this.traceRegion(edges, visited, x, y, width, height);
          
          if (region.pixels.length >= minArea && region.pixels.length <= maxArea) {
            // Calculate bounding box
            const bbox = this.getBoundingBox(region.pixels);
            const area = (bbox.x2 - bbox.x1) * (bbox.y2 - bbox.y1);
            
            if (area >= minArea && area <= maxArea) {
              contours.push({
                bbox: [bbox.x1, bbox.y1, bbox.x2, bbox.y2],
                area,
                pixels: region.pixels.length
              });
            }
          }
        }
      }
    }

    return contours;
  }

  /**
   * Trace a connected region using flood fill
   * @private
   */
  traceRegion(edges, visited, startX, startY, width, height) {
    const pixels = [];
    const stack = [[startX, startY]];
    const maxPixels = 10000; // Prevent infinite loops

    while (stack.length > 0 && pixels.length < maxPixels) {
      const [x, y] = stack.pop();
      const idx = y * width + x;

      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (visited[idx] || edges[idx] !== 255) continue;

      visited[idx] = 1;
      pixels.push([x, y]);

      // Check 8-connected neighbors
      stack.push([x+1, y], [x-1, y], [x, y+1], [x, y-1]);
      stack.push([x+1, y+1], [x-1, y-1], [x+1, y-1], [x-1, y+1]);
    }

    return { pixels };
  }

  /**
   * Get bounding box from pixel list
   * @private
   */
  getBoundingBox(pixels) {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const [x, y] of pixels) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    return { x1: minX, y1: minY, x2: maxX, y2: maxY };
  }

  /**
   * Classify contours as UI element types based on heuristics
   * @private
   */
  classifyContours(contours, screenWidth, screenHeight) {
    const elements = [];

    for (const contour of contours) {
      const [x1, y1, x2, y2] = contour.bbox;
      const width = x2 - x1;
      const height = y2 - y1;
      const aspectRatio = width / height;
      const area = width * height;
      const screenArea = screenWidth * screenHeight;
      const areaRatio = area / screenArea;

      // Classify based on shape and size
      let type = 'unknown';
      let confidence = 0.5;

      // Button: small, roughly square or wide rectangle
      if (area < screenArea * 0.05 && aspectRatio > 0.5 && aspectRatio < 4) {
        type = 'button';
        confidence = 0.7;
      }
      // Text box: wide, short rectangle
      else if (aspectRatio > 3 && height < screenHeight * 0.1) {
        type = 'input';
        confidence = 0.65;
      }
      // Icon: very small, square
      else if (area < screenArea * 0.01 && aspectRatio > 0.8 && aspectRatio < 1.2) {
        type = 'icon';
        confidence = 0.6;
      }
      // Panel/Card: medium to large rectangle
      else if (areaRatio > 0.05 && areaRatio < 0.5) {
        type = 'panel';
        confidence = 0.55;
      }
      // Image: medium size, any aspect ratio
      else if (areaRatio > 0.02 && areaRatio < 0.3) {
        type = 'image';
        confidence = 0.5;
      }

      elements.push({
        id: this.generateId(),
        type,
        bbox: contour.bbox,
        confidence,
        clickable: ['button', 'icon', 'input'].includes(type),
        description: `${type} element`,
        source: 'cv-detection',
        area,
        aspectRatio: aspectRatio.toFixed(2)
      });
    }

    // Sort by confidence
    elements.sort((a, b) => b.confidence - a.confidence);

    return elements;
  }

  /**
   * Generate unique ID
   * @private
   */
  generateId() {
    return `cv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async cleanup() {
    console.log('🧹 [CV-DETECT] Cleaned up');
  }
}

// Singleton instance
let instance = null;

export function getCVDetectionService() {
  if (!instance) {
    instance = new CVDetectionService();
  }
  return instance;
}

export default CVDetectionService;
