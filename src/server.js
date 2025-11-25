import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';

// Import middleware
import authMiddleware from './middleware/auth.js';
import { validateMCPRequest, validatePayloadSize } from './middleware/validation.js';
import metricsMiddleware from './middleware/metrics.js';
import errorHandler from './middleware/errorHandler.js';

// Import routes
import describeRoute from './routes/describe.js';
import queryRoute from './routes/query.js';
import actionRoute from './routes/action.js';
import overlayRoute from './routes/overlay.js';
import healthRoute from './routes/health.js';
import analyzeRoute from './routes/analyze.js';
import elementSearchRoute from './routes/elementSearch.js';
import watcherRoute from './routes/watcher.js';
import ocrRoute from './routes/ocr.js';
import cleanupRoute from './routes/cleanup.js';
import contextRoute from './routes/context.js';

// Import services
import { initializeAccessibilityAdapter } from './adapters/accessibility/index.js';
import { initializeOverlayManager } from './services/overlay-manager.js';
import { getScreenWatcher } from './services/screenWatcher.js';
import { getCleanupManager } from './utils/cleanupManager.js';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 3008;
const HOST = process.env.HOST || '0.0.0.0';

// Middleware
app.use(helmet());
app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(','),
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(validatePayloadSize);
app.use(metricsMiddleware);

// Global request logger (before any routes)
app.use((req, res, next) => {
  console.log('📥 [REQUEST] GLOBAL LOGGER HIT:', req.method, req.path, req.url);
  logger.info('📥 [REQUEST]', { method: req.method, path: req.path, url: req.url });
  next();
});

// Health check endpoint (no auth required)
app.get('/service.health', async (req, res) => {
  try {
    const platform = process.platform;
    const overlayStatus = await getOverlayStatus();
    const accessibilityStatus = await getAccessibilityStatus();
    const watcherStatus = getWatcherStatus();

    res.json({
      service: 'screen-intelligence',
      version: '1.0.0',
      status: 'up',
      uptime: process.uptime(),
      platform,
      overlay: overlayStatus,
      accessibility: accessibilityStatus,
      watcher: watcherStatus,
      features: {
        overlaySupported: true,
        accessibilitySupported: platform === 'darwin' || platform === 'win32',
        streamingSupported: true, // Phase 2 complete
        openCVSupported: false // Phase 4
      }
    });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(503).json({
      service: 'screen-intelligence',
      version: '1.0.0',
      status: 'degraded',
      error: error.message
    });
  }
});

// Capabilities endpoint (no auth required)
app.get('/service.capabilities', (req, res) => {
  res.json({
    service: 'screen-intelligence',
    version: '1.0.0',
    capabilities: {
      actions: [
        {
          name: 'screen.describe',
          description: 'Analyze screen with visual feedback',
          parameters: {
            showOverlay: { type: 'boolean', default: true },
            includeHidden: { type: 'boolean', default: false }
          }
        },
        {
          name: 'screen.analyze',
          description: 'Context-aware screen analysis - automatically detects which window to analyze based on query',
          parameters: {
            query: { type: 'string', required: true, description: 'Natural language query (e.g., "How many files on my desktop?")' },
            showOverlay: { type: 'boolean', default: false },
            includeScreenshot: { type: 'boolean', default: false }
          }
        },
        {
          name: 'screen.query',
          description: 'Find elements with highlighting',
          parameters: {
            query: { type: 'string', required: true },
            role: { type: 'string', optional: true },
            highlight: { type: 'boolean', default: true }
          }
        },
        {
          name: 'screen.click',
          description: 'Click element with guide overlay',
          parameters: {
            target: { type: 'string', required: true },
            showGuide: { type: 'boolean', default: true }
          }
        },
        {
          name: 'screen.type',
          description: 'Type text with visual confirmation',
          parameters: {
            target: { type: 'string', required: true },
            text: { type: 'string', required: true },
            showConfirmation: { type: 'boolean', default: true }
          }
        },
        {
          name: 'screen.guide',
          description: 'Multi-step workflow with overlays',
          parameters: {
            steps: { type: 'array', required: true }
          }
        },
        {
          name: 'screen.highlight',
          description: 'Show element highlight',
          parameters: {
            element: { type: 'object', required: true },
            duration: { type: 'number', default: 3000 }
          }
        },
        {
          name: 'screen.toast',
          description: 'Show notification overlay',
          parameters: {
            message: { type: 'string', required: true },
            type: { type: 'string', default: 'info' },
            duration: { type: 'number', default: 3000 }
          }
        },
        {
          name: 'screen.clearOverlay',
          description: 'Clear all overlays',
          parameters: {}
        },
        {
          name: 'screen.context',
          description: 'Get current active window context',
          parameters: {}
        },
        {
          name: 'element.search',
          description: 'Search for UI elements using semantic search',
          parameters: {
            query: { type: 'string', required: true, description: 'Search query (e.g., "save button", "email from Alice")' },
            k: { type: 'number', default: 3, description: 'Number of results to return' },
            minScore: { type: 'number', default: 0.5, description: 'Minimum similarity score' },
            filters: { type: 'object', description: 'Optional filters (types, clickableOnly)' }
          }
        }
      ],
      features: {
        visualFeedback: true,
        accessibility: true,
        automation: true,
        multiStep: true
      }
    }
  });
});

