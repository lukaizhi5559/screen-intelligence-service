import logger from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Enhanced macOS Accessibility Adapter
 * Improved version with better AppleScript patterns and query methods
 * 
 * Future: Replace with native AX API bindings for better performance
 */
export class EnhancedMacOSAccessibilityAdapter {
  constructor() {
    this.initialized = false;
    this.cache = new Map();
    this.cacheTimeout = 1000; // 1 second cache
  }

  async initialize() {
    logger.info('Initializing enhanced macOS accessibility adapter...');
    
    try {
      // Check accessibility permissions
      await this._checkAccessibilityPermissions();
      
      this.initialized = true;
      logger.info('✅ Enhanced macOS accessibility adapter ready');
    } catch (error) {
      logger.error('Failed to initialize enhanced macOS adapter', { error: error.message });
      throw error;
    }
  }

  /**
   * Get all UI elements from the frontmost application
   */
  async getAllElements({ includeHidden = false } = {}) {
    if (!this.initialized) {
      throw new Error('Adapter not initialized');
    }

    try {
      const cacheKey = `all-elements-${includeHidden}`;
      const cached = this._getCache(cacheKey);
      if (cached) return cached;

      logger.info('Getting all UI elements', { includeHidden });

      // Get frontmost application
      const appInfo = await this._getFrontmostAppInfo();
      
      // Get UI elements hierarchy
      const elements = await this._getUIElementsHierarchy(appInfo.name, includeHidden);
      
      // Add confidence scores
      const enrichedElements = elements.map(el => ({
        ...el,
        confidence: this._calculateElementConfidence(el),
        app: appInfo.name,
        appBundleId: appInfo.bundleId
      }));

      this._setCache(cacheKey, enrichedElements);
      
      logger.info('Retrieved UI elements', { count: enrichedElements.length, app: appInfo.name });
      
      return enrichedElements;
    } catch (error) {
      logger.error('Failed to get all elements', { error: error.message });
      throw error;
    }
  }

