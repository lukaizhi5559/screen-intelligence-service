/**
 * Icon Classification Examples
 * Demonstrates CLIP-based icon recognition
 */

import { getIconClassificationService, ALL_ICON_TYPES, ICON_CATEGORIES } from '../services/iconClassificationService.js';
import { getEnhancedDETRService } from '../services/enhancedDETRService.js';
import { getPersistentSemanticIndex } from '../services/persistentSemanticIndex.js';
import EnhancedUITreeBuilder from '../utils/enhancedUITreeBuilder.js';

/**
 * Example 1: Supported icon types
 */
async function exampleSupportedIcons() {
  console.log('\n=== Example 1: Supported Icon Types ===\n');

  const iconService = getIconClassificationService();
  const supported = iconService.getSupportedIconTypes();

  console.log(`📊 Total icon types: ${supported.count}\n`);

  for (const [category, types] of Object.entries(supported.byCategory)) {
    console.log(`${category} (${types.length}):`);
    console.log(`  ${types.join(', ')}\n`);
  }

  console.log('✨ Based on ScreenAI research - 77+ common UI icons');
}

/**
 * Example 2: Icon search
 */
async function exampleIconSearch() {
  console.log('\n=== Example 2: Icon Search ===\n');

  const iconService = getIconClassificationService();

  const queries = ['save', 'email', 'menu', 'arrow'];

  for (const query of queries) {
    const matches = iconService.searchIconTypes(query);
    console.log(`🔍 Search "${query}":`);
    console.log(`  Found: ${matches.join(', ')}`);
  }
}

/**
 * Example 3: Icon classification (simulated)
 */
async function exampleIconClassification() {
  console.log('\n=== Example 3: Icon Classification ===\n');

  const iconService = getIconClassificationService();
  
  try {
    await iconService.initialize();

    console.log('🎨 Icon classifier ready');
    console.log('   Model: CLIP (zero-shot)');
    console.log('   Supported: 77+ icon types');
    console.log('\n💡 To classify real icons, provide screenshot with icon bounding boxes');
    
    // Example of what classification would return
    const exampleResult = {
      iconType: 'settings',
      confidence: 0.92,
      category: 'system',
      description: 'a gear or cog icon for settings',
      alternatives: [
        { type: 'gear', confidence: 0.88 },
        { type: 'preferences', confidence: 0.75 }
      ]
    };

    console.log('\n📊 Example classification result:');
    console.log(JSON.stringify(exampleResult, null, 2));

  } catch (error) {
    console.warn('⚠️  Icon classifier initialization failed:', error.message);
    console.log('   (CLIP model may not be available)');
  }
}

/**
 * Example 4: Enhanced DETR with icon classification
 */
async function exampleEnhancedDETR() {
  console.log('\n=== Example 4: Enhanced DETR with Icons ===\n');

  const enhancedDETR = getEnhancedDETRService();

  // Simulated screenshot with icons
  const ocrResults = {
    screenWidth: 1920,
    screenHeight: 1080,
    screenshotPath: '/tmp/ui-with-icons.png',
    words: [
      { text: 'Settings', x0: 100, y0: 50, x1: 200, y1: 80, confidence: 0.95 },
      { text: 'Save', x0: 800, y0: 900, x1: 900, y1: 940, confidence: 0.96 },
      // Icons (no text)
      { text: '⚙', x0: 50, y0: 50, x1: 80, y1: 80, confidence: 0.85 }, // Settings icon
      { text: '🔔', x0: 1800, y0: 50, x1: 1830, y1: 80, confidence: 0.90 }, // Notification icon
      { text: '💾', x0: 750, y0: 900, x1: 780, y1: 930, confidence: 0.88 } // Save icon
    ]
  };

  try {
    await enhancedDETR.initialize();

    console.log('🎯 Running enhanced detection...');
    
    const elements = await enhancedDETR.detectAndClassify(
      ocrResults.screenshotPath,
      ocrResults.words,
      {
        screenWidth: ocrResults.screenWidth,
        screenHeight: ocrResults.screenHeight,
        classifyIcons: true
      }
    );

    console.log(`\n📊 Detection Results:`);
    console.log(`  - Total elements: ${elements.length}`);

    const icons = elements.filter(e => e.type === 'icon');
    console.log(`  - Icons detected: ${icons.length}`);

    if (icons.length > 0) {
      console.log('\n🎨 Icon Classifications:');
      for (const icon of icons) {
        console.log(`  - ${icon.iconType || 'unknown'} (${((icon.iconConfidence || 0) * 100).toFixed(0)}%)`);
        console.log(`    Category: ${icon.iconCategory || 'unknown'}`);
        console.log(`    Description: ${icon.iconDescription || 'N/A'}`);
      }
    }

    // Get icon statistics
    const stats = enhancedDETR.getIconStats(elements);
    console.log('\n📈 Icon Statistics:');
    console.log(`  - Total icons: ${stats.totalIcons}`);
    console.log(`  - Average confidence: ${(stats.averageConfidence * 100).toFixed(0)}%`);
    console.log(`  - Categories: ${Object.keys(stats.iconCategories).join(', ')}`);

  } catch (error) {
    console.warn('⚠️  Enhanced DETR not available:', error.message);
    console.log('   (Requires real screenshot and CLIP model)');
  }
}

