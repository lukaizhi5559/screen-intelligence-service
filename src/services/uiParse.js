import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NATIVE_DIR = path.join(__dirname, '..', '..', 'native');
const DAEMON_PATHS = [
  path.join(NATIVE_DIR, 'bin', 'td-ui-parse.app', 'Contents', 'MacOS', 'td-ui-parse'),
  path.join(NATIVE_DIR, 'bin', 'td-ui-parse'),
];
const MODEL_DIR = path.join(NATIVE_DIR, 'models');
const CMD_TIMEOUT_MS = 15000;

/**
 * uiParse — lifecycle + JSON-lines client for the td-ui-parse Swift daemon.
 *
 * The daemon owns screen capture (SCK), the CoreML detector, Vision OCR and
 * CGEvent actions inside one TCC-blessed .app bundle, so all elements and
 * clicks come back with real screen coordinates. This service just spawns it,
 * keeps it warm, and serializes request/response over stdin/stdout lines.
 */
class UIParseService {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.denied = null; // 'screen-recording' | 'accessibility' | null
    this.lineBuf = '';
    this.waiters = []; // FIFO: parse results are positional on stdout
    this.starting = null;
  }

  daemonPath() {
    return DAEMON_PATHS.find(p => fs.existsSync(p)) || null;
  }

  async ensureStarted() {
    if (this.proc && !this.proc.killed) return true;
    if (this.starting) return this.starting;
    this.starting = this._spawn();
    const ok = await this.starting;
    this.starting = null;
    return ok;
  }

  async _spawn() {
    const bin = this.daemonPath();
    if (!bin) {
      logger.error('td-ui-parse binary not found', { searched: DAEMON_PATHS });
      return false;
    }
    logger.info('starting td-ui-parse daemon', { bin });

    this.proc = spawn(bin, [], {
      cwd: NATIVE_DIR,
      env: {
        ...process.env,
        TD_UI_MODEL: process.env.TD_UI_MODEL || path.join(MODEL_DIR, 'icon_detect_v8.mlpackage'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdin.setDefaultEncoding('utf8');

    this.proc.stdout.on('data', (chunk) => {
      this.lineBuf += chunk.toString('utf8');
      let nl;
      while ((nl = this.lineBuf.indexOf('\n')) >= 0) {
        const line = this.lineBuf.slice(0, nl);
        this.lineBuf = this.lineBuf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const w = this.waiters.shift();
        if (w) w.resolve(msg);
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.event === 'denied') this.denied = 'screen-recording';
          if (ev.event === 'ax-not-granted') this.denied = 'accessibility';
          if (ev.event !== 'starting') logger.info('td-ui-parse', ev);
        } catch {
          logger.debug('td-ui-parse stderr', { line });
        }
      }
    });

    this.proc.on('exit', (code) => {
      logger.warn('td-ui-parse exited', { code });
      this.proc = null;
      this.ready = false;
      const pending = this.waiters.splice(0);
      for (const w of pending) w.resolve({ ok: false, error: 'daemon-exited', code });
    });

    // Warm-up ping — the daemon reports model state in the reply.
    const pong = await this._cmd({ cmd: 'ping' }, CMD_TIMEOUT_MS);
    this.ready = !!pong.ok;
    if (!this.ready) logger.error('td-ui-parse failed to become ready', { pong });
    return this.ready;
  }

  _cmd(payload, timeoutMs = CMD_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // drop our waiter so a late reply doesn't consume the next caller's slot
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve({ ok: false, error: 'timeout', timeoutMs });
      }, timeoutMs);
      const w = {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      };
      this.waiters.push(w);
      try {
        this.proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (e) {
        clearTimeout(timer);
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve({ ok: false, error: 'write-failed', detail: e.message });
      }
    });
  }

  /**
   * Parse the screen → { ok, frame_id, elements:[{id,type,label,bbox,center,conf,src}], timing_ms }
   */
  async parse(opts = {}) {
    if (!(await this.ensureStarted())) {
      return { ok: false, error: 'daemon-unavailable', hint: 'build native/td-ui-parse via native/build.sh' };
    }
    const res = await this._cmd({ cmd: 'parse', ...opts }, opts.timeoutMs || CMD_TIMEOUT_MS);
    if (this.denied === 'screen-recording') res.permission_denied = 'screen-recording';
    return res;
  }

  /** Read the frontmost app's AX menubar → [{path,title,key,mods,vkey,enabled}]. */
  async menubar() {
    if (!(await this.ensureStarted())) {
      return { ok: false, error: 'daemon-unavailable' };
    }
    const res = await this._cmd({ cmd: 'menubar' }, CMD_TIMEOUT_MS);
    if (this.denied === 'accessibility') res.permission_denied = 'accessibility';
    return res;
  }

  /** Forward an action command (click/type/key/scroll/focus). */
  async act(action) {
    if (!(await this.ensureStarted())) {
      return { ok: false, error: 'daemon-unavailable' };
    }
    const res = await this._cmd(action, CMD_TIMEOUT_MS);
    if (this.denied === 'accessibility') res.permission_denied = 'accessibility';
    return res;
  }

  /**
   * Stop an in-flight physical act (type is 25ms/char — seconds for long
   * text). Fire-and-forget: the daemon's "cancel" command emits NO response,
   * so deliberately push no waiter — the FIFO reply pairing stays aligned.
   */
  cancelActions() {
    try {
      if (this.proc && !this.proc.killed) {
        this.proc.stdin.write(JSON.stringify({ cmd: 'cancel' }) + '\n');
        return { ok: true };
      }
    } catch {}
    return { ok: false, error: 'daemon-unavailable' };
  }

  async terminate() {
    if (this.proc) {
      try { this.proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch {}
      this.proc.kill('SIGTERM');
      this.proc = null;
      this.ready = false;
    }
  }
}

let instance = null;
export function getUIParseService() {
  if (!instance) instance = new UIParseService();
  return instance;
}
export default UIParseService;
