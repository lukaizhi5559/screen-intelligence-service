import logger from '../utils/logger.js';
import { EventEmitter } from 'events';

/**
 * Overlay Manager
 * Manages transparent overlay windows for visual feedback
 * 
 * This will communicate with the main Electron app to show overlays
 * For now, we'll use IPC/HTTP to send overlay commands
 */
class OverlayManager extends EventEmitter {
  constructor() {
    super();
    this.overlays = new Map();
    this.nextId = 1;
  }

  async initialize() {
    logger.info('Initializing Overlay Manager...');
    // TODO: Establish connection with main Electron app
    // For now, we'll just log overlay requests
    this.initialized = true;
  }

  /**
   * Show discovery mode - highlight all detected elements
   */
  async showDiscoveryMode(elements) {
    logger.info('Showing discovery mode', { elementCount: elements.length });
    
    const overlayId = this.nextId++;
    const overlay = {
      id: overlayId,
      type: 'discovery',
      elements: elements.map(el => ({
        bounds: el.bounds,
        label: el.label || el.role,
        confidence: el.confidence || 1.0,
        color: this._getConfidenceColor(el.confidence || 1.0)
      })),
      timestamp: Date.now()
    };

    this.overlays.set(overlayId, overlay);
    
    // TODO: Send to Electron main process via IPC
    this._sendOverlayCommand('show-discovery', overlay);
    
    return overlayId;
  }

  /**
   * Highlight specific elements
   */
  async highlightElements(elements, duration = 3000) {
    logger.info('Highlighting elements', { count: elements.length, duration });
    
    const overlayId = this.nextId++;
    const overlay = {
      id: overlayId,
      type: 'highlight',
      elements: elements.map(el => ({
        bounds: el.bounds,
        label: el.label || el.role,
        confidence: el.confidence || 1.0,
        color: this._getConfidenceColor(el.confidence || 1.0)
      })),
      duration,
      timestamp: Date.now()
    };

    this.overlays.set(overlayId, overlay);
    
    // TODO: Send to Electron main process
    this._sendOverlayCommand('highlight', overlay);
    
    // Auto-remove after duration
    setTimeout(() => {
      this.overlays.delete(overlayId);
      this._sendOverlayCommand('remove', { id: overlayId });
    }, duration);
    
    return overlayId;
  }

  /**
   * Show action guide (step-by-step)
   */
  async showActionGuide({ action, target, text, step, total }) {
    logger.info('Showing action guide', { action, target, step, total });
    
    const overlayId = this.nextId++;
    const overlay = {
      id: overlayId,
      type: 'guide',
      action,
      target,
      text,
      step,
      total,
      timestamp: Date.now()
    };

    this.overlays.set(overlayId, overlay);
    
    // TODO: Send to Electron main process
    this._sendOverlayCommand('show-guide', overlay);
    
    return overlayId;
  }

  /**
   * Show toast notification
   */
  async showToast({ message, type = 'info', duration = 3000 }) {
    logger.info('Showing toast', { message, type, duration });
    
    const overlayId = this.nextId++;
    const overlay = {
      id: overlayId,
      type: 'toast',
      message,
      toastType: type,
      duration,
      timestamp: Date.now()
    };

    this.overlays.set(overlayId, overlay);
    
    // TODO: Send to Electron main process
    this._sendOverlayCommand('show-toast', overlay);
    
    // Auto-remove after duration
    setTimeout(() => {
      this.overlays.delete(overlayId);
    }, duration);
    
    return overlayId;
  }

  /**
   * Clear all overlays
   */
  async clearAll() {
    logger.info('Clearing all overlays');
    
    this.overlays.clear();
    
    // TODO: Send to Electron main process
    this._sendOverlayCommand('clear-all', {});
  }

  /**
   * Get overlay status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      activeOverlays: this.overlays.size,
      overlays: Array.from(this.overlays.values())
    };
  }

  /**
   * Get confidence color
   */
  _getConfidenceColor(confidence) {
    if (confidence >= 0.9) return 'green';
    if (confidence >= 0.8) return 'blue';
    if (confidence >= 0.6) return 'yellow';
    return 'red';
  }

  /**
   * Send overlay command to Electron main process via HTTP
   */
  async _sendOverlayCommand(command, data) {
    logger.debug('Overlay command', { command, data });
    
    // Emit event for local listeners
    this.emit('overlay-command', { command, data });
    
    // Send to main Electron app via HTTP (if configured)
    const mainAppUrl = process.env.MAIN_APP_URL || 'http://localhost:5173';
    
    try {
      // Map commands to IPC handler names
      const commandMap = {
        'show-discovery': 'screen-intelligence:show-discovery',
        'highlight': 'screen-intelligence:show-highlights',
        'show-guide': 'screen-intelligence:show-guide',
        'show-toast': 'screen-intelligence:show-toast',
        'remove': 'screen-intelligence:clear',
        'clear-all': 'screen-intelligence:clear'
      };
      
      const ipcCommand = commandMap[command] || command;
      
      // Note: In production, this would use Electron IPC
      // For now, we log the command that would be sent
      logger.info('Would send to Electron IPC', { ipcCommand, data });
      
      // The actual IPC communication happens when the main app
      // calls the MCP service endpoints and then triggers IPC internally
      
    } catch (error) {
      logger.error('Failed to send overlay command', { error: error.message });
    }
  }
}

// Singleton instance
let overlayManager = null;

export async function initializeOverlayManager() {
  if (!overlayManager) {
    overlayManager = new OverlayManager();
    await overlayManager.initialize();
  }
  return overlayManager;
}

export function getOverlayManager() {
  if (!overlayManager) {
    throw new Error('Overlay manager not initialized');
  }
  return overlayManager;
}

export default OverlayManager;
