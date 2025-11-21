/**
 * Screen Watcher - Continuous Visual Input Streaming
 * 
 * Background service that continuously captures and analyzes screen content,
 * maintaining a fresh, queryable screen state in DuckDB.
 * 
 * Architecture:
 * 1. Capture Loop: Grabs frames at configurable FPS (1-3 fps default)
 * 2. Vision Pipeline: OWLv2 + OCR + Embedding generation
 * 3. Auto-Indexing: Stores results in DuckDB for instant semantic search
 * 4. Smart Triggers: Only captures when screen changes or on-demand
 * 
 * Benefits:
 * - Query endpoints become <100ms (no heavy vision re-run)
 * - Always-fresh screen understanding
 * - Enables real-time "Polish up this email" queries
 */

import logger from '../utils/logger.js';
import { getSemanticAnalyzer } from '../utils/semanticAnalyzer.js';
import { detectScreenContext } from '../utils/window-detector.js';
import { getScreenChangeDetector } from '../utils/screenChangeDetector.js';

export class ScreenWatcher {
  constructor(options = {}) {
    this.semanticAnalyzer = getSemanticAnalyzer();
    
    // Configuration
    this.config = {
      fps: options.fps || 2, // 2 frames per second (500ms interval)
      enabled: options.enabled !== false, // Start enabled by default
      captureOnChange: options.captureOnChange !== false, // Smart triggering
      minChangeThreshold: options.minChangeThreshold || 0.05, // 5% pixel change
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 5000, // 5 seconds
      changeDetectionMethod: options.changeDetectionMethod || 'sampling', // 'hash', 'sampling', or 'pixels'
    };
    
    // Initialize change detector if smart triggering enabled
    this.changeDetector = null;
    if (this.config.captureOnChange) {
      this.changeDetector = getScreenChangeDetector({
        changeThreshold: this.config.minChangeThreshold,
        useSampling: this.config.changeDetectionMethod === 'sampling',
        useHashing: this.config.changeDetectionMethod === 'hash',
        downscaleFactor: 4, // 1/4 resolution for fast comparison
      });
    }
    
    // State
    this.isRunning = false;
    this.isPaused = false;
    this.loopInterval = null;
    this.lastCaptureTime = null;
    this.lastScreenState = null;
    this.captureCount = 0;
    this.errorCount = 0;
    this.stats = {
      totalCaptures: 0,
      successfulCaptures: 0,
      failedCaptures: 0,
      skippedCaptures: 0,
      skippedNoChange: 0, // Skipped due to no screen change
      averageProcessingTime: 0,
      lastError: null,
      changeDetection: {
        enabled: this.config.captureOnChange,
        method: this.config.changeDetectionMethod,
        totalChecks: 0,
        changesDetected: 0,
        averageChangePercent: 0,
      },
    };
    
    logger.info('📹 ScreenWatcher initialized', {
      fps: this.config.fps,
      interval: `${1000 / this.config.fps}ms`,
      captureOnChange: this.config.captureOnChange,
    });
  }
  
  /**
   * Start the continuous vision loop
   */
  async start() {
    if (this.isRunning) {
      logger.warn('⚠️  ScreenWatcher already running');
      return { success: false, message: 'Already running' };
    }
    
    try {
      // Initialize semantic analyzer
      await this.semanticAnalyzer.init();
      logger.info('✅ SemanticAnalyzer initialized for streaming');
      
      this.isRunning = true;
      this.isPaused = false;
      
      // Calculate interval from FPS
      const intervalMs = Math.floor(1000 / this.config.fps);
      
      // Start the capture loop
      this.loopInterval = setInterval(() => {
        this._captureLoop().catch(err => {
          logger.error('❌ Capture loop error:', err);
          this.errorCount++;
          this.stats.failedCaptures++;
          this.stats.lastError = err.message;
        });
      }, intervalMs);
      
      logger.info('🚀 ScreenWatcher started', {
        fps: this.config.fps,
        interval: `${intervalMs}ms`,
      });
      
      return {
        success: true,
        message: 'ScreenWatcher started',
        config: this.config,
      };
      
    } catch (error) {
      logger.error('❌ Failed to start ScreenWatcher:', error);
      this.isRunning = false;
      return {
        success: false,
        message: error.message,
        error: error.stack,
      };
    }
  }
  
