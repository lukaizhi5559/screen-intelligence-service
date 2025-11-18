/**
 * Persistent Semantic Search Example
 * Demonstrates DuckDB-backed persistent semantic search
 */

const UITreeBuilder = require('../utils/uiTreeBuilder');
const { getEmbeddingService } = require('../services/embeddingService');
const { getPersistentSemanticIndex } = require('../services/persistentSemanticIndex');

/**
 * Example 1: Build and index with persistence
 */
async function examplePersistentIndex() {
  console.log('\n=== Example 1: Persistent Index ===\n');

  // Simulated OCR results
  const ocrResults = {
    screenWidth: 1920,
    screenHeight: 1080,
    screenshotPath: '/tmp/screenshot.png',
    words: [
      { text: 'Gmail', x0: 50, y0: 20, x1: 150, y1: 50, confidence: 0.95 },
      { text: 'Inbox (42)', x0: 50, y0: 100, x1: 200, y1: 130, confidence: 0.93 },
      { text: 'From: alice@example.com', x0: 300, y0: 200, x1: 600, y1: 230, confidence: 0.92 },
      { text: 'Subject: Meeting notes', x0: 300, y0: 240, x1: 600, y1: 270, confidence: 0.94 },
      { text: 'From: bob@company.com', x0: 300, y0: 300, x1: 600, y1: 330, confidence: 0.91 },
      { text: 'Subject: Project update', x0: 300, y0: 340, x1: 600, y1: 370, confidence: 0.93 },
      { text: 'Compose', x0: 1700, y0: 50, x1: 1850, y1: 90, confidence: 0.96 },
      { text: 'Search mail', x0: 800, y0: 30, x1: 1000, y1: 60, confidence: 0.94 }
    ]
  };

  const windowInfo = {
    app: 'Gmail',
    url: 'https://mail.google.com/mail/u/0/#inbox',
    title: 'Inbox (42) - alice@example.com - Gmail'
  };

  // Build UI tree
  const treeBuilder = new UITreeBuilder();
  const screenState = treeBuilder.buildTree(ocrResults, windowInfo);

  console.log('📊 Screen State:');
  console.log(`  - App: ${screenState.app}`);
  console.log(`  - Nodes: ${screenState.nodes.size}`);
  console.log(`  - Description: ${screenState.description}`);

  // Index with persistent storage
  const persistentIndex = getPersistentSemanticIndex();
  await persistentIndex.initialize();
  await persistentIndex.indexScreenState(screenState);

  const stats = await persistentIndex.getStats();
  console.log(`\n✅ Indexed to DuckDB: ${stats.nodes} total nodes, ${stats.screens} total screens`);

  return screenState;
}

/**
 * Example 2: Search persists across restarts
 */
async function examplePersistentSearch() {
  console.log('\n=== Example 2: Persistent Search ===\n');

  const persistentIndex = getPersistentSemanticIndex();
  await persistentIndex.initialize();

  // Query 1: Find emails
  console.log('🔍 Query: "emails from alice"');
  const results1 = await persistentIndex.search({
    query: 'emails from alice',
    filters: {
      app: 'Gmail',
      visibleOnly: true
    },
    k: 5,
    minScore: 0.3
  });

  console.log(`📊 Found ${results1.length} results:`);
  for (const result of results1) {
    console.log(`  - Score: ${result.score.toFixed(3)} | ${result.node.description}`);
  }

  // Query 2: Find compose button
  console.log('\n🔍 Query: "button to write new email"');
  const results2 = await persistentIndex.search({
    query: 'button to write new email',
    filters: {
      clickableOnly: true
    },
    k: 3,
    minScore: 0.4
  });

  console.log(`📊 Found ${results2.length} results:`);
  for (const result of results2) {
    console.log(`  - Score: ${result.score.toFixed(3)} | ${result.node.description}`);
    console.log(`    BBox: [${result.node.bbox.join(', ')}]`);
  }
}

/**
 * Example 3: Temporal search with persistence
 */
async function exampleTemporalPersistence() {
  console.log('\n=== Example 3: Temporal Search (Persistent) ===\n');

  const persistentIndex = getPersistentSemanticIndex();
  await persistentIndex.initialize();

  // Search history
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);

  console.log('🔍 Query: "Gmail screens from last hour"');
  const history = await persistentIndex.searchHistory(
    'Gmail inbox with emails',
    { start: oneHourAgo, end: now },
    5
  );

  console.log(`📊 Found ${history.length} screen states:`);
  for (const result of history) {
    console.log(`  - Score: ${result.score.toFixed(3)} | ${result.screenState.description}`);
    console.log(`    Time: ${new Date(result.screenState.timestamp).toLocaleTimeString()}`);
  }
}

