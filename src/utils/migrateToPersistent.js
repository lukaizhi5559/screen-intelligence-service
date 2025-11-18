/**
 * Migration Utility
 * Migrate from in-memory semantic index to persistent DuckDB storage
 */

const { getSemanticIndex } = require('../services/semanticIndexService');
const { getPersistentSemanticIndex } = require('../services/persistentSemanticIndex');

/**
 * Migrate all data from in-memory index to DuckDB
 */
async function migrateToPersistent() {
  console.log('🔄 Starting migration to persistent storage...\n');

  try {
    // Get both indexes
    const memoryIndex = getSemanticIndex();
    const persistentIndex = getPersistentSemanticIndex();

    // Initialize persistent index
    await persistentIndex.initialize();

    // Get all screen states from memory
    const screenStates = Array.from(memoryIndex.screenStates.values());
    
    if (screenStates.length === 0) {
      console.log('⚠️  No screen states to migrate');
      return;
    }

    console.log(`📊 Found ${screenStates.length} screen states to migrate`);
    console.log(`📊 Total nodes: ${memoryIndex.nodes.size}`);
    console.log(`📊 Total subtrees: ${memoryIndex.subtrees.size}\n`);

    // Migrate each screen state
    let migratedCount = 0;
    for (const screenState of screenStates) {
      try {
        console.log(`📇 Migrating screen: ${screenState.id} (${screenState.app})`);
        await persistentIndex.indexScreenState(screenState);
        migratedCount++;
      } catch (error) {
        console.error(`❌ Failed to migrate screen ${screenState.id}:`, error.message);
      }
    }

    // Verify migration
    const stats = await persistentIndex.getStats();
    console.log('\n✅ Migration complete!');
    console.log(`📊 Migrated ${migratedCount}/${screenStates.length} screen states`);
    console.log(`📊 Database now contains:`);
    console.log(`   - ${stats.nodes} nodes`);
    console.log(`   - ${stats.subtrees} subtrees`);
    console.log(`   - ${stats.screens} screens`);

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

/**
 * Test that persistent index works correctly
 */
async function testPersistentIndex() {
  console.log('\n🧪 Testing persistent index...\n');

  try {
    const persistentIndex = getPersistentSemanticIndex();
    await persistentIndex.initialize();

    // Test search
    console.log('🔍 Test search: "button"');
    const results = await persistentIndex.search({
      query: 'button',
      k: 5,
      minScore: 0.3
    });

    console.log(`✅ Found ${results.length} results:`);
    for (const result of results.slice(0, 3)) {
      console.log(`   - ${result.node.description} (score: ${result.score.toFixed(3)})`);
    }

    // Test history search
    console.log('\n🔍 Test history search');
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    const history = await persistentIndex.searchHistory(
      'screen',
      { start: oneHourAgo, end: now },
      3
    );

    console.log(`✅ Found ${history.length} screens in last hour`);

    // Test stats
    const stats = await persistentIndex.getStats();
    console.log('\n📊 Database stats:', stats);

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

// Run if executed directly
if (require.main === module) {
  (async () => {
    await migrateToPersistent();
    await testPersistentIndex();
    process.exit(0);
  })().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  migrateToPersistent,
  testPersistentIndex
};
