/**
 * Enhanced UI Tree Builder with DETR Integration
 * Combines DETR object detection with OCR for accurate UI element detection
 * Based on ScreenAI research architecture
 */

import { v4 as uuidv4 } from 'uuid';
import SemanticDescriptionGenerator from './semanticDescriptionGenerator.js';
import { getDETRDetectionService } from '../services/detrDetectionService.js';

class EnhancedUITreeBuilder {
  constructor(options = {}) {
    this.descriptionGenerator = new SemanticDescriptionGenerator();
    this.detrService = getDETRDetectionService();
    this.useDETR = options.useDETR !== false; // Enabled by default
    this.detrInitialized = false;
  }

  /**
   * Build a UI tree from OCR and DETR results
   * @param {Object} ocrResults - Results from OCR analyzer
   * @param {Object} windowInfo - Active window information
   * @param {Object} options - Build options
   * @returns {Promise<Object>} UIScreenState
   */
  async buildTree(ocrResults, windowInfo = {}, options = {}) {
    const screenState = {
      id: uuidv4(),
      description: '',
      app: windowInfo.app || 'Unknown',
      url: windowInfo.url || null,
      windowTitle: windowInfo.title || null,
      nodes: new Map(),
      subtrees: [],
      rootNodeIds: [],
      screenDimensions: {
        width: ocrResults.screenWidth || 1920,
        height: ocrResults.screenHeight || 1080
      },
      timestamp: Date.now(),
      screenshotPath: ocrResults.screenshotPath || null,
      metadata: {
        usedDETR: false,
        detectionMethod: 'ocr-only'
      }
    };

    let elements = [];

    // 1. Try DETR detection first (if enabled and screenshot available)
    if (this.useDETR && ocrResults.screenshotPath) {
      try {
        if (!this.detrInitialized) {
          await this.detrService.initialize();
          this.detrInitialized = true;
        }

        console.log('🎯 Using DETR + OCR for element detection');
        elements = await this.detrService.detectAndMerge(
          ocrResults.screenshotPath,
          ocrResults.words || [],
          options.detr || {}
        );
        
        screenState.metadata.usedDETR = true;
        screenState.metadata.detectionMethod = 'detr+ocr';
      } catch (error) {
        console.warn('⚠️  DETR detection failed, falling back to OCR-only:', error.message);
        elements = this._ocrFallback(ocrResults);
        screenState.metadata.detectionMethod = 'ocr-fallback';
      }
    } else {
      // Fallback to OCR-only
      console.log('📝 Using OCR-only for element detection');
      elements = this._ocrFallback(ocrResults);
      screenState.metadata.detectionMethod = 'ocr-only';
    }

    // 2. Convert elements to UI nodes
    const nodes = this._convertElementsToNodes(elements, windowInfo, screenState);

    // 3. Build spatial hierarchy
    this._buildSpatialHierarchy(nodes, screenState);

    // 4. Detect regions/subtrees
    this._detectRegions(nodes, screenState);

    // 5. Generate semantic descriptions
    this._generateDescriptions(screenState, windowInfo);

    console.log(`✅ Built UI tree: ${screenState.nodes.size} nodes (${screenState.metadata.detectionMethod})`);

    return screenState;
  }

  /**
   * Convert detected elements to UI semantic nodes
   * @private
   */
  _convertElementsToNodes(elements, windowInfo, screenState) {
    const nodes = [];

    for (const element of elements) {
      const nodeId = uuidv4();
      
      const bbox = element.bbox;
      const normalizedBbox = this._normalizeBbox(
        bbox,
        screenState.screenDimensions.width,
        screenState.screenDimensions.height
      );

      const node = {
        id: nodeId,
        type: element.type,
        text: element.text || '',
        description: '', // Will be generated later
        bbox: bbox,
        normalizedBbox: normalizedBbox,
        parentId: null,
        childrenIds: [],
        hierarchyPath: [],
        metadata: {
          app: windowInfo.app || 'Unknown',
          url: windowInfo.url || null,
          windowTitle: windowInfo.title || null,
          visible: true,
          clickable: this._isClickable(element),
          interactive: this._isInteractive(element),
          ocrConfidence: element.metadata?.ocrConfidence || element.ocrConfidence || 0,
          detectionConfidence: element.confidence || 0,
          detectionSource: element.source || 'unknown',
          screenRegion: this._getScreenRegion(normalizedBbox),
          zIndex: element.zIndex || 0,
          cocoLabel: element.cocoLabel || null
        },
        timestamp: Date.now()
      };

      nodes.push(node);
      screenState.nodes.set(nodeId, node);
    }

    return nodes;
  }

