/**
 * Cleanup Service
 * Automatically manages storage by:
 * 1. Deleting old UI node data (keep last 7 days)
 * 2. Deleting old screenshots (keep last 24 hours)
 * 3. Vacuuming database to reclaim space
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class CleanupService {
  constructor(vectorStore, logger) {
    this.vectorStore = vectorStore;
    this.logger = logger;
    
    // Configuration
    this.config = {
      // Data retention periods
      uiNodeRetentionDays: 7,        // Keep UI nodes for 7 days
      screenshotRetentionHours: 24,  // Keep screenshots for 24 hours
      
      // Cleanup intervals
      cleanupIntervalHours: 6,       // Run cleanup every 6 hours
      vacuumIntervalDays: 1,         // Vacuum database daily
      
      // Size limits
      maxDatabaseSizeGB: 5,          // Alert if database exceeds 5GB
      maxScreenshotSizeMB: 500,      // Alert if screenshots exceed 500MB
    };
    
    this.cleanupTimer = null;
    this.vacuumTimer = null;
    this.isRunning = false;
  }
  
  /**
   * Start automated cleanup service
   */
  start() {
    if (this.isRunning) {
      this.logger.warn('Cleanup service already running');
      return;
    }
    
    this.isRunning = true;
    this.logger.info('🧹 Starting cleanup service...');
    
    // Run initial cleanup
    this.runCleanup().catch(err => {
      this.logger.error('Initial cleanup failed:', err);
    });
    
    // Schedule periodic cleanup
    const cleanupMs = this.config.cleanupIntervalHours * 60 * 60 * 1000;
    this.cleanupTimer = setInterval(() => {
      this.runCleanup().catch(err => {
        this.logger.error('Scheduled cleanup failed:', err);
      });
    }, cleanupMs);
    
    // Schedule periodic vacuum
    const vacuumMs = this.config.vacuumIntervalDays * 24 * 60 * 60 * 1000;
    this.vacuumTimer = setInterval(() => {
      this.runVacuum().catch(err => {
        this.logger.error('Scheduled vacuum failed:', err);
      });
    }, vacuumMs);
    
    this.logger.info(`✅ Cleanup service started (cleanup every ${this.config.cleanupIntervalHours}h, vacuum every ${this.config.vacuumIntervalDays}d)`);
  }
  
  /**
   * Stop cleanup service
   */
  stop() {
    if (!this.isRunning) {
      return;
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    if (this.vacuumTimer) {
      clearInterval(this.vacuumTimer);
      this.vacuumTimer = null;
    }
    
    this.isRunning = false;
    this.logger.info('🛑 Cleanup service stopped');
  }
  
  /**
   * Run cleanup operations
   */
  async runCleanup() {
    this.logger.info('🧹 Running cleanup...');
    const startTime = Date.now();
    
    try {
      // 1. Clean old UI nodes
      const nodesDeleted = await this.cleanOldUINodes();
      
      // 2. Clean old screenshots
      const screenshotsDeleted = await this.cleanOldScreenshots();
      
      // 3. Check database size
      await this.checkDatabaseSize();
      
      const elapsed = Date.now() - startTime;
      this.logger.info(`✅ Cleanup complete in ${elapsed}ms (nodes: ${nodesDeleted}, screenshots: ${screenshotsDeleted})`);
      
      return {
        success: true,
        nodesDeleted,
        screenshotsDeleted,
        elapsedMs: elapsed
      };
    } catch (error) {
      this.logger.error('❌ Cleanup failed:', error);
      throw error;
    }
  }
  
  /**
   * Delete UI nodes older than retention period
   */
  async cleanOldUINodes() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.uiNodeRetentionDays);
    const cutoffTimestamp = cutoffDate.toISOString();
    
    this.logger.info(`🗑️  Deleting UI nodes older than ${cutoffTimestamp}...`);
    
    try {
      // Delete old screen states (cascades to ui_nodes)
      const result = await this.vectorStore.deleteOldScreenStates(cutoffTimestamp);
      
      this.logger.info(`✅ Deleted ${result.deletedCount} old UI nodes`);
      return result.deletedCount;
    } catch (error) {
      this.logger.error('Failed to delete old UI nodes:', error);
      return 0;
    }
  }
  
  /**
   * Delete screenshots older than retention period
   */
  async cleanOldScreenshots() {
    const screenshotDir = '/var/folders/2r/962pnvf11_v2d27z74_0xdvw0000gn/T/thinkdrop-semantic-capture';
    
    if (!fs.existsSync(screenshotDir)) {
      this.logger.info('Screenshot directory not found, skipping');
      return 0;
    }
    
    const cutoffTime = Date.now() - (this.config.screenshotRetentionHours * 60 * 60 * 1000);
    let deletedCount = 0;
    
    try {
      const files = fs.readdirSync(screenshotDir);
      
      for (const file of files) {
        if (!file.endsWith('.png')) continue;
        
        const filePath = path.join(screenshotDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtimeMs < cutoffTime) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }
      
      this.logger.info(`✅ Deleted ${deletedCount} old screenshots`);
      return deletedCount;
    } catch (error) {
      this.logger.error('Failed to delete old screenshots:', error);
      return 0;
    }
  }
  
  /**
   * Check database size and alert if too large
   */
  async checkDatabaseSize() {
    try {
      const stats = await this.vectorStore.getStats();
      const dbSizeGB = stats.databaseSize / (1024 * 1024 * 1024);
      
      this.logger.info(`📊 Database size: ${dbSizeGB.toFixed(2)}GB (${stats.nodeCount} nodes)`);
      
      if (dbSizeGB > this.config.maxDatabaseSizeGB) {
        this.logger.warn(`⚠️  Database size (${dbSizeGB.toFixed(2)}GB) exceeds limit (${this.config.maxDatabaseSizeGB}GB)`);
        this.logger.warn('   Consider reducing retention period or running manual cleanup');
      }
      
      return dbSizeGB;
    } catch (error) {
      this.logger.error('Failed to check database size:', error);
      return 0;
    }
  }
  
  /**
   * Run database vacuum to reclaim space
   */
  async runVacuum() {
    this.logger.info('🗜️  Running database vacuum...');
    const startTime = Date.now();
    
    try {
      await this.vectorStore._execute('VACUUM');
      await this.vectorStore._execute('ANALYZE');
      
      const elapsed = Date.now() - startTime;
      this.logger.info(`✅ Vacuum complete in ${elapsed}ms`);
      
      return { success: true, elapsedMs: elapsed };
    } catch (error) {
      this.logger.error('❌ Vacuum failed:', error);
      throw error;
    }
  }
  
  /**
   * Get cleanup statistics
   */
  async getStats() {
    try {
      const dbStats = await this.vectorStore.getStats();
      
      // Get screenshot stats
      const screenshotDir = '/var/folders/2r/962pnvf11_v2d27z74_0xdvw0000gn/T/thinkdrop-semantic-capture';
      let screenshotCount = 0;
      let screenshotSizeMB = 0;
      
      if (fs.existsSync(screenshotDir)) {
        const files = fs.readdirSync(screenshotDir);
        screenshotCount = files.filter(f => f.endsWith('.png')).length;
        
        // Calculate total size
        for (const file of files) {
          if (!file.endsWith('.png')) continue;
          const filePath = path.join(screenshotDir, file);
          const stats = fs.statSync(filePath);
          screenshotSizeMB += stats.size / (1024 * 1024);
        }
      }
      
      return {
        database: {
          sizeGB: dbStats.databaseSize / (1024 * 1024 * 1024),
          nodeCount: dbStats.nodeCount,
          screenCount: dbStats.screenCount
        },
        screenshots: {
          count: screenshotCount,
          sizeMB: screenshotSizeMB
        },
        config: this.config,
        isRunning: this.isRunning
      };
    } catch (error) {
      this.logger.error('Failed to get cleanup stats:', error);
      throw error;
    }
  }
  
  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('✅ Cleanup configuration updated:', this.config);
    
    // Restart timers with new intervals
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }
}