/**
 * Example 5: Semantic search with icon understanding
 */
async function exampleSemanticSearchWithIcons() {
  console.log('\n=== Example 5: Semantic Search with Icons ===\n');

  const enhancedDETR = getEnhancedDETRService();
  const persistentIndex = getPersistentSemanticIndex();
  
  try {
    await enhancedDETR.initialize();
    await persistentIndex.initialize();

    // Simulated UI with icons
    const ocrResults = {
      screenWidth: 1920,
      screenHeight: 1080,
      screenshotPath: '/tmp/toolbar.png',
      words: [
        { text: 'File', x0: 50, y0: 20, x1: 100, y1: 50, confidence: 0.95 },
        { text: 'Edit', x0: 120, y0: 20, x1: 170, y1: 50, confidence: 0.95 },
        { text: '', x0: 200, y0: 20, x1: 230, y1: 50, confidence: 0.0 }, // Save icon (no text)
        { text: '', x0: 250, y0: 20, x1: 280, y1: 50, confidence: 0.0 }, // Print icon
        { text: '', x0: 300, y0: 20, x1: 330, y1: 50, confidence: 0.0 }  // Search icon
      ]
    };

    const windowInfo = { app: 'TextEditor', title: 'Document.txt' };

    // Build tree with icon classification
    console.log('🏗️  Building UI tree with icon classification...');
    
    const elements = await enhancedDETR.detectAndClassify(
      ocrResults.screenshotPath,
      ocrResults.words,
      {
        screenWidth: ocrResults.screenWidth,
        screenHeight: ocrResults.screenHeight,
        classifyIcons: true
      }
    );

    // Create screen state (simplified)
    const screenState = {
      id: 'example-screen',
      app: windowInfo.app,
      windowTitle: windowInfo.title,
      nodes: new Map(),
      subtrees: [],
      rootNodeIds: [],
      screenDimensions: {
        width: ocrResults.screenWidth,
        height: ocrResults.screenHeight
      },
      timestamp: Date.now()
    };

    // Add elements as nodes
    for (const element of elements) {
      const node = {
        id: `node-${Math.random()}`,
        type: element.type,
        text: element.text || '',
        description: element.iconDescription || element.text || element.type,
        bbox: element.bbox,
        metadata: {
          iconType: element.iconType,
          iconCategory: element.iconCategory,
          iconConfidence: element.iconConfidence
        }
      };
      screenState.nodes.set(node.id, node);
    }

    // Index
    await persistentIndex.indexScreenState(screenState);

    // Search for icons by semantic meaning
    console.log('\n🔍 Query: "icon to save document"');
    const results = await persistentIndex.search({
      query: 'icon to save document',
      filters: {
        types: ['icon']
      },
      k: 3,
      minScore: 0.5
    });

    console.log(`\n📊 Found ${results.length} results:`);
    for (const result of results) {
      console.log(`  - Score: ${result.score.toFixed(3)}`);
      console.log(`    Type: ${result.node.type}`);
      console.log(`    Icon: ${result.node.metadata.iconType || 'unknown'}`);
      console.log(`    Description: ${result.node.description}`);
    }

    console.log('\n✨ Benefits:');
    console.log('  - Can search for icons by meaning ("save icon")');
    console.log('  - Works even when icons have no text');
    console.log('  - Semantic understanding of icon purpose');

  } catch (error) {
    console.warn('⚠️  Example requires real screenshots:', error.message);
  }
}

