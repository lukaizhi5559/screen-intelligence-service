/**
 * Window Analysis Utilities
 * Shared functions for analyzing windows across different routes
 */

import logger from './logger.js';
import { getAccessibilityAdapter } from '../adapters/accessibility/index.js';
import { focusWindow } from './window-detector.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const BROWSER_KEYWORDS = [
  // mainstream
  'Chrome', 'Chromium', 'Edge', 'Safari', 'Firefox', 'Opera', 'Vivaldi', 'Brave', 'Arc',
  // privacy/alt builds
  'Tor', 'LibreWolf', 'Waterfox', 'Pale Moon', 'Ghost', 'DuckDuckGo',
  // mobile wrappers / system
  'Samsung Internet', 'MIUI Browser', 'Huawei Browser', 'Vivo Browser', 'Oppo Browser',
  'Android Browser', 'Silk', 'Naver Whale', 'Yandex', 'QQBrowser', 'UC Browser',
  // dev/testing
  'Electron', 'NW.js', 'CefSharp', 'Chromium Embedded', 'Playwright', 'Puppeteer',
];

/**
 * Get desktop items via AppleScript
 * @returns {Promise<Array>} Array of desktop items
 */
export async function getDesktopItems() {
  try {
    const script = `
      tell application "Finder"
        activate
        
        -- Show desktop by minimizing all windows (Cmd+F3 equivalent)
        try
          tell application "System Events"
            key code 99 -- F3 key
          end tell
        end try
        
        delay 0.5
        
        set desktopItems to {}
        set allItems to every item of desktop
        
        repeat with anItem in allItems
          try
            set itemName to name of anItem
            set itemKind to kind of anItem
            set itemPos to position of anItem
            
            set end of desktopItems to {itemName:itemName, itemKind:itemKind, x:item 1 of itemPos, y:item 2 of itemPos}
          on error
            -- Skip items that can't be accessed
          end try
        end repeat
        
        return desktopItems
      end tell
    `;
    
    const { stdout } = await execAsync(`osascript <<'EOF'\n${script}\nEOF`);
    
    // Parse AppleScript output
    const items = parseDesktopItems(stdout);
    
    logger.info('Got desktop items via AppleScript', { count: items.length });
    return items;
    
  } catch (error) {
    logger.error('Failed to get desktop items', { error: error.message });
    return [];
  }
}

/**
 * Parse desktop items from AppleScript output
 */
function parseDesktopItems(output) {
  const items = [];
  
  if (!output || output.trim() === '') {
    return items;
  }
  
  // macOS menubar height (standard is 25px, but can be 28px on newer versions)
  const MENUBAR_HEIGHT = 25;
  
  // Parse format: itemName:Document.pdf, itemKind:PDF document, x:100, y:200, itemName:...
  // AppleScript returns all items comma-separated without braces
  const matches = output.matchAll(/itemName:([^,]+), itemKind:([^,]+), x:(-?\d+), y:(-?\d+)/g);
  
  for (const match of matches) {
    const x = parseInt(match[3]);
    const y = parseInt(match[4]);
    
    // Log raw coordinates for debugging
    logger.info('Desktop item coordinates', {
      name: match[1].trim(),
      rawX: x,
      rawY: y,
      adjustedY: y + MENUBAR_HEIGHT
    });
    
    items.push({
      role: 'file',
      label: match[1].trim(),
      value: match[2].trim(), // kind/type
      bounds: {
        x: x,
        y: y + MENUBAR_HEIGHT, // Add menubar offset to convert Finder coords to screen coords
        width: 80,  // Approximate icon size
        height: 100
      },
      confidence: 1.0,
      actions: ['open', 'move', 'delete']
    });
  }
  
  return items;
}

/**
 * Check if app is a browser (supports all major browsers)
 * @param {string} appName - Application name
 * @returns {boolean} True if browser
 */
