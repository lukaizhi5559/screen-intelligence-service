/**
 * Action Planner Service
 * Decomposes complex user queries into sequential action plans
 * Enables multi-step workflows and automation
 */

/**
 * Action types supported by the planner
 */
export const ACTION_TYPES = {
  SEARCH: 'search',           // Semantic search for UI element
  CLICK: 'click',             // Click on element
  TYPE: 'type',               // Type text into input
  WAIT: 'wait',               // Wait for condition or duration
  VERIFY: 'verify',           // Verify expected state
  SCROLL: 'scroll',           // Scroll to element
  DRAG: 'drag',               // Drag and drop
  HOVER: 'hover',             // Hover over element
  SCREENSHOT: 'screenshot',   // Capture screen state
  NAVIGATE: 'navigate',       // Navigate to URL (browser)
  PRESS_KEY: 'press_key',     // Press keyboard key
  SELECT: 'select'            // Select from dropdown
};

/**
 * Workflow templates for common patterns
 */
const WORKFLOW_TEMPLATES = {
  // Email workflows
  'reply_to_email': {
    pattern: /reply to (the )?(email|message) (from|about) (.+)/i,
    steps: [
      { type: ACTION_TYPES.SEARCH, target: 'email from {sender}', saveAs: 'targetEmail' },
      { type: ACTION_TYPES.CLICK, target: '$targetEmail', verify: 'email opened' },
      { type: ACTION_TYPES.SEARCH, target: 'reply button', saveAs: 'replyButton' },
      { type: ACTION_TYPES.CLICK, target: '$replyButton', verify: 'compose window' }
    ]
  },
  
  'forward_email': {
    pattern: /forward (the )?(email|message) (from|about) (.+) to (.+)/i,
    steps: [
      { type: ACTION_TYPES.SEARCH, target: 'email from {sender}', saveAs: 'targetEmail' },
      { type: ACTION_TYPES.CLICK, target: '$targetEmail', verify: 'email opened' },
      { type: ACTION_TYPES.SEARCH, target: 'forward button', saveAs: 'forwardButton' },
      { type: ACTION_TYPES.CLICK, target: '$forwardButton', verify: 'compose window' },
      { type: ACTION_TYPES.SEARCH, target: 'to field', saveAs: 'toField' },
      { type: ACTION_TYPES.CLICK, target: '$toField' },
      { type: ACTION_TYPES.TYPE, text: '{recipient}' }
    ]
  },
  
  // Settings workflows
  'open_settings': {
    pattern: /open settings (and|then)? (.+)?/i,
    steps: [
      { type: ACTION_TYPES.SEARCH, target: 'settings icon or button', saveAs: 'settingsButton' },
      { type: ACTION_TYPES.CLICK, target: '$settingsButton', verify: 'settings window opened' },
      { type: ACTION_TYPES.WAIT, duration: 500, reason: 'wait for settings to load' }
    ]
  },
  
  'change_setting': {
    pattern: /(enable|disable|turn on|turn off) (.+) in settings/i,
    steps: [
      { type: ACTION_TYPES.SEARCH, target: 'settings icon or button', saveAs: 'settingsButton' },
      { type: ACTION_TYPES.CLICK, target: '$settingsButton', verify: 'settings opened' },
      { type: ACTION_TYPES.WAIT, duration: 500 },
      { type: ACTION_TYPES.SEARCH, target: '{setting} option', saveAs: 'settingOption' },
      { type: ACTION_TYPES.CLICK, target: '$settingOption' },
      { type: ACTION_TYPES.SEARCH, target: 'toggle or checkbox for {setting}', saveAs: 'toggle' },
      { type: ACTION_TYPES.CLICK, target: '$toggle', verify: 'setting changed' }
    ]
  },
  
  // Document workflows
  'save_document': {
    pattern: /save (the )?(document|file) as (.+)/i,
    steps: [
      { type: ACTION_TYPES.SEARCH, target: 'save button or menu', saveAs: 'saveButton' },
      { type: ACTION_TYPES.CLICK, target: '$saveButton' },
      { type: ACTION_TYPES.WAIT, duration: 300 },
      { type: ACTION_TYPES.SEARCH, target: 'filename input', saveAs: 'filenameInput' },
      { type: ACTION_TYPES.CLICK, target: '$filenameInput' },
      { type: ACTION_TYPES.TYPE, text: '{filename}' },
      { type: ACTION_TYPES.SEARCH, target: 'save confirm button', saveAs: 'confirmButton' },
      { type: ACTION_TYPES.CLICK, target: '$confirmButton', verify: 'file saved' }
    ]
  },
  
  // Form workflows
  'fill_form_field': {
    pattern: /(type|enter|fill) (.+) (in|into) (.+)/i,
    steps: [
      { type: ACTION_TYPES.SEARCH, target: '{field} input', saveAs: 'inputField' },
      { type: ACTION_TYPES.CLICK, target: '$inputField' },
      { type: ACTION_TYPES.TYPE, text: '{value}' }
    ]
  },
  
  // Navigation workflows
  'click_and_wait': {
    pattern: /click (.+) and wait/i,
    steps: [
      { type: ACTION_TYPES.SEARCH, target: '{element}', saveAs: 'targetElement' },
      { type: ACTION_TYPES.CLICK, target: '$targetElement' },
      { type: ACTION_TYPES.WAIT, duration: 1000, reason: 'wait for action to complete' }
    ]
  }
};

