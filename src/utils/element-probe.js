import { exec } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';

const execAsync = promisify(exec);

// Lazy load nut.js to avoid initialization overhead
let nutjs = null;
async function getNutjs() {
  if (!nutjs) {
    try {
      nutjs = await import('@nut-tree-fork/nut-js');
      logger.info('nut.js loaded successfully');
    } catch (error) {
      logger.warn('Failed to load nut.js, falling back to AppleScript', { error: error.message });
      nutjs = { failed: true };
    }
  }
  return nutjs.failed ? null : nutjs;
}

/**
 * Probe a specific point on screen to identify the UI element at that location
 * Uses nut.js for reliable cross-platform probing with role prediction
 * 
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {string} appName - Application name (e.g., "Google Chrome")
 * @param {Object} windowBounds - Optional window bounds {x, y, width, height} for validation
 * @param {Object} ocrData - Optional OCR data for role prediction {text, bounds, confidence}
 * @returns {Promise<Object|null>} Element info or null if probe fails
 */
export async function getElementAtPoint(x, y, appName, windowBounds = null, ocrData = null) {
  // Validate coordinates are within window bounds if provided
  if (windowBounds) {
    const { x: winX, y: winY, width: winW, height: winH } = windowBounds;
    if (x < winX || x > winX + winW || y < winY || y > winY + winH) {
      logger.debug('Probe point outside window bounds', { x, y, windowBounds });
      return null;
    }
  }
  
  // Try nut.js first (fast, reliable, no AppleScript errors)
  const nut = await getNutjs();
  if (nut) {
    try {
      const { mouse, getActiveWindow } = nut;
      
      // Save current mouse position
      const originalPos = await mouse.getPosition();
      
      // Move to target point
      await mouse.setPosition({ x, y });
      
      // Small delay for hover detection
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Get active window info
      let windowTitle = appName;
      try {
        const activeWindow = await getActiveWindow();
        windowTitle = activeWindow?.title || appName;
      } catch (err) {
        // getActiveWindow may not be available on all platforms
        logger.debug('Could not get active window', { error: err.message });
      }
      
      // Restore mouse position
      await mouse.setPosition(originalPos);
      
      // Use OCR data to predict role if available
      let predictedRole = 'interactive_element';
      let label = 'Unnamed';
      
      if (ocrData && ocrData.text && ocrData.bounds) {
        predictedRole = predictElementRole(
          ocrData.text,
          ocrData.bounds,
          ocrData.value || '',
          ocrData.description || ''
        );
        label = ocrData.text.trim() || 'Unnamed';
        
        // Log prediction for debugging
        logger.debug('Role prediction', {
          text: ocrData.text,
          predictedRole,
          bounds: ocrData.bounds
        });
      }
      
      return {
        role: predictedRole,
        label: label,
        description: ocrData?.text || '',
        value: ocrData?.value || '',
        title: windowTitle,
        bounds: ocrData?.bounds || { x, y, width: 0, height: 0 },
        confidence: ocrData?.confidence || 0.5,
        source: 'nutjs_probe'
      };
      
    } catch (error) {
      logger.warn('nut.js probe failed, trying AppleScript fallback', { x, y, error: error.message });
    }
  }
  
  // Fallback to AppleScript (more detailed but error-prone)
  try {
    const script = `
      tell application "System Events"
        tell process "${appName}"
          try
            if (count of windows) is 0 then
              return "error|No windows available"
            end if
            
            set elem to UI element at {${x}, ${y}}
            
            try
              set elemRole to role of elem
            on error
              set elemRole to "unknown"
            end try
            
            try
              set elemDesc to description of elem
            on error
              set elemDesc to "missing value"
            end try
            
            try
              set elemValue to value of elem
            on error
              set elemValue to "missing value"
            end try
            
            try
              set elemTitle to title of elem
            on error
              set elemTitle to "missing value"
            end try
            
            try
              set elemPos to position of elem
              set elemSize to size of elem
              return elemRole & "|" & elemDesc & "|" & elemValue & "|" & elemTitle & "|" & item 1 of elemPos & "|" & item 2 of elemPos & "|" & item 1 of elemSize & "|" & item 2 of elemSize
            on error
              return elemRole & "|" & elemDesc & "|" & elemValue & "|" & elemTitle & "|${x}|${y}|0|0"
            end try
          on error errMsg
            return "error|" & errMsg
          end try
        end tell
      end tell
    `;
    
    const { stdout } = await execAsync(`osascript -e '${script}'`);
    const result = stdout.trim();
    
    if (result.startsWith('error|')) {
      logger.debug('AppleScript probe failed', { x, y, error: result.substring(6) });
      return null;
    }
    
    const [role, description, value, title, posX, posY, width, height] = result.split('|');
    
    const cleanValue = (val) => val === 'missing value' ? '' : val;
    
    return {
      role: normalizeRole(role),
      description: cleanValue(description),
      value: cleanValue(value),
      title: cleanValue(title),
      bounds: {
        x: parseInt(posX) || x,
        y: parseInt(posY) || y,
        width: parseInt(width) || 0,
        height: parseInt(height) || 0
      },
      source: 'applescript_probe'
    };
    
  } catch (error) {
    logger.warn('All probe methods failed', { x, y, error: error.message });
    return null;
  }
}

