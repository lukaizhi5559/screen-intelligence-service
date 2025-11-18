/**
 * Icon Classification Service
 * Uses CLIP for zero-shot icon recognition
 * Based on ScreenAI's 77+ icon types
 */

import { pipeline } from '@xenova/transformers';
import sharp from 'sharp';

/**
 * Icon types based on ScreenAI research
 * 77+ common UI icons organized by category
 */
const ICON_CATEGORIES = {
  // Navigation & Actions (20)
  NAVIGATION: [
    'home', 'back', 'forward', 'up', 'down', 'left', 'right',
    'menu', 'hamburger menu', 'more options', 'kebab menu',
    'close', 'minimize', 'maximize', 'fullscreen', 'exit fullscreen',
    'refresh', 'reload', 'sync', 'undo', 'redo'
  ],
  
  // Communication (12)
  COMMUNICATION: [
    'email', 'message', 'chat', 'phone', 'video call',
    'notification', 'bell', 'alert', 'inbox', 'send',
    'reply', 'forward message'
  ],
  
  // Media & Content (15)
  MEDIA: [
    'play', 'pause', 'stop', 'skip forward', 'skip back',
    'volume', 'mute', 'unmute', 'camera', 'microphone',
    'image', 'photo', 'video', 'music', 'file'
  ],
  
  // Editing & Tools (18)
  EDITING: [
    'edit', 'delete', 'trash', 'save', 'download', 'upload',
    'copy', 'paste', 'cut', 'share', 'export', 'import',
    'print', 'search', 'filter', 'sort', 'add', 'plus'
  ],
  
  // Settings & System (12)
  SYSTEM: [
    'settings', 'gear', 'preferences', 'account', 'user', 'profile',
    'lock', 'unlock', 'security', 'help', 'info', 'question mark'
  ],
  
  // Status & Indicators (10)
  STATUS: [
    'check', 'checkmark', 'success', 'error', 'warning',
    'star', 'favorite', 'bookmark', 'flag', 'pin'
  ]
};

/**
 * Flatten icon categories into single list
 */
const ALL_ICON_TYPES = Object.values(ICON_CATEGORIES).flat();

/**
 * Icon descriptions for CLIP zero-shot classification
 */
const ICON_DESCRIPTIONS = {
  // Navigation
  'home': 'a house icon representing home or homepage',
  'back': 'a left arrow icon for going back',
  'forward': 'a right arrow icon for going forward',
  'menu': 'three horizontal lines representing a menu',
  'hamburger menu': 'three stacked horizontal lines menu icon',
  'close': 'an X icon for closing',
  'refresh': 'a circular arrow icon for refresh',
  
  // Communication
  'email': 'an envelope icon representing email',
  'message': 'a speech bubble icon for messages',
  'notification': 'a bell icon for notifications',
  'send': 'a paper plane or arrow icon for sending',
  
  // Media
  'play': 'a triangle pointing right for play',
  'pause': 'two vertical bars for pause',
  'volume': 'a speaker icon with sound waves',
  'camera': 'a camera icon for taking photos',
  
  // Editing
  'edit': 'a pencil icon for editing',
  'delete': 'a trash can icon for deleting',
  'save': 'a floppy disk icon for saving',
  'download': 'a downward arrow icon for downloading',
  'search': 'a magnifying glass icon for search',
  'add': 'a plus sign icon for adding',
  
  // Settings
  'settings': 'a gear or cog icon for settings',
  'user': 'a person silhouette icon for user account',
  'lock': 'a padlock icon for security',
  'help': 'a question mark icon for help',
  
  // Status
  'check': 'a checkmark icon indicating success',
  'error': 'an X or exclamation mark indicating error',
  'star': 'a star icon for favorites',
  'bookmark': 'a bookmark ribbon icon'
};

class IconClassificationService {
  constructor() {
    this.clipModel = null;
    this.modelName = 'Xenova/clip-vit-base-patch32';
    this.isInitialized = false;
    this.initPromise = null;
    
    // Classification settings
    this.minConfidence = 0.3; // Minimum confidence for icon classification
    this.topK = 3; // Return top K icon predictions
  }