class ActionPlannerService {
  constructor() {
    this.templates = WORKFLOW_TEMPLATES;
    this.customTemplates = new Map();
  }

  /**
   * Plan actions for a complex user query
   * @param {string} userQuery - User's natural language query
   * @param {Object} context - Current context (screen state, app, etc.)
   * @returns {Object} Action plan
   */
  async planActions(userQuery, context = {}) {
    console.log(`🎯 Planning actions for: "${userQuery}"`);

    // 1. Try to match workflow template
    const templateMatch = this._matchTemplate(userQuery);
    if (templateMatch) {
      console.log(`✅ Matched template: ${templateMatch.name}`);
      return this._buildPlanFromTemplate(templateMatch, userQuery, context);
    }

    // 2. Decompose query using heuristics
    const decomposed = this._decomposeQuery(userQuery, context);
    if (decomposed) {
      console.log(`✅ Decomposed into ${decomposed.steps.length} steps`);
      return decomposed;
    }

    // 3. Fallback to single-step action
    console.log(`⚠️  No multi-step pattern found, creating single-step plan`);
    return this._createSingleStepPlan(userQuery, context);
  }

  /**
   * Match query against workflow templates
   * @private
   */
  _matchTemplate(query) {
    const lowerQuery = query.toLowerCase();

    // Check built-in templates
    for (const [name, template] of Object.entries(this.templates)) {
      const match = lowerQuery.match(template.pattern);
      if (match) {
        return {
          name,
          template,
          matches: match
        };
      }
    }

    // Check custom templates
    for (const [name, template] of this.customTemplates.entries()) {
      const match = lowerQuery.match(template.pattern);
      if (match) {
        return {
          name,
          template,
          matches: match
        };
      }
    }

    return null;
  }

  /**
   * Build action plan from matched template
   * @private
   */
  _buildPlanFromTemplate(templateMatch, userQuery, context) {
    const { template, matches } = templateMatch;
    
    // Clone template steps
    const steps = JSON.parse(JSON.stringify(template.steps));

    // Substitute placeholders with matched values
    const substitutions = this._extractSubstitutions(templateMatch, userQuery);
    
    for (const step of steps) {
      // Substitute in target
      if (step.target) {
        step.target = this._substituteVariables(step.target, substitutions);
      }
      
      // Substitute in text
      if (step.text) {
        step.text = this._substituteVariables(step.text, substitutions);
      }
      
      // Substitute in verify
      if (step.verify) {
        step.verify = this._substituteVariables(step.verify, substitutions);
      }
    }

    return {
      query: userQuery,
      templateName: templateMatch.name,
      steps,
      context,
      estimatedDuration: this._estimateDuration(steps),
      createdAt: Date.now()
    };
  }