/**
 * Normalize macOS Accessibility role names to our standard format
 */
function normalizeRole(axRole) {
  const roleMap = {
    'AXButton': 'button',
    'AXTextField': 'textfield',
    'AXTextArea': 'textarea',
    'AXStaticText': 'text',
    'AXLink': 'link',
    'AXImage': 'image',
    'AXCheckBox': 'checkbox',
    'AXRadioButton': 'radiobutton',
    'AXComboBox': 'combobox',
    'AXPopUpButton': 'select',
    'AXMenu': 'menu',
    'AXMenuItem': 'menuitem',
    'AXWindow': 'window',
    'AXGroup': 'group',
    'AXScrollArea': 'scrollarea',
    'AXWebArea': 'webarea'
  };
  
  return roleMap[axRole] || axRole.toLowerCase().replace('ax', '');
}

/**
 * Predict element role based on OCR text, bounds, and context
 * Used when we can't get semantic info from Accessibility API
 * 
 * @param {string} text - OCR extracted text
 * @param {Object} bounds - Element bounds {x, y, width, height}
 * @param {string} value - Element value (if any)
 * @param {string} description - Element description (if any)
 * @returns {string} Predicted role
 */
function predictElementRole(text, bounds, value = '', description = '') {
  if (!text) return 'unknown';
  
  const lowerText = text.toLowerCase().trim();
  const wordCount = text.split(/\s+/).length;
  const aspectRatio = bounds.width / Math.max(bounds.height, 1);
  
  // BUTTON DETECTION
  // Short action words in small rectangular bounds
  const buttonKeywords = [
    'submit', 'login', 'sign in', 'sign up', 'register', 'buy', 'purchase',
    'add to cart', 'checkout', 'continue', 'next', 'back', 'cancel', 'close',
    'save', 'delete', 'edit', 'send', 'post', 'share', 'download', 'upload',
    'search', 'go', 'ok', 'yes', 'no', 'accept', 'decline', 'confirm',
    'get started', 'learn more', 'try', 'start', 'begin', 'create', 'new',
    'open', 'view', 'show', 'hide', 'toggle', 'enable', 'disable', 'apply'
  ];
  
  if (wordCount <= 4 && buttonKeywords.some(kw => lowerText.includes(kw))) {
    return 'button';
  }
  
  // Short text in small rectangular bounds (likely button)
  if (wordCount <= 4 && bounds.width < 250 && bounds.height < 80 && aspectRatio > 1.2) {
    return 'button';
  }
  
  // Very short text (1-2 words) in compact bounds is likely a button
  if (wordCount <= 2 && bounds.width < 150 && bounds.height < 50) {
    return 'button';
  }
  
  // SELECT/DROPDOWN DETECTION
  // Dropdown indicators
  if (/[▼⌄▾⏷↓]/.test(text) || lowerText.includes('select') || lowerText.includes('choose')) {
    return 'select';
  }
  
  // FORM INPUT DETECTION
  // Common form field labels/placeholders
  const formKeywords = [
    'email', 'password', 'username', 'name', 'phone', 'address', 'city',
    'zip', 'postal', 'search', 'enter', 'type', 'message', 'comment'
  ];
  
  if (formKeywords.some(kw => lowerText.includes(kw))) {
    // Empty value suggests input field
    if (!value || value.trim() === '') {
      return 'textfield';
    }
  }
  
  // Large rectangular bounds with empty value (likely textarea)
  if (bounds.height > 80 && (!value || value.trim() === '') && aspectRatio < 3) {
    return 'textarea';
  }
  
  // LINK DETECTION
  // URL patterns
  if (/https?:\/\/|www\.|\.com|\.org|\.net/i.test(text)) {
    return 'link';
  }
  
  // Common link phrases
  const linkKeywords = [
    'learn more', 'read more', 'view details', 'see more', 'click here',
    'more info', 'details', 'view all', 'show all', 'read', 'explore'
  ];
  
  if (linkKeywords.some(kw => lowerText.includes(kw))) {
    return 'link';
  }
  
  // Underlined or colored text (common link styling) - detect by aspect ratio
  // Links are typically inline with text, so they have moderate aspect ratio
  if (wordCount >= 2 && wordCount <= 6 && aspectRatio > 2 && aspectRatio < 10 && bounds.height < 40) {
    return 'link';
  }
  
  // CHECKBOX/RADIO DETECTION
  if (/^[☐☑✓✗⊙○◉]/.test(text) || lowerText.match(/^(check|uncheck|select|deselect)/)) {
    return 'checkbox';
  }
  
  // IMAGE/ICON DETECTION
  // Very small bounds with minimal text (likely icon)
  if (bounds.width < 50 && bounds.height < 50 && wordCount <= 1) {
    return 'icon';
  }
  
  // HEADING DETECTION
  // Large text, short content
  if (bounds.height > 30 && wordCount <= 10 && aspectRatio > 2) {
    return 'heading';
  }
  
  // DEFAULT: Generic text element
  return 'text';
}

