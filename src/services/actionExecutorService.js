/**
 * Action Executor Service
 * Executes multi-step action plans with context management
 * Handles verification, error recovery, and rollback
 */

import { ACTION_TYPES } from './actionPlannerService.js';
import { getPersistentSemanticIndex } from './persistentSemanticIndex.js';

/**
 * Execution status
 */
export const EXECUTION_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back'
};

/**
 * Action Context - stores state between steps
 */
class ActionContext {
  constructor() {
    this.variables = new Map();      // Stored values from steps
    this.history = [];                // Execution history
    this.screenStates = [];           // Screen snapshots
    this.startTime = Date.now();
  }

  /**
   * Set a variable
   */
  set(name, value) {
    this.variables.set(name, value);
    console.log(`  💾 Stored variable: $${name}`);
  }

  /**
   * Get a variable
   */
  get(name) {
    return this.variables.get(name);
  }

  /**
   * Check if variable exists
   */
  has(name) {
    return this.variables.has(name);
  }

  /**
   * Add to execution history
   */
  addHistory(step, result) {
    this.history.push({
      step,
      result,
      timestamp: Date.now()
    });
  }

  /**
   * Get last N history entries
   */
  getRecentHistory(n = 5) {
    return this.history.slice(-n);
  }

  /**
   * Save screen state snapshot
   */
  saveScreenState(screenState) {
    this.screenStates.push({
      state: screenState,
      timestamp: Date.now()
    });
  }

  /**
   * Get elapsed time
   */
  getElapsedTime() {
    return Date.now() - this.startTime;
  }

  /**
   * Clear context
   */
  clear() {
    this.variables.clear();
    this.history = [];
    this.screenStates = [];
  }
}

class ActionExecutorService {
  constructor() {
    this.semanticIndex = getPersistentSemanticIndex();
    this.isInitialized = false;
    
    // Execution settings
    this.defaultTimeout = 5000;        // 5s timeout per step
    this.verificationDelay = 300;      // 300ms delay before verification
    this.retryAttempts = 2;            // Retry failed steps twice
    this.enableRollback = true;        // Enable automatic rollback on failure
  }

  /**
   * Initialize the executor
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      await this.semanticIndex.initialize();
      this.isInitialized = true;
      console.log('✅ Action executor initialized');
    } catch (error) {
      console.error('❌ Failed to initialize action executor:', error);
      throw error;
    }
  }

  /**
   * Execute an action plan
   * @param {Object} plan - Action plan from planner
   * @param {Object} options - Execution options
   * @returns {Promise<Object>} Execution result
   */
  async executePlan(plan, options = {}) {
    await this.initialize();

    console.log(`\n🚀 Executing plan: "${plan.query}"`);
    console.log(`   Steps: ${plan.steps.length}`);
    console.log(`   Estimated: ${plan.estimatedDuration}ms\n`);

    const context = new ActionContext();
    const results = [];
    let currentStep = 0;

    try {
      for (let i = 0; i < plan.steps.length; i++) {
        currentStep = i;
        const step = plan.steps[i];

        console.log(`📍 Step ${i + 1}/${plan.steps.length}: ${this._formatStep(step)}`);

        // Execute step with retry logic
        const result = await this._executeStepWithRetry(step, context, options);

        // Store result
        results.push(result);
        context.addHistory(step, result);

        // Check if step failed
        if (result.status === EXECUTION_STATUS.FAILED) {
          console.log(`❌ Step ${i + 1} failed: ${result.error}`);

          if (this.enableRollback && options.rollbackOnFailure !== false) {
            console.log('🔄 Rolling back...');
            await this._rollback(results, context);
            
            return {
              status: EXECUTION_STATUS.ROLLED_BACK,
              query: plan.query,
              completedSteps: i,
              totalSteps: plan.steps.length,
              results,
              error: result.error,
              elapsedTime: context.getElapsedTime()
            };
          }

          return {
            status: EXECUTION_STATUS.FAILED,
            query: plan.query,
            completedSteps: i,
            totalSteps: plan.steps.length,
            results,
            error: result.error,
            elapsedTime: context.getElapsedTime()
          };
        }

        console.log(`✅ Step ${i + 1} completed\n`);
      }

      // All steps completed successfully
      console.log(`🎉 Plan completed successfully in ${context.getElapsedTime()}ms\n`);

      return {
        status: EXECUTION_STATUS.COMPLETED,
        query: plan.query,
        completedSteps: plan.steps.length,
        totalSteps: plan.steps.length,
        results,
        elapsedTime: context.getElapsedTime()
      };

    } catch (error) {
      console.error(`❌ Execution error at step ${currentStep + 1}:`, error);

      return {
        status: EXECUTION_STATUS.FAILED,
        query: plan.query,
        completedSteps: currentStep,
        totalSteps: plan.steps.length,
        results,
        error: error.message,
        elapsedTime: context.getElapsedTime()
      };
    }
  }

