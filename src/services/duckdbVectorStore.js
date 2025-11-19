/**
 * DuckDB Vector Store
 * Persistent storage for UI semantic nodes with vector search
 * Uses DuckDB with VSS (Vector Similarity Search) extension
 */

import duckdb from 'duckdb';
import path from 'path';
import os from 'os';
import fs from 'fs';

class DuckDBVectorStore {
  constructor(dbPath = null) {
    this.dbPath = dbPath || path.join(os.homedir(), '.thinkdrop', 'semantic-ui.duckdb');
    this.db = null;
    this.connection = null;
    this.isInitialized = false;
    this.embeddingDimension = 384; // MiniLM-L6-v2
  }

  /**
   * Initialize DuckDB database and create schema
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      console.log('🦆 Initializing DuckDB vector store...');
      console.log(`   Database: ${this.dbPath}`);

      // Ensure directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // Create database connection
      this.db = new duckdb.Database(this.dbPath);
      this.connection = this.db.connect();

      // Install and load VSS extension for vector search
      await this._execute(`INSTALL vss;`);
      await this._execute(`LOAD vss;`);

      // Enable experimental HNSW persistence
      await this._execute(`SET hnsw_enable_experimental_persistence = true;`);

      // Create schema
      await this._createSchema();

      this.isInitialized = true;
      console.log('✅ DuckDB vector store initialized');
    } catch (error) {
      console.error('❌ Failed to initialize DuckDB:', error);
      throw error;
    }
  }

  /**
   * Create database schema
   * @private
   */
  async _createSchema() {
    // UI Nodes table
    await this._execute(`
      CREATE TABLE IF NOT EXISTS ui_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        text TEXT,
        description TEXT NOT NULL,
        bbox_x1 INTEGER,
        bbox_y1 INTEGER,
        bbox_x2 INTEGER,
        bbox_y2 INTEGER,
        normalized_bbox_x1 INTEGER,
        normalized_bbox_y1 INTEGER,
        normalized_bbox_x2 INTEGER,
        normalized_bbox_y2 INTEGER,
        parent_id TEXT,
        screen_state_id TEXT NOT NULL,
        app TEXT,
        url TEXT,
        window_title TEXT,
        visible BOOLEAN,
        clickable BOOLEAN,
        interactive BOOLEAN,
        screen_region TEXT,
        ocr_confidence REAL,
        detection_confidence REAL,
        icon_type TEXT,
        image_caption TEXT,
        z_index INTEGER,
        timestamp BIGINT NOT NULL,
        embedding FLOAT[${this.embeddingDimension}]
      );
    `);

    // Create indexes for fast filtering
    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON ui_nodes(type);
    `);
    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_nodes_app ON ui_nodes(app);
    `);
    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_nodes_screen_state ON ui_nodes(screen_state_id);
    `);
    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_nodes_timestamp ON ui_nodes(timestamp);
    `);
    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_nodes_clickable ON ui_nodes(clickable);
    `);

    // Create HNSW index for vector search
    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_nodes_embedding 
      ON ui_nodes USING HNSW(embedding)
      WITH (metric = 'cosine');
    `);

    // UI Subtrees table
    await this._execute(`
      CREATE TABLE IF NOT EXISTS ui_subtrees (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT,
        description TEXT NOT NULL,
        root_node_id TEXT,
        screen_state_id TEXT NOT NULL,
        bbox_x1 INTEGER,
        bbox_y1 INTEGER,
        bbox_x2 INTEGER,
        bbox_y2 INTEGER,
        timestamp BIGINT NOT NULL,
        embedding FLOAT[${this.embeddingDimension}]
      );
    `);

    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_subtrees_screen_state ON ui_subtrees(screen_state_id);
    `);
    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_subtrees_embedding 
      ON ui_subtrees USING HNSW(embedding)
      WITH (metric = 'cosine');
    `);

    // UI Screen States table
    await this._execute(`
      CREATE TABLE IF NOT EXISTS ui_screen_states (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        app TEXT NOT NULL,
        url TEXT,
        window_title TEXT,
        screen_width INTEGER,
        screen_height INTEGER,
        screenshot_path TEXT,
        timestamp BIGINT NOT NULL,
        embedding FLOAT[${this.embeddingDimension}]
      );
    `);

    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_screen_states_app ON ui_screen_states(app);
    `);
    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_screen_states_timestamp ON ui_screen_states(timestamp);
    `);
    await this._execute(`
      CREATE INDEX IF NOT EXISTS idx_screen_states_embedding 
      ON ui_screen_states USING HNSW(embedding)
      WITH (metric = 'cosine');
    `);

    console.log('✅ Database schema created');
  }

  /**
   * Insert a UI node
   */
  async insertNode(node) {
    try {
      // Convert embedding array to DuckDB array literal syntax
      const embeddingLiteral = node.embedding && Array.isArray(node.embedding)
        ? `[${node.embedding.join(',')}]`
        : 'NULL';

      const sql = `
        INSERT OR REPLACE INTO ui_nodes (
          id, type, text, description,
          bbox_x1, bbox_y1, bbox_x2, bbox_y2,
          normalized_bbox_x1, normalized_bbox_y1, normalized_bbox_x2, normalized_bbox_y2,
          parent_id, screen_state_id,
          app, url, window_title,
          visible, clickable, interactive,
          screen_region, ocr_confidence, detection_confidence,
          icon_type, image_caption, z_index,
          timestamp, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${embeddingLiteral});
      `;

      // Handle missing fields with defaults
      const bbox = node.bbox || [0, 0, 0, 0];
      const normalizedBbox = node.normalizedBbox || bbox;
      const metadata = node.metadata || {};

      const params = [
        node.id,
        node.type,
        node.text || null,
        node.description,
        bbox[0], bbox[1], bbox[2], bbox[3],
        normalizedBbox[0], normalizedBbox[1], normalizedBbox[2], normalizedBbox[3],
        node.parentId || null,
        metadata.screenStateId || 'unknown',
        metadata.app || null,
        metadata.url || null,
        metadata.windowTitle || null,
        metadata.visible !== undefined ? metadata.visible : true,
        node.clickable !== undefined ? node.clickable : (metadata.clickable || false),
        metadata.interactive !== undefined ? metadata.interactive : false,
        metadata.screenRegion || null,
        metadata.ocrConfidence || null,
        node.confidence || metadata.detectionConfidence || null,
        metadata.iconType || null,
        metadata.imageCaption || null,
        metadata.zIndex || null,
        node.timestamp || Date.now()
        // Note: embedding is embedded in SQL, not as parameter
      ];

      await this._execute(sql, params);
    } catch (error) {
      console.error('❌ Failed to insert node:', {
        nodeId: node.id,
        type: node.type,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Insert multiple nodes in batch
   */
  async insertNodesBatch(nodes) {
    // Note: No explicit transaction needed - DuckDB auto-commits each INSERT OR REPLACE
    // This prevents "cannot start a transaction within a transaction" errors
    // when multiple concurrent analysis requests are processed
    for (const node of nodes) {
      await this.insertNode(node);
    }
  }

  /**
   * Insert a subtree
   */
  async insertSubtree(subtree) {
    // Convert embedding array to DuckDB array literal syntax
    const embeddingLiteral = subtree.embedding && Array.isArray(subtree.embedding)
      ? `[${subtree.embedding.join(',')}]`
      : 'NULL';

    const sql = `
      INSERT OR REPLACE INTO ui_subtrees (
        id, type, title, description, root_node_id, screen_state_id,
        bbox_x1, bbox_y1, bbox_x2, bbox_y2,
        timestamp, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${embeddingLiteral});
    `;

    const params = [
      subtree.id,
      subtree.type,
      subtree.title,
      subtree.description,
      subtree.rootNodeId,
      subtree.screenStateId || 'unknown',
      subtree.bbox[0], subtree.bbox[1], subtree.bbox[2], subtree.bbox[3],
      subtree.timestamp
      // Note: embedding is embedded in SQL, not as parameter
    ];

    await this._execute(sql, params);
  }

  /**
   * Insert a screen state
   */
  async insertScreenState(screenState) {
    try {
      console.log(`💾 Inserting screen state: ${screenState.id} with ${screenState.nodes.size} nodes`);
      
      // Convert embedding array to DuckDB array literal syntax
      const embeddingLiteral = screenState.embedding && Array.isArray(screenState.embedding)
        ? `[${screenState.embedding.join(',')}]`
        : 'NULL';

      const sql = `
        INSERT OR REPLACE INTO ui_screen_states (
          id, description, app, url, window_title,
          screen_width, screen_height, screenshot_path,
          timestamp, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${embeddingLiteral});
      `;

      const params = [
        screenState.id,
        screenState.description,
        screenState.app,
        screenState.url,
        screenState.windowTitle,
        screenState.screenDimensions.width,
        screenState.screenDimensions.height,
        screenState.screenshotPath,
        screenState.timestamp
        // Note: embedding is embedded in SQL, not as parameter
      ];

      await this._execute(sql, params);
      console.log(`✅ Screen state inserted: ${screenState.id}`);

      // Insert all nodes
      const nodes = Array.from(screenState.nodes.values()).map(node => ({
        ...node,
        metadata: {
          ...(node.metadata || {}),
          screenStateId: screenState.id
        }
      }));
      console.log(`💾 Inserting ${nodes.length} nodes...`);
      await this.insertNodesBatch(nodes);
      console.log(`✅ All nodes inserted`);

      // Insert all subtrees
      if (screenState.subtrees && screenState.subtrees.length > 0) {
        console.log(`💾 Inserting ${screenState.subtrees.length} subtrees...`);
        for (const subtree of screenState.subtrees) {
          subtree.screenStateId = screenState.id;
          await this.insertSubtree(subtree);
        }
        console.log(`✅ All subtrees inserted`);
      }

      // Checkpoint immediately after inserting to prevent WAL buildup
      // This ensures data is persisted and Database Explorer can access it
      await this.checkpoint();
    } catch (error) {
      console.error('❌ Failed to insert screen state:', {
        screenId: screenState.id,
        nodeCount: screenState.nodes?.size,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Vector search for nodes
   */
  async searchNodes(queryEmbedding, filters = {}, k = 5, minScore = 0.0) {
    // Convert query embedding to DuckDB array literal syntax
    const embeddingLiteral = Array.isArray(queryEmbedding)
      ? `[${queryEmbedding.join(',')}]`
      : 'NULL';

    let sql = `
      SELECT 
        id, type, text, description,
        bbox_x1, bbox_y1, bbox_x2, bbox_y2,
        normalized_bbox_x1, normalized_bbox_y1, normalized_bbox_x2, normalized_bbox_y2,
        parent_id, screen_state_id,
        app, url, window_title,
        visible, clickable, interactive,
        screen_region, ocr_confidence, detection_confidence,
        icon_type, image_caption, z_index,
        timestamp,
        array_cosine_similarity(embedding, ${embeddingLiteral}::FLOAT[${this.embeddingDimension}]) AS score
      FROM ui_nodes
      WHERE 1=1
    `;

    const params = [];

    // Apply filters
    if (filters.types && filters.types.length > 0) {
      sql += ` AND type IN (${filters.types.map(() => '?').join(',')})`;
      params.push(...filters.types);
    }

    if (filters.app) {
      sql += ` AND app = ?`;
      params.push(filters.app);
    }

    if (filters.screenId) {
      sql += ` AND screen_state_id = ?`;
      params.push(filters.screenId);
    }

    if (filters.clickableOnly) {
      sql += ` AND clickable = true`;
    }

    if (filters.visibleOnly) {
      sql += ` AND visible = true`;
    }

    if (filters.textContains) {
      sql += ` AND (LOWER(text) LIKE ? OR LOWER(description) LIKE ?)`;
      const searchTerm = `%${filters.textContains.toLowerCase()}%`;
      params.push(searchTerm, searchTerm);
    }

    if (filters.bboxRegion) {
      const { minX, maxX, minY, maxY } = filters.bboxRegion;
      if (minX !== undefined) {
        sql += ` AND (bbox_x1 + bbox_x2) / 2 >= ?`;
        params.push(minX);
      }
      if (maxX !== undefined) {
        sql += ` AND (bbox_x1 + bbox_x2) / 2 <= ?`;
        params.push(maxX);
      }
      if (minY !== undefined) {
        sql += ` AND (bbox_y1 + bbox_y2) / 2 >= ?`;
        params.push(minY);
      }
      if (maxY !== undefined) {
        sql += ` AND (bbox_y1 + bbox_y2) / 2 <= ?`;
        params.push(maxY);
      }
    }

    if (filters.timeRange) {
      if (filters.timeRange.start) {
        sql += ` AND timestamp >= ?`;
        params.push(filters.timeRange.start);
      }
      if (filters.timeRange.end) {
        sql += ` AND timestamp <= ?`;
        params.push(filters.timeRange.end);
      }
    }

    // Filter by minimum score and order by score
    sql += ` AND array_cosine_similarity(embedding, ${embeddingLiteral}::FLOAT[${this.embeddingDimension}]) >= ?`;
    params.push(minScore);

    sql += ` ORDER BY score DESC LIMIT ?`;
    params.push(k);

    const rows = await this._query(sql, params);
    return rows.map(row => this._rowToNode(row));
  }

  /**
   * Search screen states
   */
  async searchScreenStates(queryEmbedding, timeRange = {}, k = 5) {
    // Convert query embedding to DuckDB array literal syntax
    const embeddingLiteral = Array.isArray(queryEmbedding)
      ? `[${queryEmbedding.join(',')}]`
      : 'NULL';

    let sql = `
      SELECT 
        id, description, app, url, window_title,
        screen_width, screen_height, screenshot_path,
        timestamp,
        array_cosine_similarity(embedding, ${embeddingLiteral}::FLOAT[${this.embeddingDimension}]) AS score
      FROM ui_screen_states
      WHERE 1=1
    `;

    const params = [];

    if (timeRange.start) {
      sql += ` AND timestamp >= ?`;
      params.push(timeRange.start);
    }

    if (timeRange.end) {
      sql += ` AND timestamp <= ?`;
      params.push(timeRange.end);
    }

    sql += ` ORDER BY score DESC LIMIT ?`;
    params.push(k);

    const rows = await this._query(sql, params);
    return rows.map(row => this._rowToScreenState(row));
  }

  /**
   * Get node by ID
   */
  async getNode(id) {
    const sql = `SELECT * FROM ui_nodes WHERE id = ?`;
    const rows = await this._query(sql, [id]);
    return rows.length > 0 ? this._rowToNode(rows[0]) : null;
  }

  /**
   * Get screen state by ID
   */
  async getScreenState(id) {
    const sql = `SELECT * FROM ui_screen_states WHERE id = ?`;
    const rows = await this._query(sql, [id]);
    return rows.length > 0 ? this._rowToScreenState(rows[0]) : null;
  }

  /**
   * Get all nodes for a screen state
   */
  async getNodesForScreen(screenStateId) {
    const sql = `SELECT * FROM ui_nodes WHERE screen_state_id = ?`;
    const rows = await this._query(sql, [screenStateId]);
    return rows.map(row => this._rowToNode(row));
  }

  /**
   * Delete old screen states (cleanup)
   */
  async deleteOldScreenStates(beforeTimestamp) {
    await this._execute('BEGIN TRANSACTION;');
    try {
      // Get screen state IDs to delete
      const screenStates = await this._query(
        `SELECT id FROM ui_screen_states WHERE timestamp < ?`,
        [beforeTimestamp]
      );

      const screenStateIds = screenStates.map(row => row.id);

      if (screenStateIds.length > 0) {
        // Delete nodes
        await this._execute(
          `DELETE FROM ui_nodes WHERE screen_state_id IN (${screenStateIds.map(() => '?').join(',')})`,
          screenStateIds
        );

        // Delete subtrees
        await this._execute(
          `DELETE FROM ui_subtrees WHERE screen_state_id IN (${screenStateIds.map(() => '?').join(',')})`,
          screenStateIds
        );

        // Delete screen states
        await this._execute(
          `DELETE FROM ui_screen_states WHERE timestamp < ?`,
          [beforeTimestamp]
        );
      }

      await this._execute('COMMIT;');
      console.log(`🧹 Deleted ${screenStateIds.length} old screen states`);
    } catch (error) {
      await this._execute('ROLLBACK;');
      throw error;
    }
  }

  /**
   * Get database statistics
   */
  async getStats() {
    const nodeCount = await this._query(`SELECT COUNT(*) as count FROM ui_nodes`);
    const subtreeCount = await this._query(`SELECT COUNT(*) as count FROM ui_subtrees`);
    const screenCount = await this._query(`SELECT COUNT(*) as count FROM ui_screen_states`);

    return {
      nodes: nodeCount[0].count,
      subtrees: subtreeCount[0].count,
      screens: screenCount[0].count
    };
  }

  /**
   * Checkpoint the database to flush WAL to disk
   * Call this periodically to prevent large WAL files and ensure data durability
   */
  async checkpoint() {
    try {
      await this._execute('CHECKPOINT;');
      console.log('✅ Database checkpointed');
    } catch (error) {
      console.error('❌ Failed to checkpoint database:', error);
      throw error;
    }
  }

  /**
   * Close database connection
   * Checkpoints before closing to ensure all data is persisted
   */
  async close() {
    try {
      // Checkpoint to flush WAL before closing
      if (this.isInitialized) {
        await this.checkpoint();
      }
    } catch (error) {
      console.error('⚠️  Failed to checkpoint during close:', error);
    }
    
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.isInitialized = false;
    console.log('🦆 DuckDB connection closed');
  }

  // ==================== Private Methods ====================

  /**
   * Execute SQL statement
   * @private
   */
  _execute(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.connection.run(sql, ...params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Execute SQL query
   * @private
   */
  _query(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.connection.all(sql, ...params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Convert database row to UISemanticNode
   * @private
   */
  _rowToNode(row) {
    return {
      id: row.id,
      type: row.type,
      text: row.text,
      description: row.description,
      bbox: [row.bbox_x1, row.bbox_y1, row.bbox_x2, row.bbox_y2],
      normalizedBbox: [
        row.normalized_bbox_x1,
        row.normalized_bbox_y1,
        row.normalized_bbox_x2,
        row.normalized_bbox_y2
      ],
      parentId: row.parent_id,
      metadata: {
        screenStateId: row.screen_state_id,
        app: row.app,
        url: row.url,
        windowTitle: row.window_title,
        visible: row.visible,
        clickable: row.clickable,
        interactive: row.interactive,
        screenRegion: row.screen_region,
        ocrConfidence: row.ocr_confidence,
        detectionConfidence: row.detection_confidence,
        iconType: row.icon_type,
        imageCaption: row.image_caption,
        zIndex: row.z_index
      },
      timestamp: row.timestamp,
      score: row.score // From vector search
    };
  }

  /**
   * Convert database row to UIScreenState
   * @private
   */
  _rowToScreenState(row) {
    return {
      id: row.id,
      description: row.description,
      app: row.app,
      url: row.url,
      windowTitle: row.window_title,
      screenDimensions: {
        width: row.screen_width,
        height: row.screen_height
      },
      screenshotPath: row.screenshot_path,
      timestamp: row.timestamp,
      score: row.score // From vector search
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton DuckDB vector store instance
 */
function getDuckDBVectorStore(dbPath = null) {
  if (!instance) {
    instance = new DuckDBVectorStore(dbPath);
  }
  return instance;
}

export {
  DuckDBVectorStore,
  getDuckDBVectorStore
};
