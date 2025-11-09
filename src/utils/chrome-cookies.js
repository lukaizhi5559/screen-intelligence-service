/**
 * Chrome Cookie Extractor
 * Extracts cookies from Chrome's cookie database for a specific domain
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import logger from './logger.js';

const execAsync = promisify(exec);

/**
 * Get Chrome's cookie database path for macOS
 */
function getChromeCookiePath() {
  const homeDir = os.homedir();
  return path.join(homeDir, 'Library/Application Support/Google/Chrome/Default/Cookies');
}

/**
 * Extract cookies for a specific domain from Chrome
 * @param {string} domain - Domain to extract cookies for (e.g., 'chatgpt.com')
 * @returns {Promise<Array>} Array of cookie objects
 */
export async function extractChromeCookies(domain) {
  try {
    const cookiePath = getChromeCookiePath();
    
    // Check if cookie file exists
    try {
      await fs.access(cookiePath);
    } catch (error) {
      logger.warn('Chrome cookie database not found', { path: cookiePath });
      return [];
    }

    // Chrome's Cookies file is a SQLite database, but it's encrypted on macOS
    // We need to use a temporary copy to avoid locking issues
    const tempCookiePath = `/tmp/chrome-cookies-${Date.now()}.db`;
    
    try {
      // Copy cookie database to temp location
      await fs.copyFile(cookiePath, tempCookiePath);
      
      // Query cookies using sqlite3
      // Note: Chrome encrypts cookie values on macOS using Keychain
      // We can only get the cookie names and metadata, not encrypted values
      const query = `
        SELECT 
          host_key,
          name,
          path,
          expires_utc,
          is_secure,
          is_httponly,
          samesite
        FROM cookies 
        WHERE host_key LIKE '%${domain}%'
      `;
      
      const { stdout } = await execAsync(
        `sqlite3 "${tempCookiePath}" "${query.replace(/\n/g, ' ')}"`
      );
      
      // Parse SQLite output (pipe-separated values)
      const cookies = [];
      const lines = stdout.trim().split('\n');
      
      for (const line of lines) {
        if (!line) continue;
        
        const [host_key, name, cookiePath, expires_utc, is_secure, is_httponly, samesite] = line.split('|');
        
        // Convert Chrome's timestamp (microseconds since 1601) to Unix timestamp
        const expiresUnix = expires_utc ? parseInt(expires_utc) / 1000000 - 11644473600 : -1;
        
        cookies.push({
          name,
          value: '', // Encrypted, can't extract without Keychain access
          domain: host_key,
          path: cookiePath || '/',
          expires: expiresUnix > 0 ? expiresUnix : -1,
          httpOnly: is_httponly === '1',
          secure: is_secure === '1',
          sameSite: samesite === '0' ? 'None' : samesite === '1' ? 'Lax' : 'Strict'
        });
      }
      
      logger.info('Extracted Chrome cookies', { domain, count: cookies.length });
      return cookies;
      
    } finally {
      // Clean up temp file
      try {
        await fs.unlink(tempCookiePath);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    
  } catch (error) {
    logger.error('Failed to extract Chrome cookies', { 
      domain, 
      error: error.message 
    });
    return [];
  }
}

/**
 * Get scroll position from Chrome via CDP
 * @param {string} url - URL of the page
 * @param {number} debugPort - Chrome debugging port (default 9222)
 * @returns {Promise<{scrollX: number, scrollY: number}>}
 */
export async function getScrollPositionViaCDP(url, debugPort = 9222) {
  try {
    // Connect to Chrome DevTools Protocol
    const { default: CDP } = await import('chrome-remote-interface');
    
    const client = await CDP({ port: debugPort });
    const { Runtime, Page } = client;
    
    await Runtime.enable();
    await Page.enable();
    
    // Execute JavaScript to get scroll position
    const result = await Runtime.evaluate({
      expression: 'JSON.stringify({scrollX: window.scrollX, scrollY: window.scrollY})',
      returnByValue: true
    });
    
    await client.close();
    
    const scrollData = JSON.parse(result.result.value);
    logger.info('Got scroll position via CDP', scrollData);
    
    return scrollData;
    
  } catch (error) {
    logger.warn('Failed to get scroll position via CDP', { 
      error: error.message,
      hint: 'Start Chrome with --remote-debugging-port=9222'
    });
    return { scrollX: 0, scrollY: 0 };
  }
}

/**
 * Alternative: Get scroll position via AppleScript with Chrome Automation
 * This requires Chrome to have "Allow JavaScript from Apple Events" enabled
 * in View > Developer menu
 */
export async function getScrollPositionViaAppleScript(appName = 'Google Chrome') {
  try {
    const script = `
      tell application "${appName}"
        tell front window's active tab
          execute javascript "JSON.stringify({scrollX: window.scrollX || window.pageXOffset, scrollY: window.scrollY || window.pageYOffset})"
        end tell
      end tell
    `;
    
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "\\'")}'`);
    const scrollData = JSON.parse(stdout.trim());
    
    logger.info('Got scroll position via AppleScript', scrollData);
    return scrollData;
    
  } catch (error) {
    logger.warn('Failed to get scroll position via AppleScript', {
      error: error.message,
      hint: 'Enable "Allow JavaScript from Apple Events" in Chrome Developer menu'
    });
    return { scrollX: 0, scrollY: 0 };
  }
}