export function isBrowser(appName) {
  if (!appName) return false;
  const name = appName.toLowerCase();
  return BROWSER_KEYWORDS.some(b =>
    name.includes(b.toLowerCase().replace(/\s+/g, ''))
  );
}

/**
 * Check if page is authenticated by looking at window title
 * Common patterns: login pages have "Sign in", "Log in", "Login" in title
 * Authenticated pages have user-specific content
 * @param {Object} window - Window object with title
 * @returns {Promise<boolean>} True if authenticated
 */
async function checkIfAuthenticated(window) {
  const title = window.title.toLowerCase();
  
  // Check for login/signin keywords in title (indicates NOT authenticated)
  const loginKeywords = ['sign in', 'log in', 'login', 'signin', 'authenticate', 'create account'];
  const hasLoginKeyword = loginKeywords.some(keyword => title.includes(keyword));
  
  if (hasLoginKeyword) {
    logger.info('Login page detected', { title: window.title });
    return false; // Login page = not authenticated
  }
  
  // Check for authenticated page indicators
  const authKeywords = ['inbox', 'dashboard', 'profile', 'settings', 'messages', 'mail', 'chat'];
  const hasAuthKeyword = authKeywords.some(keyword => title.includes(keyword));
  
  if (hasAuthKeyword) {
    logger.info('Authenticated page detected', { title: window.title });
    return true;
  }
  
  // Default: assume authenticated if not a login page
  // This is safer - we'll use alternative extraction methods
  return true;
}

/**
 * Analyze a single window and return elements
 * @param {Object} window - Window object with appName, title, bounds
 * @param {Object} adapter - Accessibility adapter instance
 * @param {boolean} includeScreenshot - Whether to capture screenshot
 * @returns {Promise<Object>} Analysis result with elements, screenshot, method
 */
export async function analyzeWindow(window, adapter, includeScreenshot = false) {
  let elements = [];
  let screenshot = null;
  let method = 'unknown';
  
  // Handle different window types
  if (window.appName === 'Finder') {
    // Finder/Desktop - use AppleScript
    method = 'applescript';
    const desktopElements = await getDesktopItems();
    
    if (desktopElements.length > 0) {
      elements = desktopElements;
    } else {
      // Fallback: focus Finder and use accessibility API
      method = 'accessibility';
      await focusWindow({ appName: 'Finder', title: '' });
      await new Promise(resolve => setTimeout(resolve, 500));
      elements = await adapter.getAllElements({ includeHidden: false });
    }
    
  } else if (isBrowser(window.appName)) {
    // Browser detected - use smart extraction strategy
    const isAuthenticated = await checkIfAuthenticated(window);
    
    if (!isAuthenticated) {
      // Public page - use standard Playwright
      logger.info('Public page detected, using standard Playwright');
      await focusWindow(window);
      await new Promise(resolve => setTimeout(resolve, 500));
      method = 'playwright';
      elements = await adapter.getAllElements({ includeHidden: false });
      
    } else {
      // Authenticated page - try AppleScript first, fallback to OCR
      logger.info('Authenticated page detected, attempting text extraction');
      
      await focusWindow(window);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Get basic UI elements from accessibility
      elements = await adapter.getAllElements({ includeHidden: false });
      
      // Try AppleScript first (fast for Chrome/Safari, no screenshot needed)
      let pageText = await extractPageTextViaAppleScript(window);
      
      if (pageText && pageText.length > 50) {
        method = 'accessibility_applescript';
        logger.info('Extracted text via AppleScript', { length: pageText.length });
      } else {
        // Fallback to OCR (works for all browsers, requires screenshot)
        logger.info('AppleScript failed or not supported, using OCR fallback');
        screenshot = await captureWindowScreenshot(window);
        if (screenshot) {
          pageText = await extractTextFromScreenshot(screenshot);
          method = 'accessibility_ocr';
        }
      }
      
      // Add page text to elements if we got any
      if (pageText && pageText.length > 50) {
        elements.push({
          role: 'page_content',
          label: 'Page Text Content',
          value: pageText.substring(0, 10000), // Limit to 10k chars
          bounds: { x: 0, y: 0, width: window.width, height: window.height },
          confidence: method === 'accessibility_applescript' ? 1.0 : 0.85,
          actions: []
        });
        logger.info('Added page text to elements', { 
          method, 
          length: pageText.length 
        });
      }
    }
    
  } else {
    // Other apps - use accessibility API
    method = 'accessibility';
    await focusWindow(window);
    await new Promise(resolve => setTimeout(resolve, 500));
    elements = await adapter.getAllElements({ includeHidden: false });
  }

  // Take screenshot if requested
  if (includeScreenshot && !screenshot) {
    screenshot = await captureWindowScreenshot(window);
  }

  return { elements, screenshot, method };
}

