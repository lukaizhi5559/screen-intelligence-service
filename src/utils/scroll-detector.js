/**
 * Scroll Position Detector
 * Uses image comparison to detect scroll position by comparing
 * Playwright screenshot (at scroll 0) with actual Chrome window screenshot
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import logger from './logger.js';

const execAsync = promisify(exec);

/**
 * Capture screenshot of a specific window using screencapture
 * @param {Object} windowBounds - {x, y, width, height}
 * @returns {Promise<string>} Path to screenshot file
 */
async function captureWindowScreenshot(windowBounds) {
  const tempFile = path.join(os.tmpdir(), `chrome-window-${Date.now()}.png`);
  
  try {
    // Use macOS screencapture with specific region
    // -R x,y,width,height captures specific rectangle
    const { x, y, width, height } = windowBounds;
    await execAsync(`screencapture -R${x},${y},${width},${height} -x "${tempFile}"`);
    
    logger.info('Captured window screenshot', { path: tempFile, bounds: windowBounds });
    return tempFile;
  } catch (error) {
    logger.error('Failed to capture window screenshot', { error: error.message });
    throw error;
  }
}

/**
 * Compare two images and find vertical offset using template matching
 * Uses Python + OpenCV for image comparison
 * @param {string} referenceImage - Path to reference image (Playwright at scroll 0)
 * @param {string} currentImage - Path to current window screenshot
 * @returns {Promise<{scrollX: number, scrollY: number, confidence: number}>}
 */
async function compareImagesForScroll(referenceImage, currentImage) {
  try {
    // Create Python script for template matching
    const pythonScript = `
import cv2
import numpy as np
import sys
import json

def find_scroll_offset(reference_path, current_path):
    # Read images
    reference = cv2.imread(reference_path)
    current = cv2.imread(current_path)
    
    if reference is None or current is None:
        return {"error": "Failed to read images"}
    
    # Convert to grayscale
    ref_gray = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
    curr_gray = cv2.cvtColor(current, cv2.COLOR_BGR2GRAY)
    
    # Get dimensions
    ref_h, ref_w = ref_gray.shape
    curr_h, curr_w = curr_gray.shape
    
    # Strategy: Use multiple templates from different parts of the reference
    # to find which parts are visible in the current view
    
    # Take templates from bottom of reference (more likely to still be visible after scroll)
    template_height = min(200, ref_h // 4)
    templates = []
    
    # Template from middle of reference
    mid_y = ref_h // 2
    if mid_y + template_height < ref_h:
        templates.append({
            'img': ref_gray[mid_y:mid_y+template_height, :],
            'ref_y': mid_y,
            'name': 'middle'
        })
    
    # Template from bottom third
    bottom_y = (ref_h * 2) // 3
    if bottom_y + template_height < ref_h:
        templates.append({
            'img': ref_gray[bottom_y:bottom_y+template_height, :],
            'ref_y': bottom_y,
            'name': 'bottom'
        })
    
    best_match = None
    best_confidence = 0
    
    # Try each template
    for template_info in templates:
        template = template_info['img']
        result = cv2.matchTemplate(curr_gray, template, cv2.TM_CCOEFF_NORMED)
        min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(result)
        
        if max_val > best_confidence:
            best_confidence = max_val
            best_match = {
                'ref_y': template_info['ref_y'],
                'curr_y': max_loc[1],
                'name': template_info['name']
            }
    
    # Calculate scroll based on best match
    if best_match and best_confidence > 0.6:
        # If template from ref_y in reference is found at curr_y in current:
        # scroll_y = ref_y - curr_y
        # Example: Template from y=500 in ref found at y=200 in current
        # means we scrolled down 300px (500 - 200 = 300)
        scroll_y = best_match['ref_y'] - best_match['curr_y']
        
        # Clamp to reasonable values
        scroll_y = max(0, min(scroll_y, ref_h))
        
        return {
            "scrollX": 0,
            "scrollY": scroll_y,
            "confidence": float(best_confidence)
        }
    else:
        # No good match found - can't determine scroll
        return {
            "scrollX": 0,
            "scrollY": 0,
            "confidence": float(best_confidence)
        }

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(json.dumps({"error": "Usage: script.py <reference> <current>"}))
        sys.exit(1)
    
    result = find_scroll_offset(sys.argv[1], sys.argv[2])
    print(json.dumps(result))
`;

    // Save Python script to temp file
    const scriptPath = path.join(os.tmpdir(), `scroll-detector-${Date.now()}.py`);
    await fs.writeFile(scriptPath, pythonScript);
    
    try {
      // Run Python script
      const { stdout } = await execAsync(
        `python3 "${scriptPath}" "${referenceImage}" "${currentImage}"`
      );
      
      const result = JSON.parse(stdout.trim());
      
      if (result.error) {
        throw new Error(result.error);
      }
      
      logger.info('Detected scroll offset via image comparison', result);
      return result;
      
    } finally {
      // Clean up script file
      await fs.unlink(scriptPath).catch(() => {});
    }
    
  } catch (error) {
    logger.error('Failed to compare images for scroll', { error: error.message });
    return { scrollX: 0, scrollY: 0, confidence: 0 };
  }
}

/**
 * Simpler approach: Use ImageMagick for image comparison
 * Falls back if OpenCV/Python not available
 */
