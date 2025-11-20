/**
 * Window Detector
 * Detects and analyzes windows without requiring focus
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { screen } from '@nut-tree-fork/nut-js';
import logger from './logger.js';

const execAsync = promisify(exec);

/**
 * Get all visible windows on screen
 * @returns {Promise<Array>} Array of window objects
 */
export async function getAllWindows() {
  try {
    const script = `
      tell application "System Events"
        set windowList to ""
        set appList to every application process whose visible is true
        
        repeat with appProc in appList
          set appName to name of appProc
          
          try
            set appWindows to every window of appProc
            
            repeat with win in appWindows
              try
                set winTitle to title of win
                set winPos to position of win
                set winSize to size of win
                
                -- Build window info string
                set windowInfo to "APP:" & appName & "|TITLE:" & winTitle & "|X:" & (item 1 of winPos) & "|Y:" & (item 2 of winPos) & "|W:" & (item 1 of winSize) & "|H:" & (item 2 of winSize) & "\\n"
                set windowList to windowList & windowInfo
              on error
                -- Skip windows that can't be accessed
              end try
            end repeat
          on error
            -- Skip apps with no windows
          end try
        end repeat
        
        return windowList
      end tell
    `;
    
    const { stdout } = await execAsync(`osascript <<'EOF'\n${script}\nEOF`);
    
    // Parse output
    const windows = parseWindowList(stdout);
    
    logger.info('Detected windows', { count: windows.length, raw: stdout.substring(0, 200) });
    return windows;
    
  } catch (error) {
    logger.error('Failed to get windows', { error: error.message, stack: error.stack });
    return [];
  }
}

/**
 * Get window at specific screen coordinates
 * @param {number} x - Screen X coordinate
 * @param {number} y - Screen Y coordinate
 * @returns {Promise<Object|null>} Window object or null
 */
export async function getWindowAtPoint(x, y) {
  const windows = await getAllWindows();
  
  // Find window that contains the point
  for (const win of windows) {
    if (x >= win.x && x <= win.x + win.width &&
        y >= win.y && y <= win.y + win.height) {
      logger.info('Found window at point', { x, y, window: win.title, app: win.appName });
      return win;
    }
  }
  
  logger.warn('No window found at point', { x, y });
  return null;
}

/**
 * Get the frontmost (focused) window
 * @returns {Promise<Object|null>} Window object or null
 */