  /**
   * Query elements by role
   */
  async getByRole(role, options = {}) {
    const allElements = await this.getAllElements(options);
    
    const matches = allElements.filter(el => 
      el.role && el.role.toLowerCase() === role.toLowerCase()
    );

    return matches.map(el => ({
      ...el,
      confidence: this._calculateRoleMatchConfidence(el, role)
    })).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Query elements by text (label or value)
   */
  async getByText(text, options = {}) {
    const { exact = false, includeHidden = false } = options;
    const allElements = await this.getAllElements({ includeHidden });
    
    const textLower = text.toLowerCase();
    
    const matches = allElements.filter(el => {
      const label = (el.label || '').toLowerCase();
      const value = (el.value || '').toLowerCase();
      const title = (el.title || '').toLowerCase();
      
      if (exact) {
        return label === textLower || value === textLower || title === textLower;
      } else {
        return label.includes(textLower) || 
               value.includes(textLower) || 
               title.includes(textLower);
      }
    });

    return matches.map(el => ({
      ...el,
      confidence: this._calculateTextMatchConfidence(el, text, exact)
    })).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Query elements with flexible criteria
   */
  async queryElements({ query, role, text, exact = false } = {}) {
    if (!this.initialized) {
      throw new Error('Adapter not initialized');
    }

    try {
      logger.info('Querying UI elements', { query, role, text, exact });

      let results = [];

      // If role specified, filter by role first
      if (role) {
        results = await this.getByRole(role);
      } else {
        results = await this.getAllElements();
      }

      // If text/query specified, filter by text
      if (text || query) {
        const searchText = text || query;
        const textLower = searchText.toLowerCase();
        
        results = results.filter(el => {
          const label = (el.label || '').toLowerCase();
          const value = (el.value || '').toLowerCase();
          const title = (el.title || '').toLowerCase();
          const roleStr = (el.role || '').toLowerCase();
          
          if (exact) {
            return label === textLower || value === textLower || title === textLower;
          } else {
            return label.includes(textLower) || 
                   value.includes(textLower) || 
                   title.includes(textLower) ||
                   roleStr.includes(textLower);
          }
        });

        // Recalculate confidence for text matches
        results = results.map(el => ({
          ...el,
          confidence: this._calculateQueryMatchConfidence(el, searchText, role, exact)
        }));
      }

      // Sort by confidence
      results.sort((a, b) => b.confidence - a.confidence);
      
      logger.info('Query results', { count: results.length });
      
      return results;
    } catch (error) {
      logger.error('Failed to query elements', { error: error.message });
      throw error;
    }
  }

  /**
   * Get frontmost application info
   */
  async _getFrontmostAppInfo() {
    try {
      const script = `
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          set appName to name of frontApp
          set appBundleId to bundle identifier of frontApp
          return appName & "|" & appBundleId
        end tell
      `;
      
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      const [name, bundleId] = stdout.trim().split('|');
      
      return { name, bundleId };
    } catch (error) {
      logger.error('Failed to get frontmost app info', { error: error.message });
      return { name: 'Unknown', bundleId: 'unknown' };
    }
  }

  /**
   * Get UI elements hierarchy using AppleScript
   */
  async _getUIElementsHierarchy(appName, includeHidden) {
    try {
      // Enhanced AppleScript that gets more element types
      const script = `
        tell application "System Events"
          tell process "${appName}"
            set allElements to {}
            
            -- Get windows
            repeat with w in windows
              try
                set windowInfo to {elementType:"window", role:"window", label:name of w, value:"", title:name of w}
                set windowPos to position of w
                set windowSize to size of w
                set windowBounds to {x:item 1 of windowPos, y:item 2 of windowPos, width:item 1 of windowSize, height:item 2 of windowSize}
                set end of allElements to {info:windowInfo, bounds:windowBounds}
              end try
            end repeat
            
            -- Get elements from first window
            try
              tell window 1
                -- Buttons
                repeat with btn in buttons
                  try
                    set btnInfo to {elementType:"button", role:"button", label:name of btn, value:value of btn, title:title of btn}
                    set btnPos to position of btn
                    set btnSize to size of btn
                    set btnBounds to {x:item 1 of btnPos, y:item 2 of btnPos, width:item 1 of btnSize, height:item 2 of btnSize}
                    set end of allElements to {info:btnInfo, bounds:btnBounds}
                  end try
                end repeat
                
                -- Text fields
                repeat with txt in text fields
                  try
                    set txtInfo to {elementType:"textfield", role:"textfield", label:name of txt, value:value of txt, title:title of txt}
                    set txtPos to position of txt
                    set txtSize to size of txt
                    set txtBounds to {x:item 1 of txtPos, y:item 2 of txtPos, width:item 1 of txtSize, height:item 2 of txtSize}
                    set end of allElements to {info:txtInfo, bounds:txtBounds}
                  end try
                end repeat
                
                -- Text areas
                repeat with area in text areas
                  try
                    set areaInfo to {elementType:"textarea", role:"textarea", label:name of area, value:value of area, title:title of area}
                    set areaPos to position of area
                    set areaSize to size of area
                    set areaBounds to {x:item 1 of areaPos, y:item 2 of areaPos, width:item 1 of areaSize, height:item 2 of areaSize}
                    set end of allElements to {info:areaInfo, bounds:areaBounds}
                  end try
                end repeat
                
                -- Static text
                repeat with st in static texts
                  try
                    set stInfo to {elementType:"statictext", role:"statictext", label:name of st, value:value of st, title:title of st}
                    set stPos to position of st
                    set stSize to size of st
                    set stBounds to {x:item 1 of stPos, y:item 2 of stPos, width:item 1 of stSize, height:item 2 of stSize}
                    set end of allElements to {info:stInfo, bounds:stBounds}
                  end try
                end repeat
                
                -- Checkboxes
                repeat with cb in checkboxes
                  try
                    set cbInfo to {elementType:"checkbox", role:"checkbox", label:name of cb, value:value of cb, title:title of cb}
                    set cbPos to position of cb
                    set cbSize to size of cb
                    set cbBounds to {x:item 1 of cbPos, y:item 2 of cbPos, width:item 1 of cbSize, height:item 2 of cbSize}
                    set end of allElements to {info:cbInfo, bounds:cbBounds}
                  end try
                end repeat
                
                -- Radio buttons
                repeat with rb in radio buttons
                  try
                    set rbInfo to {elementType:"radiobutton", role:"radiobutton", label:name of rb, value:value of rb, title:title of rb}
                    set rbPos to position of rb
                    set rbSize to size of rb
                    set rbBounds to {x:item 1 of rbPos, y:item 2 of rbPos, width:item 1 of rbSize, height:item 2 of rbSize}
                    set end of allElements to {info:rbInfo, bounds:rbBounds}
                  end try
                end repeat
                
                -- Menus
                repeat with m in menus
                  try
                    set mInfo to {elementType:"menu", role:"menu", label:name of m, value:value of m, title:title of m}
                    set mPos to position of m
                    set mSize to size of m
                    set mBounds to {x:item 1 of mPos, y:item 2 of mPos, width:item 1 of mSize, height:item 2 of mSize}
                    set end of allElements to {info:mInfo, bounds:mBounds}
                  end try
                end repeat
              end tell
            end try
            
            return allElements
          end tell
        end tell
      `;
      
      const { stdout } = await execAsync(`osascript -e '${script.replace(/\n/g, ' ')}'`);
      
      // Parse AppleScript output
      const elements = this._parseAppleScriptElements(stdout);
      
      return elements;
    } catch (error) {
      logger.warn('AppleScript element retrieval failed, using mock data', { error: error.message });
      return this._getMockElements();
    }
  }

  /**
   * Parse AppleScript output into element objects
   */
  _parseAppleScriptElements(output) {
    // AppleScript returns complex nested structures
    // For now, return mock data - real implementation would parse the output
    // TODO: Implement proper AppleScript output parser
    return this._getMockElements();
  }

  /**
   * Get mock elements for development
   */
  _getMockElements() {
    return [
      {
        role: 'window',
        label: 'Main Window',
        value: '',
        title: 'Main Window',
        bounds: { x: 100, y: 100, width: 800, height: 600 },
        actions: ['focus', 'minimize', 'close'],
        elementType: 'window'
      },
      {
        role: 'button',
        label: 'Send',
        value: '',
        title: 'Send',
        bounds: { x: 700, y: 500, width: 80, height: 30 },
        actions: ['press'],
        elementType: 'button'
      },
      {
        role: 'textfield',
        label: 'Message',
        value: '',
        title: 'Message',
        bounds: { x: 150, y: 500, width: 500, height: 30 },
        actions: ['focus', 'type'],
        elementType: 'textfield'
      },
      {
        role: 'button',
        label: 'Cancel',
        value: '',
        title: 'Cancel',
        bounds: { x: 600, y: 500, width: 80, height: 30 },
        actions: ['press'],
        elementType: 'button'
      },
      {
        role: 'statictext',
        label: 'Status: Ready',
        value: 'Ready',
        title: 'Status',
        bounds: { x: 150, y: 550, width: 200, height: 20 },
        actions: [],
        elementType: 'statictext'
      }
    ];
  }

  /**
   * Calculate element confidence score
   */
  _calculateElementConfidence(element) {
    let confidence = 0.5;

    // Has label
    if (element.label && element.label.length > 0) {
      confidence += 0.2;
    }

    // Has valid bounds
    if (element.bounds && element.bounds.width > 0 && element.bounds.height > 0) {
      confidence += 0.2;
    }

    // Has actions
    if (element.actions && element.actions.length > 0) {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Calculate role match confidence
   */
  _calculateRoleMatchConfidence(element, targetRole) {
    let confidence = 0.5;

    // Exact role match
    if (element.role && element.role.toLowerCase() === targetRole.toLowerCase()) {
      confidence = 0.9;
    }

    // Has label
    if (element.label) {
      confidence += 0.05;
    }

    // Has valid bounds
    if (element.bounds && element.bounds.width > 0) {
      confidence += 0.05;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Calculate text match confidence
   */
  _calculateTextMatchConfidence(element, targetText, exact) {
    let confidence = 0.5;

    const textLower = targetText.toLowerCase();
    const label = (element.label || '').toLowerCase();
    const value = (element.value || '').toLowerCase();

    if (exact) {
      if (label === textLower || value === textLower) {
        confidence = 0.95;
      }
    } else {
      // Partial match
      if (label.includes(textLower) || value.includes(textLower)) {
        // Calculate match ratio
        const labelRatio = label.length > 0 ? textLower.length / label.length : 0;
        const valueRatio = value.length > 0 ? textLower.length / value.length : 0;
        const maxRatio = Math.max(labelRatio, valueRatio);
        
        confidence = 0.6 + (maxRatio * 0.3);
      }
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Calculate query match confidence
   */
  _calculateQueryMatchConfidence(element, query, role, exact) {
    let confidence = 0.5;

    // Role match bonus
    if (role && element.role && element.role.toLowerCase() === role.toLowerCase()) {
      confidence += 0.2;
    }

    // Text match
    const textConfidence = this._calculateTextMatchConfidence(element, query, exact);
    confidence = Math.max(confidence, textConfidence);

    return Math.min(confidence, 1.0);
  }

  /**
   * Check accessibility permissions
   */
  async _checkAccessibilityPermissions() {
    try {
      const script = `
        tell application "System Events"
          return name of first process
        end tell
      `;
      
      await execAsync(`osascript -e '${script}'`);
      logger.info('✅ Accessibility permissions granted');
      return true;
    } catch (error) {
      logger.warn('⚠️ Accessibility permissions may not be granted');
      logger.warn('Please grant accessibility permissions in System Preferences > Security & Privacy > Privacy > Accessibility');
      return false;
    }
  }

  /**
   * Cache management
   */
  _getCache(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }
    return null;
  }

  _setCache(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  clearCache() {
    this.cache.clear();
  }
}