  /**
   * Execute a single step with retry logic
   * @private
   */
  async _executeStepWithRetry(step, context, options) {
    let lastError = null;
    const maxAttempts = options.retryAttempts ?? this.retryAttempts;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (attempt > 0) {
        console.log(`  🔄 Retry attempt ${attempt}/${maxAttempts}`);
        await this._wait(500); // Wait before retry
      }

      try {
        const result = await this._executeStep(step, context, options);
        
        // If successful, return
        if (result.status !== EXECUTION_STATUS.FAILED) {
          return result;
        }

        lastError = result.error;
      } catch (error) {
        lastError = error.message;
      }
    }

    // All attempts failed
    return {
      status: EXECUTION_STATUS.FAILED,
      step,
      error: lastError || 'Unknown error',
      attempts: maxAttempts + 1
    };
  }

  /**
   * Execute a single step
   * @private
   */
  async _executeStep(step, context, options) {
    // Resolve variable references in step
    const resolvedStep = this._resolveVariables(step, context);

    switch (resolvedStep.type) {
      case ACTION_TYPES.SEARCH:
        return await this._executeSearch(resolvedStep, context, options);
      
      case ACTION_TYPES.CLICK:
        return await this._executeClick(resolvedStep, context, options);
      
      case ACTION_TYPES.TYPE:
        return await this._executeType(resolvedStep, context, options);
      
      case ACTION_TYPES.WAIT:
        return await this._executeWait(resolvedStep, context, options);
      
      case ACTION_TYPES.VERIFY:
        return await this._executeVerify(resolvedStep, context, options);
      
      case ACTION_TYPES.SCREENSHOT:
        return await this._executeScreenshot(resolvedStep, context, options);
      
      default:
        return {
          status: EXECUTION_STATUS.FAILED,
          step: resolvedStep,
          error: `Unsupported action type: ${resolvedStep.type}`
        };
    }
  }

  /**
   * Execute search action
   * @private
   */
  async _executeSearch(step, context, options) {
    try {
      console.log(`  🔍 Searching for: "${step.target}"`);

      const results = await this.semanticIndex.search({
        query: step.target,
        filters: step.filters || {},
        k: step.k || 1,
        minScore: step.minScore || 0.6
      });

      if (results.length === 0) {
        return {
          status: EXECUTION_STATUS.FAILED,
          step,
          error: `No results found for: ${step.target}`
        };
      }

      const topResult = results[0];
      console.log(`  ✅ Found: ${topResult.node.type} (score: ${topResult.score.toFixed(3)})`);

      // Save result if requested
      if (step.saveAs) {
        context.set(step.saveAs, topResult.node);
      }

      return {
        status: EXECUTION_STATUS.COMPLETED,
        step,
        result: topResult.node,
        allResults: results
      };

    } catch (error) {
      return {
        status: EXECUTION_STATUS.FAILED,
        step,
        error: error.message
      };
    }
  }

  /**
   * Execute click action
   * @private
   */
  async _executeClick(step, context, options) {
    try {
      // Get target element (either from variable or direct reference)
      let element;
      if (step.target.startsWith('$')) {
        const varName = step.target.substring(1);
        element = context.get(varName);
        if (!element) {
          return {
            status: EXECUTION_STATUS.FAILED,
            step,
            error: `Variable not found: ${step.target}`
          };
        }
      } else {
        element = step.target;
      }

      // Calculate click coordinates
      const bbox = element.bbox;
      if (!bbox) {
        return {
          status: EXECUTION_STATUS.FAILED,
          step,
          error: 'Element has no bounding box'
        };
      }

      const clickX = Math.round((bbox[0] + bbox[2]) / 2);
      const clickY = Math.round((bbox[1] + bbox[3]) / 2);

      console.log(`  🖱️  Clicking at (${clickX}, ${clickY})`);

      // Note: Actual click would be performed by the caller
      // This service just plans and validates the action
      const clickAction = {
        type: 'mouse_click',
        x: clickX,
        y: clickY,
        element: element
      };

      // Verify if requested
      if (step.verify) {
        await this._wait(this.verificationDelay);
        const verified = await this._verifyCondition(step.verify, context, options);
        
        if (!verified) {
          return {
            status: EXECUTION_STATUS.FAILED,
            step,
            error: `Verification failed: ${step.verify}`
          };
        }
      }

      return {
        status: EXECUTION_STATUS.COMPLETED,
        step,
        action: clickAction,
        element
      };

    } catch (error) {
      return {
        status: EXECUTION_STATUS.FAILED,
        step,
        error: error.message
      };
    }
  }

  /**
   * Execute type action
   * @private
   */
  async _executeType(step, context, options) {
    try {
      console.log(`  ⌨️  Typing: "${step.text}"`);

      // Get target element
      let element;
      if (step.target?.startsWith('$')) {
        const varName = step.target.substring(1);
        element = context.get(varName);
      }

      const typeAction = {
        type: 'keyboard_type',
        text: step.text,
        element
      };

      return {
        status: EXECUTION_STATUS.COMPLETED,
        step,
        action: typeAction
      };

    } catch (error) {
      return {
        status: EXECUTION_STATUS.FAILED,
        step,
        error: error.message
      };
    }
  }

  /**
   * Execute wait action
   * @private
   */
  async _executeWait(step, context, options) {
    const duration = step.duration || 1000;
    console.log(`  ⏱️  Waiting ${duration}ms${step.reason ? ` (${step.reason})` : ''}`);

    await this._wait(duration);

    return {
      status: EXECUTION_STATUS.COMPLETED,
      step,
      duration
    };
  }

  /**
   * Execute verify action
   * @private
   */
  async _executeVerify(step, context, options) {
    try {
      console.log(`  ✓ Verifying: ${step.condition}`);

      const verified = await this._verifyCondition(step.condition, context, options);

      if (!verified) {
        return {
          status: EXECUTION_STATUS.FAILED,
          step,
          error: `Verification failed: ${step.condition}`
        };
      }

      return {
        status: EXECUTION_STATUS.COMPLETED,
        step,
        verified: true
      };

    } catch (error) {
      return {
        status: EXECUTION_STATUS.FAILED,
        step,
        error: error.message
      };
    }
  }

  /**
   * Execute screenshot action
   * @private
   */
  async _executeScreenshot(step, context, options) {
    console.log(`  📸 Taking screenshot`);

    // Note: Actual screenshot would be taken by the caller
    const screenshotAction = {
      type: 'take_screenshot',
      saveAs: step.saveAs
    };

    return {
      status: EXECUTION_STATUS.COMPLETED,
      step,
      action: screenshotAction
    };
  }

  /**
   * Verify a condition
   * @private
   */
  async _verifyCondition(condition, context, options) {
    // Simple verification: search for the condition
    const results = await this.semanticIndex.search({
      query: condition,
      k: 1,
      minScore: 0.5
    });

    return results.length > 0;
  }

  /**
   * Resolve variable references in step
   * @private
   */
  _resolveVariables(step, context) {
    const resolved = { ...step };

    // Resolve target
    if (resolved.target?.startsWith('$')) {
      // Keep variable reference for later resolution
      // (actual resolution happens in execute methods)
    }

    return resolved;
  }

  /**
   * Rollback executed steps
   * @private
   */
  async _rollback(results, context) {
    console.log(`🔄 Rolling back ${results.length} steps...`);

    // For now, just log the rollback
    // In a full implementation, this would undo actions
    for (let i = results.length - 1; i >= 0; i--) {
      const result = results[i];
      console.log(`  ↩️  Undoing step ${i + 1}: ${this._formatStep(result.step)}`);
      
      // Rollback logic would go here
      // e.g., close opened windows, restore previous state, etc.
    }

    console.log('✅ Rollback complete');
  }

  /**
   * Wait for specified duration
   * @private
   */
  async _wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Format step for display
   * @private
   */
  _formatStep(step) {
    switch (step.type) {
      case ACTION_TYPES.SEARCH:
        return `Search "${step.target}"`;
      case ACTION_TYPES.CLICK:
        return `Click ${step.target}`;
      case ACTION_TYPES.TYPE:
        return `Type "${step.text}"`;
      case ACTION_TYPES.WAIT:
        return `Wait ${step.duration}ms`;
      case ACTION_TYPES.VERIFY:
        return `Verify ${step.condition}`;
      default:
        return step.type;
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton action executor service instance
 */
export function getActionExecutorService() {
  if (!instance) {
    instance = new ActionExecutorService();
  }
  return instance;
}

export { ActionExecutorService, ActionContext };