/**
 * Example 4: Performance comparison
 */
async function examplePerformanceTest() {
  console.log('\n=== Example 4: Performance Test ===\n');

  const persistentIndex = getPersistentSemanticIndex();
  await persistentIndex.initialize();

  const queries = [
    'button to compose email',
    'emails from alice',
    'search functionality',
    'inbox label',
    'email subjects'
  ];

  console.log(`🏃 Running ${queries.length} queries...\n`);

  const startTime = Date.now();
  
  for (const query of queries) {
    const queryStart = Date.now();
    const results = await persistentIndex.search({
      query,
      k: 5,
      minScore: 0.3
    });
    const queryTime = Date.now() - queryStart;
    
    console.log(`✅ "${query}": ${results.length} results in ${queryTime}ms`);
  }

  const totalTime = Date.now() - startTime;
  const avgTime = totalTime / queries.length;

  console.log(`\n📊 Performance:`);
  console.log(`  - Total time: ${totalTime}ms`);
  console.log(`  - Average per query: ${avgTime.toFixed(1)}ms`);
  console.log(`  - Queries per second: ${(1000 / avgTime).toFixed(1)}`);
}

/**
 * Example 5: Cleanup old data
 */
async function exampleCleanup() {
  console.log('\n=== Example 5: Data Cleanup ===\n');

  const persistentIndex = getPersistentSemanticIndex();
  await persistentIndex.initialize();

  // Get stats before cleanup
  const statsBefore = await persistentIndex.getStats();
  console.log('📊 Before cleanup:', statsBefore);

  // Cleanup data older than 1 hour
  const oneHour = 60 * 60 * 1000;
  await persistentIndex.cleanup(oneHour);

  // Get stats after cleanup
  const statsAfter = await persistentIndex.getStats();
  console.log('📊 After cleanup:', statsAfter);

  const nodesRemoved = statsBefore.nodes - statsAfter.nodes;
  const screensRemoved = statsBefore.screens - statsAfter.screens;

  console.log(`\n🧹 Removed:`);
  console.log(`  - ${nodesRemoved} nodes`);
  console.log(`  - ${screensRemoved} screens`);
}

/**
 * Example 6: Database statistics
 */
async function exampleStats() {
  console.log('\n=== Example 6: Database Statistics ===\n');

  const persistentIndex = getPersistentSemanticIndex();
  await persistentIndex.initialize();

  const stats = await persistentIndex.getStats();

  console.log('📊 Database Statistics:');
  console.log(`  - Total nodes: ${stats.nodes}`);
  console.log(`  - Total subtrees: ${stats.subtrees}`);
  console.log(`  - Total screens: ${stats.screens}`);

  // Calculate storage estimates
  const avgNodeSize = 1024; // ~1KB per node
  const estimatedSize = (stats.nodes * avgNodeSize) / (1024 * 1024);

  console.log(`\n💾 Storage Estimates:`);
  console.log(`  - Approximate size: ${estimatedSize.toFixed(2)} MB`);
  console.log(`  - Average per screen: ${(stats.nodes / Math.max(stats.screens, 1)).toFixed(0)} nodes`);
}

/**
 * Run all examples
 */
async function runAllExamples() {
  try {
    console.log('🚀 Starting Persistent Semantic Search Examples\n');
    console.log('=' .repeat(60));

    // Initialize embedding service
    const embeddingService = getEmbeddingService();
    await embeddingService.initialize();

    // Run examples
    await examplePersistentIndex();
    await examplePersistentSearch();
    await exampleTemporalPersistence();
    await examplePerformanceTest();
    await exampleStats();
    await exampleCleanup();

    console.log('\n' + '='.repeat(60));
    console.log('✅ All examples completed successfully');
    console.log('\n💡 Data is now persistent! Restart and run again to see it persist.');
  } catch (error) {
    console.error('❌ Error running examples:', error);
  }
}

// Run if executed directly
if (require.main === module) {
  runAllExamples().then(() => process.exit(0));
}

module.exports = {
  examplePersistentIndex,
  examplePersistentSearch,
  exampleTemporalPersistence,
  examplePerformanceTest,
  exampleCleanup,
  exampleStats,
  runAllExamples
};