/**
 * Batch probe multiple points in parallel
 * More efficient than probing one at a time
 * 
 * @param {Array<{x: number, y: number}>} points - Array of coordinates to probe
 * @param {string} appName - Application name
 * @param {Object} windowBounds - Optional window bounds for validation
 * @returns {Promise<Array<Object|null>>} Array of element info (same order as input)
 */
export async function batchProbeElements(points, appName, windowBounds = null) {
  logger.info('Batch probing elements', { count: points.length, app: appName });
  
  // Filter out points outside window bounds before probing
  const validPoints = windowBounds
    ? points.filter(p => {
        const { x: winX, y: winY, width: winW, height: winH } = windowBounds;
        return p.x >= winX && p.x <= winX + winW && p.y >= winY && p.y <= winY + winH;
      })
    : points;
  
  if (validPoints.length < points.length) {
    logger.debug('Filtered out points outside window bounds', {
      total: points.length,
      valid: validPoints.length,
      filtered: points.length - validPoints.length
    });
  }
  
  const results = await Promise.all(
    validPoints.map(point => getElementAtPoint(point.x, point.y, appName, windowBounds, point.ocrData))
  );
  
  const successCount = results.filter(r => r !== null).length;
  logger.info('Batch probe complete', { 
    total: points.length, 
    success: successCount, 
    failed: points.length - successCount 
  });
  
  return results;
}

/**
 * Get available actions for a given role
 */
export function getActionsForRole(role) {
  const actionMap = {
    'button': ['click', 'press'],
    'textfield': ['focus', 'type', 'clear'],
    'textarea': ['focus', 'type', 'clear'],
    'checkbox': ['toggle', 'check', 'uncheck'],
    'radiobutton': ['select'],
    'link': ['click', 'open'],
    'menu': ['open', 'click'],
    'menuitem': ['click', 'select'],
    'select': ['open', 'select'],
    'combobox': ['open', 'select', 'type'],
    'image': ['view'],
    'window': ['focus', 'minimize', 'close', 'maximize'],
    'heading': [],
    'icon': ['click'],
    'text': []
  };
  
  return actionMap[role] || [];
}

// Export predictElementRole for use in Vision Panel
export { predictElementRole };
