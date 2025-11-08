import logger from '../utils/logger.js';
import { mouse, keyboard, screen, Button, Key } from '@nut-tree-fork/nut-js';
import { boundsToCenter, getScreenDimensions } from '../utils/coords.js';

/**
 * Action Engine
 * Handles mouse and keyboard automation using @nut-tree/nut-js
 */
class ActionEngine {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    logger.info('Initializing Action Engine...');
    
    try {
      // Configure nut.js
      mouse.config.mouseSpeed = 1000; // pixels per second
      keyboard.config.autoDelayMs = 50; // delay between keystrokes
      
      this.initialized = true;
      logger.info('✅ Action Engine initialized');
    } catch (error) {
      logger.error('Failed to initialize Action Engine', { error: error.message });
      throw error;
    }
  }

  /**
   * Click at coordinates or element
   */
  async click(target) {
    if (!this.initialized) {
      throw new Error('Action Engine not initialized');
    }

    try {
      let x, y;

      if (typeof target === 'object' && target.bounds) {
        // Click center of element bounds using coordinate utilities
        const center = boundsToCenter(target.bounds);
        x = Math.round(center.x);
        y = Math.round(center.y);
      } else if (typeof target === 'object' && target.x !== undefined && target.y !== undefined) {
        // Direct coordinates
        x = Math.round(target.x);
        y = Math.round(target.y);
      } else {
        throw new Error('Invalid target format. Expected bounds or {x, y} coordinates');
      }

      logger.info('Clicking', { x, y });

      // Move mouse and click
      await mouse.setPosition({ x, y });
      await mouse.click(Button.LEFT);

      return { x, y, success: true };
    } catch (error) {
      logger.error('Click failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Type text
   */
  async type(target, text) {
    if (!this.initialized) {
      throw new Error('Action Engine not initialized');
    }

    try {
      // Click target first to focus
      if (target) {
        await this.click(target);
        // Wait for focus
        await this._sleep(100);
      }

      logger.info('Typing text', { length: text.length });

      // Type the text
      await keyboard.type(text);

      return { success: true, length: text.length };
    } catch (error) {
      logger.error('Type failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Press key combination
   */
  async pressKey(keys) {
    if (!this.initialized) {
      throw new Error('Action Engine not initialized');
    }

    try {
      logger.info('Pressing keys', { keys });

      // Convert string keys to Key enum
      const keyArray = Array.isArray(keys) ? keys : [keys];
      const nutKeys = keyArray.map(k => this._mapKey(k));

      // Press keys
      for (const key of nutKeys) {
        await keyboard.pressKey(key);
      }

      // Release in reverse order
      for (const key of nutKeys.reverse()) {
        await keyboard.releaseKey(key);
      }

      return { success: true, keys: keyArray };
    } catch (error) {
      logger.error('Press key failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Get screen size
   */
  async getScreenSize() {
    try {
      const size = await screen.width();
      const height = await screen.height();
      return { width: size, height };
    } catch (error) {
      logger.error('Get screen size failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Get mouse position
   */
  async getMousePosition() {
    try {
      const position = await mouse.getPosition();
      return position;
    } catch (error) {
      logger.error('Get mouse position failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Map string key to nut.js Key enum
   */
  _mapKey(keyString) {
    const keyMap = {
      'enter': Key.Enter,
      'return': Key.Enter,
      'tab': Key.Tab,
      'escape': Key.Escape,
      'esc': Key.Escape,
      'space': Key.Space,
      'backspace': Key.Backspace,
      'delete': Key.Delete,
      'up': Key.Up,
      'down': Key.Down,
      'left': Key.Left,
      'right': Key.Right,
      'cmd': Key.LeftCmd,
      'command': Key.LeftCmd,
      'ctrl': Key.LeftControl,
      'control': Key.LeftControl,
      'alt': Key.LeftAlt,
      'option': Key.LeftAlt,
      'shift': Key.LeftShift
    };

    const normalized = keyString.toLowerCase();
    return keyMap[normalized] || keyString;
  }

  /**
   * Sleep helper
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
let actionEngine = null;

export async function initializeActionEngine() {
  if (!actionEngine) {
    actionEngine = new ActionEngine();
    await actionEngine.initialize();
  }
  return actionEngine;
}

export function getActionEngine() {
  if (!actionEngine) {
    throw new Error('Action Engine not initialized');
  }
  return actionEngine;
}

export default ActionEngine;
