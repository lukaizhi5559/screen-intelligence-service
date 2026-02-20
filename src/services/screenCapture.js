import screenshot from 'screenshot-desktop';
import logger from '../utils/logger.js';

class ScreenCaptureService {
  constructor() {
    this.lastScreenshotBuffer = null;
  }

  /**
   * Take a screenshot and return the raw PNG buffer.
   */
  async capture() {
    try {
      const startTime = Date.now();
      const buffer = await screenshot({ format: 'png' });
      const elapsed = Date.now() - startTime;

      logger.info('Screenshot captured', {
        sizeKB: Math.round(buffer.length / 1024),
        elapsed
      });

      this.lastScreenshotBuffer = buffer;
      return buffer;
    } catch (error) {
      logger.error('Screenshot capture failed', { error: error.message });
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
