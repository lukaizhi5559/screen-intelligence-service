/**
 * UI Semantic Index Service
 * In-memory vector index with hybrid semantic + symbolic search
 * Supports node-level, subtree-level, and screen-level search
 */

const { getEmbeddingService } = require('./embeddingService');

class UISemanticIndex {
  constructor() {
    this.embeddingService = getEmbeddingService();
    
    // In-memory indexes
    this.nodes = new Map(); // id -> UISemanticNode
    this.subtrees = new Map(); // id -> UISubtree
    this.screenStates = new Map(); // id -> UIScreenState
    
    // Temporal index (for history/memory)
    this.timeline = []; // Array of {timestamp, screenStateId}
    
    console.log('🗂️  UI Semantic Index initialized');
  }

  /**
   * Index a complete screen state
   * @param {Object} screenState - UI screen state with nodes and subtrees
   */
  async indexScreenState(screenState) {
    try {
      console.log(`📇 Indexing screen state: ${screenState.id}`);

      // 1. Index all nodes
      const nodePromises = [];
      for (const [nodeId, node] of screenState.nodes.entries()) {
        if (!node.embedding && node.description) {
          nodePromises.push(
            this.embeddingService.embed(node.description).then(embedding => {
              node.embedding = embedding;
              this.nodes.set(nodeId, node);
            })
          );
        } else {
          this.nodes.set(nodeId, node);
        }
      }
      await Promise.all(nodePromises);

      // 2. Index all subtrees
      const subtreePromises = [];
      for (const subtree of screenState.subtrees) {
        if (!subtree.embedding && subtree.description) {
          subtreePromises.push(
            this.embeddingService.embed(subtree.description).then(embedding => {
              subtree.embedding = embedding;
              this.subtrees.set(subtree.id, subtree);
            })
          );
        } else {
          this.subtrees.set(subtree.id, subtree);
        }
      }
      await Promise.all(subtreePromises);

      // 3. Index screen-level description
      if (!screenState.embedding && screenState.description) {
        screenState.embedding = await this.embeddingService.embed(screenState.description);
      }
      this.screenStates.set(screenState.id, screenState);

      // 4. Add to timeline
      this.timeline.push({
        timestamp: screenState.timestamp,
        screenStateId: screenState.id
      });
      this.timeline.sort((a, b) => a.timestamp - b.timestamp);

      console.log(`✅ Indexed: ${this.nodes.size} nodes, ${this.subtrees.size} subtrees, ${this.screenStates.size} screens`);
    } catch (error) {
      console.error('❌ Failed to index screen state:', error);
      throw error;
    }
  }

  /**
   * Hybrid search: symbolic prefilter + semantic ranking
   * @param {Object} query - Search query with filters
   * @returns {Promise<Array>} Search results
   */
  async search(query) {
    try {
      console.log('🔍 Searching:', query.query);

      // 1. Embed the query
      const queryEmbedding = await this.embeddingService.embed(query.query);

      // 2. Symbolic prefilter
      const candidateNodes = this._symbolicPrefilter(
        Array.from(this.nodes.values()),
        query.filters || {}
      );

      console.log(`📊 Prefilter: ${candidateNodes.length} candidates from ${this.nodes.size} nodes`);

      // 3. Semantic ranking
      const results = this._semanticRank(
        candidateNodes,
        queryEmbedding,
        query.k || 5,
        query.minScore || 0.0
      );

      console.log(`✅ Found ${results.length} results`);
      return results;
    } catch (error) {
      console.error('❌ Search failed:', error);
      throw error;
    }
  }

