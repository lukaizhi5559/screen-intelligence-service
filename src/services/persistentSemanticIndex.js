/**
 * Persistent Semantic Index
 * Drop-in replacement for in-memory semantic index using DuckDB backend
 * Maintains same API but with persistent storage
 */

import { getDuckDBVectorStore } from './duckdbVectorStore.js';
import { getEmbeddingService, getSearchEmbeddingService } from './embeddingService.js';

class PersistentSemanticIndex {
  constructor(dbPath = null) {
    this.vectorStore = getDuckDBVectorStore(dbPath);
    this.embeddingService = getEmbeddingService(); // For indexing
    this.searchEmbeddingService = getSearchEmbeddingService(); // Dedicated for searches
    this.isInitialized = false;
    
    console.log('🗄️  Persistent Semantic Index initialized');
  }

  /**
   * Initialize the index
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      // Initialize both embedding services
      await Promise.all([
        this.embeddingService.initialize(),
        this.searchEmbeddingService.initialize()
      ]);
      
      // Initialize DuckDB vector store
      await this.vectorStore.initialize();
      
      this.isInitialized = true;
      
      // Log stats
      const stats = await this.vectorStore.getStats();
      console.log('📊 Database stats:', stats);
    } catch (error) {
      console.error('❌ Failed to initialize persistent index:', error);
      throw error;
    }
  }

  /**
   * Index a complete screen state
   * @param {Object} screenState - UI screen state with nodes and subtrees
   */
  async indexScreenState(screenState) {
    await this.initialize();

    try {
      // console.log(`📇 Indexing screen state: ${screenState.id}`);

      // 1. Embed all nodes that don't have embeddings
      // nodes is now an array instead of a Map
      const nodesToEmbed = [];
      for (const node of screenState.nodes) {
        if (!node.embedding && node.description) {
          nodesToEmbed.push({ id: node.id, description: node.description });
        }
      }

      if (nodesToEmbed.length > 0) {
        console.log(`🧠 Embedding ${nodesToEmbed.length} nodes...`);
        const descriptions = nodesToEmbed.map(n => n.description);
        const embeddings = await this.embeddingService.embedBatch(descriptions);
        
        console.log(`   ✅ Generated ${embeddings.length} embeddings`);
        console.log(`   Sample embedding length: ${embeddings[0]?.length || 'N/A'}`);
        
        // Assign embeddings back to nodes
        // nodes is now an array, so find by id
        nodesToEmbed.forEach((item, idx) => {
          const node = screenState.nodes.find(n => n.id === item.id);
          if (node) {
            node.embedding = embeddings[idx];
          }
        });
      }

      // 2. Embed all subtrees that don't have embeddings
      const subtreesToEmbed = screenState.subtrees.filter(s => !s.embedding && s.description);
      if (subtreesToEmbed.length > 0) {
        // console.log(`🧠 Embedding ${subtreesToEmbed.length} subtrees...`);
        const descriptions = subtreesToEmbed.map(s => s.description);
        const embeddings = await this.embeddingService.embedBatch(descriptions);
        
        subtreesToEmbed.forEach((subtree, idx) => {
          subtree.embedding = embeddings[idx];
        });
      }

      // 3. Embed screen-level description if needed
      if (!screenState.embedding && screenState.description) {
        // console.log('🧠 Embedding screen state...');
        screenState.embedding = await this.embeddingService.embed(screenState.description);
      }

      // 4. Insert into DuckDB
      // console.log('💾 Saving to database...');
      await this.vectorStore.insertScreenState(screenState);

      const stats = await this.vectorStore.getStats();
      console.log(`✅ Indexed: ${stats.nodes} total nodes, ${stats.screens} total screens`);
    } catch (error) {
      console.error('❌ Failed to index screen state:', error);
      throw error;
    }
  }

