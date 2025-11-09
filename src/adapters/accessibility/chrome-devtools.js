/**
 * Chrome DevTools Protocol Adapter
 * Uses CDP's DOMSnapshot and Accessibility APIs for fast, comprehensive DOM extraction
 * 
 * Based on best practices from:
 * - DOMSnapshot.captureSnapshot: Flattened DOM + layout + styles
 * - Accessibility.getFullAXTree: Full accessibility tree for semantics
 */

import CDP from 'chrome-remote-interface';
import logger from '../../utils/logger.js';

export class ChromeDevToolsAdapter {
  constructor() {
    this.client = null;
    this.connected = false;
    this.currentUrl = null;
  }

  /**
   * Connect to Chrome DevTools Protocol
   * @param {number} port - Debug port (default: 9222 for Chrome, 9223 for Electron)
   * @param {string} targetUrl - Optional specific URL to connect to
   */
  async connect(port = 9222, targetUrl = null) {
    try {
      logger.info('Connecting to Chrome DevTools Protocol', { port, targetUrl });
      
      // Get list of available targets (tabs/windows)
      const targets = await CDP.List({ port });
      
      if (targets.length === 0) {
        throw new Error('No Chrome targets found. Is Chrome running with --remote-debugging-port?');
      }

      // Find target by URL if specified, otherwise use first page target
      let target;
      if (targetUrl) {
        target = targets.find(t => t.type === 'page' && t.url === targetUrl);
      }
      if (!target) {
        target = targets.find(t => t.type === 'page') || targets[0];
      }
      
      this.client = await CDP({ target, port });
      const { Page, Runtime, DOMSnapshot, Accessibility } = this.client;

      // Enable required domains
      await Page.enable();
      await Runtime.enable();
      await DOMSnapshot.enable();
      await Accessibility.enable();

      this.connected = true;
      this.currentUrl = target.url;
      
      logger.info('Connected to Chrome DevTools Protocol', { 
        targetId: target.id,
        url: target.url 
      });

      return true;
    } catch (error) {
      logger.error('Failed to connect to Chrome DevTools Protocol', { 
        error: error.message,
        port 
      });
      return false;
    }
  }

  /**
   * Get comprehensive DOM snapshot using CDP's DOMSnapshot API
   * This is MUCH faster than querying individual elements
   */
  async getDOMSnapshot() {
    if (!this.connected) {
      throw new Error('Not connected to Chrome DevTools Protocol');
    }

    try {
      const { DOMSnapshot } = this.client;

      logger.info('Capturing DOM snapshot...');

      // Capture complete DOM snapshot with layout and styles
      const snapshot = await DOMSnapshot.captureSnapshot({
        computedStyles: [
          'display',
          'visibility', 
          'position',
          'z-index',
          'opacity',
          'pointer-events'
        ],
        includePaintOrder: true,
        includeDOMRects: true,
        includeBlendedBackgroundColors: false,
        includeTextColorOpacities: false
      });

      logger.info('DOM snapshot captured', { 
        documentCount: snapshot.documents?.length || 0,
        stringCount: snapshot.strings?.length || 0
      });

      return snapshot;

    } catch (error) {
      logger.error('Failed to capture DOM snapshot', { error: error.message });
      throw error;
    }
  }

  /**
   * Get full accessibility tree using CDP's Accessibility API
   * Provides semantic information about elements
   */
  async getAccessibilityTree() {
    if (!this.connected) {
      throw new Error('Not connected to Chrome DevTools Protocol');
    }

    try {
      const { Accessibility } = this.client;

      logger.info('Getting accessibility tree...');

      // Get full AX tree
      const { nodes } = await Accessibility.getFullAXTree({});

      logger.info('Accessibility tree retrieved', { nodeCount: nodes.length });

      return nodes;

    } catch (error) {
      logger.error('Failed to get accessibility tree', { error: error.message });
      throw error;
    }
  }