  /**
   * Search for screen states in history
   * @param {string} query - Natural language query
   * @param {Object} timeRange - {start, end} timestamps
   * @param {number} k - Number of results
   * @returns {Promise<Array>} Screen state results
   */
  async searchHistory(query, timeRange = {}, k = 5) {
    try {
      // Filter screens by time range
      let candidateScreens = Array.from(this.screenStates.values());
      
      if (timeRange.start || timeRange.end) {
        candidateScreens = candidateScreens.filter(screen => {
          if (timeRange.start && screen.timestamp < timeRange.start) return false;
          if (timeRange.end && screen.timestamp > timeRange.end) return false;
          return true;
        });
      }

      if (candidateScreens.length === 0) {
        return [];
      }

      // Embed query
      const queryEmbedding = await this.embeddingService.embed(query);

      // Rank by similarity
      const results = candidateScreens.map(screen => ({
        id: screen.id,
        resultType: 'screen',
        score: this.embeddingService.cosineSimilarity(queryEmbedding, screen.embedding),
        screenState: screen
      }));

      // Sort and return top-k
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, k);
    } catch (error) {
      console.error('❌ History search failed:', error);
      throw error;
    }
  }

  /**
   * Get a node by ID
   * @param {string} id - Node ID
   * @returns {Object|null} Node or null
   */
  getNode(id) {
    return this.nodes.get(id) || null;
  }

  /**
   * Get a subtree by ID
   * @param {string} id - Subtree ID
   * @returns {Object|null} Subtree or null
   */
  getSubtree(id) {
    return this.subtrees.get(id) || null;
  }

  /**
   * Get a screen state by ID
   * @param {string} id - Screen state ID
   * @returns {Object|null} Screen state or null
   */
  getScreenState(id) {
    return this.screenStates.get(id) || null;
  }

  /**
   * Get screen history in time range
   * @param {number} startTime - Start timestamp
   * @param {number} endTime - End timestamp
   * @returns {Array} Array of screen states
   */
  getScreenHistory(startTime, endTime) {
    const screenIds = this.timeline
      .filter(entry => entry.timestamp >= startTime && entry.timestamp <= endTime)
      .map(entry => entry.screenStateId);

    return screenIds
      .map(id => this.screenStates.get(id))
      .filter(screen => screen !== undefined);
  }

  /**
   * Clear the index
   */
  clear() {
    this.nodes.clear();
    this.subtrees.clear();
    this.screenStates.clear();
    this.timeline = [];
    console.log('🧹 Index cleared');
  }

  // ==================== Private Methods ====================

  /**
   * Symbolic prefilter: Apply rule-based filters
   * @private
   */
  _symbolicPrefilter(nodes, filters) {
    let filtered = nodes;

    // Filter by types
    if (filters.types && filters.types.length > 0) {
      filtered = filtered.filter(n => filters.types.includes(n.type));
    }

    // Filter by app
    if (filters.app) {
      filtered = filtered.filter(n => n.metadata.app === filters.app);
    }

    // Filter by screen ID
    if (filters.screenId) {
      filtered = filtered.filter(n => {
        // Assuming nodes have a screenId in metadata
        return n.metadata.screenId === filters.screenId;
      });
    }

    // Filter by clickable
    if (filters.clickableOnly) {
      filtered = filtered.filter(n => n.metadata.clickable === true);
    }

    // Filter by visible
    if (filters.visibleOnly) {
      filtered = filtered.filter(n => n.metadata.visible === true);
    }

    // Filter by text content (case-insensitive substring)
    if (filters.textContains) {
      const searchText = filters.textContains.toLowerCase();
      filtered = filtered.filter(n =>
        n.text.toLowerCase().includes(searchText) ||
        n.description.toLowerCase().includes(searchText)
      );
    }

    // Filter by bounding box region
    if (filters.bboxRegion) {
      const { minX, maxX, minY, maxY } = filters.bboxRegion;
      filtered = filtered.filter(n => {
        const [x1, y1, x2, y2] = n.bbox;
        const centerX = (x1 + x2) / 2;
        const centerY = (y1 + y2) / 2;

        if (minX !== undefined && centerX < minX) return false;
        if (maxX !== undefined && centerX > maxX) return false;
        if (minY !== undefined && centerY < minY) return false;
        if (maxY !== undefined && centerY > maxY) return false;

        return true;
      });
    }

    // Filter by time range
    if (filters.timeRange) {
      const { start, end } = filters.timeRange;
      filtered = filtered.filter(n => {
        if (start && n.timestamp < start) return false;
        if (end && n.timestamp > end) return false;
        return true;
      });
    }

    return filtered;
  }

  /**
   * Semantic ranking: Rank by embedding similarity
   * @private
   */
  _semanticRank(nodes, queryEmbedding, k, minScore) {
    // Calculate similarities
    const results = nodes
      .filter(n => n.embedding) // Only nodes with embeddings
      .map(node => ({
        id: node.id,
        resultType: 'node',
        score: this.embeddingService.cosineSimilarity(queryEmbedding, node.embedding),
        node: node
      }))
      .filter(r => r.score >= minScore); // Filter by minimum score

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Return top-k
    return results.slice(0, k);
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton semantic index instance
 * @returns {UISemanticIndex}
 */
function getSemanticIndex() {
  if (!instance) {
    instance = new UISemanticIndex();
  }
  return instance;
}

module.exports = {
  UISemanticIndex,
  getSemanticIndex
};