  /**
   * Extract variable substitutions from template match
   * @private
   */
  _extractSubstitutions(templateMatch, query) {
    const { template, matches } = templateMatch;
    const substitutions = {};

    // Common patterns
    if (template.pattern.source.includes('from|about')) {
      const senderMatch = query.match(/(from|about)\s+([^,]+)/i);
      if (senderMatch) {
        substitutions.sender = senderMatch[2].trim();
      }
    }

    if (template.pattern.source.includes('to')) {
      const recipientMatch = query.match(/to\s+([^,]+)/i);
      if (recipientMatch) {
        substitutions.recipient = recipientMatch[1].trim();
      }
    }

    if (template.pattern.source.includes('enable|disable')) {
      const actionMatch = query.match(/(enable|disable|turn on|turn off)\s+([^,]+)/i);
      if (actionMatch) {
        substitutions.action = actionMatch[1].trim();
        substitutions.setting = actionMatch[2].trim();
      }
    }

    if (template.pattern.source.includes('as')) {
      const filenameMatch = query.match(/as\s+(.+)/i);
      if (filenameMatch) {
        substitutions.filename = filenameMatch[1].trim();
      }
    }

    // Extract field and value for form filling
    if (template.pattern.source.includes('type|enter|fill')) {
      const formMatch = query.match(/(type|enter|fill)\s+(.+?)\s+(in|into)\s+(.+)/i);
      if (formMatch) {
        substitutions.value = formMatch[2].trim();
        substitutions.field = formMatch[4].trim();
      }
    }

    // Extract element for click
    if (template.pattern.source.includes('click')) {
      const clickMatch = query.match(/click\s+(.+?)(\s+and|$)/i);
      if (clickMatch) {
        substitutions.element = clickMatch[1].trim();
      }
    }

    return substitutions;
  }