  /**
   * Get all interactive elements by combining DOM snapshot + AX tree
   * This is the main method to use - combines both APIs for best results
   */
  async getAllElements() {
    if (!this.connected) {
      throw new Error('Not connected to Chrome DevTools Protocol');
    }

    try {
      logger.info('Getting all elements via CDP snapshots...');

      // Get both snapshots in parallel
      const [domSnapshot, axNodes] = await Promise.all([
        this.getDOMSnapshot(),
        this.getAccessibilityTree()
      ]);

      // Process snapshots into element list
      const elements = this._processSnapshots(domSnapshot, axNodes);

      logger.info('Retrieved elements via CDP', { count: elements.length });
      return elements;

    } catch (error) {
      logger.error('Failed to get elements', { error: error.message });
      throw error;
    }
  }

  /**
   * Process DOM snapshot and AX tree into element list
   */
  _processSnapshots(domSnapshot, axNodes) {
    const elements = [];
    
    // DOMSnapshot returns data in parallel arrays
    const doc = domSnapshot.documents[0]; // Main document
    if (!doc) return elements;

    const { nodes, layout, textBoxes } = doc;
    const strings = domSnapshot.strings;

    // Helper to get string value
    const getString = (index) => index >= 0 ? strings[index] : '';

    // Build AX node lookup by backendNodeId
    const axByBackendId = new Map();
    for (const axNode of axNodes) {
      if (axNode.backendDOMNodeId) {
        axByBackendId.set(axNode.backendDOMNodeId, axNode);
      }
    }

    // Process each node
    for (let i = 0; i < nodes.nodeName.length; i++) {
      const nodeName = getString(nodes.nodeName[i]).toLowerCase();
      const backendNodeId = nodes.backendNodeId[i];
      
      // Get layout info
      const layoutIndex = nodes.layoutNodeIndex?.[i];
      if (layoutIndex === undefined || layoutIndex < 0) {
        continue; // No layout = not rendered
      }

      const bounds = layout.bounds[layoutIndex];
      if (!bounds || bounds[2] === 0 || bounds[3] === 0) {
        continue; // No size = not visible
      }

      // Check if interactive
      const isInteractive = this._isInteractiveNode(nodeName, nodes, i, getString);
      if (!isInteractive) {
        continue; // Skip non-interactive elements
      }

      // Get AX node for semantic info
      const axNode = axByBackendId.get(backendNodeId);

      // Get computed styles
      const styles = this._getComputedStyles(nodes, layout, i, layoutIndex, getString);
      
      // Check visibility
      if (!this._isVisible(styles)) {
        continue;
      }

      // Build element object
      const element = {
        nodeId: backendNodeId,
        nodeName,
        role: axNode?.role?.value || this._inferRole(nodeName),
        label: this._getLabel(axNode, nodes, i, getString),
        value: this._getValue(axNode, nodes, i, getString),
        bounds: {
          x: Math.round(bounds[0]),
          y: Math.round(bounds[1]),
          width: Math.round(bounds[2]),
          height: Math.round(bounds[3])
        },
        styles,
        isVisible: true,
        isInteractive: true,
        actions: this._getActions(nodeName, axNode)
      };

      elements.push(element);
    }

    return elements;
  }