/**
 * Capture screenshot of a specific window
 * @param {Object} window - Window object with bounds
 * @returns {Promise<Buffer>} Screenshot buffer
 */
async function captureWindowScreenshot(window) {
  try {
    const tempFile = `/tmp/window-screenshot-${Date.now()}.png`;
    
    // Use screencapture with window bounds
    const { x, y, width, height } = window;
    await execAsync(`screencapture -R${x},${y},${width},${height} -x "${tempFile}"`);
    
    // Read and return the file
    const fs = await import('fs/promises');
    const buffer = await fs.readFile(tempFile);
    
    // Clean up
    await fs.unlink(tempFile).catch(() => {});
    
    return buffer;
    
  } catch (error) {
    logger.error('Failed to capture window screenshot', { error: error.message });
    return null;
  }
}

/**
 * Extract page text via AppleScript (works for Chrome-based and Safari)
 * @param {Object} window - Window object with appName
 * @returns {Promise<string>} Extracted page text
 */
async function extractPageTextViaAppleScript(window) {
  try {
    let script = '';
    let appName = window.appName;
    
    // Chrome and Chromium-based browsers (Chrome, Brave, Edge, Arc, Vivaldi, Opera)
    if (appName.includes('Chrome') || appName.includes('Brave') || 
        appName.includes('Edge') || appName.includes('Arc') || 
        appName.includes('Vivaldi') || appName.includes('Opera') || 
        appName.includes('Chromium')) {
      
      // Map app names to their AppleScript names
      const appScriptName = appName.includes('Brave') ? 'Brave Browser' :
                           appName.includes('Edge') ? 'Microsoft Edge' :
                           appName.includes('Arc') ? 'Arc' :
                           appName.includes('Vivaldi') ? 'Vivaldi' :
                           appName.includes('Opera') ? 'Opera' :
                           'Google Chrome';
      
      script = `
        tell application "${appScriptName}"
          tell front window's active tab
            execute javascript "document.body.innerText || document.body.textContent"
          end tell
        end tell
      `;
      
    } else if (appName.includes('Safari')) {
      // Safari
      script = `
        tell application "Safari"
          tell front document
            do JavaScript "document.body.innerText || document.body.textContent"
          end tell
        end tell
      `;
      
    } else {
      // Firefox, Tor Browser, or other browsers don't support AppleScript JS execution
      logger.warn('Browser does not support AppleScript text extraction', { browser: appName });
      return '';
    }
    
    const { stdout } = await execAsync(`osascript <<'EOF'\n${script}\nEOF`);
    const text = stdout.trim();
    
    logger.info('Extracted page text via AppleScript', { 
      browser: appName,
      length: text.length 
    });
    
    return text;
    
  } catch (error) {
    logger.error('AppleScript text extraction failed', { 
      browser: window.appName,
      error: error.message,
      hint: 'For Chrome-based browsers: Enable "Allow JavaScript from Apple Events" in Developer menu'
    });
    return '';
  }
}

