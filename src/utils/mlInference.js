/**
 * ML-based inference for layout detection
 * Uses Transformers.js with DistilBERT for text classification
 */

import { pipeline } from '@xenova/transformers';

export class MLInference {
  constructor() {
    this.classifier = null;
    this.elementClassifier = null;
    this.embedder = null;
    this.initialized = false;
    this.initPromise = null;
  }

  /**
   * Initialize ML models (call once at startup)
   * Returns a promise that resolves when models are loaded
   */
  async init() {
    // Prevent multiple initializations
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        console.log('🤖 [ML] Loading Transformers.js models...');
        const startTime = Date.now();
        
        // Zero-shot classifier for structure and element detection
        // This is the most versatile model - can classify anything!
        this.classifier = await pipeline(
          'zero-shot-classification',
          'Xenova/distilbert-base-uncased-mnli'
        );

        // Sentence embedder for similarity matching
        this.embedder = await pipeline(
          'feature-extraction',
          'Xenova/all-MiniLM-L6-v2'
        );

        const elapsed = Date.now() - startTime;
        this.initialized = true;
        console.log(`✅ [ML] Models loaded successfully (${elapsed}ms)`);
      } catch (error) {
        console.error('❌ [ML] Failed to load models:', error);
        // Don't throw - allow fallback to rule-based
        this.initialized = false;
      }
    })();

    return this.initPromise;
  }

  /**
   * Classify text into structure type
   * @param {string} text - Text to classify
   * @returns {Promise<Object>} Classification result
   */
  async classifyStructure(text) {
    if (!this.initialized) {
      await this.init();
    }

    if (!this.classifier) {
      return { type: 'unknown', confidence: 0, method: 'fallback' };
    }

    try {
      // Define candidate labels for structure types
      const labels = [
        'form with login fields',
        'navigation menu',
        'data table',
        'chat messages',
        'email list',
        'source code',
        'document text',
        'bullet list',
        'video grid',
        'settings panel'
      ];

      const result = await this.classifier(text.substring(0, 500), labels);
      
      // Map verbose labels to simple types
      const typeMap = {
        'form with login fields': 'form',
        'navigation menu': 'navbar',
        'data table': 'table',
        'chat messages': 'chat',
        'email list': 'email',
        'source code': 'code',
        'document text': 'document',
        'bullet list': 'list',
        'video grid': 'grid',
        'settings panel': 'settings'
      };

      return {
        type: typeMap[result.labels[0]] || 'unknown',
        confidence: result.scores[0],
        method: 'ml',
        alternatives: result.labels.slice(1, 3).map((label, idx) => ({
          type: typeMap[label] || label,
          confidence: result.scores[idx + 1]
        }))
      };
    } catch (error) {
      console.error('❌ [ML] Classification failed:', error);
      return { type: 'unknown', confidence: 0, method: 'error' };
    }
  }

  /**
   * Classify individual words into element types
   * @param {Array<string>} words - Words to classify (max 50 for performance)
   * @returns {Promise<Array>} Element classifications
   */
  async classifyElements(words) {
    if (!this.initialized) {
      await this.init();
    }

    if (!this.classifier) {
      return words.map(word => ({ word, type: 'text', confidence: 0.5, method: 'fallback' }));
    }

    const labels = [
      'button',
      'hyperlink',
      'text input field',
      'regular text',
      'heading title',
      'price amount',
      'date',
      'email address',
      'username',
      'channel name'
    ];

    const results = [];
    const maxWords = Math.min(words.length, 50); // Limit for performance

    try {
      // Process in batches of 5 for efficiency
      for (let i = 0; i < maxWords; i += 5) {
        const batch = words.slice(i, i + 5);
        
        const batchResults = await Promise.all(
          batch.map(async (word) => {
            try {
              const result = await this.classifier(word, labels);
              
              // Map verbose labels to simple types
              const typeMap = {
                'button': 'button',
                'hyperlink': 'link',
                'text input field': 'input',
                'regular text': 'text',
                'heading title': 'heading',
                'price amount': 'price',
                'date': 'date',
                'email address': 'email',
                'username': 'username',
                'channel name': 'channel'
              };

              return {
                word,
                type: typeMap[result.labels[0]] || 'text',
                confidence: result.scores[0],
                method: 'ml'
              };
            } catch (error) {
              return {
                word,
                type: 'text',
                confidence: 0.5,
                method: 'error'
              };
            }
          })
        );

        results.push(...batchResults);
      }

      // Add remaining words as 'text' without classification
      for (let i = maxWords; i < words.length; i++) {
        results.push({
          word: words[i],
          type: 'text',
          confidence: 0.5,
          method: 'skipped'
        });
      }

      return results;
    } catch (error) {
      console.error('❌ [ML] Element classification failed:', error);
      return words.map(word => ({ word, type: 'text', confidence: 0.5, method: 'error' }));
    }
  }

  /**
   * Find most similar app template using embeddings
   * @param {string} text - Text to match
   * @param {Array<string>} templateNames - Available template names
   * @returns {Promise<Object>} Best matching template
   */
  async findSimilarTemplate(text, templateNames) {
    if (!this.initialized) {
      await this.init();
    }

    if (!this.embedder || templateNames.length === 0) {
      return { template: null, similarity: 0, method: 'fallback' };
    }

    try {
      // Get embedding for input text
      const textEmbedding = await this.embedder(text.substring(0, 500));
      
      // Get embeddings for each template name
      const templateEmbeddings = await Promise.all(
        templateNames.map(name => this.embedder(name))
      );

      // Calculate cosine similarity
      const similarities = templateEmbeddings.map((templateEmb, idx) => {
        const similarity = this.cosineSimilarity(
          textEmbedding.data,
          templateEmb.data
        );
        return {
          template: templateNames[idx],
          similarity
        };
      });

      // Sort by similarity
      similarities.sort((a, b) => b.similarity - a.similarity);

      return {
        ...similarities[0],
        method: 'ml',
        alternatives: similarities.slice(1, 3)
      };
    } catch (error) {
      console.error('❌ [ML] Template matching failed:', error);
      return { template: null, similarity: 0, method: 'error' };
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Enhance pattern detection with ML
   * @param {string} text - Text to analyze
   * @returns {Promise<Object>} Enhanced patterns
   */
  async enhancePatterns(text) {
    if (!this.initialized) {
      await this.init();
    }

    if (!this.classifier) {
      return {
        hasButtons: false,
        hasLinks: false,
        hasInputs: false,
        hasPrices: false,
        hasChannels: false,
        confidence: 0,
        method: 'fallback'
      };
    }

    try {
      const words = text.split(/\s+/).filter(w => w.length > 0).slice(0, 100);
      const elements = await this.classifyElements(words);

      // Group by type
      const grouped = {};
      elements.forEach(el => {
        if (!grouped[el.type]) {
          grouped[el.type] = [];
        }
        grouped[el.type].push(el);
      });

      // Detect patterns
      const patterns = {
        hasButtons: (grouped.button || []).length >= 2,
        hasLinks: (grouped.link || []).length >= 3,
        hasInputs: (grouped.input || []).length >= 2,
        hasPrices: (grouped.price || []).length >= 2,
        hasChannels: (grouped.channel || []).length >= 2,
        hasHeadings: (grouped.heading || []).length >= 1,
        confidence: elements.reduce((sum, el) => sum + el.confidence, 0) / elements.length,
        method: 'ml',
        grouped
      };

      return patterns;
    } catch (error) {
      console.error('❌ [ML] Pattern enhancement failed:', error);
      return {
        hasButtons: false,
        hasLinks: false,
        hasInputs: false,
        hasPrices: false,
        hasChannels: false,
        confidence: 0,
        method: 'error'
      };
    }
  }

  /**
   * Predict if text represents a specific app layout
   * @param {string} text - Text to analyze
   * @param {string} appName - App name to check
   * @returns {Promise<Object>} Prediction result
   */
  async predictAppLayout(text, appName) {
    if (!this.initialized) {
      await this.init();
    }

    if (!this.classifier) {
      return { isMatch: false, confidence: 0, method: 'fallback' };
    }

    try {
      const labels = [
        `${appName} application interface`,
        'generic application interface',
        'web browser page',
        'text document'
      ];

      const result = await this.classifier(text.substring(0, 500), labels);
      
      return {
        isMatch: result.labels[0].includes(appName),
        confidence: result.scores[0],
        method: 'ml',
        prediction: result.labels[0]
      };
    } catch (error) {
      console.error('❌ [ML] App layout prediction failed:', error);
      return { isMatch: false, confidence: 0, method: 'error' };
    }
  }

  /**
   * Get model status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      hasClassifier: !!this.classifier,
      hasEmbedder: !!this.embedder
    };
  }
}

export default MLInference;