  /**
   * Check if node is interactive based on tag name and attributes
   */
  _isInteractiveNode(nodeName, nodes, index, getString) {
    // Interactive tags
    const interactiveTags = ['button', 'a', 'input', 'textarea', 'select', 'details', 'summary'];
    if (interactiveTags.includes(nodeName)) {
      return true;
    }

    // Check for role attribute
    const attributes = nodes.attributes?.[index];
    if (attributes) {
      for (let i = 0; i < attributes.length; i += 2) {
        const attrName = getString(attributes[i]);
        const attrValue = getString(attributes[i + 1]);
        
        if (attrName === 'role') {
          const interactiveRoles = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem'];
          if (interactiveRoles.includes(attrValue)) {
            return true;
          }
        }
        
        if (attrName === 'onclick' || attrName === 'tabindex') {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get computed styles for a node
   */
  _getComputedStyles(nodes, layout, nodeIndex, layoutIndex, getString) {
    const styles = {};
    
    const styleIndexes = layout.styles?.[layoutIndex];
    if (styleIndexes) {
      for (let i = 0; i < styleIndexes.length; i += 2) {
        const name = getString(styleIndexes[i]);
        const value = getString(styleIndexes[i + 1]);
        styles[name] = value;
      }
    }

    return styles;
  }

  /**
   * Check if element is visible based on computed styles
   */
  _isVisible(styles) {
    if (styles.display === 'none') return false;
    if (styles.visibility === 'hidden') return false;
    if (styles.opacity === '0') return false;
    if (styles['pointer-events'] === 'none') return false;
    return true;
  }

  /**
   * Infer role from tag name
   */
  _inferRole(nodeName) {
    const roleMap = {
      'button': 'button',
      'a': 'link',
      'input': 'textbox',
      'textarea': 'textbox',
      'select': 'combobox',
      'img': 'image',
      'nav': 'navigation',
      'header': 'banner',
      'footer': 'contentinfo',
      'main': 'main',
      'aside': 'complementary',
      'details': 'group',
      'summary': 'button'
    };

    return roleMap[nodeName] || 'generic';
  }

  /**
   * Get label from AX node or DOM attributes
   */
  _getLabel(axNode, nodes, index, getString) {
    // Try AX node name first (most reliable)
    if (axNode?.name?.value) {
      return axNode.name.value.substring(0, 100);
    }

    // Try aria-label attribute
    const attributes = nodes.attributes?.[index];
    if (attributes) {
      for (let i = 0; i < attributes.length; i += 2) {
        const attrName = getString(attributes[i]);
        const attrValue = getString(attributes[i + 1]);
        
        if (attrName === 'aria-label' || attrName === 'title' || attrName === 'alt') {
          return attrValue.substring(0, 100);
        }
      }
    }

    return '';
  }

  /**
   * Get value from AX node or DOM attributes
   */
  _getValue(axNode, nodes, index, getString) {
    // Try AX node value first
    if (axNode?.value?.value) {
      return axNode.value.value.substring(0, 100);
    }

    // Try value attribute
    const attributes = nodes.attributes?.[index];
    if (attributes) {
      for (let i = 0; i < attributes.length; i += 2) {
        const attrName = getString(attributes[i]);
        const attrValue = getString(attributes[i + 1]);
        
        if (attrName === 'value' || attrName === 'placeholder') {
          return attrValue.substring(0, 100);
        }
      }
    }

    return '';
  }

  /**
   * Get available actions based on node name and AX role
   */
  _getActions(nodeName, axNode) {
    const actions = [];

    if (nodeName === 'button' || nodeName === 'a' || axNode?.role?.value === 'button' || axNode?.role?.value === 'link') {
      actions.push('click');
    }

    if (nodeName === 'input' || nodeName === 'textarea' || axNode?.role?.value === 'textbox') {
      actions.push('focus', 'type', 'clear');
    }

    if (nodeName === 'select' || axNode?.role?.value === 'combobox') {
      actions.push('select');
    }

    return actions;
  }

  /**
   * Get current page URL
   */
  async getCurrentUrl() {
    if (!this.connected) {
      throw new Error('Not connected to Chrome DevTools Protocol');
    }

    try {
      const { Page } = this.client;
      const { frameTree } = await Page.getFrameTree();
      return frameTree.frame.url;
    } catch (error) {
      logger.error('Failed to get current URL', { error: error.message });
      return null;
    }
  }

  /**
   * Disconnect from Chrome DevTools Protocol
   */
  async disconnect() {
    if (this.client) {
      try {
        await this.client.close();
        this.connected = false;
        logger.info('Disconnected from Chrome DevTools Protocol');
      } catch (error) {
        logger.error('Failed to disconnect', { error: error.message });
      }
    }
  }
}

/**
 * Helper function to check if Chrome is running with debugging enabled
 */
export async function isChromeDebuggingEnabled(port = 9222) {
  try {
    const targets = await CDP.List({ port });
    return targets.length > 0;
  } catch {
    return false;
  }
}

/**
 * Helper function to get Chrome debugging port from process
 */
export async function getChromeDebugPort() {
  // Check common ports
  const ports = [9222, 9223, 9224];
  
  for (const port of ports) {
    if (await isChromeDebuggingEnabled(port)) {
      return port;
    }
  }
  
  return null;
}
