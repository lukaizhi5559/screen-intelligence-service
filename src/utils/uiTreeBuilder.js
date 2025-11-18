/**
 * UI Tree Builder
 * Converts OCR results into a semantic UI tree structure
 * Integrates with existing OCR analyzer and prepares for future object detection
 */

const { v4: uuidv4 } = require('uuid');
const SemanticDescriptionGenerator = require('./semanticDescriptionGenerator');

class UITreeBuilder {
  constructor() {
    this.descriptionGenerator = new SemanticDescriptionGenerator();
  }

  /**
   * Build a UI tree from OCR results
   * @param {Object} ocrResults - Results from OCR analyzer
   * @param {Object} windowInfo - Active window information
   * @returns {Object} UIScreenState
   */
  buildTree(ocrResults, windowInfo = {}) {
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
      screenshotPath: ocrResults.screenshotPath || null
    };

    // 1. Convert OCR words to UI nodes
    const nodes = this._convertOCRToNodes(ocrResults, windowInfo, screenState);

    // 2. Build spatial hierarchy
    this._buildSpatialHierarchy(nodes, screenState);

    // 3. Detect regions/subtrees
    this._detectRegions(nodes, screenState);

    // 4. Generate semantic descriptions
    this._generateDescriptions(screenState, windowInfo);

    return screenState;
  }

  /**
   * Convert OCR words to UI semantic nodes
   * @private
   */
  _convertOCRToNodes(ocrResults, windowInfo, screenState) {
    const nodes = [];

    if (!ocrResults.words || ocrResults.words.length === 0) {
      return nodes;
    }

    for (const word of ocrResults.words) {
      const nodeId = uuidv4();
      
      const bbox = word.bbox || [word.x0, word.y0, word.x1, word.y1];
      const normalizedBbox = this._normalizeBbox(
        bbox,
        screenState.screenDimensions.width,
        screenState.screenDimensions.height
      );

      const node = {
        id: nodeId,
        type: this._inferElementType(word),
        text: word.text || '',
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
          clickable: this._isLikelyClickable(word),
          interactive: this._isLikelyInteractive(word),
          ocrConfidence: word.confidence || 0,
          screenRegion: this._getScreenRegion(normalizedBbox),
          zIndex: word.zIndex || 0
        },
        timestamp: Date.now()
      };

      nodes.push(node);
      screenState.nodes.set(nodeId, node);
    }

    return nodes;
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
    // Simple region detection based on spatial clustering
    // TODO: Enhance with object detection model (DETR)

    const regions = this._clusterNodesByProximity(nodes);

    for (const region of regions) {
      if (region.nodes.length < 3) continue; // Skip small regions

      const subtree = {
        id: uuidv4(),
        type: this._inferRegionType(region),
        title: this._extractRegionTitle(region),
        description: '', // Will be generated later
        rootNodeId: region.nodes[0].id,
        nodeIds: region.nodes.map(n => n.id),
        bbox: this._computeBoundingBox(region.nodes),
        timestamp: Date.now()
      };

      screenState.subtrees.push(subtree);
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
   * Infer element type from OCR word
   * @private
   */
  _inferElementType(word) {
    // TODO: Use object detection model to determine actual type
    // For now, classify based on text patterns
    
    const text = (word.text || '').toLowerCase();
    
    // Button-like patterns
    if (/^(ok|cancel|submit|save|delete|send|create|add|remove|edit|update|close|confirm)$/i.test(text)) {
      return 'button';
    }

    // Link-like patterns
    if (text.includes('http') || text.includes('www.')) {
      return 'link';
    }

    // Default to text
    return 'text';
  }

  /**
   * Check if element is likely clickable
   * @private
   */
  _isLikelyClickable(word) {
    const text = (word.text || '').toLowerCase();
    const clickableKeywords = ['button', 'link', 'click', 'submit', 'ok', 'cancel', 'save', 'delete', 'send'];
    return clickableKeywords.some(keyword => text.includes(keyword));
  }

  /**
   * Check if element is likely interactive
   * @private
   */
  _isLikelyInteractive(word) {
    const text = (word.text || '').toLowerCase();
    const interactiveKeywords = ['input', 'search', 'enter', 'type', 'field'];
    return interactiveKeywords.some(keyword => text.includes(keyword));
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
   * Cluster nodes by spatial proximity
   * @private
   */
  _clusterNodesByProximity(nodes) {
    // Simple clustering: group nodes that are close together
    const clusters = [];
    const visited = new Set();

    for (const node of nodes) {
      if (visited.has(node.id)) continue;

      const cluster = { nodes: [node] };
      visited.add(node.id);

      // Find nearby nodes
      for (const other of nodes) {
        if (visited.has(other.id)) continue;
        
        const distance = this._bboxDistance(node.bbox, other.bbox);
        if (distance < 100) { // Threshold for proximity
          cluster.nodes.push(other);
          visited.add(other.id);
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  /**
   * Calculate distance between two bounding boxes
   * @private
   */
  _bboxDistance(bbox1, bbox2) {
    const center1 = [(bbox1[0] + bbox1[2]) / 2, (bbox1[1] + bbox1[3]) / 2];
    const center2 = [(bbox2[0] + bbox2[2]) / 2, (bbox2[1] + bbox2[3]) / 2];
    
    return Math.sqrt(
      Math.pow(center1[0] - center2[0], 2) +
      Math.pow(center1[1] - center2[1], 2)
    );
  }

  /**
   * Infer region type from cluster
   * @private
   */
  _inferRegionType(region) {
    // TODO: Use object detection to determine actual region type
    return 'section';
  }

  /**
   * Extract region title from cluster
   * @private
   */
  _extractRegionTitle(region) {
    // Find the largest or topmost text node as title
    const sortedNodes = [...region.nodes].sort((a, b) => a.bbox[1] - b.bbox[1]);
    return sortedNodes[0]?.text || 'Untitled Region';
  }

  /**
   * Compute bounding box that encompasses all nodes
   * @private
   */
  _computeBoundingBox(nodes) {
    if (nodes.length === 0) return [0, 0, 0, 0];

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const node of nodes) {
      minX = Math.min(minX, node.bbox[0]);
      minY = Math.min(minY, node.bbox[1]);
      maxX = Math.max(maxX, node.bbox[2]);
      maxY = Math.max(maxY, node.bbox[3]);
    }

    return [minX, minY, maxX, maxY];
  }
}

module.exports = UITreeBuilder;
