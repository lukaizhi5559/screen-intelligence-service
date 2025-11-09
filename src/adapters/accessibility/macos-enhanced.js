import logger from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ChromeDevToolsAdapter, getChromeDebugPort } from './chrome-devtools.js';
import { PlaywrightAdapter, getBrowserUrl } from './playwright-adapter.js';

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
    this.chromeAdapter = null;
    this.playwrightAdapter = null;
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
      logger.info('Getting all UI elements', { includeHidden });

      // Get frontmost application
      const appInfo = await this._getFrontmostAppInfo();
      
      // Cache key includes app name to avoid returning stale data when switching apps
      const cacheKey = `all-elements-${appInfo.name}-${includeHidden}`;
      const cached = this._getCache(cacheKey);
      if (cached) return cached;
      
      // Try web-specific adapters for browsers
      let elements = await this._getWebElements(appInfo);
      
      // Fallback to Accessibility API if web adapters didn't work
      if (!elements || elements.length === 0) {
        elements = await this._getUIElementsHierarchy(appInfo.name, includeHidden, appInfo);
      }
      
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
   * Try to get web elements using Chrome DevTools or Playwright
   * Returns null if not a web app or if adapters fail
   */
  async _getWebElements(appInfo) {
    const webBrowsers = ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'];
    const electronApps = ['Electron', 'Visual Studio Code', 'Slack', 'Discord', 'stable'];
    
    const isWebBrowser = webBrowsers.includes(appInfo.name);
    const isElectronApp = electronApps.includes(appInfo.name);

    if (!isWebBrowser && !isElectronApp) {
      return null; // Not a web app
    }

    logger.info('Detected web-based app, trying web adapters', { 
      app: appInfo.name,
      type: isWebBrowser ? 'browser' : 'electron'
    });

    // Strategy 1: Try Chrome DevTools Protocol (fastest, most accurate)
    if (isWebBrowser || isElectronApp) {
      const cdpElements = await this._tryChromeDevTools(appInfo);
      if (cdpElements && cdpElements.length > 0) {
        logger.info('✅ Got elements via Chrome DevTools Protocol', { count: cdpElements.length });
        return cdpElements;
      }
    }

    // Strategy 2: Try Playwright (URL → load page)
    if (isWebBrowser) {
      const playwrightElements = await this._tryPlaywright(appInfo);
      if (playwrightElements && playwrightElements.length > 0) {
        logger.info('✅ Got elements via Playwright', { count: playwrightElements.length });
        return playwrightElements;
      }
    }

    logger.info('⚠️ Web adapters failed, falling back to Accessibility API');
    return null;
  }

  /**
   * Try to get elements via Chrome DevTools Protocol
   */
  async _tryChromeDevTools(appInfo) {
    try {
      // Find Chrome debugging port
      const port = await getChromeDebugPort();
      if (!port) {
        logger.info('Chrome debugging not enabled');
        return null;
      }

      // Create adapter if needed
      if (!this.chromeAdapter) {
        this.chromeAdapter = new ChromeDevToolsAdapter();
      }

      // Connect and get elements
      const connected = await this.chromeAdapter.connect(port);
      if (!connected) {
        return null;
      }

      const elements = await this.chromeAdapter.getAllElements();
      
      // Convert CDP elements to our format
      return elements.map(el => ({
        role: el.role,
        label: el.label,
        value: el.value,
        elementType: el.nodeName,
        bounds: el.bounds,
        actions: el.actions,
        source: 'chrome-devtools'
      }));

    } catch (error) {
      logger.warn('Chrome DevTools failed', { error: error.message });
      return null;
    }
  }

  /**
   * Get Chrome window bounds and scroll position via AppleScript + JavaScript
   * Returns the content area position (excluding title bar and chrome)
   */
  async _getChromeWindowBounds(appName, url) {
    try {
      const script = `
        tell application "System Events"
          tell process "${appName}"
            try
              set frontWindow to window 1
              set windowPos to position of frontWindow
              set windowSize to size of frontWindow
              
              -- Chrome title bar is typically 37-38px on macOS
              -- Content starts below the title bar and tabs
              set contentOffsetY to 75
              
              -- Return window position + offset for content area
              return {x:item 1 of windowPos, y:(item 2 of windowPos) + contentOffsetY, width:item 1 of windowSize, height:(item 2 of windowSize) - contentOffsetY}
            on error errMsg
              log "Window bounds error: " & errMsg
              return {x:0, y:75, width:1920, height:1005}
            end try
          end tell
        end tell
      `;
      
      const { stdout } = await execAsync(`osascript <<'EOF'\n${script}\nEOF`);
      const match = stdout.match(/x:(\d+), y:(\d+), width:(\d+), height:(\d+)/);
      
      if (match) {
        const bounds = {
          x: parseInt(match[1]),
          y: parseInt(match[2]),
          width: parseInt(match[3]),
          height: parseInt(match[4]),
          scrollX: 0,
          scrollY: 0
        };
        
        // Try to get scroll position - multiple methods
        // 1. Try CDP first (if Chrome debugging is enabled)
        // 2. Fall back to AppleScript (requires "Allow JavaScript from Apple Events")
        try {
          // Method 1: Try CDP (port 9222)
          const { getScrollPositionViaCDP, getScrollPositionViaAppleScript } = await import('../../utils/chrome-cookies.js');
          
          let scrollData = await getScrollPositionViaCDP(url, 9222);
          
          // If CDP failed (scrollX and scrollY both 0), try AppleScript
          if (scrollData.scrollX === 0 && scrollData.scrollY === 0) {
            scrollData = await getScrollPositionViaAppleScript(appName);
          }
          
          bounds.scrollX = scrollData.scrollX || 0;
          bounds.scrollY = scrollData.scrollY || 0;
          
          if (bounds.scrollX === 0 && bounds.scrollY === 0) {
            logger.warn('⚠️ Scroll position is 0 - highlights may be inaccurate if page is scrolled');
            logger.warn('💡 Enable Chrome debugging (--remote-debugging-port=9222) or AppleScript automation for scroll tracking');
          } else {
            logger.info('✅ Got scroll position', { scrollX: bounds.scrollX, scrollY: bounds.scrollY });
          }
        } catch (scrollError) {
          logger.warn('⚠️ Could not get scroll position - highlights accurate only at top of page', { 
            error: scrollError.message 
          });
          bounds.scrollX = 0;
          bounds.scrollY = 0;
        }
        
        logger.info('Got Chrome window bounds', bounds);
        return bounds;
      }
    } catch (error) {
      logger.warn('Failed to get window bounds', { error: error.message });
    }
    
    // Default fallback - assume content starts at y=75 (title bar + tabs)
    return { x: 0, y: 75, width: 1920, height: 1005, scrollX: 0, scrollY: 0 };
  }

  /**
   * Try to get elements via Playwright
   */
  async _tryPlaywright(appInfo) {
    try {
      // Get URL from browser
      const url = await getBrowserUrl(appInfo.name);
      if (!url || url.startsWith('chrome://') || url.startsWith('about:')) {
        logger.info('No valid URL to load', { url });
        return null;
      }

      // Get Chrome window bounds and scroll position for coordinate adjustment
      const windowBounds = await this._getChromeWindowBounds(appInfo.name, url);

      // Create adapter if needed
      if (!this.playwrightAdapter) {
        this.playwrightAdapter = new PlaywrightAdapter();
        await this.playwrightAdapter.initialize();
      }

      // Load page and get elements
      const elements = await this.playwrightAdapter.getElementsFromUrl(url, {
        timeout: 10000, // 10 second timeout
        windowBounds // Pass window bounds + scroll for coordinate adjustment
      });

      // Convert Playwright elements to our format
      return elements.map(el => ({
        role: el.role,
        label: el.label,
        value: el.value,
        elementType: el.tagName,
        bounds: el.bounds,
        actions: el.actions,
        source: 'playwright'
      }));

    } catch (error) {
      logger.warn('Playwright failed', { error: error.message });
      return null;
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
  async _getUIElementsHierarchy(appName, includeHidden, appInfo) {
    try {
      logger.info('Getting UI elements for app', { appName });
      
      // Enhanced AppleScript that gets more element types
      // Special handling for Finder to get Desktop icons
      const isFinderDesktop = appName === 'Finder';
      
      const script = `
        tell application "System Events"
          tell process "${appName}"
            set allElements to {}
            set elementCount to 0
            
            -- Get windows
            repeat with w in windows
              try
                set windowInfo to {elementType:"window", role:"window", label:name of w, value:"", title:name of w}
                set windowPos to position of w
                set windowSize to size of w
                set windowBounds to {x:item 1 of windowPos, y:item 2 of windowPos, width:item 1 of windowSize, height:item 2 of windowSize}
                set end of allElements to {info:windowInfo, bounds:windowBounds}
                set elementCount to elementCount + 1
              on error errMsg
                -- Silently skip windows that can't be accessed
              end try
            end repeat
            
            ${isFinderDesktop ? `
            -- Special: Get Desktop icons (Finder only)
            -- Desktop is a scroll area at the process level, not a window
            try
              repeat with scrollArea in scroll areas
                try
                  repeat with uiGroup in UI elements of scrollArea
                    try
                      repeat with desktopItem in UI elements of uiGroup
                        try
                          set elRole to role of desktopItem
                          set elName to name of desktopItem
                          set elPos to position of desktopItem
                          set elSize to size of desktopItem
                          
                          -- Desktop icons are typically "AXButton" with file/folder names
                          set elInfo to {elementType:"desktop-icon", role:elRole, label:elName, value:"", title:elName}
                          set elBounds to {x:item 1 of elPos, y:item 2 of elPos, width:item 1 of elSize, height:item 2 of elSize}
                          set end of allElements to {info:elInfo, bounds:elBounds}
                          set elementCount to elementCount + 1
                        on error itemErr
                          -- Skip items that can't be accessed
                        end try
                      end repeat
                    on error groupErr
                      -- Skip UI groups that can't be accessed
                    end try
                  end repeat
                on error scrollErr
                  -- Skip scroll areas that can't be accessed
                end try
              end repeat
            on error errMsg
              -- Desktop not accessible, continue
            end try
            ` : ''}
            
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
                repeat with staticTxt in static texts
                  try
                    set stInfo to {elementType:"statictext", role:"statictext", label:name of staticTxt, value:value of staticTxt, title:title of staticTxt}
                    set stPos to position of staticTxt
                    set stSize to size of staticTxt
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
      
      // Execute AppleScript using heredoc to preserve formatting
      const { stdout } = await execAsync(`osascript <<'EOF'\n${script}\nEOF`);
      
      logger.info('AppleScript raw output', { 
        length: stdout.length, 
        preview: stdout.substring(0, 200) 
      });
      
      // Parse AppleScript output
      const elements = this._parseAppleScriptElements(stdout);
      
      logger.info('Parsed elements', { count: elements.length });
      
      if (elements.length === 0) {
        logger.warn('No accessible elements found', { 
          app: appInfo.name,
          note: 'Web-based apps (Electron, Chrome, VSCode) may not expose UI elements via accessibility APIs. Try a native macOS app like Finder, Safari, or System Preferences.'
        });
      }
      
      return elements;
    } catch (error) {
      logger.warn('AppleScript element retrieval failed', { 
        error: error.message,
        app: appInfo.name 
      });
      return [];
    }
  }

  /**
   * Parse AppleScript output into element objects
   */
  _parseAppleScriptElements(output) {
    try {
      if (!output || output.trim() === '') {
        logger.warn('Empty AppleScript output');
        return [];
      }

      // AppleScript returns data in format:
      // info:elementType:window, role:window, label:yarn, value:, title:yarn, bounds:x:23, y:45, width:942, height:774
      // Each element is separated by ", info:" pattern
      
      const elements = [];
      const lines = output.split(/,\s*info:/);
      
      for (let line of lines) {
        // Add back "info:" prefix if it was removed by split
        if (!line.trim().startsWith('info:')) {
          line = 'info:' + line;
        }
        
        try {
          const parsed = this._parseAppleScriptElementLine(line.trim());
          if (parsed && parsed.bounds && parsed.bounds.width > 0 && parsed.bounds.height > 0) {
            elements.push(parsed);
          }
        } catch (err) {
          logger.warn('Failed to parse element line', { 
            line: line.substring(0, 100), 
            error: err.message 
          });
        }
      }
      
      logger.info('Parsed AppleScript elements', { count: elements.length });
      return elements;
      
    } catch (error) {
      logger.error('Failed to parse AppleScript output', { error: error.message });
      return [];
    }
  }

  /**
   * Parse a single AppleScript element line
   * Format: info:elementType:window, role:window, label:yarn, bounds:x:23, y:45, width:942, height:774
   */
  _parseAppleScriptElementLine(line) {
    const element = {
      role: 'unknown',
      label: '',
      value: '',
      title: '',
      elementType: 'unknown',
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      actions: []
    };

    // Split by comma, but track if we're in bounds section
    const parts = line.split(',').map(p => p.trim());
    let inBounds = false;

    for (const part of parts) {
      if (part.startsWith('info:')) {
        // Parse info section: info:elementType:window
        const infoMatch = part.match(/info:elementType:([^,\s]+)/);
        if (infoMatch) {
          element.elementType = infoMatch[1];
        }
      } else if (part.startsWith('role:')) {
        element.role = part.substring(5).trim();
      } else if (part.startsWith('label:')) {
        element.label = part.substring(6).trim();
        if (element.label === 'missing value') element.label = '';
      } else if (part.startsWith('value:')) {
        element.value = part.substring(6).trim();
        if (element.value === 'missing value') element.value = '';
      } else if (part.startsWith('title:')) {
        element.title = part.substring(6).trim();
        if (element.title === 'missing value') element.title = '';
      } else if (part.startsWith('bounds:')) {
        inBounds = true;
        // Parse bounds: bounds:x:23
        const boundsMatch = part.match(/bounds:x:(\d+)/);
        if (boundsMatch) {
          element.bounds.x = parseInt(boundsMatch[1]);
        }
      } else if (inBounds) {
        // Continue parsing bounds coordinates
        if (part.startsWith('y:')) {
          element.bounds.y = parseInt(part.substring(2));
        } else if (part.startsWith('width:')) {
          element.bounds.width = parseInt(part.substring(6));
        } else if (part.startsWith('height:')) {
          element.bounds.height = parseInt(part.substring(7));
          inBounds = false; // End of bounds
        }
      }
    }

    // Get actions for this role
    element.actions = this._getActionsForRole(element.role);

    return element;
  }


  /**
   * Get available actions for a given role
   */
  _getActionsForRole(role) {
    const actionMap = {
      'button': ['press', 'click'],
      'textfield': ['focus', 'type', 'clear'],
      'textarea': ['focus', 'type', 'clear'],
      'checkbox': ['toggle', 'check', 'uncheck'],
      'radiobutton': ['select'],
      'menu': ['open', 'click'],
      'menuitem': ['click', 'select'],
      'window': ['focus', 'minimize', 'close', 'maximize'],
      'statictext': ['read'],
      'link': ['click', 'open']
    };
    
    return actionMap[role] || [];
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
