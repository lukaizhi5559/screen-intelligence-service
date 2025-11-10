import { exec } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';

const execAsync = promisify(exec);

/**
 * Probe a specific point on screen to identify the UI element at that location
 * Uses macOS Accessibility API to get element type and metadata
 * 
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {string} appName - Application name (e.g., "Google Chrome")
 * @returns {Promise<Object|null>} Element info or null if probe fails
 */
export async function getElementAtPoint(x, y, appName) {
  try {
    const script = `
      tell application "System Events"
        tell process "${appName}"
          try
            set elem to UI element at {${x}, ${y}}
            set elemRole to role of elem
            set elemDesc to description of elem
            set elemValue to value of elem
            set elemTitle to title of elem
            
            -- Get position and size
            set elemPos to position of elem
            set elemSize to size of elem
            
            return elemRole & "|" & elemDesc & "|" & elemValue & "|" & elemTitle & "|" & item 1 of elemPos & "|" & item 2 of elemPos & "|" & item 1 of elemSize & "|" & item 2 of elemSize
          on error errMsg
            return "error|" & errMsg
          end try
        end tell
      end tell
    `;
    
    const { stdout } = await execAsync(`osascript -e '${script}'`);
    const result = stdout.trim();
    
    if (result.startsWith('error|')) {
      logger.debug('Probe failed at point', { x, y, error: result.substring(6) });
      return null;
    }
    
    const [role, description, value, title, posX, posY, width, height] = result.split('|');
    
    // Clean up "missing value" placeholders
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
      }
    };
    
  } catch (error) {
    logger.warn('Failed to probe element at point', { x, y, error: error.message });
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
 * Batch probe multiple points in parallel
 * More efficient than probing one at a time
 * 
 * @param {Array<{x: number, y: number}>} points - Array of coordinates to probe
 * @param {string} appName - Application name
 * @returns {Promise<Array<Object|null>>} Array of element info (same order as input)
 */
export async function batchProbeElements(points, appName) {
  logger.info('Batch probing elements', { count: points.length, app: appName });
  
  const results = await Promise.all(
    points.map(point => getElementAtPoint(point.x, point.y, appName))
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
    'window': ['focus', 'minimize', 'close', 'maximize']
  };
  
  return actionMap[role] || [];
}
