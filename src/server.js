import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';
import { getScreenCaptureService } from './services/screenCapture.js';
import { getOCRService } from './services/ocrService.js';
import { getActiveWindow } from './services/activeWindow.js';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 3008;
const HOST = process.env.HOST || '0.0.0.0';

// Middleware
app.use(cors());
app.use(express.json());

// --- Health ---

app.get('/service.health', (req, res) => {
  res.json({
    service: 'screen-intelligence',
    version: '2.0.0',
    status: 'up',
    uptime: process.uptime(),
    platform: process.platform
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'screen-intelligence' });
});

// --- Capabilities ---

app.get('/service.capabilities', (req, res) => {
  res.json({
    service: 'screen-intelligence',
    version: '2.0.0',
    capabilities: {
      actions: [
        {
          name: 'screen.analyze',
          description: 'Capture screen, run OCR, and return cleaned text for LLM consumption',
          parameters: {
            query: { type: 'string', required: false, description: 'Natural language query passed through for context' }
          }
        }
      ],
      features: {
        ocr: true,
        textCleanup: true
      }
    }
  });
});

// --- Screen Analyze (single endpoint) ---

/**
 * POST /screen.analyze  (or /screen/analyze)
 *
 * Captures the screen, runs Tesseract OCR, cleans the text,
 * and returns it ready for an LLM answer node in a StateGraph.
 *
 * Request body (all fields optional):
 * {
 *   "query": "What's on my screen?"   // passed through for context
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "text": "cleaned OCR text ...",
 *   "rawText": "raw OCR text ...",
 *   "confidence": 87.5,
 *   "elapsed": 2340,
 *   "query": "What's on my screen?",
 *   "timestamp": "2026-02-19T..."
 * }
 */
async function handleAnalyze(req, res) {
  try {
    const payload = req.body.payload || req.body;
    const { query } = payload;

    logger.info('Screen analyze request', { query });

    // 1. Get active window context + capture screenshot in parallel
    const screenCapture = getScreenCaptureService();
    const [activeWin, buffer] = await Promise.all([
      getActiveWindow(),
      screenCapture.capture()
    ]);

    if (!buffer) {
      return res.status(500).json({
        success: false,
        error: 'Failed to capture screenshot'
      });
    }

    // 2. OCR + cleanup pipeline
    const ocrService = getOCRService();
    const result = await ocrService.extractAndClean(buffer);

    // 3. Return cleaned text for LLM consumption
    res.json({
      success: true,
      appName: activeWin.appName,
      windowTitle: activeWin.windowTitle,
      url: activeWin.url || null,
      text: result.text,
      rawText: result.rawText,
      confidence: result.confidence,
      elapsed: result.elapsed,
      query: query || null,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Screen analyze failed', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// Both slash and dot notation for MCP compatibility
app.post('/screen.analyze', handleAnalyze);
app.post('/screen/analyze', handleAnalyze);

/**
 * POST /screen.analyze-file
 *
 * Runs Tesseract OCR on a local image file (instead of a live screenshot).
 * Used as a fallback by image.analyze skill when the vision backend is unavailable.
 *
 * Request body:
 * {
 *   "filePath": "/absolute/path/to/image.png",
 *   "query": "optional context string"
 * }
 *
 * Response: same shape as /screen.analyze
 */
app.post('/screen.analyze-file', async (req, res) => {
  try {
    const payload = req.body.payload || req.body;
    const { filePath, query } = payload;

    if (!filePath) {
      return res.status(400).json({ success: false, error: 'filePath is required' });
    }

    const { readFileSync, existsSync } = await import('fs');
    if (!existsSync(filePath)) {
      return res.status(400).json({ success: false, error: `File not found: ${filePath}` });
    }

    logger.info('Screen analyze-file request', { filePath, query });

    const buffer = readFileSync(filePath);
    const ocrService = getOCRService();
    const result = await ocrService.extractAndClean(buffer);

    res.json({
      success: true,
      filePath,
      text: result.text,
      rawText: result.rawText,
      confidence: result.confidence,
      elapsed: result.elapsed,
      query: query || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Screen analyze-file failed', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
  }
});

// Alias: screen.analyze-vision → same pipeline (vision API removed, OCR is the backend)
app.post('/screen.analyze-vision', handleAnalyze);

// screen.context — returns active window info without full OCR
app.get('/screen.context', async (req, res) => {
  try {
    const screenCapture = getScreenCaptureService();
    const activeWin = await getActiveWindow();
    res.json({
      success: true,
      data: {
        windows: [
          {
            appName: activeWin.appName,
            title: activeWin.windowTitle,
            url: activeWin.url || null,
          }
        ]
      }
    });
  } catch (error) {
    logger.error('screen.context failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/screen.context', async (req, res) => {
  try {
    const activeWin = await getActiveWindow();
    res.json({
      success: true,
      data: {
        windows: [
          {
            appName: activeWin.appName,
            title: activeWin.windowTitle,
            url: activeWin.url || null,
          }
        ]
      }
    });
  } catch (error) {
    logger.error('screen.context failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// screen.idle — returns system idle time in ms (via ioreg, macOS only)
app.get('/screen.idle', async (req, res) => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    if (process.platform !== 'darwin') {
      return res.json({ success: true, idleMs: 0, platform: process.platform });
    }
    const { stdout } = await execAsync(
      'ioreg -c IOHIDSystem | awk \'/HIDIdleTime/ {print $NF; exit}\'',
      { timeout: 2000 }
    );
    const idleNs = parseInt(stdout.trim(), 10);
    const idleMs = isNaN(idleNs) ? 0 : Math.floor(idleNs / 1000000);
    res.json({ success: true, idleMs });
  } catch (error) {
    logger.error('screen.idle failed', { error: error.message });
    res.json({ success: false, idleMs: 0, error: error.message });
  }
});

// --- Initialize & Start ---

async function initialize() {
  logger.info('Initializing Screen Intelligence Service...');

  // Pre-initialize OCR worker so first request is fast
  const ocrService = getOCRService();
  await ocrService.initialize();

  logger.info('Screen Intelligence Service ready');
}

const server = app.listen(PORT, HOST, async () => {
  logger.info(`Screen Intelligence Service listening on ${HOST}:${PORT}`);

  try {
    await initialize();
  } catch (error) {
    logger.error('Failed to initialize services', { error: error.message });
    process.exit(1);
  }
});

// Graceful shutdown
function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down...`);

  const ocrService = getOCRService();
  ocrService.terminate().catch(() => {});

  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => logger.info('SIGHUP received — ignoring (background process)'));

export default app;
