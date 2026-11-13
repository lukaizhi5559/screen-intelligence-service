import screenshot from 'screenshot-desktop';
import logger from '../utils/logger.js';
import { capturePng } from './nativeScreenHelper.js';

class ScreenCaptureService {
  constructor() {
    this.lastScreenshotBuffer = null;
    this.lastError = null;
  }

  /**
   * Take a screenshot and return the raw PNG buffer.
   * macOS prefers td-screen-helper — its own TCC client, grantable as
   * "ThinkDrop Screen Helper" in Screen Recording settings. Falls back to
   * screenshot-desktop (screencapture CLI) on helper build/exec failure and
   * on non-darwin platforms.
   */
  async capture() {
    const startTime = Date.now();
    let helperErr = null;
    if (process.platform === 'darwin') {
      try {
        const buffer = await capturePng();
        logger.info('Screenshot captured via td-screen-helper', {
          sizeKB: Math.round(buffer.length / 1024),
          elapsed: Date.now() - startTime
        });
        this.lastScreenshotBuffer = buffer;
        this.lastError = null;
        return buffer;
      } catch (e) {
        helperErr = e;
        logger.warn('td-screen-helper capture failed, trying screencapture', {
          error: e.message, denied: !!e.denied
        });
      }
    }
    try {
      const buffer = await screenshot({ format: 'png' });
      const elapsed = Date.now() - startTime;

      logger.info('Screenshot captured', {
        sizeKB: Math.round(buffer.length / 1024),
        elapsed
      });

      this.lastScreenshotBuffer = buffer;
      this.lastError = null;
      return buffer;
    } catch (error) {
      logger.error('Screenshot capture failed', { error: error.message });
      // The helper's denial names a grantable app — prefer it over the
      // generic screencapture failure as the surfaced lastError.
      this.lastError = (helperErr && helperErr.denied) ? helperErr.message : error.message;
      return null;
    }
  }
}

let instance = null;

export function getScreenCaptureService() {
  if (!instance) {
    instance = new ScreenCaptureService();
  }
  return instance;
}

export default ScreenCaptureService;