/**
 * Example 6: Real-world use case - "Click the settings icon"
 */
async function exampleRealWorldIconClick() {
  console.log('\n=== Example 6: Real-World - Click Settings Icon ===\n');
  console.log('Scenario: User says "Click the settings icon"\n');

  const enhancedDETR = getEnhancedDETRService();
  const persistentIndex = getPersistentSemanticIndex();

  try {
    await enhancedDETR.initialize();
    await persistentIndex.initialize();

    // Simulated app with settings icon
    const ocrResults = {
      screenWidth: 1920,
      screenHeight: 1080,
      screenshotPath: '/tmp/app-header.png',
      words: [
        { text: 'MyApp', x0: 50, y0: 20, x1: 150, y1: 50, confidence: 0.95 },
        { text: '', x0: 1800, y0: 20, x1: 1850, y1: 70, confidence: 0.0 } // Settings gear icon
      ]
    };

    console.log('🎯 Step 1: Detect and classify icons');
    const elements = await enhancedDETR.detectAndClassify(
      ocrResults.screenshotPath,
      ocrResults.words,
      {
        screenWidth: ocrResults.screenWidth,
        screenHeight: ocrResults.screenHeight,
        classifyIcons: true
      }
    );

    // Find settings icon
    const settingsIcon = elements.find(e => 
      e.type === 'icon' && 
      (e.iconType === 'settings' || e.iconType === 'gear')
    );

    if (settingsIcon) {
      console.log('✅ Found settings icon:');
      console.log(`   Type: ${settingsIcon.iconType}`);
      console.log(`   Confidence: ${(settingsIcon.iconConfidence * 100).toFixed(0)}%`);
      console.log(`   BBox: [${settingsIcon.bbox.join(', ')}]`);

      const [x1, y1, x2, y2] = settingsIcon.bbox;
      const clickX = Math.round((x1 + x2) / 2);
      const clickY = Math.round((y1 + y2) / 2);

      console.log(`\n🎬 Action:`);
      console.log(`   Click at (${clickX}, ${clickY})`);
      console.log(`   await mouse.setPosition(new Point(${clickX}, ${clickY}));`);
      console.log(`   await mouse.leftClick();`);

      console.log('\n✨ Why icon classification helps:');
      console.log('   - Identifies settings icon even with no text');
      console.log('   - Distinguishes from other icons (menu, help, etc.)');
      console.log('   - Works across different icon styles');
      console.log('   - Semantic understanding ("settings" = "gear" = "preferences")');
    } else {
      console.log('❌ Settings icon not found');
    }

  } catch (error) {
    console.warn('⚠️  Example requires real screenshots:', error.message);
  }
}

/**
 * Run all examples
 */
async function runAllExamples() {
  try {
    console.log('🚀 Starting Icon Classification Examples\n');
    console.log('='.repeat(60));

    await exampleSupportedIcons();
    await exampleIconSearch();
    await exampleIconClassification();
    await exampleEnhancedDETR();
    await exampleSemanticSearchWithIcons();
    await exampleRealWorldIconClick();

    console.log('\n' + '='.repeat(60));
    console.log('✅ All examples completed');
    console.log('\n💡 Note: Full icon classification requires:');
    console.log('   - Real screenshots (not simulated data)');
    console.log('   - CLIP model (auto-downloaded on first run)');
    console.log('   - Icon bounding boxes from DETR');
  } catch (error) {
    console.error('❌ Error running examples:', error);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllExamples().then(() => process.exit(0));
}

export {
  exampleSupportedIcons,
  exampleIconSearch,
  exampleIconClassification,
  exampleEnhancedDETR,
  exampleSemanticSearchWithIcons,
  exampleRealWorldIconClick,
  runAllExamples
};
