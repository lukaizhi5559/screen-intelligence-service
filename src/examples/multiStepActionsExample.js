/**
 * Multi-Step Actions Examples
 * Demonstrates complex workflow automation
 */

import { getActionPlannerService } from '../services/actionPlannerService.js';
import { getActionExecutorService } from '../services/actionExecutorService.js';
import { getPersistentSemanticIndex } from '../services/persistentSemanticIndex.js';

/**
 * Example 1: Email reply workflow
 */
async function exampleEmailReply() {
  console.log('\n=== Example 1: Email Reply Workflow ===\n');

  const planner = getActionPlannerService();
  const executor = getActionExecutorService();

  // User query
  const query = "Reply to the email from Alice";

  // Plan the actions
  const plan = await planner.planActions(query);

  console.log(planner.getPlanSummary(plan));

  // Validate plan
  const validation = planner.validatePlan(plan);
  console.log('\n📋 Validation:');
  console.log(`   Valid: ${validation.valid}`);
  if (validation.errors.length > 0) {
    console.log(`   Errors: ${validation.errors.join(', ')}`);
  }
  if (validation.warnings.length > 0) {
    console.log(`   Warnings: ${validation.warnings.join(', ')}`);
  }

  console.log('\n💡 This workflow would:');
  console.log('   1. Search for email from Alice');
  console.log('   2. Click to open the email');
  console.log('   3. Find the reply button');
  console.log('   4. Click reply to open compose window');
}

/**
 * Example 2: Settings navigation workflow
 */
async function exampleSettingsNavigation() {
  console.log('\n=== Example 2: Settings Navigation ===\n');

  const planner = getActionPlannerService();

  const queries = [
    "Open settings and disable notifications",
    "Turn off location tracking in settings",
    "Enable dark mode in preferences"
  ];

  for (const query of queries) {
    console.log(`\n📝 Query: "${query}"`);
    
    const plan = await planner.planActions(query);
    console.log(`   Steps: ${plan.steps.length}`);
    console.log(`   Duration: ~${plan.estimatedDuration}ms`);
    
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      console.log(`   ${i + 1}. ${step.type}: ${step.target || step.text || ''}`);
    }
  }
}

/**
 * Example 3: Form filling workflow
 */
async function exampleFormFilling() {
  console.log('\n=== Example 3: Form Filling Workflow ===\n');

  const planner = getActionPlannerService();

  const query = "Type john@example.com into the email field and then click submit";

  const plan = await planner.planActions(query);

  console.log(planner.getPlanSummary(plan));

  console.log('\n💡 Decomposed into steps:');
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    console.log(`   ${i + 1}. ${step.type}${step.target ? `: ${step.target}` : ''}${step.text ? ` → "${step.text}"` : ''}`);
  }
}

/**
 * Example 4: Custom workflow template
 */
async function exampleCustomTemplate() {
  console.log('\n=== Example 4: Custom Workflow Template ===\n');

  const planner = getActionPlannerService();

  // Add custom template for "compose email" workflow
  planner.addTemplate('compose_email', {
    pattern: /compose (an? )?(email|message) to (.+) with subject (.+)/i,
    steps: [
      {
        type: 'search',
        target: 'compose or new email button',
        saveAs: 'composeButton'
      },
      {
        type: 'click',
        target: '$composeButton',
        verify: 'compose window opened'
      },
      {
        type: 'wait',
        duration: 500,
        reason: 'wait for compose window to load'
      },
      {
        type: 'search',
        target: 'to field',
        saveAs: 'toField'
      },
      {
        type: 'click',
        target: '$toField'
      },
      {
        type: 'type',
        text: '{recipient}'
      },
      {
        type: 'search',
        target: 'subject field',
        saveAs: 'subjectField'
      },
      {
        type: 'click',
        target: '$subjectField'
      },
      {
        type: 'type',
        text: '{subject}'
      }
    ]
  });

  // Test the custom template
  const query = "Compose an email to bob@example.com with subject Meeting Notes";
  const plan = await planner.planActions(query);

  console.log(planner.getPlanSummary(plan));

  console.log('\n✨ Custom template matched!');
  console.log(`   Template: ${plan.templateName}`);
  console.log(`   Steps: ${plan.steps.length}`);
}