async function compareImagesSimple(referenceImage, currentImage) {
  try {
    // Use ImageMagick's compare command to find differences
    const diffImage = path.join(os.tmpdir(), `diff-${Date.now()}.png`);
    
    // Compare images and get metrics
    const { stdout } = await execAsync(
      `compare -metric RMSE "${referenceImage}" "${currentImage}" "${diffImage}" 2>&1 || true`
    );
    
    // Parse RMSE output (format: "1234.56 (0.0189)")
    const match = stdout.match(/([\d.]+)\s*\(([\d.]+)\)/);
    
    if (match) {
      const rmse = parseFloat(match[1]);
      const normalized = parseFloat(match[2]);
      
      logger.info('Image comparison via ImageMagick', { rmse, normalized });
      
      // If images are very similar (low RMSE), assume no scroll
      if (normalized < 0.05) {
        return { scrollX: 0, scrollY: 0, confidence: 1 - normalized };
      }
    }
    
    // Clean up diff image
    await fs.unlink(diffImage).catch(() => {});
    
    // Can't determine scroll from simple comparison
    return { scrollX: 0, scrollY: 0, confidence: 0 };
    
  } catch (error) {
    logger.warn('ImageMagick comparison failed', { error: error.message });
    return { scrollX: 0, scrollY: 0, confidence: 0 };
  }
}

/**
 * Detect scroll position by comparing Playwright screenshot with actual window
 * @param {Object} page - Playwright page object
 * @param {Object} windowBounds - Chrome window bounds {x, y, width, height}
 * @returns {Promise<{scrollX: number, scrollY: number}>}
 */
export async function detectScrollPosition(page, windowBounds) {
  let playwrightScreenshot = null;
  let windowScreenshot = null;
  
  try {
    // IMPORTANT: Resize Playwright viewport to match Chrome window size
    // This ensures screenshots are the same size for comparison
    await page.setViewportSize({
      width: windowBounds.width,
      height: windowBounds.height
    });
    
    // Wait a moment for resize to take effect
    await page.waitForTimeout(200);
    
    // 1. Take screenshot from Playwright (at scroll 0)
    playwrightScreenshot = path.join(os.tmpdir(), `playwright-${Date.now()}.png`);
    await page.screenshot({ 
      path: playwrightScreenshot,
      fullPage: false // Only visible viewport
    });
    
    logger.info('Captured Playwright screenshot', { 
      path: playwrightScreenshot,
      viewport: { width: windowBounds.width, height: windowBounds.height }
    });
    
    // 2. Take screenshot of actual Chrome window
    windowScreenshot = await captureWindowScreenshot(windowBounds);
    
    // 3. Compare images to find scroll offset
    // Try OpenCV first (more accurate)
    let result = await compareImagesForScroll(playwrightScreenshot, windowScreenshot);
    
    logger.info('Image comparison result', { 
      confidence: result.confidence,
      scrollX: result.scrollX,
      scrollY: result.scrollY,
      error: result.error
    });
    
    // If OpenCV failed or low confidence, try simple comparison
    if (result.confidence < 0.5) {
      logger.warn('OpenCV comparison had low confidence, trying simple comparison');
      result = await compareImagesSimple(playwrightScreenshot, windowScreenshot);
    }
    
    // 4. Return scroll position
    // For now, DISABLE scroll detection since it's not working reliably
    // TODO: Fix this when OpenCV is properly installed
    logger.warn('⚠️ Image-based scroll detection not reliable yet - returning scroll=0');
    logger.warn('💡 To enable: pip3 install opencv-python OR enable Chrome debugging');
    return { scrollX: 0, scrollY: 0 };
    
    /* Disabled until OpenCV works properly
    if (result.confidence > 0.5) {
      logger.info('✅ Detected scroll position via image comparison', {
        scrollX: result.scrollX,
        scrollY: result.scrollY,
        confidence: result.confidence
      });
      return { scrollX: result.scrollX, scrollY: result.scrollY };
    } else {
      logger.warn('⚠️ Low confidence in scroll detection, assuming no scroll');
      return { scrollX: 0, scrollY: 0 };
    }
    */
    
  } catch (error) {
    logger.error('Failed to detect scroll position', { error: error.message });
    return { scrollX: 0, scrollY: 0 };
    
  } finally {
    // Clean up temporary files
    if (playwrightScreenshot) {
      await fs.unlink(playwrightScreenshot).catch(() => {});
    }
    if (windowScreenshot) {
      await fs.unlink(windowScreenshot).catch(() => {});
    }
  }
}

/**
 * Check if required dependencies are available
 */
export async function checkDependencies() {
  const deps = {
    python3: false,
    opencv: false,
    imagemagick: false,
    screencapture: true // Always available on macOS
  };
  
  // Check Python 3
  try {
    await execAsync('python3 --version');
    deps.python3 = true;
  } catch (error) {
    logger.warn('Python 3 not found');
  }
  
  // Check OpenCV (try importing cv2)
  if (deps.python3) {
    try {
      await execAsync('python3 -c "import cv2"');
      deps.opencv = true;
    } catch (error) {
      logger.warn('OpenCV not found - install with: pip3 install opencv-python');
    }
  }
  
  // Check ImageMagick
  try {
    await execAsync('compare -version');
    deps.imagemagick = true;
  } catch (error) {
    logger.warn('ImageMagick not found - install with: brew install imagemagick');
  }
  
  logger.info('Scroll detection dependencies', deps);
  return deps;
}