/**
 * Extract text from screenshot using Tesseract.js OCR (fallback)
 * @param {Buffer} screenshotBuffer - Screenshot image buffer
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromScreenshot(screenshotBuffer) {
  try {
    // Dynamically import Tesseract.js
    const { createWorker } = await import('tesseract.js');
    
    logger.info('Starting OCR text extraction...');
    const startTime = Date.now();
    
    // Create Tesseract worker
    const worker = await createWorker('eng');
    
    // Perform OCR on the screenshot
    const { data: { text } } = await worker.recognize(screenshotBuffer);
    
    // Terminate worker
    await worker.terminate();
    
    const duration = Date.now() - startTime;
    logger.info('OCR extraction complete', { 
      textLength: text.length, 
      durationMs: duration 
    });
    
    return text.trim();
    
  } catch (error) {
    logger.error('OCR extraction failed', { error: error.message });
    return '';
  }
}

/**
 * Analyze multiple windows based on context
 * @param {Object} context - Context from detectContextFromQuery
 * @param {boolean} includeScreenshot - Whether to capture screenshots
 * @returns {Promise<Object>} Analysis result with all elements and metadata
 */
export async function analyzeContext(context, includeScreenshot = false) {
  const adapter = getAccessibilityAdapter();
  let allElements = [];
  let screenshots = [];
  let windowsAnalyzed = [];
  
  // Only include desktop items if desktop is actually visible
  // Skip if: fullscreen app OR large window covering most of screen
  const shouldSkipDesktop = context.strategy === 'fullscreen_app' || 
    (context.primary && context.primary.height > 700); // Large window likely covers desktop
  
  if (!shouldSkipDesktop) {
    try {
      const desktopElements = await getDesktopItems();
      if (desktopElements.length > 0) {
        logger.info('Adding desktop items to analysis', { count: desktopElements.length });
        allElements.push(...desktopElements);
        windowsAnalyzed.push({
          app: 'Finder',
          title: 'Desktop',
          bounds: { x: 0, y: 0, width: 0, height: 0 }, // Desktop has no bounds
          elementCount: desktopElements.length,
          method: 'applescript'
        });
      }
    } catch (error) {
      logger.error('Failed to get desktop items', { error: error.message });
    }
  } else {
    logger.info('Skipping desktop items (large window or fullscreen detected)', {
      strategy: context.strategy,
      primaryHeight: context.primary?.height
    });
  }
  
  // For fullscreen or single window, analyze just that one
  if (context.strategy === 'fullscreen_app' || context.windows.length === 1) {
    const window = context.primary;
    logger.info('Analyzing single window', { app: window.appName, title: window.title });
    
    const { elements, screenshot, method } = await analyzeWindow(window, adapter, includeScreenshot);
    allElements.push(...elements);
    if (screenshot) screenshots.push(screenshot);
    windowsAnalyzed.push({
      app: window.appName,
      title: window.title,
      bounds: { x: window.x, y: window.y, width: window.width, height: window.height },
      elementCount: elements.length,
      method
    });
    
  } else {
    // Multiple windows - analyze all (limit to top 5 for performance)
    // First, extract URLs for browser windows to enable URL-based deduplication
    // Group windows by browser to batch URL extraction
    const browserWindows = new Map(); // browserName -> windows[]
    context.windows.forEach(window => {
      if (isBrowser(window.appName)) {
        if (!browserWindows.has(window.appName)) {
          browserWindows.set(window.appName, []);
        }
        browserWindows.get(window.appName).push(window);
      }
    });
    
    // Get URLs for all browser windows in batch
    const urlMap = new Map(); // windowTitle -> url
    for (const [browserName, windows] of browserWindows) {
      try {
        const { getAllBrowserWindowUrls } = await import('../adapters/accessibility/playwright-adapter.js');
        const browserUrls = await getAllBrowserWindowUrls(browserName);
        
        // Match windows by title to get URLs
        browserUrls.forEach(({ title, url }) => {
          urlMap.set(`${browserName}:${title}`, url);
        });
      } catch (error) {
        logger.debug('Failed to get URLs for browser', { browser: browserName, error: error.message });
      }
    }
    
    // Attach URLs to windows
    const windowsWithUrls = context.windows.map(window => {
      if (isBrowser(window.appName)) {
        const url = urlMap.get(`${window.appName}:${window.title}`);
        return { ...window, url: url || null };
      }
      return { ...window, url: null };
    });
    
    // Deduplicate windows by URL (for browsers) or app+title (for non-browsers)
    const seenWindows = new Set();
    const uniqueWindows = windowsWithUrls.filter(window => {
      // For browser windows with URLs, deduplicate by URL
      if (window.url) {
        if (seenWindows.has(window.url)) {
          logger.info('Skipping duplicate browser window (same URL)', { 
            app: window.appName, 
            title: window.title,
            url: window.url 
          });
          return false;
        }
        seenWindows.add(window.url);
        return true;
      }
      
      // Skip browser windows without URLs or titles (likely Chrome UI elements)
      if (isBrowser(window.appName) && !window.title) {
        logger.info('Skipping browser window without URL or title (likely UI element)', {
          app: window.appName,
          bounds: { x: window.x, y: window.y, w: window.width, h: window.height }
        });
        return false;
      }
      
      // For non-browser windows, deduplicate by app+title
      const key = `${window.appName}:${window.title}`;
      if (seenWindows.has(key)) {
        logger.debug('Skipping duplicate window (same app+title)', { app: window.appName, title: window.title });
        return false;
      }
      seenWindows.add(key);
      return true;
    });
    
    const windowsToAnalyze = uniqueWindows.slice(0, 5);
    logger.info('Analyzing multiple windows', { 
      total: context.windows.length,
      unique: uniqueWindows.length,
      analyzing: windowsToAnalyze.length,
      deduplicationMethod: 'url+app+title'
    });
    
    for (const window of windowsToAnalyze) {
      try {
        const { elements, screenshot, method } = await analyzeWindow(window, adapter, includeScreenshot);
        
        // Tag elements with window info
        const taggedElements = elements.map(el => ({
          ...el,
          windowApp: window.appName,
          windowTitle: window.title
        }));
        
        allElements.push(...taggedElements);
        if (screenshot) screenshots.push(screenshot);
        windowsAnalyzed.push({
          app: window.appName,
          title: window.title,
          bounds: { x: window.x, y: window.y, width: window.width, height: window.height },
          elementCount: elements.length,
          method
        });
        
      } catch (error) {
        logger.error('Failed to analyze window', { 
          app: window.appName, 
          error: error.message 
        });
      }
    }
  }
  
  return {
    elements: allElements,
    screenshots,
    windowsAnalyzed,
    strategy: context.strategy
  };
}

/**
 * Get selected/highlighted text from the frontmost application
 * Uses AppleScript to access AXSelectedText attribute
 * @returns {Promise<string|null>} Selected text or null if none
 */
export async function getSelectedText() {
  try {
    const script = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        
        try
          tell frontApp
            set focusedElement to focused element of window 1
            set selectedText to value of attribute "AXSelectedText" of focusedElement
            return selectedText
          end tell
        on error errMsg
          -- Try alternative approach: use focused UI element
          try
            set focusedUI to focused UI element of frontApp
            set selectedText to value of attribute "AXSelectedText" of focusedUI
            return selectedText
          on error
            return ""
          end try
        end try
      end tell
    `;
    
    const { stdout } = await execAsync(`osascript <<'EOF'\n${script}\nEOF`);
    const selectedText = stdout.trim();
    
    if (selectedText && selectedText.length > 0) {
      logger.info('Got selected text from frontmost app', { 
        length: selectedText.length,
        preview: selectedText.substring(0, 50) + '...'
      });
      return selectedText;
    }
    
    return null;
    
  } catch (error) {
    logger.debug('No selected text found', { error: error.message });
    return null;
  }
}
