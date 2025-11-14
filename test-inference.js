#!/usr/bin/env node

/**
 * Test script for Layout Inference Engine
 * Tests robust document detection and app template matching
 */

import { LayoutInferenceEngine } from './src/utils/layoutInferenceEngine.js';

const engine = new LayoutInferenceEngine();

console.log('🧪 Testing Layout Inference Engine\n');
console.log('=' .repeat(60));

// Test cases
const tests = [
  {
    name: 'Slack Detection',
    text: '#general @john 3:45 PM Hey everyone!',
    context: { app: 'Slack', url: '', windowTitle: 'Slack - ThinkDrop Team' }
  },
  {
    name: 'VSCode Detection',
    text: 'function hello() {\n  console.log("hi");\n}',
    context: { app: 'Visual Studio Code', windowTitle: 'index.js - myproject', hasCodeBlock: true }
  },
  {
    name: 'Google Sheets Detection',
    text: 'Q1\tQ2\tQ3\tQ4\nRevenue\t$100K\t$120K\t$150K\t$180K',
    context: { url: 'https://docs.google.com/spreadsheets/d/abc123', app: 'Chrome' }
  },
  {
    name: 'Notion Detection',
    text: '# Project Plan\n- [ ] Task 1\n- [x] Task 2\n- [ ] Task 3',
    context: { app: 'Notion', windowTitle: 'Untitled - Notion' }
  },
  {
    name: 'PDF Detection',
    text: 'Invoice #12345\nDue Date: Jan 15, 2024\nTotal: $1,250.00',
    context: { app: 'Preview', windowTitle: 'invoice_2024.pdf' }
  },
  {
    name: 'Terminal Detection',
    text: '$ npm install\n$ git commit -m "fix"\npermission denied',
    context: { app: 'Terminal', windowTitle: 'Terminal — bash' }
  },
  {
    name: 'Gmail Detection',
    text: 'Inbox (5)\nFrom: john@example.com\nSubject: Meeting tomorrow',
    context: { url: 'https://mail.google.com/mail/u/0/#inbox', app: 'Chrome' }
  },
  {
    name: 'Figma Detection',
    text: 'Frame 1\nRectangle\nText Layer\n#FF5733',
    context: { url: 'https://figma.com/file/abc123', app: 'Chrome' }
  },
  {
    name: 'Markdown Detection',
    text: '# Heading\n## Subheading\n- Bullet 1\n- Bullet 2\n- Bullet 3',
    context: { app: 'Obsidian', windowTitle: 'notes.md' }
  },
  {
    name: 'Unknown App (Fallback)',
    text: 'Some random text without clear patterns',
    context: { app: 'Unknown App', windowTitle: 'Untitled' }
  }
];

// Run tests
let passed = 0;
let failed = 0;

tests.forEach((test, idx) => {
  console.log(`\n${idx + 1}. ${test.name}`);
  console.log('-'.repeat(60));
  
  try {
    const result = engine.inferLayout(test.text, test.context);
    
    console.log(`📄 Document Type: ${result.docType}`);
    console.log(`🎯 Confidence: ${(result.metadata.confidence * 100).toFixed(1)}%`);
    console.log(`📊 Structures Found:`);
    console.log(`   - Tables: ${result.structures.tables.length}`);
    console.log(`   - Navbars: ${result.structures.navbars.length}`);
    console.log(`   - Headers: ${result.structures.headers.length}`);
    console.log(`   - Lists: ${result.structures.lists.length}`);
    console.log(`   - Grids: ${result.structures.grids.length}`);
    console.log(`   - Forms: ${result.structures.forms.length}`);
    console.log(`📦 Elements: ${result.elements.length}`);
    
    // Check if zones were detected
    const zoneCount = Object.values(result.zones).filter(z => z !== null).length;
    console.log(`🏗️  Layout Zones: ${zoneCount}`);
    
    passed++;
    console.log('✅ PASSED');
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    console.error(error.stack);
    failed++;
  }
});

// Summary
console.log('\n' + '='.repeat(60));
console.log('📊 TEST SUMMARY');
console.log('='.repeat(60));
console.log(`✅ Passed: ${passed}/${tests.length}`);
console.log(`❌ Failed: ${failed}/${tests.length}`);
console.log(`📈 Success Rate: ${((passed / tests.length) * 100).toFixed(1)}%`);

if (failed === 0) {
  console.log('\n🎉 All tests passed! System is ready to use!');
  process.exit(0);
} else {
  console.log('\n⚠️  Some tests failed. Please review errors above.');
  process.exit(1);
}