  /**
   * OCR-only fallback
   * @private
   */
  _ocrFallback(ocrResults) {
    if (!ocrResults.words || ocrResults.words.length === 0) {
      return [];
    }

    return ocrResults.words.map(word => ({
      type: this._inferElementTypeFromOCR(word),
      bbox: word.bbox || [word.x0, word.y0, word.x1, word.y1],
      text: word.text || '',
      confidence: word.confidence || 0.9,
      source: 'ocr',
      metadata: {
        ocrConfidence: word.confidence
      }
    }));
  }

  /**
   * Infer element type from OCR word (heuristic fallback)
   * @private
   */
  _inferElementTypeFromOCR(word) {
    const text = (word.text || '').toLowerCase();
    
    // Button-like patterns
    if (/^(ok|cancel|submit|save|delete|send|create|add|remove|edit|update|close|confirm|apply|next|back|continue|finish|start|stop|play|pause|search|login|signup|register|download|upload|export|import)$/i.test(text)) {
      return 'button';
    }

    // Link-like patterns
    if (text.includes('http') || text.includes('www.') || text.includes('.com')) {
      return 'link';
    }

    // Input field indicators
    if (text.includes('enter') || text.includes('type') || text.includes('search')) {
      return 'input';
    }

    // Default to text
    return 'text';
  }

  /**
   * Determine if element is clickable
   * @private
   */
  _isClickable(element) {
    const clickableTypes = ['button', 'link', 'checkbox', 'radio', 'dropdown', 'menu_item', 'tab'];
    
    if (clickableTypes.includes(element.type)) {
      return true;
    }

    // Check text content for button-like words
    const text = (element.text || '').toLowerCase();
    const clickableKeywords = ['button', 'click', 'submit', 'ok', 'cancel', 'save', 'delete', 'send', 'close'];
    return clickableKeywords.some(keyword => text.includes(keyword));
  }

  /**
   * Determine if element is interactive
   * @private
   */
  _isInteractive(element) {
    const interactiveTypes = ['input', 'checkbox', 'radio', 'dropdown'];
    
    if (interactiveTypes.includes(element.type)) {
      return true;
    }

    const text = (element.text || '').toLowerCase();
    const interactiveKeywords = ['input', 'search', 'enter', 'type', 'field', 'textarea'];
    return interactiveKeywords.some(keyword => text.includes(keyword));
  }

  /**
   * Build spatial hierarchy (parent-child relationships)
   * @private
   */
  _buildSpatialHierarchy(nodes, screenState) {
    // Sort nodes by area (largest first)
    const sortedNodes = [...nodes].sort((a, b) => {
      const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
      const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
      return areaB - areaA;
    });

    // Find parent-child relationships
    for (let i = 0; i < sortedNodes.length; i++) {
      const child = sortedNodes[i];
      
      // Find smallest parent that contains this child
      let parent = null;
      for (let j = 0; j < i; j++) {
        const candidate = sortedNodes[j];
        if (this._contains(candidate.bbox, child.bbox)) {
          if (!parent || this._contains(parent.bbox, candidate.bbox)) {
            parent = candidate;
          }
        }
      }

      if (parent) {
        child.parentId = parent.id;
        parent.childrenIds.push(child.id);
        child.hierarchyPath = [...parent.hierarchyPath, parent.id];
      } else {
        // Root node
        screenState.rootNodeIds.push(child.id);
        child.hierarchyPath = [];
      }
    }
  }

