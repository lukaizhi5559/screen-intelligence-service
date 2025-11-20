/**
 * OWLv2 Zero-Shot Object Detection Service
 * Uses Google's OWLv2 for open-vocabulary UI element detection
 * No training required - detects elements based on text descriptions
 */

import { pipeline, env } from '@xenova/transformers';
import path from 'path';
import os from 'os';

// Configure transformers cache
env.cacheDir = path.join(os.homedir(), '.cache', 'transformers');

/**
 * OWLv2-based UI element detector
 * Detects UI elements using zero-shot object detection with text prompts
 */
class OWLv2DetectionService {
  constructor() {
    this.detector = null;
    this.isInitialized = false;
    
    // UI element classes to detect (optimized for performance)
    // Reduced from 40+ to 20 most important types
    this.uiClasses = [
      // Primary interactive elements
      'button',
      'icon',
      
      // Input elements
      'input field',
      'search box',
      
      // Selection elements
      'checkbox',
      'dropdown menu',
      
      // Navigation
      'menu',
      'toolbar',
      'tab',
      
      // Containers
      'panel',
      'card',
      'dialog box',
      
      // Content
      'image',
      'logo',
      
      // Notifications
      'notification',
      'alert',
      
      // Other
      'link',
      'heading'
    ];
    
    console.log('🦉 [OWLv2] Detection service created');
  }

  /**
   * Initialize OWLv2 model
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('✅ [OWLv2] Already initialized');
      return;
    }

    try {
      console.log('🔧 [OWLv2] Loading model (this may take a minute on first run)...');
      console.log('📦 [OWLv2] Model will be cached at:', env.cacheDir);
      
      // Load OWLv2 model for zero-shot object detection
      this.detector = await pipeline(
        'zero-shot-object-detection',
        'Xenova/owlv2-base-patch16-ensemble',
        {
          quantized: true, // Use quantized model for faster inference
        }
      );
      
      this.isInitialized = true;
      console.log('✅ [OWLv2] Model loaded successfully');
      console.log(`📋 [OWLv2] Detecting ${this.uiClasses.length} UI element types`);
      
    } catch (error) {
      console.error('❌ [OWLv2] Failed to initialize:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Detect UI elements in screenshot using zero-shot detection
   * @param {string} imagePath - Path to screenshot
   * @param {Object} options - Detection options
   * @returns {Promise<Array>} Detected UI elements with bounding boxes
   */
  async detectElements(imagePath, options = {}) {
    if (!this.isInitialized) {
      console.warn('⚠️  [OWLv2] Model not initialized, skipping detection');
      return [];
    }

    try {
      const {
        confidenceThreshold = 0.25, // Increased to reduce false positives
        customLabels = null,
        maxDetections = 30 // Reduced from 100 - most screens have 10-30 key elements
      } = options;

      const labels = customLabels || this.uiClasses;
      
      console.log(`🔍 [OWLv2] Detecting UI elements in: ${imagePath}`);
      console.log(`📋 [OWLv2] Using ${labels.length} candidate labels`);
      console.log(`🎯 [OWLv2] Confidence threshold: ${confidenceThreshold}`);

      const startTime = Date.now();

      // Run zero-shot object detection
      const detections = await this.detector(imagePath, labels, {
        threshold: confidenceThreshold,
        topk: maxDetections
      });

      const elapsed = Date.now() - startTime;
      console.log(`⏱️  [OWLv2] Detection completed in ${elapsed}ms`);
      console.log(`✅ [OWLv2] Found ${detections.length} UI elements`);

      // Convert to standard format
      const elements = detections.map((detection, idx) => {
        const bbox = this.normalizeBbox(detection.box);
        const elementType = this.mapLabelToType(detection.label);
        
        return {
          id: this.generateId(idx),
          type: elementType,
          label: detection.label,
          bbox: bbox,
          confidence: detection.score,
          clickable: this.isClickableType(elementType),
          description: `${detection.label} (${(detection.score * 100).toFixed(1)}%)`,
          source: 'owlv2',
          area: (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        };
      });

      // Sort by confidence
      elements.sort((a, b) => b.confidence - a.confidence);

      // Log top detections
      if (elements.length > 0) {
        console.log('📊 [OWLv2] Top detections:');
        elements.slice(0, 5).forEach((el, i) => {
          console.log(`   ${i + 1}. ${el.label} (${(el.confidence * 100).toFixed(1)}%) at [${el.bbox.map(v => Math.round(v)).join(', ')}]`);
        });
      }

      return elements;

    } catch (error) {
      console.error('❌ [OWLv2] Detection failed:', error);
      return [];
    }
  }

  /**
   * Normalize bounding box format
   * OWLv2 returns {xmin, ymin, xmax, ymax}, we need [x1, y1, x2, y2]
   * @private
   */
  normalizeBbox(box) {
    return [
      Math.round(box.xmin),
      Math.round(box.ymin),
      Math.round(box.xmax),
      Math.round(box.ymax)
    ];
  }

  /**
   * Map OWLv2 label to simplified element type
   * @private
   */
  mapLabelToType(label) {
    const labelLower = label.toLowerCase();
    
    // Button types
    if (labelLower.includes('button')) return 'button';
    if (labelLower.includes('icon') && !labelLower.includes('notification')) return 'icon';
    
    // Input types
    if (labelLower.includes('input') || labelLower.includes('text box')) return 'input';
    if (labelLower.includes('search')) return 'search';
    if (labelLower.includes('checkbox')) return 'checkbox';
    if (labelLower.includes('radio')) return 'radio';
    if (labelLower.includes('dropdown') || labelLower.includes('select')) return 'dropdown';
    
    // Navigation
    if (labelLower.includes('menu')) return 'menu';
    if (labelLower.includes('toolbar')) return 'toolbar';
    if (labelLower.includes('tab')) return 'tab';
    if (labelLower.includes('navigation')) return 'navbar';
    
    // Containers
    if (labelLower.includes('panel')) return 'panel';
    if (labelLower.includes('card')) return 'card';
    if (labelLower.includes('modal') || labelLower.includes('dialog')) return 'modal';
    if (labelLower.includes('popup')) return 'popup';
    
    // Content
    if (labelLower.includes('image') || labelLower.includes('picture')) return 'image';
    if (labelLower.includes('avatar')) return 'avatar';
    if (labelLower.includes('logo')) return 'logo';
    
    // Notifications
    if (labelLower.includes('notification') || labelLower.includes('toast') || labelLower.includes('alert')) return 'notification';
    if (labelLower.includes('badge')) return 'badge';
    
    // Lists
    if (labelLower.includes('list')) return 'list';
    if (labelLower.includes('table')) return 'table';
    if (labelLower.includes('row')) return 'row';
    
    // Other
    if (labelLower.includes('link')) return 'link';
    if (labelLower.includes('label')) return 'label';
    if (labelLower.includes('heading')) return 'heading';
    
    return 'unknown';
  }

  /**
   * Check if element type is typically clickable
   * @private
   */
  isClickableType(type) {
    const clickableTypes = [
      'button', 'icon', 'link', 'checkbox', 'radio', 
      'dropdown', 'tab', 'menu', 'search'
    ];
    return clickableTypes.includes(type);
  }

  /**
   * Generate unique element ID
   * @private
   */
  generateId(index) {
    return `owl-${Date.now()}-${index}`;
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.detector) {
      // Transformers.js handles cleanup automatically
      this.detector = null;
    }
    this.isInitialized = false;
    console.log('🧹 [OWLv2] Cleaned up');
  }