  /**
   * Hybrid search: symbolic prefilter + semantic ranking (via DuckDB)
   * @param {Object} query - Search query with filters
   * @returns {Promise<Array>} Search results
   */
  async search(query) {
    await this.initialize();

    try {
      // console.log('🔍 Searching:', query.query);

      // 1. Embed the query using dedicated search embedding service (non-blocking)
      const queryEmbedding = await this.searchEmbeddingService.embed(query.query);

      // 2. DuckDB does hybrid search in one query (symbolic filters + vector search)
      const results = await this.vectorStore.searchNodes(
        queryEmbedding,
        query.filters || {},
        query.k || 5,
        query.minScore || 0.0
      );

      // console.log(`✅ Found ${results.length} results`);
      
      // Format results to match expected structure
      return results.map(node => ({
        id: node.id,
        resultType: 'node',
        score: node.score,
        node: node
      }));
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
    await this.initialize();

    try {
      // Embed query using dedicated search embedding service
      const queryEmbedding = await this.searchEmbeddingService.embed(query);

      // Search via DuckDB
      const results = await this.vectorStore.searchScreenStates(
        queryEmbedding,
        timeRange,
        k
      );

      // Format results
      return results.map(screen => ({
        id: screen.id,
        resultType: 'screen',
        score: screen.score,
        screenState: screen
      }));
    } catch (error) {
      console.error('❌ History search failed:', error);
      throw error;
    }
  }

  /**
   * Get a node by ID
   * @param {string} id - Node ID
   * @returns {Promise<Object|null>} Node or null
   */
  async getNode(id) {
    await this.initialize();
    return await this.vectorStore.getNode(id);
  }

  /**
   * Get a subtree by ID
   * @param {string} id - Subtree ID
   * @returns {Promise<Object|null>} Subtree or null
   */
  async getSubtree(id) {
    await this.initialize();
    // TODO: Add getSubtree to vectorStore
    return null;
  }

  /**
   * Get a screen state by ID
   * @param {string} id - Screen state ID
   * @returns {Promise<Object|null>} Screen state or null
   */
  async getScreenState(id) {
    await this.initialize();
    const screen = await this.vectorStore.getScreenState(id);
    
    if (screen) {
      // Load all nodes for this screen
      const nodes = await this.vectorStore.getNodesForScreen(id);
      screen.nodes = new Map(nodes.map(n => [n.id, n]));
    }
    
    return screen;
  }

  /**
   * Get screen history in time range
   * @param {number} startTime - Start timestamp
   * @param {number} endTime - End timestamp
   * @returns {Promise<Array>} Array of screen states
   */
  async getScreenHistory(startTime, endTime) {
    await this.initialize();
    
    const results = await this.vectorStore.searchScreenStates(
      null, // No embedding needed for time-based search
      { start: startTime, end: endTime },
      1000 // Get all in range
    );
    
    return results;
  }

  /**
   * Clear old data (cleanup)
   * @param {number} olderThanMs - Delete data older than this many milliseconds
   */
  async cleanup(olderThanMs = 24 * 60 * 60 * 1000) {
    await this.initialize();
    
    const cutoffTime = Date.now() - olderThanMs;
    await this.vectorStore.deleteOldScreenStates(cutoffTime);
    
    console.log(`🧹 Cleaned up data older than ${new Date(cutoffTime).toLocaleString()}`);
  }

  /**
   * Get database statistics
   */
  async getStats() {
    await this.initialize();
    return await this.vectorStore.getStats();
  }

  /**
   * Clear the entire index (use with caution!)
   */
  async clear() {
    await this.initialize();
    
    // Delete all data
    await this.vectorStore.deleteOldScreenStates(Date.now() + 1000);
    
    console.log('🧹 Index cleared');
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.vectorStore) {
      await this.vectorStore.close();
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton persistent semantic index instance
 * @param {string} dbPath - Optional database path
 * @returns {PersistentSemanticIndex}
 */
function getPersistentSemanticIndex(dbPath = null) {
  if (!instance) {
    instance = new PersistentSemanticIndex(dbPath);
  }
  return instance;
}

export {
  PersistentSemanticIndex,
  getPersistentSemanticIndex
};