export async function getFrontmostWindow() {
  try {
    const script = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        
        try
          set frontWin to front window of frontApp
          set winTitle to title of frontWin
          set winPos to position of frontWin
          set winSize to size of frontWin
          
          return "APP:" & appName & "|TITLE:" & winTitle & "|X:" & (item 1 of winPos) & "|Y:" & (item 2 of winPos) & "|W:" & (item 1 of winSize) & "|H:" & (item 2 of winSize)
        on error errMsg
          return "APP:" & appName & "|TITLE:|X:0|Y:0|W:0|H:0"
        end try
      end tell
    `;
    
    const { stdout } = await execAsync(`osascript <<'EOF'\n${script}\nEOF`);
    
    // Parse output
    const windows = parseWindowList(stdout);
    
    if (windows.length > 0) {
      logger.info('Got frontmost window', windows[0]);
      return windows[0];
    }
    
    return null;
    
  } catch (error) {
    logger.error('Failed to get frontmost window', { error: error.message });
    return null;
  }
}

/**
 * Get window by title (partial match)
 * @param {string} titlePattern - Title to search for
 * @returns {Promise<Object|null>} Window object or null
 */
export async function getWindowByTitle(titlePattern) {
  const windows = await getAllWindows();
  const pattern = titlePattern.toLowerCase();
  
  const match = windows.find(win => 
    win.title.toLowerCase().includes(pattern)
  );
  
  if (match) {
    logger.info('Found window by title', { pattern, window: match.title });
    return match;
  }
  
  logger.warn('No window found with title', { pattern });
  return null;
}

/**
 * Get window by application name
 * @param {string} appName - Application name
 * @returns {Promise<Object|null>} Window object or null
 */
export async function getWindowByApp(appName) {
  const windows = await getAllWindows();
  const pattern = appName.toLowerCase();
  
  const match = windows.find(win => 
    win.appName.toLowerCase().includes(pattern)
  );
  
  if (match) {
    logger.info('Found window by app', { appName, window: match.title });
    return match;
  }
  
  // Special case for Finder - it might not have visible windows but is always running
  if (pattern === 'finder') {
    logger.info('Finder requested - checking if running');
    const isFinderRunning = await isAppRunning('Finder');
    
    if (isFinderRunning) {
      // Return a virtual window for Finder desktop
      const desktopWindow = {
        appName: 'Finder',
        title: 'Desktop',
        x: 0,
        y: 0,
        width: 1920,
        height: 1080
      };
      logger.info('Using Finder desktop (no window required)', desktopWindow);
      return desktopWindow;
    }
  }
  
  logger.warn('No window found for app', { appName });
  return null;
}

/**
 * Check if an application is running
 * @param {string} appName - Application name
 * @returns {Promise<boolean>}
 */
async function isAppRunning(appName) {
  try {
    const script = `
      tell application "System Events"
        return exists (application process "${appName}")
      end tell
    `;
    
    const { stdout } = await execAsync(`osascript -e '${script}'`);
    return stdout.trim() === 'true';
    
  } catch (error) {
    logger.error('Failed to check if app is running', { appName, error: error.message });
    return false;
  }
}

/**
 * Focus a specific window
 * @param {Object} window - Window object
 * @returns {Promise<boolean>} Success
 */
export async function focusWindow(window) {
  try {
    const script = `
      tell application "System Events"
        tell process "${window.appName}"
          set frontmost to true
          perform action "AXRaise" of window "${window.title}"
        end tell
      end tell
    `;
    
    await execAsync(`osascript <<'EOF'\n${script}\nEOF`);
    logger.info('Focused window', { app: window.appName, title: window.title });
    return true;
    
  } catch (error) {
    logger.error('Failed to focus window', { error: error.message });
    return false;
  }
}

/**
 * Parse window list output
 * @param {string} output - Raw output
 * @returns {Array} Parsed window objects
 */
function parseWindowList(output) {
  const windows = [];
  
  if (!output || output.trim() === '') {
    return windows;
  }
  
  // Parse format: APP:Finder|TITLE:Desktop|X:0|Y:0|W:1920|H:1080
  const lines = output.trim().split('\n');
  
  for (const line of lines) {
    if (!line || line.trim() === '') continue;
    
    const parts = {};
    const segments = line.split('|');
    
    for (const segment of segments) {
      const [key, ...valueParts] = segment.split(':');
      const value = valueParts.join(':'); // Handle titles with colons
      parts[key] = value;
    }
    
    if (parts.APP) {
      windows.push({
        appName: parts.APP,
        title: parts.TITLE || '',
        x: parseInt(parts.X) || 0,
        y: parseInt(parts.Y) || 0,
        width: parseInt(parts.W) || 0,
        height: parseInt(parts.H) || 0
      });
    }
  }
  
  return windows;
}

/**
 * Get screen dimensions using nut.js
 * @returns {Promise<Object>} Screen dimensions {width, height}
 */
async function getScreenDimensions() {
  try {
    const width = await screen.width();
    const height = await screen.height();
    logger.debug('Screen dimensions', { width, height });
    return { width, height };
  } catch (error) {
    logger.error('Failed to get screen dimensions from nut.js, using default', { error: error.message });
    // Fallback: Use common MacBook resolution
    return { width: 1440, height: 900 };
  }
}

/**
 * Detect screen context using smart strategy
 * 1. If fullscreen app exists → Use that (user is clearly focused on it)
 * 2. Otherwise → Return ALL visible windows for AI to analyze
 * 
 * Note: Query parameter removed - AI will filter relevant windows from the returned set
 * 
 * @returns {Promise<Object>} Context object with windows to analyze
 */
async function detectScreenContext() {
  try {
    // Get all windows
    const allWindows = await getAllWindows();
    
    if (!allWindows || allWindows.length === 0) {
      logger.warn('No windows found');
      return {
        type: 'none',
        windows: [],
        strategy: 'no_windows'
      };
    }
    
    // Get screen dimensions via AppleScript
    const screenDimensions = await getScreenDimensions();
    
    // Check for fullscreen app (window bounds match screen bounds)
    const fullscreenWindow = allWindows.find(win => {
      // A window is fullscreen if it covers most of the screen
      // Allow some tolerance for menu bar (25px) and slight variations
      const widthMatch = win.width >= screenDimensions.width * 0.95; // 95% of screen width
      const heightMatch = win.height >= screenDimensions.height * 0.90; // 90% of screen height (menu bar)
      const positionMatch = win.x <= 10 && win.y <= 30; // Near top-left corner
      
      return widthMatch && heightMatch && positionMatch;
    });
    
    if (fullscreenWindow) {
      logger.info('Fullscreen app detected', { 
        app: fullscreenWindow.appName,
        title: fullscreenWindow.title 
      });
      
      return {
        type: 'fullscreen',
        windows: [fullscreenWindow],
        strategy: 'fullscreen_app',
        primary: fullscreenWindow
      };
    }
    
    // Check for Chrome fullscreen mode (multiple windows spanning full height)
    // Chrome in fullscreen creates separate windows for UI elements
    const chromeWindows = allWindows.filter(w => w.appName === 'Google Chrome');
    if (chromeWindows.length >= 2) {
      const totalHeight = chromeWindows.reduce((sum, w) => sum + w.height, 0);
      const allFullWidth = chromeWindows.every(w => w.width >= screenDimensions.width * 0.95);
      const allAtTopLeft = chromeWindows.every(w => w.x <= 10 && w.y <= 100);
      
      if (totalHeight >= screenDimensions.height * 0.85 && allFullWidth && allAtTopLeft) {
        // Find the largest window (main content area)
        const mainWindow = chromeWindows.reduce((largest, w) => 
          w.height > largest.height ? w : largest
        );
        
        logger.info('Chrome fullscreen detected (multiple UI windows)', { 
          windowCount: chromeWindows.length,
          totalHeight,
          mainWindow: { title: mainWindow.title, height: mainWindow.height }
        });
        
        return {
          type: 'fullscreen',
          windows: [mainWindow],
          strategy: 'fullscreen_app',
          primary: mainWindow
        };
      }
    }
    
    // No fullscreen - return all visible windows
    // Sort by z-order (frontmost first)
    const sortedWindows = [...allWindows].sort((a, b) => {
      // Frontmost window should be first
      if (a.appName === allWindows[0].appName && a.title === allWindows[0].title) return -1;
      if (b.appName === allWindows[0].appName && b.title === allWindows[0].title) return 1;
      return 0;
    });
    
    logger.info('Multiple windows detected', { 
      count: sortedWindows.length,
      apps: sortedWindows.map(w => w.appName).slice(0, 5)
    });
    
    return {
      type: 'multi_window',
      windows: sortedWindows,
      strategy: 'all_visible_windows',
      primary: sortedWindows[0] // Frontmost as primary
    };
    
  } catch (error) {
    logger.error('Failed to detect context', { error: error.message });
    
    // Fallback: try to get frontmost window
    try {
      const frontmost = await getFrontmostWindow();
      return {
        type: 'fallback',
        windows: [frontmost],
        strategy: 'frontmost_fallback',
        primary: frontmost
      };
    } catch (fallbackError) {
      return {
        type: 'error',
        windows: [],
        strategy: 'error',
        error: error.message
      };
    }
  }
}

// Export the renamed function with both names for backward compatibility
export { detectScreenContext, detectScreenContext as detectContextFromQuery };