  /**
   * Detect regions/subtrees (dialogs, panels, etc.)
   * @private
   */
  _detectRegions(nodes, screenState) {
    // Group nodes by type and proximity
    const containerTypes = ['dialog', 'modal', 'panel', 'container', 'section'];
    const containerNodes = nodes.filter(n => containerTypes.includes(n.type));

    for (const container of containerNodes) {
      // Find all nodes within this container
      const childNodes = nodes.filter(n => 
        n.id !== container.id && this._contains(container.bbox, n.bbox)
      );

      if (childNodes.length >= 2) {
        const subtree = {
          id: uuidv4(),
          type: container.type,
          title: container.text || this._extractRegionTitle(childNodes),
          description: '', // Will be generated later
          rootNodeId: container.id,
          nodeIds: [container.id, ...childNodes.map(n => n.id)],
          bbox: container.bbox,
          timestamp: Date.now()
        };

        screenState.subtrees.push(subtree);
      }
    }
  }

  /**
   * Generate semantic descriptions for all nodes and subtrees
   * @private
   */
  _generateDescriptions(screenState, windowInfo) {
    const context = {
      app: screenState.app,
      url: screenState.url,
      windowTitle: screenState.windowTitle
    };

    // Generate node descriptions
    for (const [nodeId, node] of screenState.nodes.entries()) {
      node.description = this.descriptionGenerator.generateNodeDescription(node, context);
    }

    // Generate subtree descriptions
    for (const subtree of screenState.subtrees) {
      const subtreeNodes = subtree.nodeIds
        .map(id => screenState.nodes.get(id))
        .filter(n => n !== undefined);
      
      subtree.description = this.descriptionGenerator.generateSubtreeDescription(
        subtree,
        subtreeNodes,
        context
      );
    }

    // Generate screen-level description
    screenState.description = this.descriptionGenerator.generateScreenDescription(screenState);
  }

  // ==================== Helper Methods ====================

  /**
   * Normalize bounding box to 0-999 range (ScreenAI style)
   * @private
   */
  _normalizeBbox(bbox, screenWidth, screenHeight) {
    return [
      Math.round((bbox[0] / screenWidth) * 999),
      Math.round((bbox[1] / screenHeight) * 999),
      Math.round((bbox[2] / screenWidth) * 999),
      Math.round((bbox[3] / screenHeight) * 999)
    ];
  }

  /**
   * Get screen region label
   * @private
   */
  _getScreenRegion(normalizedBbox) {
    const [x1, y1, x2, y2] = normalizedBbox;
    const centerX = (x1 + x2) / 2;
    const centerY = (y1 + y2) / 2;

    let region = '';
    
    // Vertical position
    if (centerY < 333) region += 'top';
    else if (centerY < 666) region += 'middle';
    else region += 'bottom';

    region += '-';

    // Horizontal position
    if (centerX < 333) region += 'left';
    else if (centerX < 666) region += 'center';
    else region += 'right';

    return region;
  }

  /**
   * Check if bbox1 contains bbox2
   * @private
   */
  _contains(bbox1, bbox2) {
    return (
      bbox1[0] <= bbox2[0] &&
      bbox1[1] <= bbox2[1] &&
      bbox1[2] >= bbox2[2] &&
      bbox1[3] >= bbox2[3]
    );
  }

  /**
   * Extract region title from child nodes
   * @private
   */
  _extractRegionTitle(nodes) {
    // Find the topmost text node as title
    const textNodes = nodes.filter(n => n.text && n.text.length > 0);
    if (textNodes.length === 0) return 'Untitled Region';

    const sortedByY = textNodes.sort((a, b) => a.bbox[1] - b.bbox[1]);
    return sortedByY[0].text;
  }
}

export default EnhancedUITreeBuilder;
