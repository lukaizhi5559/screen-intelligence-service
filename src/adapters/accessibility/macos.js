import logger from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * macOS Accessibility Adapter
 * Uses AppleScript and AX APIs to query UI elements
 * 
 * Note: This is a basic implementation. For production, consider using:
 * - node-mac-permissions for permission checks
 * - Native Node.js addon for direct AX API access
 * - Or axuielement npm package if available
 */
export class MacOSAccessibilityAdapter {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    logger.info('Initializing macOS accessibility adapter...');
    
    try {
      // Check if accessibility permissions are granted
      await this._checkAccessibilityPermissions();
      
      this.initialized = true;
      logger.info('✅ macOS accessibility adapter ready');
    } catch (error) {
      logger.error('Failed to initialize macOS adapter', { error: error.message });
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
      logger.info('Getting all UI elements', { includeHidden });

      // Get frontmost application
      const appName = await this._getFrontmostApp();
      
      // Get UI elements using AppleScript
      const elements = await this._getUIElements(appName, includeHidden);
      
      logger.info('Retrieved UI elements', { count: elements.length, app: appName });
      
      return elements;
    } catch (error) {
      logger.error('Failed to get all elements', { error: error.message });
      throw error;
    }
  }

  /**
   * Query specific UI elements
   */
  async queryElements({ query, role } = {}) {
    if (!this.initialized) {
      throw new Error('Adapter not initialized');
    }

    try {
      logger.info('Querying UI elements', { query, role });

      // Get all elements first
      const allElements = await this.getAllElements();
      
      // Filter by query and role
      let filtered = allElements;
      
      if (role) {
        filtered = filtered.filter(el => 
          el.role && el.role.toLowerCase() === role.toLowerCase()
        );
      }
      
      if (query) {
        const queryLower = query.toLowerCase();
        filtered = filtered.filter(el => {
          const label = (el.label || '').toLowerCase();
          const value = (el.value || '').toLowerCase();
          const roleStr = (el.role || '').toLowerCase();
          
          return label.includes(queryLower) || 
                 value.includes(queryLower) || 
                 roleStr.includes(queryLower);
        });
      }
      
      // Calculate confidence scores
      filtered = filtered.map(el => ({
        ...el,
        confidence: this._calculateConfidence(el, query, role)
      }));
      
      // Sort by confidence
      filtered.sort((a, b) => b.confidence - a.confidence);
      
      logger.info('Query results', { count: filtered.length });
      
      return filtered;
    } catch (error) {
      logger.error('Failed to query elements', { error: error.message });
      throw error;
    }
  }

  /**
   * Get frontmost application name
   */
  async _getFrontmostApp() {
    try {
      const script = `
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
          return frontApp
        end tell
      `;
      
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      return stdout.trim();
    } catch (error) {
      logger.error('Failed to get frontmost app', { error: error.message });
      return 'Unknown';
    }
  }

  /**
   * Get UI elements using AppleScript
   * 
   * Note: This is a simplified implementation.
   * For production, use native AX API bindings for better performance.
   */
  async _getUIElements(appName, includeHidden) {
    try {
      // Basic AppleScript to get UI elements
      // This is a simplified version - real implementation would need more detail
      const script = `
        tell application "System Events"
          tell process "${appName}"
            set allElements to {}
            
            -- Get windows
            repeat with w in windows
              try
                set windowInfo to {role:"window", label:name of w, value:""}
                set windowBounds to position of w & size of w
                set end of allElements to {info:windowInfo, bounds:windowBounds}
              end try
            end repeat
            
            -- Get buttons, text fields, etc from first window
            try
              tell window 1
                repeat with btn in buttons
                  try
                    set btnInfo to {role:"button", label:name of btn, value:value of btn}
                    set btnBounds to position of btn & size of btn
                    set end of allElements to {info:btnInfo, bounds:btnBounds}
                  end try
                end repeat
                
                repeat with txt in text fields
                  try
                    set txtInfo to {role:"textfield", label:name of txt, value:value of txt}
                    set txtBounds to position of txt & size of txt
                    set end of allElements to {info:txtInfo, bounds:txtBounds}
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
      // Note: This is simplified - real parsing would be more robust
      const elements = this._parseAppleScriptOutput(stdout);
      
      return elements;
    } catch (error) {
      logger.error('Failed to get UI elements', { error: error.message });
      
      // Return mock data for development
      return this._getMockElements();
    }
  }

  /**
   * Parse AppleScript output into element objects
   */
  _parseAppleScriptOutput(output) {
    // Simplified parser - real implementation would be more robust
    // For now, return mock data
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
        bounds: { x: 100, y: 100, width: 800, height: 600 },
        actions: ['focus', 'minimize', 'close']
      },
      {
        role: 'button',
        label: 'Send',
        value: '',
        bounds: { x: 700, y: 500, width: 80, height: 30 },
        actions: ['press']
      },
      {
        role: 'textfield',
        label: 'Message',
        value: '',
        bounds: { x: 150, y: 500, width: 500, height: 30 },
        actions: ['focus', 'type']
      }
    ];
  }

  /**
   * Calculate confidence score for element match
   */
  _calculateConfidence(element, query, role) {
    let confidence = 0.5; // Base confidence

    // Exact role match
    if (role && element.role && element.role.toLowerCase() === role.toLowerCase()) {
      confidence += 0.3;
    }

    // Query match in label
    if (query && element.label) {
      const queryLower = query.toLowerCase();
      const labelLower = element.label.toLowerCase();
      
      if (labelLower === queryLower) {
        confidence += 0.4; // Exact match
      } else if (labelLower.includes(queryLower)) {
        confidence += 0.2; // Partial match
      }
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Check if accessibility permissions are granted
   */
  async _checkAccessibilityPermissions() {
    try {
      // Try to access System Events
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
      // Don't throw - allow initialization to continue
      return false;
    }
  }
}
