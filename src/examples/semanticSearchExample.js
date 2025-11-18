/**
 * Semantic Search Example
 * Demonstrates how to use the UI semantic tree and search system
 */

const UITreeBuilder = require('../utils/uiTreeBuilder');
const { getEmbeddingService } = require('../services/embeddingService');
const { getSemanticIndex } = require('../services/semanticIndexService');

/**
 * Example 1: Build UI tree from OCR results and index it
 */
async function exampleBuildAndIndex() {
  console.log('\n=== Example 1: Build and Index UI Tree ===\n');

  // Simulated OCR results
  const ocrResults = {
    screenWidth: 1920,
    screenHeight: 1080,
    screenshotPath: '/tmp/screenshot.png',
    words: [
      { text: 'Settings', x0: 100, y0: 50, x1: 200, y1: 80, confidence: 0.95 },
      { text: 'Account', x0: 50, y0: 150, x1: 150, y1: 180, confidence: 0.92 },
      { text: 'Profile', x0: 50, y0: 200, x1: 150, y1: 230, confidence: 0.93 },
      { text: 'Save changes', x0: 800, y0: 900, x1: 950, y1: 940, confidence: 0.96 },
      { text: 'Cancel', x0: 650, y0: 900, x1: 750, y1: 940, confidence: 0.94 },
      { text: 'Export logs', x0: 1500, y0: 100, x1: 1650, y1: 140, confidence: 0.91 }
    ]
  };

  const windowInfo = {
    app: 'Chrome',
    url: 'https://example.com/settings/profile',
    title: 'Settings - Profile'
  };

  // Build UI tree
  const treeBuilder = new UITreeBuilder();
  const screenState = treeBuilder.buildTree(ocrResults, windowInfo);

  console.log('📊 Screen State:');
  console.log(`  - ID: ${screenState.id}`);
  console.log(`  - App: ${screenState.app}`);
  console.log(`  - URL: ${screenState.url}`);
  console.log(`  - Nodes: ${screenState.nodes.size}`);
  console.log(`  - Subtrees: ${screenState.subtrees.length}`);
  console.log(`  - Description: ${screenState.description}`);

  // Print some node descriptions
  console.log('\n📝 Sample Node Descriptions:');
  let count = 0;
  for (const [id, node] of screenState.nodes.entries()) {
    if (count++ >= 3) break;
    console.log(`  - ${node.description}`);
  }

  // Index the screen state
  const semanticIndex = getSemanticIndex();
  await semanticIndex.indexScreenState(screenState);

  console.log('\n✅ Screen state indexed successfully');

  return screenState;
}

/**
 * Example 2: Semantic search for UI elements
 */
async function exampleSemanticSearch(screenState) {
  console.log('\n=== Example 2: Semantic Search ===\n');

  const semanticIndex = getSemanticIndex();

  // Query 1: Find button to export logs
  console.log('🔍 Query: "button to export logs"');
  const results1 = await semanticIndex.search({
    query: 'button to export logs',
    filters: {
      clickableOnly: true,
      visibleOnly: true
    },
    k: 3,
    minScore: 0.3
  });

  console.log(`📊 Found ${results1.length} results:`);
  for (const result of results1) {
    console.log(`  - Score: ${result.score.toFixed(3)} | ${result.node.description}`);
    console.log(`    BBox: [${result.node.bbox.join(', ')}]`);
  }

  // Query 2: Find save button
  console.log('\n🔍 Query: "save my changes"');
  const results2 = await semanticIndex.search({
    query: 'save my changes',
    filters: {
      types: ['button', 'text'],
      visibleOnly: true
    },
    k: 3,
    minScore: 0.3
  });

  console.log(`📊 Found ${results2.length} results:`);
  for (const result of results2) {
    console.log(`  - Score: ${result.score.toFixed(3)} | ${result.node.description}`);
    console.log(`    BBox: [${result.node.bbox.join(', ')}]`);
  }

  // Query 3: Find settings related elements
  console.log('\n🔍 Query: "account settings"');
  const results3 = await semanticIndex.search({
    query: 'account settings',
    k: 5,
    minScore: 0.2
  });

  console.log(`📊 Found ${results3.length} results:`);
  for (const result of results3) {
    console.log(`  - Score: ${result.score.toFixed(3)} | ${result.node.description}`);
  }
}

/**
 * Example 3: Hybrid search (symbolic + semantic)
 */