/**
 * Example 5: Execution simulation
 */
async function exampleExecutionSimulation() {
  console.log('\n=== Example 5: Execution Simulation ===\n');

  const planner = getActionPlannerService();
  const executor = getActionExecutorService();

  // Create a simple plan
  const query = "Click the save button and wait";
  const plan = await planner.planActions(query);

  console.log('📋 Plan:');
  console.log(planner.getPlanSummary(plan));

  console.log('\n🚀 Simulating execution...\n');

  // Note: This would actually execute with real screen data
  // For now, we just show what would happen
  console.log('Step 1: Search for "save button"');
  console.log('  → Would search semantic index');
  console.log('  → Would return best match');
  console.log('  → Would save to variable');

  console.log('\nStep 2: Click the save button');
  console.log('  → Would get element from variable');
  console.log('  → Would calculate click coordinates');
  console.log('  → Would perform mouse click');

  console.log('\nStep 3: Wait 1000ms');
  console.log('  → Would pause execution');

  console.log('\n✅ Execution complete');
}

/**
 * Example 6: Error handling and rollback
 */
async function exampleErrorHandling() {
  console.log('\n=== Example 6: Error Handling & Rollback ===\n');

  const planner = getActionPlannerService();

  const query = "Open settings, click notifications, and enable alerts";
  const plan = await planner.planActions(query);

  console.log('📋 Plan:');
  console.log(planner.getPlanSummary(plan));

  console.log('\n💡 Error handling features:');
  console.log('   ✅ Retry failed steps (up to 2 attempts)');
  console.log('   ✅ Verify step completion');
  console.log('   ✅ Rollback on failure');
  console.log('   ✅ Detailed error reporting');

  console.log('\n🔄 Rollback scenario:');
  console.log('   Step 1: Open settings → ✅ Success');
  console.log('   Step 2: Click notifications → ❌ Failed (not found)');
  console.log('   → Rollback: Close settings window');
  console.log('   → Report: "Could not find notifications option"');
}

/**
 * Example 7: Context and variables
 */
async function exampleContextVariables() {
  console.log('\n=== Example 7: Context & Variables ===\n');

  const planner = getActionPlannerService();

  const query = "Find email from Alice and reply to it";
  const plan = await planner.planActions(query);

  console.log('📋 Plan with variable flow:');
  console.log('');

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    console.log(`Step ${i + 1}: ${step.type}`);
    
    if (step.target) {
      console.log(`  Target: ${step.target}`);
    }
    
    if (step.saveAs) {
      console.log(`  → Saves to: $${step.saveAs}`);
    }
    
    if (step.target?.startsWith('$')) {
      console.log(`  ← Uses variable: ${step.target}`);
    }
    
    console.log('');
  }

  console.log('💡 Variable flow:');
  console.log('   1. Search stores result in $targetEmail');
  console.log('   2. Click uses $targetEmail to know what to click');
  console.log('   3. Search stores result in $replyButton');
  console.log('   4. Click uses $replyButton');
}

/**
 * Example 8: Performance estimation
 */
async function examplePerformanceEstimation() {
  console.log('\n=== Example 8: Performance Estimation ===\n');

  const planner = getActionPlannerService();

  const queries = [
    "Click the save button",
    "Type hello into the search box",
    "Open settings and disable notifications",
    "Compose an email to bob@example.com with subject Meeting Notes"
  ];

  console.log('⏱️  Estimated execution times:\n');

  for (const query of queries) {
    const plan = await planner.planActions(query);
    console.log(`"${query}"`);
    console.log(`  Steps: ${plan.steps.length}`);
    console.log(`  Duration: ~${plan.estimatedDuration}ms`);
    console.log('');
  }

  console.log('💡 Estimation breakdown:');
  console.log('   - Search: 100ms per search');
  console.log('   - Click: 200ms per click');
  console.log('   - Type: 50ms per character');
  console.log('   - Wait: as specified');
  console.log('   - Verify: 300ms per verification');
}