  /**
   * Initialize CLIP model for zero-shot classification
   */
  async initialize() {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        console.log('🎨 Initializing CLIP icon classifier...');
        console.log(`   Model: ${this.modelName}`);
        
        // Load CLIP zero-shot classification pipeline
        this.clipModel = await pipeline('zero-shot-image-classification', this.modelName, {
          quantized: true,
        });

        this.isInitialized = true;
        console.log('✅ CLIP icon classifier initialized');
      } catch (error) {
        console.error('❌ Failed to initialize CLIP model:', error);
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Classify an icon from image crop
   * @param {Buffer|string} iconImage - Icon image buffer or path
   * @param {Object} options - Classification options
   * @returns {Promise<Object>} Icon classification result
   */
  async classifyIcon(iconImage, options = {}) {
    await this.initialize();

    try {
      // Preprocess icon image
      const processedImage = await this._preprocessIcon(iconImage);

      // Get candidate labels
      const candidateLabels = options.candidateLabels || this._getDefaultCandidates();

      // Run CLIP zero-shot classification
      const results = await this.clipModel(processedImage, candidateLabels);

      // Process results
      const topResults = results
        .sort((a, b) => b.score - a.score)
        .slice(0, this.topK)
        .filter(r => r.score >= this.minConfidence);

      if (topResults.length === 0) {
        return {
          iconType: 'unknown',
          confidence: 0,
          alternatives: []
        };
      }

      const best = topResults[0];
      
      return {
        iconType: best.label,
        confidence: best.score,
        alternatives: topResults.slice(1).map(r => ({
          type: r.label,
          confidence: r.score
        })),
        category: this._getIconCategory(best.label),
        description: ICON_DESCRIPTIONS[best.label] || `${best.label} icon`
      };
    } catch (error) {
      console.error('❌ Icon classification failed:', error);
      return {
        iconType: 'unknown',
        confidence: 0,
        alternatives: [],
        error: error.message
      };
    }
  }

  /**
   * Classify multiple icons in batch
   * @param {Array} iconImages - Array of icon images
   * @returns {Promise<Array>} Array of classification results
   */
  async classifyBatch(iconImages) {
    await this.initialize();

    const results = [];
    for (const iconImage of iconImages) {
      const result = await this.classifyIcon(iconImage);
      results.push(result);
    }

    return results;
  }

  /**
   * Extract and classify icon from bounding box
   * @param {string|Buffer} fullImage - Full screenshot
   * @param {Array} bbox - Bounding box [x1, y1, x2, y2]
   * @returns {Promise<Object>} Icon classification
   */
  async classifyIconFromBbox(fullImage, bbox) {
    await this.initialize();

    try {
      const [x1, y1, x2, y2] = bbox;
      
      // Extract icon region
      const iconCrop = await sharp(fullImage)
        .extract({
          left: Math.max(0, x1),
          top: Math.max(0, y1),
          width: x2 - x1,
          height: y2 - y1
        })
        .toBuffer();

      // Classify the cropped icon
      return await this.classifyIcon(iconCrop);
    } catch (error) {
      console.error('❌ Failed to extract and classify icon:', error);
      return {
        iconType: 'unknown',
        confidence: 0,
        alternatives: [],
        error: error.message
      };
    }
  }

  /**
   * Preprocess icon image for CLIP
   * @private
   */
  async _preprocessIcon(iconImage) {
    try {
      // Resize to 224x224 (CLIP input size)
      // Convert to RGB, normalize
      const processed = await sharp(iconImage)
        .resize(224, 224, {
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        })
        .toBuffer();

      return processed;
    } catch (error) {
      console.error('❌ Icon preprocessing failed:', error);
      throw error;
    }
  }

  /**
   * Get default candidate labels for classification
   * @private
   */
  _getDefaultCandidates() {
    // Use icon descriptions for better CLIP matching
    return ALL_ICON_TYPES.map(type => 
      ICON_DESCRIPTIONS[type] || `${type} icon`
    );
  }

  /**
   * Get icon category
   * @private
   */
  _getIconCategory(iconType) {
    for (const [category, types] of Object.entries(ICON_CATEGORIES)) {
      if (types.includes(iconType)) {
        return category.toLowerCase();
      }
    }
    return 'unknown';
  }

  /**
   * Get all supported icon types
   */
  getSupportedIconTypes() {
    return {
      all: ALL_ICON_TYPES,
      byCategory: ICON_CATEGORIES,
      count: ALL_ICON_TYPES.length
    };
  }

  /**
   * Search for icon type by keyword
   * @param {string} keyword - Search keyword
   * @returns {Array} Matching icon types
   */
  searchIconTypes(keyword) {
    const lowerKeyword = keyword.toLowerCase();
    return ALL_ICON_TYPES.filter(type => 
      type.includes(lowerKeyword) ||
      (ICON_DESCRIPTIONS[type] || '').toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.clipModel) {
      this.clipModel = null;
      this.isInitialized = false;
      console.log('🧹 Icon classifier cleaned up');
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton icon classification service instance
 */
function getIconClassificationService() {
  if (!instance) {
    instance = new IconClassificationService();
  }
  return instance;
}

export {
  IconClassificationService,
  getIconClassificationService,
  ICON_CATEGORIES,
  ALL_ICON_TYPES,
  ICON_DESCRIPTIONS
};