async function exampleHybridSearch() {
  console.log('\n=== Example 3: Hybrid Search ===\n');

  const semanticIndex = getSemanticIndex();

  // Hybrid search: Find clickable elements in bottom-right with "save" or "export"
  console.log('🔍 Hybrid Query: Clickable elements in bottom-right containing "save" or "export"');
  
  const results = await semanticIndex.search({
    query: 'save or export button',
    filters: {
      clickableOnly: true,
      visibleOnly: true,
      bboxRegion: {
        minX: 500,  // Right half of screen
        minY: 800   // Bottom portion
      }
    },
    k: 5,
    minScore: 0.2
  });

  console.log(`📊 Found ${results.length} results:`);
  for (const result of results) {
    console.log(`  - Score: ${result.score.toFixed(3)} | ${result.node.description}`);
    console.log(`    Region: ${result.node.metadata.screenRegion}`);
    console.log(`    BBox: [${result.node.bbox.join(', ')}]`);
  }
}

/**
 * Example 4: Temporal search (screen history)
 */
async function exampleTemporalSearch() {
  console.log('\n=== Example 4: Temporal Search (Screen History) ===\n');

  const semanticIndex = getSemanticIndex();

  // Search for past screens
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);

  console.log('🔍 Query: "settings page I was on earlier"');
  
  const results = await semanticIndex.searchHistory(
    'settings page with profile options',
    { start: oneHourAgo, end: now },
    3
  );

  console.log(`📊 Found ${results.length} screen states:`);
  for (const result of results) {
    console.log(`  - Score: ${result.score.toFixed(3)} | ${result.screenState.description}`);
    console.log(`    Time: ${new Date(result.screenState.timestamp).toLocaleTimeString()}`);
    console.log(`    App: ${result.screenState.app}`);
  }
}

/**
 * Example 5: Action planning with semantic search
 */
async function exampleActionPlanning() {
  console.log('\n=== Example 5: Action Planning ===\n');

  const semanticIndex = getSemanticIndex();

  // User intent: "Export the logs"
  const userIntent = 'Export the logs';
  console.log(`🎯 User Intent: "${userIntent}"`);

  // Step 1: Find the relevant UI element
  const results = await semanticIndex.search({
    query: userIntent,
    filters: {
      clickableOnly: true,
      visibleOnly: true
    },
    k: 1,
    minScore: 0.5
  });

  if (results.length === 0) {
    console.log('❌ No suitable element found');
    return;
  }

  const targetElement = results[0];
  console.log(`\n✅ Found target element:`);
  console.log(`  - Description: ${targetElement.node.description}`);
  console.log(`  - Confidence: ${(targetElement.score * 100).toFixed(1)}%`);
  console.log(`  - Type: ${targetElement.node.type}`);
  console.log(`  - BBox: [${targetElement.node.bbox.join(', ')}]`);

  // Step 2: Plan the action
  const [x1, y1, x2, y2] = targetElement.node.bbox;
  const clickX = Math.round((x1 + x2) / 2);
  const clickY = Math.round((y1 + y2) / 2);

  console.log(`\n🎬 Action Plan:`);
  console.log(`  1. Move mouse to (${clickX}, ${clickY})`);
  console.log(`  2. Click left button`);
  console.log(`  3. Wait for export dialog`);

  // This would integrate with nut.js or similar automation tool
  console.log(`\n💡 Integration with nut.js:`);
  console.log(`  await mouse.setPosition(new Point(${clickX}, ${clickY}));`);
  console.log(`  await mouse.leftClick();`);
}

/**
 * Run all examples
 */
async function runAllExamples() {
  try {
    console.log('🚀 Starting Semantic Search Examples\n');
    console.log('=' .repeat(60));

    // Initialize embedding service
    const embeddingService = getEmbeddingService();
    await embeddingService.initialize();

    // Run examples
    const screenState = await exampleBuildAndIndex();
    await exampleSemanticSearch(screenState);
    await exampleHybridSearch();
    await exampleTemporalSearch();
    await exampleActionPlanning();

    console.log('\n' + '='.repeat(60));
    console.log('✅ All examples completed successfully');
  } catch (error) {
    console.error('❌ Error running examples:', error);
  }
}

// Run if executed directly
if (require.main === module) {
  runAllExamples();
}

module.exports = {
  exampleBuildAndIndex,
  exampleSemanticSearch,
  exampleHybridSearch,
  exampleTemporalSearch,
  exampleActionPlanning,
  runAllExamples
};
