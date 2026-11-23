import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';
import { getScreenCaptureService } from './services/screenCapture.js';
import { getOCRService } from './services/ocrService.js';
import { getActiveWindow } from './services/activeWindow.js';
import { getUIParseService } from './services/uiParse.js';

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

    // 1. Capture first — if it fails we respond immediately instead of
    // waiting on window metadata. get-windows can hang tens of seconds under
    // Screen Recording denial, so a parallel await turned a <1s failure into
    // a full client timeout (callers burned 20-30s per attempt).
    const screenCapture = getScreenCaptureService();
    const buffer = await screenCapture.capture();

    if (!buffer) {
      const capErr = screenCapture.lastError || 'Failed to capture screenshot';
      const permDenied = /could not create image from display|screen recording|not authorized|denied/i.test(capErr);
      logger.warn('Screen analyze: screenshot failed', { capErr: capErr.slice(0, 200), permDenied });
      return res.status(500).json({
        success: false,
        error: permDenied ? 'screen_recording_permission_denied' : 'screenshot_capture_failed',
        detail: capErr.slice(0, 400),
        hint: permDenied
          ? 'Grant Screen Recording permission to "ThinkDrop Screen Helper" (System Settings → Privacy & Security → Screen Recording — it appears under its own name), then retry. No restart needed.'
          : undefined,
      });
    }

    // Window metadata is best-effort context — bound it so it can never
    // out-live the pipeline when get-windows stalls under TCC denial.
    const activeWin = await Promise.race([
      getActiveWindow(),
      new Promise(r => setTimeout(
        () => r({ appName: 'unknown', windowTitle: 'unknown', url: null }),
        2500
      )),
    ]);

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

// --- Element-level parse + act (td-ui-parse daemon) ---

/**
 * POST /screen/parse (or /screen.parse)
 *
 * Captures the screen and returns numbered UI elements — the input a local
 * decision model uses to pick an element ID to act on. All on-device:
 * SCK capture → CoreML YOLO detect → Vision OCR → merged element list.
 *
 * Body: { "display": 0, "annotate": "/abs/path.png" }  (all optional)
 *
 * Response: {
 *   "success": true, "frame_id": "f-3",
 *   "timing_ms": {"capture":190,"detect":70,"ocr":110,"total":420},
 *   "elements": [{"id":0,"type":"icon|text","label":"…","conf":0.9,
 *                 "bbox":[x,y,w,h],"center":[x,y],"src":"merged|detector|ocr"}]
 * }
 */
async function handleParse(req, res) {
  try {
    const payload = req.body.payload || req.body || {};
    const svc = getUIParseService();
    const result = await svc.parse({
      display: payload.display ?? 0,
      windowOnly: payload.windowOnly,
      annotate: payload.annotate,
      mode: payload.mode,
      caption: payload.caption,
      rect: payload.rect,
      wantImage: payload.wantImage,
      cursor: payload.cursor,
    });

    if (!result.ok) {
      const denied = result.permission_denied === 'screen-recording';
      return res.status(result.error === 'daemon-unavailable' ? 503 : 500).json({
        success: false,
        error: denied ? 'screen_recording_permission_denied' : result.error,
        detail: result.hint,
        hint: denied
          ? 'Grant Screen Recording to "ThinkDrop UI Parse Helper" in System Settings → Privacy & Security → Screen Recording'
          : undefined,
      });
    }

    res.json({
      success: true,
      frame_id: result.frame_id,
      display: result.display,
      size_px: result.size_px,
      coord_space: result.coord_space,
      scale: result.scale,
      offset: result.offset,
      windowOnly: result.windowOnly,
      front_app: result.front_app,
      front_bundle: result.front_bundle,
      rect: result.rect,
      phash: result.phash,
      lum: result.lum,
      image_png_b64: result.image_png_b64,
      layers: result.layers,
      timing_ms: result.timing_ms,
      elements: result.elements,
    });
  } catch (error) {
    logger.error('screen.parse failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
}
app.post('/screen/parse', handleParse);
app.post('/screen.parse', handleParse);

/**
 * POST /screen/act (or /screen.act)
 *
 * Executes an action at screen coordinates / with keys via CGEvent.
 *
 * Body: { "action": "click", "x": 100, "y": 200, "button": "left", "double": false }
 *       { "action": "type", "text": "hello" }
 *       { "action": "key", "key": "return", "mods": ["cmd"] }
 *       { "action": "scroll", "x": 960, "y": 540, "dx": 0, "dy": -300 }
 *       { "action": "focus", "bundle": "com.google.Chrome" }
 *
 * Response: { "success": true } or { "success": false, "error": "..." }
 */
async function handleAct(req, res) {
  try {
    const payload = req.body.payload || req.body || {};
    const action = payload.action;
    if (!action) return res.status(400).json({ success: false, error: 'action is required' });

    const svc = getUIParseService();
    const result = await svc.act({ cmd: action, ...payload });
    if (!result.ok) {
      return res.status(result.error === 'daemon-unavailable' ? 503 : 500).json({
        success: false,
        error: result.permission_denied === 'accessibility' ? 'accessibility_permission_denied' : result.error,
        hint: result.permission_denied === 'accessibility'
          ? 'Grant Accessibility to "ThinkDrop UI Parse Helper" in System Settings → Privacy & Security → Accessibility'
          : undefined,
      });
    }
    const { ok: _ok, ...rest } = result;
    res.json({ success: true, ...rest });
  } catch (error) {
    logger.error('screen.act failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
}
app.post('/screen/act', handleAct);
app.post('/screen.act', handleAct);

/**
 * POST /screen/cancel (or /screen.cancel)
 *
 * Stops an in-flight physical act in the td-ui-parse daemon (e.g. a long
 * doType). Called by command-service /automation.cancel so a user cancel
 * halts the mouse/keyboard mid-run, not just the JS loop above it.
 *
 * Response: { "success": true }
 */
app.post('/screen/cancel', (req, res) => {
  try {
    const svc = getUIParseService();
    const r = svc.cancelActions();
    res.json({ success: !!r.ok, error: r.error || undefined });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
app.post('/screen.cancel', (req, res) => res.redirect(307, '/screen/cancel'));

/**
 * POST /screen/menubar (or /screen.menubar)
 *
 * Reads the frontmost app's AX menu bar — real menu titles + key equivalents.
 * Used by shortcut resolution (cache → menubar → model → web → screen pick).
 *
 * Response: { "ok": true, "app": "Safari", "items": [{path,title,key,mods,vkey,enabled}] }
 */
app.post('/screen/menubar', async (req, res) => {
  try {
    const svc = getUIParseService();
    const result = await svc.menubar();
    if (!result.ok) {
      return res.status(result.error === 'daemon-unavailable' ? 503 : 500).json({
        success: false, error: result.error, app: result.app,
      });
    }
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('screen.menubar failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});
app.post('/screen.menubar', (req, res) => res.redirect(307, '/screen/menubar'));

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