// Apply auth middleware to protected routes (both slash and dot notation)
console.log('🔒 [SERVER] Registering auth middleware for /screen/ and /screen. and /element.');
app.use('/screen/', authMiddleware);
app.use('/screen.', authMiddleware);
app.use('/element.', authMiddleware);

// Routes (support both slash and dot notation for compatibility)
// Slash notation (for keyboard shortcuts and direct calls)
app.use('/screen/describe', describeRoute);
app.use('/screen/query', queryRoute);
app.use('/screen/action', actionRoute);
app.use('/screen/overlay', overlayRoute);
app.use('/screen/analyze', analyzeRoute);
app.use('/screen/context', contextRoute);
app.use('/ocr', ocrRoute);

// Element search route (dot notation for MCP compatibility)
app.use('/', elementSearchRoute);

// Dot notation (for MCP protocol)
app.use('/screen.describe', describeRoute);
app.use('/screen.query', queryRoute);
app.use('/screen.action', actionRoute);
app.use('/screen.overlay', overlayRoute);
app.use('/screen.analyze', analyzeRoute);
app.use('/element.search', elementSearchRoute);
app.use('/watcher', watcherRoute);
app.use('/cleanup', cleanupRoute);
app.use('/screen.context', contextRoute);

app.use('/health', healthRoute);

// Error handler (must be last)
app.use(errorHandler);

// Helper functions
async function getOverlayStatus() {
  try {
    // Will implement with overlay manager
    return { status: 'ready', windows: 0 };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

async function getAccessibilityStatus() {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      return { status: 'ready', adapter: 'AX (macOS)' };
    } else if (platform === 'win32') {
      return { status: 'pending', adapter: 'UIA (Windows)' };
    } else {
      return { status: 'unsupported', adapter: 'none' };
    }
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

function getWatcherStatus() {
  try {
    const watcher = getScreenWatcher();
    const status = watcher.getStatus();
    return {
      status: status.isRunning ? (status.isPaused ? 'paused' : 'running') : 'stopped',
      fps: status.config.fps,
      captureCount: status.stats.captureCount,
      successRate: status.stats.totalCaptures > 0 
        ? `${((status.stats.successfulCaptures / status.stats.totalCaptures) * 100).toFixed(1)}%`
        : 'N/A',
    };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

// Initialize services
async function initialize() {
  try {
    logger.info('🚀 Initializing Screen Intelligence Service...');
    
    // Initialize accessibility adapter
    await initializeAccessibilityAdapter();
    logger.info('✅ Accessibility adapter initialized');
    
    // Initialize overlay manager
    await initializeOverlayManager();
    logger.info('✅ Overlay manager initialized');
    
    // Initialize ScreenWatcher (but don't auto-start)
    // Use POST /watcher/start to begin streaming
    const watcher = getScreenWatcher({
      fps: parseInt(process.env.WATCHER_FPS) || 2,
      captureOnChange: process.env.WATCHER_ON_CHANGE !== 'false',
    });
    
    // Optional: Auto-start watcher if WATCHER_AUTO_START=true
    if (process.env.WATCHER_AUTO_START === 'true') {
      logger.info('🎬 Auto-starting ScreenWatcher...');
      await watcher.start();
      logger.info('✅ ScreenWatcher started automatically');
    } else {
      logger.info('⏸️  ScreenWatcher initialized (use POST /watcher/start to begin)');
    }
    
    // Start cleanup manager
    const cleanupManager = getCleanupManager();
    cleanupManager.start();
    
    logger.info('✅ Screen Intelligence Service ready');
  } catch (error) {
    logger.error('❌ Initialization failed', { error: error.message });
    throw error;
  }
}

// Start server
const server = app.listen(PORT, HOST, async () => {
  logger.info(`🎯 Screen Intelligence Service listening on ${HOST}:${PORT}`);
  
  try {
    await initialize();
  } catch (error) {
    logger.error('Failed to initialize services', { error });
    process.exit(1);
  }
});

// Graceful shutdown
function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully...`);
  
  // Stop ScreenWatcher
  try {
    const watcher = getScreenWatcher();
    if (watcher.isRunning) {
      logger.info('⏹️  Stopping ScreenWatcher...');
      watcher.stop();
    }
  } catch (err) {
    logger.warn('Failed to stop watcher:', err.message);
  }
  
  // Stop cleanup manager
  try {
    const cleanupManager = getCleanupManager();
    cleanupManager.stop();
  } catch (err) {
    logger.warn('Failed to stop cleanup manager:', err.message);
  }
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
