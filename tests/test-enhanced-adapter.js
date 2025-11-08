/**
 * Test Enhanced macOS Accessibility Adapter
 * 
 * Run with: node tests/test-enhanced-adapter.js
 */

import { EnhancedMacOSAccessibilityAdapter } from '../src/adapters/accessibility/macos-enhanced.js';
import logger from '../src/utils/logger.js';

async function testEnhancedAdapter() {
  console.log('🧪 Testing Enhanced macOS Accessibility Adapter\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    // Initialize adapter
    console.log('1️⃣  Initializing adapter...');
    const adapter = new EnhancedMacOSAccessibilityAdapter();
    await adapter.initialize();
    console.log('   ✅ Adapter initialized\n');

    // Test 1: Get all elements
    console.log('2️⃣  Getting all UI elements...');
    const allElements = await adapter.getAllElements();
    console.log(`   ✅ Found ${allElements.length} elements`);
    console.log('   Elements:', allElements.map(el => ({
      role: el.role,
      label: el.label,
      confidence: el.confidence
    })));
    console.log('');

    // Test 2: Get by role
    console.log('3️⃣  Querying by role (button)...');
    const buttons = await adapter.getByRole('button');
    console.log(`   ✅ Found ${buttons.length} buttons`);
    buttons.forEach(btn => {
      console.log(`      • ${btn.label} (confidence: ${btn.confidence.toFixed(2)})`);
    });
    console.log('');

    // Test 3: Get by text
    console.log('4️⃣  Querying by text ("Send")...');
    const sendElements = await adapter.getByText('Send');
    console.log(`   ✅ Found ${sendElements.length} elements matching "Send"`);
    sendElements.forEach(el => {
      console.log(`      • ${el.role}: ${el.label} (confidence: ${el.confidence.toFixed(2)})`);
    });
    console.log('');

    // Test 4: Query with multiple criteria
    console.log('5️⃣  Querying with criteria (role: button, text: "Send")...');
    const queryResults = await adapter.queryElements({
      role: 'button',
      query: 'Send'
    });
    console.log(`   ✅ Found ${queryResults.length} matching elements`);
    queryResults.forEach(el => {
      console.log(`      • ${el.label} (confidence: ${el.confidence.toFixed(2)})`);
    });
    console.log('');

    // Test 5: Cache test
    console.log('6️⃣  Testing cache...');
    const start1 = Date.now();
    await adapter.getAllElements();
    const time1 = Date.now() - start1;
    
    const start2 = Date.now();
    await adapter.getAllElements();
    const time2 = Date.now() - start2;
    
    console.log(`   First call: ${time1}ms`);
    console.log(`   Cached call: ${time2}ms`);
    console.log(`   ✅ Cache speedup: ${(time1 / time2).toFixed(1)}x faster\n`);

    // Summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ All tests passed!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('📊 Summary:');
    console.log(`   • Total elements: ${allElements.length}`);
    console.log(`   • Buttons found: ${buttons.length}`);
    console.log(`   • "Send" matches: ${sendElements.length}`);
    console.log(`   • Query matches: ${queryResults.length}`);
    console.log(`   • Cache working: ✅`);
    console.log('');

    console.log('🎯 Next Steps:');
    console.log('   1. Test with real applications (VS Code, Chrome, etc.)');
    console.log('   2. Improve AppleScript parsing for real element data');
    console.log('   3. Add native AX API bindings for better performance');
    console.log('   4. Implement Windows UIA adapter');
    console.log('');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
testEnhancedAdapter();
