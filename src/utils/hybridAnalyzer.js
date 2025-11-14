import { NutJsAnalyzer } from './nutJsAnalyzer.js';
import { OCRAnalyzer } from './ocrAnalyzer.js';

/**
 * Hybrid Analyzer - Intelligently chooses between NutJS and OCR
 * Based on content type and analysis requirements
 */
export class HybridAnalyzer {
  constructor() {
    this.nutjsAnalyzer = new NutJsAnalyzer();
    this.ocrAnalyzer = new OCRAnalyzer();
    this.preferredMethod = 'auto'; // 'auto', 'nutjs', 'ocr'
  }

  /**
   * Initialize both analyzers
   */
  async init() {
    console.log('🔧 [HYBRID] Initializing analyzers...');
    await this.nutjsAnalyzer.init();
    await this.ocrAnalyzer.init();
    console.log('✅ [HYBRID] Both analyzers initialized');
  }

  /**
   * Cleanup both analyzers
   */
  async cleanup() {
    await this.ocrAnalyzer.cleanup();
    console.log('🧹 [HYBRID] Analyzers cleaned up');
  }

  /**
   * Set overlay callback for both analyzers
   */
  setOverlayCallback(callback) {
    this.nutjsAnalyzer.setOverlayCallback(callback);
    this.ocrAnalyzer.setOverlayCallback(callback);
  }

  /**
   * Analyze screen using the best method
   * @param {Object} options - Analysis options
   * @returns {Promise<Object>} Analysis result
   */
  async analyze(options = {}) {
    const {
      method = this.preferredMethod,
      windowInfo = {},
      fallback = true, // Try other method if first fails
      ...otherOptions
    } = options;

    // Determine which method to use
    const selectedMethod = method === 'auto' 
      ? this.selectBestMethod(windowInfo)
      : method;

    console.log(`🎯 [HYBRID] Using method: ${selectedMethod}`);

    try {
      // Try primary method
      if (selectedMethod === 'nutjs') {
        const result = await this.nutjsAnalyzer.captureAndAnalyze({
          windowInfo,
          ...otherOptions
        });
        
        if (result) {
          return { ...result, selectedMethod: 'nutjs' };
        }
        
        // Fallback to OCR if NutJS failed
        if (fallback) {
          console.log('⚠️  [HYBRID] NutJS failed, falling back to OCR...');
          const ocrResult = await this.ocrAnalyzer.captureAndAnalyze({
            windowInfo,
            ...otherOptions
          });
          return { ...ocrResult, selectedMethod: 'ocr', fallbackUsed: true };
        }
      } else {
        // Use OCR
        const result = await this.ocrAnalyzer.captureAndAnalyze({
          windowInfo,
          ...otherOptions
        });
        
        if (result) {
          return { ...result, selectedMethod: 'ocr' };
        }
        
        // Fallback to NutJS if OCR failed
        if (fallback) {
          console.log('⚠️  [HYBRID] OCR failed, falling back to NutJS...');
          const nutjsResult = await this.nutjsAnalyzer.captureAndAnalyze({
            windowInfo,
            ...otherOptions
          });
          return { ...nutjsResult, selectedMethod: 'nutjs', fallbackUsed: true };
        }
      }

      return null;

    } catch (error) {
      console.error('❌ [HYBRID] Analysis failed:', error);
      return null;
    }
  }

  /**
   * Intelligently select the best analysis method
   * @param {Object} windowInfo - Window context
   * @returns {string} 'nutjs' or 'ocr'
   */
  selectBestMethod(windowInfo) {
    const { app = '', url = '', title = '' } = windowInfo;
    const appLower = app.toLowerCase();
    const urlLower = url.toLowerCase();

    // Use OCR for these apps (non-text-selectable content)
    const ocrApps = [
      'preview',      // PDF viewer
      'acrobat',      // Adobe PDF
      'vlc',          // Video player
      'quicktime',    // Video player
      'photos',       // Image viewer
      'photoshop',    // Image editor
      'figma',        // Design tool
      'sketch',       // Design tool
      'zoom',         // Video conferencing
      'teams',        // Video conferencing
      'slack'         // Sometimes has images
    ];

    // Use OCR for PDF files
    if (urlLower.includes('.pdf') || title.toLowerCase().includes('.pdf')) {
      console.log('📄 [HYBRID] PDF detected → OCR');
      return 'ocr';
    }

    // Use OCR for image files
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
    if (imageExtensions.some(ext => urlLower.includes(ext) || title.toLowerCase().includes(ext))) {
      console.log('🖼️  [HYBRID] Image detected → OCR');
      return 'ocr';
    }

    // Use OCR for specific apps
    if (ocrApps.some(ocrApp => appLower.includes(ocrApp))) {
      console.log(`📱 [HYBRID] ${app} detected → OCR`);
      return 'ocr';
    }

    // Use NutJS for web browsers (text-selectable)
    const browsers = ['chrome', 'safari', 'firefox', 'edge', 'brave', 'arc', 'vivaldi'];
    if (browsers.some(browser => appLower.includes(browser))) {
      console.log(`🌐 [HYBRID] Browser detected → NutJS`);
      return 'nutjs';
    }

    // Use NutJS for text editors and IDEs
    const textApps = ['code', 'vscode', 'sublime', 'atom', 'notepad', 'textedit', 'terminal'];
    if (textApps.some(textApp => appLower.includes(textApp))) {
      console.log(`📝 [HYBRID] Text app detected → NutJS`);
      return 'nutjs';
    }

    // Default to NutJS (faster)
    console.log('⚡ [HYBRID] Default → NutJS');
    return 'nutjs';
  }

  /**
   * Set preferred method
   * @param {string} method - 'auto', 'nutjs', or 'ocr'
   */
  setPreferredMethod(method) {
    if (['auto', 'nutjs', 'ocr'].includes(method)) {
      this.preferredMethod = method;
      console.log(`🎯 [HYBRID] Preferred method set to: ${method}`);
    } else {
      console.warn(`⚠️  [HYBRID] Invalid method: ${method}`);
    }
  }

  /**
   * Clear caches for both analyzers
   */
  clearCache() {
    this.nutjsAnalyzer.cache.clear();
    this.ocrAnalyzer.clearCache();
    console.log('🧹 [HYBRID] All caches cleared');
  }

  /**
   * Get cache stats for both analyzers
   */
  getCacheStats() {
    return {
      nutjs: {
        size: this.nutjsAnalyzer.cache.size,
        keys: Array.from(this.nutjsAnalyzer.cache.keys())
      },
      ocr: this.ocrAnalyzer.getCacheStats()
    };
  }
}

export default HybridAnalyzer;