  /**
   * Substitute variables in string
   * @private
   */
  _substituteVariables(str, substitutions) {
    let result = str;
    for (const [key, value] of Object.entries(substitutions)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
  }

  /**
   * Decompose query using heuristics
   * @private
   */
  _decomposeQuery(query, context) {
    const steps = [];
    const lowerQuery = query.toLowerCase();

    // Check for "and" or "then" indicating multiple steps
    if (!lowerQuery.includes(' and ') && !lowerQuery.includes(' then ')) {
      return null; // Single action, no decomposition needed
    }

    // Split by "and" or "then"
    const parts = query.split(/\s+(?:and|then)\s+/i);

    for (const part of parts) {
      const step = this._parseQueryPart(part.trim(), context);
      if (step) {
        steps.push(step);
      }
    }

    if (steps.length === 0) {
      return null;
    }

    return {
      query,
      steps,
      context,
      estimatedDuration: this._estimateDuration(steps),
      createdAt: Date.now()
    };
  }

  /**
   * Parse a single query part into an action step
   * @private
   */
  _parseQueryPart(part, context) {
    const lowerPart = part.toLowerCase();

    // Click action
    if (lowerPart.startsWith('click')) {
      const target = part.replace(/^click\s+/i, '').trim();
      return {
        type: ACTION_TYPES.SEARCH,
        target,
        saveAs: `element_${Date.now()}`,
        nextAction: {
          type: ACTION_TYPES.CLICK,
          target: `$element_${Date.now()}`
        }
      };
    }

    // Type action
    if (lowerPart.match(/^(type|enter|fill)/)) {
      const match = part.match(/(type|enter|fill)\s+(.+?)\s+(in|into)\s+(.+)/i);
      if (match) {
        return {
          type: ACTION_TYPES.SEARCH,
          target: match[4].trim(),
          saveAs: `input_${Date.now()}`,
          nextAction: {
            type: ACTION_TYPES.TYPE,
            target: `$input_${Date.now()}`,
            text: match[2].trim()
          }
        };
      }
    }

    // Wait action
    if (lowerPart.startsWith('wait')) {
      const durationMatch = part.match(/wait\s+(\d+)\s*(ms|seconds?)?/i);
      const duration = durationMatch ? parseInt(durationMatch[1]) : 1000;
      return {
        type: ACTION_TYPES.WAIT,
        duration: durationMatch && durationMatch[2]?.startsWith('s') ? duration * 1000 : duration,
        reason: 'user requested wait'
      };
    }

    // Open/navigate action
    if (lowerPart.match(/^(open|go to|navigate to)/)) {
      const target = part.replace(/^(open|go to|navigate to)\s+/i, '').trim();
      return {
        type: ACTION_TYPES.SEARCH,
        target,
        saveAs: `nav_${Date.now()}`,
        nextAction: {
          type: ACTION_TYPES.CLICK,
          target: `$nav_${Date.now()}`
        }
      };
    }

    // Generic search
    return {
      type: ACTION_TYPES.SEARCH,
      target: part,
      saveAs: `result_${Date.now()}`
    };
  }

  /**
   * Create single-step plan for simple queries
   * @private
   */
  _createSingleStepPlan(query, context) {
    const step = this._parseQueryPart(query, context);
    
    return {
      query,
      steps: step ? [step] : [],
      context,
      estimatedDuration: 500,
      createdAt: Date.now()
    };
  }

  /**
   * Estimate total duration for plan
   * @private
   */
  _estimateDuration(steps) {
    let total = 0;
    
    for (const step of steps) {
      switch (step.type) {
        case ACTION_TYPES.SEARCH:
          total += 100; // 100ms for search
          break;
        case ACTION_TYPES.CLICK:
          total += 200; // 200ms for click + UI response
          break;
        case ACTION_TYPES.TYPE:
          total += (step.text?.length || 10) * 50; // 50ms per character
          break;
        case ACTION_TYPES.WAIT:
          total += step.duration || 1000;
          break;
        case ACTION_TYPES.VERIFY:
          total += 300; // 300ms for verification
          break;
        default:
          total += 200;
      }
    }
    
    return total;
  }

  /**
   * Add custom workflow template
   * @param {string} name - Template name
   * @param {Object} template - Template definition
   */
  addTemplate(name, template) {
    this.customTemplates.set(name, template);
    console.log(`✅ Added custom template: ${name}`);
  }

  /**
   * Validate action plan
   * @param {Object} plan - Action plan to validate
   * @returns {Object} Validation result
   */
  validatePlan(plan) {
    const errors = [];
    const warnings = [];

    if (!plan.steps || plan.steps.length === 0) {
      errors.push('Plan has no steps');
    }

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      
      // Check required fields
      if (!step.type) {
        errors.push(`Step ${i}: Missing type`);
      }
      
      // Check type-specific requirements
      if (step.type === ACTION_TYPES.SEARCH && !step.target) {
        errors.push(`Step ${i}: Search requires target`);
      }
      
      if (step.type === ACTION_TYPES.TYPE && !step.text) {
        errors.push(`Step ${i}: Type requires text`);
      }
      
      if (step.type === ACTION_TYPES.WAIT && !step.duration) {
        warnings.push(`Step ${i}: Wait has no duration, using default`);
      }
      
      // Check variable references
      if (step.target?.startsWith('$')) {
        const varName = step.target.substring(1);
        const varDefined = plan.steps.slice(0, i).some(s => s.saveAs === varName);
        if (!varDefined) {
          errors.push(`Step ${i}: References undefined variable ${varName}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Get plan summary
   * @param {Object} plan - Action plan
   * @returns {string} Human-readable summary
   */
  getPlanSummary(plan) {
    const lines = [
      `📋 Action Plan: ${plan.query}`,
      `   Steps: ${plan.steps.length}`,
      `   Estimated duration: ${plan.estimatedDuration}ms`,
      ''
    ];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      lines.push(`   ${i + 1}. ${this._formatStep(step)}`);
    }

    return lines.join('\n');
  }

  /**
   * Format step for display
   * @private
   */
  _formatStep(step) {
    switch (step.type) {
      case ACTION_TYPES.SEARCH:
        return `Search for "${step.target}"${step.saveAs ? ` → $${step.saveAs}` : ''}`;
      case ACTION_TYPES.CLICK:
        return `Click ${step.target}${step.verify ? ` (verify: ${step.verify})` : ''}`;
      case ACTION_TYPES.TYPE:
        return `Type "${step.text}" into ${step.target}`;
      case ACTION_TYPES.WAIT:
        return `Wait ${step.duration}ms${step.reason ? ` (${step.reason})` : ''}`;
      case ACTION_TYPES.VERIFY:
        return `Verify ${step.condition}`;
      default:
        return `${step.type}: ${step.target || ''}`;
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton action planner service instance
 */
export function getActionPlannerService() {
  if (!instance) {
    instance = new ActionPlannerService();
  }
  return instance;
}

export { ActionPlannerService };