  /**
   * Stop the continuous vision loop
   */
  stop() {
    if (!this.isRunning) {
      logger.warn('⚠️  ScreenWatcher not running');
      return { success: false, message: 'Not running' };
    }
    
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
    
    this.isRunning = false;
    this.isPaused = false;
    
    logger.info('⏹️  ScreenWatcher stopped', {
      totalCaptures: this.stats.totalCaptures,
      successRate: `${((this.stats.successfulCaptures / this.stats.totalCaptures) * 100).toFixed(1)}%`,
    });
    
    return {
      success: true,
      message: 'ScreenWatcher stopped',
      stats: this.stats,
    };
  }
  
  /**
   * Pause the watcher (keeps running but skips captures)
   */
  pause() {
    if (!this.isRunning) {
      return { success: false, message: 'Not running' };
    }
    
    this.isPaused = true;
    logger.info('⏸️  ScreenWatcher paused');
    
    return { success: true, message: 'Paused' };
  }
  
  /**
   * Resume the watcher
   */
  resume() {
    if (!this.isRunning) {
      return { success: false, message: 'Not running' };
    }
    
    this.isPaused = false;
    logger.info('▶️  ScreenWatcher resumed');
    
    return { success: true, message: 'Resumed' };
  }
  
  /**
   * Get current status and statistics
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      config: this.config,
      stats: {
        ...this.stats,
        uptime: this.lastCaptureTime ? Date.now() - this.lastCaptureTime : 0,
        captureCount: this.captureCount,
        errorCount: this.errorCount,
      },
      lastCaptureTime: this.lastCaptureTime,
    };
  }
  
  /**
   * Update configuration on the fly
   */
  updateConfig(newConfig = {}) {
    const oldFps = this.config.fps;
    
    // Update config
    Object.assign(this.config, newConfig);
    
    // If FPS changed and we're running, restart the interval
    if (newConfig.fps && newConfig.fps !== oldFps && this.isRunning) {
      clearInterval(this.loopInterval);
      const intervalMs = Math.floor(1000 / this.config.fps);
      this.loopInterval = setInterval(() => {
        this._captureLoop().catch(err => {
          logger.error('❌ Capture loop error:', err);
          this.errorCount++;
        });
      }, intervalMs);
      
      logger.info('🔄 ScreenWatcher config updated', {
        oldFps,
        newFps: this.config.fps,
        newInterval: `${intervalMs}ms`,
      });
    }
    
    return {
      success: true,
      message: 'Config updated',
      config: this.config,
    };
  }
  
  /**
   * Force an immediate capture (bypasses pause and triggers)
   */
  async captureNow() {
    logger.info('📸 Manual capture triggered');
    return await this._performCapture(true);
  }
  
  /**
   * Main capture loop (runs every interval)
   * @private
   */
  async _captureLoop() {
    // Skip if paused
    if (this.isPaused) {
      this.stats.skippedCaptures++;
      return;
    }
    
    // Skip if not enabled
    if (!this.config.enabled) {
      return;
    }
    
    await this._performCapture(false);
  }
  