  /**
   * Get custom labels for specific UI contexts
   */
  getContextLabels(context) {
    const contexts = {
      email: [
        'email message',
        'inbox item',
        'compose button',
        'send button',
        'attachment',
        'reply button',
        'forward button',
        'delete button',
        'search box'
      ],
      browser: [
        'address bar',
        'tab',
        'bookmark',
        'back button',
        'forward button',
        'refresh button',
        'search box',
        'link',
        'menu button'
      ],
      chat: [
        'message bubble',
        'chat input',
        'send button',
        'emoji button',
        'attachment button',
        'avatar',
        'timestamp',
        'reaction'
      ],
      document: [
        'toolbar',
        'menu bar',
        'text area',
        'formatting button',
        'save button',
        'page',
        'ruler',
        'scroll bar'
      ]
    };

    return contexts[context] || this.uiClasses;
  }

  /**
   * Generate detection labels from natural language query
   * Extracts objects/entities from user queries using multiple strategies
   * @param {string} query - User's natural language query
   * @returns {Array<string>} Candidate labels for detection
   */
  generateLabelsFromQuery(query) {
    const queryLower = query.toLowerCase();
    const labels = new Set();

    // Strategy 1: Extract ALL potential nouns (words that could be objects)
    // Remove common stop words and extract candidate nouns
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
      'could', 'can', 'may', 'might', 'must', 'shall',
      'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
      'my', 'your', 'his', 'her', 'its', 'our', 'their',
      'this', 'that', 'these', 'those',
      'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
      'and', 'or', 'but', 'if', 'because', 'as', 'until', 'while',
      'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
      'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from',
      'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again',
      'further', 'then', 'once', 'here', 'there', 'all', 'both', 'each',
      'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
      'only', 'own', 'same', 'so', 'than', 'too', 'very'
    ]);

    const actionWords = new Set([
      'click', 'press', 'tap', 'select', 'choose', 'open', 'close', 'show',
      'hide', 'find', 'locate', 'see', 'look', 'view', 'display',
      'type', 'enter', 'input', 'write', 'search', 'scroll', 'move',
      'go', 'navigate', 'get', 'take', 'make', 'create', 'delete', 'remove'
    ]);

    // Extract words from query
    const words = queryLower.match(/\b[a-z]+\b/g) || [];
    
    for (const word of words) {
      // Skip stop words and action words
      if (stopWords.has(word) || actionWords.has(word)) continue;
      
      // Add potential nouns (3+ characters to avoid noise)
      if (word.length >= 3) {
        labels.add(word);
        // Add common variations
        labels.add(`${word} button`);
        labels.add(`${word} icon`);
        labels.add(`${word} image`);
      }
    }

    // Strategy 2: Extract multi-word phrases (e.g., "search box", "send button")
    const phrases = queryLower.match(/\b([a-z]+\s+[a-z]+)\b/g) || [];
    for (const phrase of phrases) {
      const [word1, word2] = phrase.split(' ');
      if (!stopWords.has(word1) && !stopWords.has(word2)) {
        labels.add(phrase);
      }
    }

    // Strategy 3: Common object patterns (fallback for known categories)
    const objectPatterns = {
      animals: ['cat', 'dog', 'bird', 'fish', 'horse', 'cow', 'sheep', 'pet', 'animal'],
      people: ['person', 'face', 'man', 'woman', 'child', 'baby', 'adult', 'people', 'avatar'],
      ui: ['button', 'icon', 'menu', 'input', 'text box', 'image', 'photo', 'picture', 'toolbar', 'tab'],
      vehicles: ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'vehicle'],
      food: ['food', 'pizza', 'burger', 'sandwich', 'salad', 'drink', 'coffee', 'tea'],
      electronics: ['phone', 'laptop', 'computer', 'tablet', 'screen', 'monitor', 'keyboard', 'mouse'],
      nature: ['tree', 'flower', 'plant', 'grass', 'sky', 'cloud', 'sun', 'moon', 'star'],
      buildings: ['building', 'house', 'window', 'door', 'roof', 'wall']
    };

    for (const [category, objects] of Object.entries(objectPatterns)) {
      for (const obj of objects) {
        if (queryLower.includes(obj)) {
          labels.add(obj);
          labels.add(`${obj} image`);
          labels.add(`${obj} photo`);
        }
      }
    }

    // Strategy 4: Extract color + object patterns (e.g., "blue button", "red car")
    const colors = ['red', 'blue', 'green', 'yellow', 'black', 'white', 'gray', 'grey', 'orange', 'purple', 'pink', 'brown'];
    for (const color of colors) {
      if (queryLower.includes(color)) {
        // Find object after color
        const colorPattern = new RegExp(`${color}\\s+(\\w+)`, 'gi');
        let match;
        while ((match = colorPattern.exec(query)) !== null) {
          const object = match[1].toLowerCase();
          if (!stopWords.has(object)) {
            labels.add(`${color} ${object}`);
            labels.add(object);
          }
        }
      }
    }

    // Strategy 5: Context-based label addition
    // If query implies UI interaction, add UI elements
    if (queryLower.match(/click|press|tap|select|choose/)) {
      labels.add('button');
      labels.add('clickable button');
      labels.add('icon');
      labels.add('link');
    }
    
    // If query is about finding/showing content
    if (queryLower.match(/show|find|where|locate|see|look|view/)) {
      labels.add('image');
      labels.add('photo');
      labels.add('picture');
      labels.add('icon');
    }

    // If query is about text input
    if (queryLower.match(/type|enter|input|write|search/)) {
      labels.add('input field');
      labels.add('text box');
      labels.add('search box');
    }

    // Strategy 6: Always include core UI elements for context
    const coreUIElements = ['button', 'icon', 'menu', 'image'];
    coreUIElements.forEach(el => labels.add(el));

    // Strategy 7: Remove overly generic or short labels
    const finalLabels = Array.from(labels).filter(label => {
      // Keep if it's a known UI element
      if (coreUIElements.includes(label)) return true;
      // Keep if it's a multi-word phrase
      if (label.includes(' ')) return true;
      // Keep if it's 4+ characters
      if (label.length >= 4) return true;
      return false;
    });

    return finalLabels;
  }

  /**
   * Detect elements based on natural language query
   * Automatically generates appropriate labels from query
   * @param {string} imagePath - Path to screenshot
   * @param {string} query - User's natural language query
   * @param {Object} options - Additional options
   * @returns {Promise<Array>} Detected elements matching query
   */
  async detectFromQuery(imagePath, query, options = {}) {
    console.log(`🔍 [OWLv2] Detecting from query: "${query}"`);
    
    const labels = this.generateLabelsFromQuery(query);
    console.log(`📋 [OWLv2] Generated labels:`, labels);

    return this.detectElements(imagePath, {
      ...options,
      customLabels: labels
    });
  }
}

// Singleton instance
let instance = null;

export function getOWLv2DetectionService() {
  if (!instance) {
    instance = new OWLv2DetectionService();
  }
  return instance;
}

export default OWLv2DetectionService;