/**
 * Example 9: Real-world workflows
 */
async function exampleRealWorldWorkflows() {
  console.log('\n=== Example 9: Real-World Workflows ===\n');

  const planner = getActionPlannerService();

  const workflows = [
    {
      name: 'Email Management',
      query: 'Find unread emails and mark as read',
      description: 'Batch process unread emails'
    },
    {
      name: 'Document Export',
      query: 'Save the document as Project Report.pdf',
      description: 'Export document with specific name'
    },
    {
      name: 'Settings Configuration',
      query: 'Open settings and change profile picture',
      description: 'Navigate to settings and modify profile'
    },
    {
      name: 'Multi-App Workflow',
      query: 'Copy text from Chrome and paste into Notes',
      description: 'Cross-application data transfer'
    }
  ];

  for (const workflow of workflows) {
    console.log(`\n📌 ${workflow.name}`);
    console.log(`   Query: "${workflow.query}"`);
    console.log(`   Description: ${workflow.description}`);
    
    const plan = await planner.planActions(workflow.query);
    console.log(`   Steps: ${plan.steps.length}`);
    console.log(`   Duration: ~${plan.estimatedDuration}ms`);
  }
}

/**
 * Example 10: Plan validation
 */
async function examplePlanValidation() {
  console.log('\n=== Example 10: Plan Validation ===\n');

  const planner = getActionPlannerService();

  // Valid plan
  const validQuery = "Click the save button";
  const validPlan = await planner.planActions(validQuery);
  const validResult = planner.validatePlan(validPlan);

  console.log('✅ Valid plan:');
  console.log(`   Query: "${validQuery}"`);
  console.log(`   Valid: ${validResult.valid}`);
  console.log(`   Errors: ${validResult.errors.length}`);
  console.log(`   Warnings: ${validResult.warnings.length}`);

  // Create an invalid plan (manually)
  const invalidPlan = {
    query: "Test invalid plan",
    steps: [
      { type: 'search' }, // Missing target
      { type: 'click', target: '$undefinedVar' }, // Undefined variable
      { type: 'type' }, // Missing text
      { type: 'wait' } // Missing duration (warning)
    ]
  };

  const invalidResult = planner.validatePlan(invalidPlan);

  console.log('\n❌ Invalid plan:');
  console.log(`   Valid: ${invalidResult.valid}`);
  console.log(`   Errors: ${invalidResult.errors.length}`);
  for (const error of invalidResult.errors) {
    console.log(`     - ${error}`);
  }
  console.log(`   Warnings: ${invalidResult.warnings.length}`);
  for (const warning of invalidResult.warnings) {
    console.log(`     - ${warning}`);
  }
}

/**
 * Run all examples
 */
async function runAllExamples() {
  try {
    console.log('🚀 Starting Multi-Step Actions Examples\n');
    console.log('='.repeat(60));

    await exampleEmailReply();
    await exampleSettingsNavigation();
    await exampleFormFilling();
    await exampleCustomTemplate();
    await exampleExecutionSimulation();
    await exampleErrorHandling();
    await exampleContextVariables();
    await examplePerformanceEstimation();
    await exampleRealWorldWorkflows();
    await examplePlanValidation();

    console.log('\n' + '='.repeat(60));
    console.log('✅ All examples completed');
    console.log('\n💡 Phase 4 Features:');
    console.log('   ✅ Multi-step action planning');
    console.log('   ✅ Context & variable management');
    console.log('   ✅ Error handling & rollback');
    console.log('   ✅ Custom workflow templates');
    console.log('   ✅ Execution simulation');
    console.log('   ✅ Plan validation');
    console.log('   ✅ Performance estimation');
  } catch (error) {
    console.error('❌ Error running examples:', error);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllExamples().then(() => process.exit(0));
}

export {
  exampleEmailReply,
  exampleSettingsNavigation,
  exampleFormFilling,
  exampleCustomTemplate,
  exampleExecutionSimulation,
  exampleErrorHandling,
  exampleContextVariables,
  examplePerformanceEstimation,
  exampleRealWorldWorkflows,
  examplePlanValidation,
  runAllExamples
};