  /**
   * Perform a single capture and analysis
   * @private
   */
  async _performCapture(forced = false) {
    const startTime = Date.now();
    this.stats.totalCaptures++;
    
    try {
      // 1. Check if screen changed (if smart triggering enabled)
      if (!forced && this.config.captureOnChange && this.changeDetector) {
        const changeResult = await this.changeDetector.hasChanged();
        
        this.stats.changeDetection.totalChecks++;
        
        if (changeResult.changed) {
          this.stats.changeDetection.changesDetected++;
          this.stats.changeDetection.averageChangePercent = 
            (this.stats.changeDetection.averageChangePercent * (this.stats.changeDetection.changesDetected - 1) + 
             changeResult.changePercent) / this.stats.changeDetection.changesDetected;
          
          logger.debug('🔄 Screen changed', {
            changePercent: `${(changeResult.changePercent * 100).toFixed(1)}%`,
            method: changeResult.method,
            comparisonTime: `${changeResult.comparisonTime}ms`,
          });
        } else {
          // No change detected - skip capture
          logger.debug('⏭️  No screen change detected, skipping capture');
          this.stats.skippedNoChange++;
          this.stats.skippedCaptures++;
          return {
            success: true,
            skipped: true,
            reason: 'no-change',
            changePercent: changeResult.changePercent,
          };
        }
      }
      
      // 2. Detect screen context (which window is active)
      const context = await detectScreenContext();
      
      if (!context || !context.windows || context.windows.length === 0) {
        logger.debug('⏭️  No active windows, skipping capture');
        this.stats.skippedCaptures++;
        return;
      }
      
      const activeWindow = context.windows[0];
      logger.debug('📱 Active window detected', {
        app: activeWindow.appName,
        title: activeWindow.title?.substring(0, 50),
      });
      
      // 3. Run semantic analysis (OCR-only for fast background indexing)
      // Skip OWLv2 for background watcher - only run OCR + DuckDB indexing
      // OWLv2 will be used on-demand when user makes automation queries
      const result = await this.semanticAnalyzer.captureAndAnalyze({
        windowInfo: activeWindow,
        debounce: false, // No debounce in streaming mode
        userQuery: null, // No specific query, just index everything
        skipOWLv2: true, // ⚡ FAST MODE: OCR-only, no visual detection
      });
      
      if (!result.success) {
        throw new Error('Semantic analysis failed');
      }
      
      // 4. Update state
      this.lastCaptureTime = Date.now();
      this.lastScreenState = {
        screenId: result.screenId,
        timestamp: result.timestamp,
        app: activeWindow.appName,
        windowTitle: activeWindow.title,
        elementCount: result.elements?.length || 0,
        hasText: result.capturedText?.length > 0,
      };
      this.captureCount++;
      this.stats.successfulCaptures++;
      
      // 5. Update average processing time
      const processingTime = Date.now() - startTime;
      this.stats.averageProcessingTime = 
        (this.stats.averageProcessingTime * (this.stats.successfulCaptures - 1) + processingTime) / 
        this.stats.successfulCaptures;
      
      logger.debug('✅ Capture successful', {
        screenId: result.screenId,
        elements: result.elements?.length || 0,
        processingTime: `${processingTime}ms`,
        forced,
      });
      
      return {
        success: true,
        screenState: this.lastScreenState,
        processingTime,
      };
      
    } catch (error) {
      this.stats.failedCaptures++;
      this.stats.lastError = error.message;
      this.errorCount++;
      
      logger.error('❌ Capture failed', {
        error: error.message,
        errorCount: this.errorCount,
        maxRetries: this.config.maxRetries,
      });
      
      // If too many errors, pause the watcher
      if (this.errorCount >= this.config.maxRetries) {
        logger.error('🛑 Too many errors, pausing ScreenWatcher');
        this.pause();
        
        // Auto-resume after retry delay
        setTimeout(() => {
          logger.info('🔄 Auto-resuming ScreenWatcher after error cooldown');
          this.errorCount = 0;
          this.resume();
        }, this.config.retryDelay);
      }
      
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

// Singleton instance
let watcherInstance = null;

/**
 * Get or create the ScreenWatcher singleton
 */
export function getScreenWatcher(options = {}) {
  if (!watcherInstance) {
    watcherInstance = new ScreenWatcher(options);
  }
  return watcherInstance;
}

/**
 * Reset the singleton (useful for testing)
 */
export function resetScreenWatcher() {
  if (watcherInstance && watcherInstance.isRunning) {
    watcherInstance.stop();
  }
  watcherInstance = null;
}
