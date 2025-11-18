/**
 * UI Embedding Service
 * Uses local embedding models (MiniLM/BGE) for semantic search
 * Lightweight and privacy-preserving
 */

import { pipeline } from '@xenova/transformers';

class UIEmbeddingService {
  constructor() {
    this.model = null;
    this.modelName = 'Xenova/all-MiniLM-L6-v2'; // Fast, 384-dim embeddings
    this.isInitialized = false;
    this.initPromise = null;
  }

  /**
   * Initialize the embedding model
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        console.log('🧠 Initializing UI embedding model:', this.modelName);
        
        // Load the feature extraction pipeline
        this.model = await pipeline('feature-extraction', this.modelName, {
          quantized: true, // Use quantized model for speed
        });

        this.isInitialized = true;
        console.log('✅ UI embedding model initialized');
      } catch (error) {
        console.error('❌ Failed to initialize embedding model:', error);
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Embed a single text description
   * @param {string} text - Text to embed
   * @returns {Promise<number[]>} Embedding vector
   */
  async embed(text) {
    await this.initialize();

    if (!text || text.trim().length === 0) {
      throw new Error('Cannot embed empty text');
    }

    try {
      // Generate embedding
      const output = await this.model(text, {
        pooling: 'mean',
        normalize: true,
      });

      // Convert to regular array
      const embedding = Array.from(output.data);
      
      return embedding;
    } catch (error) {
      console.error('❌ Failed to embed text:', error);
      throw error;
    }
  }

  /**
   * Embed multiple text descriptions in batch
   * @param {string[]} texts - Array of texts to embed
   * @returns {Promise<number[][]>} Array of embedding vectors
   */
  async embedBatch(texts) {
    await this.initialize();

    if (!texts || texts.length === 0) {
      return [];
    }

    // Filter out empty texts
    const validTexts = texts.filter(t => t && t.trim().length > 0);
    if (validTexts.length === 0) {
      return [];
    }

    try {
      // Process in batches to avoid memory issues
      const batchSize = 32;
      const embeddings = [];

      for (let i = 0; i < validTexts.length; i += batchSize) {
        const batch = validTexts.slice(i, i + batchSize);
        
        // Generate embeddings for batch
        const batchEmbeddings = await Promise.all(
          batch.map(text => this.embed(text))
        );

        embeddings.push(...batchEmbeddings);
      }

      return embeddings;
    } catch (error) {
      console.error('❌ Failed to embed batch:', error);
      throw error;
    }
  }

  /**
   * Calculate cosine similarity between two embeddings
   * @param {number[]} a - First embedding
   * @param {number[]} b - Second embedding
   * @returns {number} Similarity score (0-1)
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) {
      throw new Error('Invalid embeddings for similarity calculation');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  /**
   * Find top-k most similar embeddings
   * @param {number[]} queryEmbedding - Query embedding
   * @param {Array<{id: string, embedding: number[]}>} candidates - Candidate embeddings
   * @param {number} k - Number of results to return
   * @returns {Array<{id: string, score: number}>} Top-k results
   */
  findTopK(queryEmbedding, candidates, k = 5) {
    if (!queryEmbedding || !candidates || candidates.length === 0) {
      return [];
    }

    // Calculate similarities
    const results = candidates.map(candidate => ({
      id: candidate.id,
      score: this.cosineSimilarity(queryEmbedding, candidate.embedding),
      ...candidate
    }));

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Return top-k
    return results.slice(0, k);
  }

  /**
   * Batch similarity calculation
   * @param {number[]} queryEmbedding - Query embedding
   * @param {number[][]} candidateEmbeddings - Array of candidate embeddings
   * @returns {number[]} Array of similarity scores
   */
  batchSimilarity(queryEmbedding, candidateEmbeddings) {
    return candidateEmbeddings.map(candidate =>
      this.cosineSimilarity(queryEmbedding, candidate)
    );
  }

  /**
   * Get embedding dimension
   * @returns {number} Dimension of embeddings
   */
  getDimension() {
    // MiniLM-L6-v2 produces 384-dimensional embeddings
    return 384;
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    if (this.model) {
      // Transformers.js handles cleanup automatically
      this.model = null;
      this.isInitialized = false;
      console.log('🧹 Embedding model cleaned up');
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton embedding service instance
 * @returns {UIEmbeddingService}
 */
function getEmbeddingService() {
  if (!instance) {
    instance = new UIEmbeddingService();
  }
  return instance;
}

export {
  UIEmbeddingService,
  getEmbeddingService
};
