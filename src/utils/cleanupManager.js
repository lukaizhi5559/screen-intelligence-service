/**
 * Cleanup Manager
 * Handles automatic cleanup of temp screenshots and log rotation
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class CleanupManager {
  constructor() {
    this.screenshotDirs = [
      '/var/folders/2r/962pnvf11_v2d27z74_0xdvw0000gn/T/thinkdrop-semantic-capture',
      '/var/folders/2r/962pnvf11_v2d27z74_0xdvw0000gn/T/thinkdrop-screen-capture',
      '/var/folders/2r/962pnvf11_v2d27z74_0xdvw0000gn/T/thinkdrop-ocr-capture'
    ];
    
    this.logDir = path.join(__dirname, '../../../logs');
    
    // Cleanup intervals
    this.screenshotCleanupInterval = null;
    this.logRotationInterval = null;
    
    // Configuration
    this.config = {
      // Screenshots older than 1 hour are deleted
      screenshotMaxAge: parseInt(process.env.SCREENSHOT_MAX_AGE_MS) || 60 * 60 * 1000, // 1 hour
      // Run screenshot cleanup every 10 minutes
      screenshotCleanupFrequency: parseInt(process.env.SCREENSHOT_CLEANUP_FREQ_MS) || 10 * 60 * 1000, // 10 min
      // Max log file size before rotation (50MB)
      maxLogSize: parseInt(process.env.MAX_LOG_SIZE_MB) || 50 * 1024 * 1024, // 50MB
      // Keep last N rotated logs
      maxLogFiles: parseInt(process.env.MAX_LOG_FILES) || 5,
      // Run log rotation check every 5 minutes
      logRotationFrequency: parseInt(process.env.LOG_ROTATION_FREQ_MS) || 5 * 60 * 1000 // 5 min
    };
  }

  /**
   * Start automatic cleanup tasks
   */
  start() {
    logger.info('🧹 Starting cleanup manager...', {
      screenshotMaxAge: `${this.config.screenshotMaxAge / 1000}s`,
      screenshotCleanupFrequency: `${this.config.screenshotCleanupFrequency / 1000}s`,
      maxLogSize: `${this.config.maxLogSize / (1024 * 1024)}MB`,
      maxLogFiles: this.config.maxLogFiles
    });

    // Initial cleanup
    this.cleanupScreenshots().catch(err => 
      logger.error('Initial screenshot cleanup failed:', err)
    );
    this.rotateLogsIfNeeded().catch(err => 
      logger.error('Initial log rotation failed:', err)
    );

    // Schedule periodic cleanup
    this.screenshotCleanupInterval = setInterval(() => {
      this.cleanupScreenshots().catch(err => 
        logger.error('Scheduled screenshot cleanup failed:', err)
      );
    }, this.config.screenshotCleanupFrequency);

    this.logRotationInterval = setInterval(() => {
      this.rotateLogsIfNeeded().catch(err => 
        logger.error('Scheduled log rotation failed:', err)
      );
    }, this.config.logRotationFrequency);

    logger.info('✅ Cleanup manager started');
  }

  /**
   * Stop cleanup tasks
   */
  stop() {
    if (this.screenshotCleanupInterval) {
      clearInterval(this.screenshotCleanupInterval);
      this.screenshotCleanupInterval = null;
    }
    if (this.logRotationInterval) {
      clearInterval(this.logRotationInterval);
      this.logRotationInterval = null;
    }
    logger.info('🛑 Cleanup manager stopped');
  }

  /**
   * Clean up old screenshots
   */
  async cleanupScreenshots() {
    const now = Date.now();
    let totalDeleted = 0;
    let totalSize = 0;

    for (const dir of this.screenshotDirs) {
      try {
        // Check if directory exists
        await fs.access(dir);
        
        const files = await fs.readdir(dir);
        
        for (const file of files) {
          if (!file.endsWith('.png')) continue;
          
          const filePath = path.join(dir, file);
          
          try {
            const stats = await fs.stat(filePath);
            const age = now - stats.mtimeMs;
            
            // Delete if older than max age
            if (age > this.config.screenshotMaxAge) {
              totalSize += stats.size;
              await fs.unlink(filePath);
              totalDeleted++;
            }
          } catch (err) {
            // File might have been deleted already, skip
            if (err.code !== 'ENOENT') {
              logger.warn(`Failed to process file ${file}:`, err.message);
            }
          }
        }
      } catch (err) {
        // Directory doesn't exist or can't be accessed, skip
        if (err.code !== 'ENOENT') {
          logger.warn(`Failed to access directory ${dir}:`, err.message);
        }
      }
    }

    if (totalDeleted > 0) {
      logger.info('🗑️  Screenshot cleanup complete', {
        deleted: totalDeleted,
        freedSpace: `${(totalSize / (1024 * 1024)).toFixed(2)}MB`
      });
    }

    return { deleted: totalDeleted, freedSpace: totalSize };
  }

  /**
   * Rotate logs if they exceed max size
   */
  async rotateLogsIfNeeded() {
    const logFiles = [
      'screen-intelligence.log',
      'combined.log',
      'error.log'
    ];

    for (const logFile of logFiles) {
      const logPath = path.join(this.logDir, logFile);
      
      try {
        const stats = await fs.stat(logPath);
        
        if (stats.size > this.config.maxLogSize) {
          await this.rotateLog(logPath, logFile);
        }
      } catch (err) {
        // Log file doesn't exist yet, skip
        if (err.code !== 'ENOENT') {
          logger.warn(`Failed to check log file ${logFile}:`, err.message);
        }
      }
    }
  }

  /**
   * Rotate a specific log file
   */
  async rotateLog(logPath, logFile) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedPath = path.join(
      this.logDir,
      `${path.basename(logFile, '.log')}-${timestamp}.log`
    );

    try {
      // Get file size before rotation
      const stats = await fs.stat(logPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

      // Rename current log to rotated log
      await fs.rename(logPath, rotatedPath);
      
      logger.info('📋 Log rotated', {
        file: logFile,
        size: `${sizeMB}MB`,
        rotatedTo: path.basename(rotatedPath)
      });

      // Clean up old rotated logs
      await this.cleanupOldLogs(logFile);
    } catch (err) {
      logger.error(`Failed to rotate log ${logFile}:`, err);
    }
  }

  /**
   * Clean up old rotated logs, keeping only the most recent N files
   */
  async cleanupOldLogs(logFile) {
    try {
      const files = await fs.readdir(this.logDir);
      const baseName = path.basename(logFile, '.log');
      
      // Find all rotated versions of this log
      const rotatedLogs = files
        .filter(f => f.startsWith(`${baseName}-`) && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.logDir, f)
        }));

      // Sort by name (timestamp is in filename)
      rotatedLogs.sort((a, b) => b.name.localeCompare(a.name));

      // Delete old logs beyond maxLogFiles
      const toDelete = rotatedLogs.slice(this.config.maxLogFiles);
      
      for (const log of toDelete) {
        await fs.unlink(log.path);
        logger.info('🗑️  Deleted old log', { file: log.name });
      }
    } catch (err) {
      logger.error('Failed to cleanup old logs:', err);
    }
  }

  /**
   * Get current storage usage stats
   */
  async getStorageStats() {
    const stats = {
      screenshots: {
        count: 0,
        size: 0,
        oldestAge: 0
      },
      logs: {
        count: 0,
        size: 0
      }
    };

    // Count screenshots
    const now = Date.now();
    for (const dir of this.screenshotDirs) {
      try {
        await fs.access(dir);
        const files = await fs.readdir(dir);
        
        for (const file of files) {
          if (!file.endsWith('.png')) continue;
          
          const filePath = path.join(dir, file);
          try {
            const fileStats = await fs.stat(filePath);
            stats.screenshots.count++;
            stats.screenshots.size += fileStats.size;
            
            const age = now - fileStats.mtimeMs;
            if (age > stats.screenshots.oldestAge) {
              stats.screenshots.oldestAge = age;
            }
          } catch (err) {
            // Skip if file was deleted
          }
        }
      } catch (err) {
        // Directory doesn't exist, skip
      }
    }

    // Count logs
    try {
      const files = await fs.readdir(this.logDir);
      for (const file of files) {
        if (!file.endsWith('.log')) continue;
        
        const filePath = path.join(this.logDir, file);
        try {
          const fileStats = await fs.stat(filePath);
          stats.logs.count++;
          stats.logs.size += fileStats.size;
        } catch (err) {
          // Skip if file was deleted
        }
      }
    } catch (err) {
      // Log directory doesn't exist
    }

    return {
      screenshots: {
        count: stats.screenshots.count,
        size: `${(stats.screenshots.size / (1024 * 1024)).toFixed(2)}MB`,
        oldestAge: `${Math.floor(stats.screenshots.oldestAge / 1000)}s`
      },
      logs: {
        count: stats.logs.count,
        size: `${(stats.logs.size / (1024 * 1024)).toFixed(2)}MB`
      }
    };
  }

  /**
   * Manual cleanup - force cleanup of all old files
   */
  async forceCleanup() {
    logger.info('🧹 Running forced cleanup...');
    
    const screenshotResult = await this.cleanupScreenshots();
    await this.rotateLogsIfNeeded();
    const stats = await this.getStorageStats();
    
    logger.info('✅ Forced cleanup complete', {
      screenshotsDeleted: screenshotResult.deleted,
      freedSpace: `${(screenshotResult.freedSpace / (1024 * 1024)).toFixed(2)}MB`,
      currentStats: stats
    });
    
    return { screenshotResult, stats };
  }
}

// Singleton instance
let cleanupManager = null;

export function getCleanupManager() {
  if (!cleanupManager) {
    cleanupManager = new CleanupManager();
  }
  return cleanupManager;
}

export default getCleanupManager;
