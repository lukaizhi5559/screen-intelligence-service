import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';

// Import middleware
import authMiddleware from './middleware/auth.js';
import errorHandler from './middleware/errorHandler.js';

// Import routes (only used routes)
import healthRoute from './routes/health.js';
import analyzeRoute from './routes/analyze.js';
import analyzeVisionRoute from './routes/analyze-vision.js';
import elementSearchRoute from './routes/elementSearch.js';
import contextRoute from './routes/context.js';
import generateEmbeddingsRoute from './routes/generateEmbeddings.js';

// Import services
import { initializeOverlayManager } from './services/overlay-manager.js';

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

    res.json({
      service: 'screen-intelligence',
      version: '1.0.0',
      status: 'up',
      uptime: process.uptime(),
      platform,
      features: {
        semanticAnalysis: true,
        ocrSupported: true,
        vectorSearch: true
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
          name: 'screen.analyze-vision',
          description: 'Backend vision API analysis using Claude/OpenAI/Grok - captures screenshot and sends to backend for analysis',
          parameters: {
            query: { type: 'string', required: true, description: 'Natural language query (e.g., "List all email titles on my screen")' }
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

// Routes - Only the 3 used routes + health
app.use('/screen/analyze', analyzeRoute);
app.use('/screen/analyze-vision', analyzeVisionRoute); // New backend vision API route
app.use('/screen/context', contextRoute);
app.use('/', elementSearchRoute); // Handles /element.search
app.use('/', generateEmbeddingsRoute); // Handles /screen.generateEmbeddings
app.use('/health', healthRoute);

// Dot notation (for MCP protocol)
app.use('/screen.analyze', analyzeRoute);
app.use('/screen.analyze-vision', analyzeVisionRoute); // New backend vision API route (dot notation)
app.use('/screen.context', contextRoute);

// Error handler (must be last)
app.use(errorHandler);

// Helper functions removed - no longer needed

// Initialize services
async function initialize() {
  try {
    logger.info('🚀 Initializing Screen Intelligence Service...');
    
    // Initialize overlay manager
    await initializeOverlayManager();
    logger.info('✅ Overlay manager initialized');
    
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
