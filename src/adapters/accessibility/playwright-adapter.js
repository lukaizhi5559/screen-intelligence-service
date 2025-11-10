/**
 * Playwright Adapter
 * Loads web pages and extracts DOM elements using Playwright
 */

import { chromium } from 'playwright';
import logger from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { extractChromeCookies, getScrollPositionViaCDP, getScrollPositionViaAppleScript } from '../../utils/chrome-cookies.js';
import { detectScrollPosition } from '../../utils/scroll-detector.js';

const execAsync = promisify(exec);

export class PlaywrightAdapter {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * Initialize Playwright browser
   */
  async initialize() {
    try {
      logger.info('Launching Playwright browser');
      
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      });

      logger.info('Playwright browser launched');
      return true;

    } catch (error) {
      logger.error('Failed to launch Playwright', { error: error.message });
      return false;
    }
  }

  /**
   * Load a URL and extract all interactive elements
   */
  async getElementsFromUrl(url, options = {}) {
    const { timeout = 30000, waitForSelector = 'body', useSnapshot = false, useCDP = true, windowBounds } = options;

    try {
      logger.info('Loading URL in Playwright', { url, useSnapshot, windowBounds });

      // Extract domain from URL for cookie loading
      const urlObj = new URL(url);
      const domain = urlObj.hostname;

      // Try to load Chrome cookies for this domain
      try {
        const cookies = await extractChromeCookies(domain);
        if (cookies.length > 0) {
          logger.info('Loading Chrome cookies into Playwright', { domain, count: cookies.length });
          // Note: Cookie values are encrypted, so this won't fully work
          // But we log the attempt for debugging
          logger.warn('⚠️ Chrome cookies are encrypted - cannot copy values without Keychain access');
        }
      } catch (error) {
        logger.warn('Could not load Chrome cookies', { error: error.message });
      }

      // Create new page with viewport matching actual window size
      // Use windowBounds if provided, otherwise use default
      const viewportWidth = windowBounds?.width || 1920;
      const viewportHeight = windowBounds?.height || 1080;
      
      this.page = await this.context.newPage();
      await this.page.setViewportSize({ width: viewportWidth, height: viewportHeight });

      // Navigate to URL
      await this.page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout 
      });

      // Wait for page to be ready
      await this.page.waitForSelector(waitForSelector, { timeout: 5000 }).catch(() => {});

      // Detect scroll position via image comparison
      // This compares Playwright screenshot (at scroll 0) with actual Chrome window
      let detectedScroll = { scrollX: 0, scrollY: 0 };
      if (windowBounds && windowBounds.x !== undefined) {
        try {
          logger.info('🔍 Detecting scroll position via image comparison...');
          detectedScroll = await detectScrollPosition(this.page, windowBounds);
          logger.info('✅ Scroll detection complete', detectedScroll);
        } catch (error) {
          logger.warn('Scroll detection failed, assuming no scroll', { error: error.message });
        }
      }

      // Choose extraction method
      let elements;
      if (useCDP) {
        // Use CDP via Playwright (best: fast + bounding boxes + semantics)
        elements = await this._extractViaCDP();
      } else if (useSnapshot) {
        // Use accessibility snapshot (faster but no bounding boxes)
        elements = await this._extractFromSnapshot();
      } else {
        // Use locator queries (slower but includes bounding boxes)
        elements = await this._extractElements();
      }

      // Adjust coordinates if window bounds provided
      // Account for: window position + detected scroll offset
      if (windowBounds && windowBounds.x !== undefined) {
        // Use detected scroll if available, otherwise fall back to provided scroll
        const scrollX = detectedScroll.scrollX || windowBounds.scrollX || 0;
        const scrollY = detectedScroll.scrollY || windowBounds.scrollY || 0;
        
        elements = elements.map(el => ({
          ...el,
          bounds: {
            // Element position in page - scroll position + window position
            x: el.bounds.x - scrollX + windowBounds.x,
            y: el.bounds.y - scrollY + windowBounds.y,
            width: el.bounds.width,
            height: el.bounds.height
          }
        }));
        logger.info('Adjusted element coordinates', { 
          windowOffset: { x: windowBounds.x, y: windowBounds.y },
          scroll: { x: scrollX, y: scrollY }
        });
      }

      logger.info('Extracted elements from URL', { 
        url, 
        count: elements.length,
        method: useSnapshot ? 'snapshot' : 'locators'
      });

      return elements;

    } catch (error) {
      logger.error('Failed to load URL', { url, error: error.message });
      throw error;
    } finally {
      // Close page
      if (this.page) {
        await this.page.close().catch(() => {});
        this.page = null;
      }
    }
  }

  /**
   * Extract elements via CDP using Playwright's CDP session
   * Best of both worlds: Playwright manages browser, CDP gets rich data
   */
  async _extractViaCDP() {
    try {
      // Get CDP session from Playwright
      const cdpSession = await this.page.context().newCDPSession(this.page);
      
      // Enable required domains
      // PERFORMANCE: CDP snapshot processing is VERY slow (10-15 seconds per window)
      // Skip it entirely and use faster locator-based extraction
      // Set ENABLE_CDP_SNAPSHOTS=true in .env to re-enable if needed
      const enableCDP = process.env.ENABLE_CDP_SNAPSHOTS === 'true';
      
      if (enableCDP) {
        await cdpSession.send('DOM.enable');
        await cdpSession.send('CSS.enable');
        await cdpSession.send('Accessibility.enable');
        
        // Wait for layout to stabilize
        await this.page.waitForLoadState('domcontentloaded');
        await this.page.waitForTimeout(500); // Give extra time for layout
        
        // Try CDP snapshot with minimal parameters
        // Note: Some Chromium versions have issues with DOMSnapshot API
        const [domSnap, axTree] = await Promise.all([
          cdpSession.send('DOMSnapshot.captureSnapshot', {
            computedStyles: [] // Empty array instead of whitelist
          }).catch(err => {
            logger.warn('DOMSnapshot failed, trying without params', { error: err.message });
            return cdpSession.send('DOMSnapshot.captureSnapshot', {});
          }),
          cdpSession.send('Accessibility.getFullAXTree', {})
        ]);
        
        logger.info('CDP snapshots captured via Playwright', {
          domDocs: domSnap.documents?.length || 0,
          axNodes: axTree.nodes?.length || 0
        });
        
        // Process snapshots (reuse logic from ChromeDevToolsAdapter)
        const elements = this._processCDPSnapshots(domSnap, axTree.nodes);
        
        await cdpSession.detach();
        
        // If CDP returned elements, use them; otherwise fallback
        if (elements.length > 0) {
          return elements;
        }
        
        logger.info('CDP returned 0 elements, falling back to locators');
      } else {
        logger.info('CDP snapshots disabled (ENABLE_CDP_SNAPSHOTS=false), using fast locator extraction');
        await cdpSession.detach();
      }
      
      return await this._extractElements();
      
    } catch (error) {
      logger.warn('CDP extraction via Playwright failed', { error: error.message });
      // Fallback to locator method
      return await this._extractElements();
    }
  }

  /**
   * Process CDP snapshots into element list
   * Uses comprehensive interactive detection like ChromeDevToolsAdapter
   */
  _processCDPSnapshots(domSnapshot, axNodes) {
    const elements = [];
    
    const doc = domSnapshot.documents?.[0];
    if (!doc) {
      logger.warn('No DOM document in snapshot');
      return elements;
    }

    const { nodes, layout } = doc;
    const strings = domSnapshot.strings || [];

    const getString = (index) => index >= 0 ? strings[index] : '';

    logger.info('Processing CDP snapshot', {
      totalNodes: nodes.nodeName.length,
      totalAxNodes: axNodes?.length || 0,
      hasLayout: !!layout
    });

    // Build AX lookup
    const axByBackendId = new Map();
    for (const axNode of axNodes || []) {
      if (axNode.backendDOMNodeId) {
        axByBackendId.set(axNode.backendDOMNodeId, axNode);
      }
    }

    let noLayoutCount = 0;
    let zeroBoundsCount = 0;
    let notInteractiveCount = 0;
    let notVisibleCount = 0;

    // Process each node
    for (let i = 0; i < nodes.nodeName.length; i++) {
      const nodeName = getString(nodes.nodeName[i]).toLowerCase();
      const backendNodeId = nodes.backendNodeId[i];
      
      const layoutIndex = nodes.layoutNodeIndex?.[i];
      if (layoutIndex === undefined || layoutIndex < 0) {
        noLayoutCount++;
        continue;
      }

      const bounds = layout.bounds[layoutIndex];
      if (!bounds || bounds[2] === 0 || bounds[3] === 0) {
        zeroBoundsCount++;
        continue;
      }

      // Check if interactive (comprehensive check)
      if (!this._isInteractiveNode(nodeName, nodes, i, getString)) {
        notInteractiveCount++;
        continue;
      }

      // Get computed styles and check visibility
      const styles = this._getComputedStyles(nodes, layout, i, layoutIndex, getString);
      if (!this._isVisible(styles)) {
        notVisibleCount++;
        continue;
      }

      const axNode = axByBackendId.get(backendNodeId);

      elements.push({
        nodeName,
        role: axNode?.role?.value || nodeName,
        label: axNode?.name?.value || '',
        value: axNode?.value?.value || '',
        bounds: {
          x: Math.round(bounds[0]),
          y: Math.round(bounds[1]),
          width: Math.round(bounds[2]),
          height: Math.round(bounds[3])
        },
        styles,
        isVisible: true,
        isInteractive: true,
        actions: this._getActionsFromRole(axNode?.role?.value || nodeName)
      });
    }

    logger.info('CDP snapshot processing complete', {
      extracted: elements.length,
      filtered: {
        noLayout: noLayoutCount,
        zeroBounds: zeroBoundsCount,
        notInteractive: notInteractiveCount,
        notVisible: notVisibleCount
      }
    });

    return elements;
  }

  /**
   * Check if node is interactive (same logic as ChromeDevToolsAdapter)
   */
  _isInteractiveNode(nodeName, nodes, index, getString) {
    // Interactive tags
    const interactiveTags = ['button', 'a', 'input', 'textarea', 'select', 'details', 'summary'];
    if (interactiveTags.includes(nodeName)) {
      return true;
    }

    // Check for role attribute
    const attributes = nodes.attributes?.[index];
    if (attributes) {
      for (let i = 0; i < attributes.length; i += 2) {
        const attrName = getString(attributes[i]);
        const attrValue = getString(attributes[i + 1]);
        
        if (attrName === 'role') {
          const interactiveRoles = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'option'];
          if (interactiveRoles.includes(attrValue)) {
            return true;
          }
        }
        
        if (attrName === 'onclick' || attrName === 'tabindex') {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get computed styles for a node
   */
  _getComputedStyles(nodes, layout, nodeIndex, layoutIndex, getString) {
    const styles = {};
    
    const styleIndexes = layout.styles?.[layoutIndex];
    if (styleIndexes) {
      for (let i = 0; i < styleIndexes.length; i += 2) {
        const name = getString(styleIndexes[i]);
        const value = getString(styleIndexes[i + 1]);
        styles[name] = value;
      }
    }

    return styles;
  }

  /**
   * Check if element is visible based on computed styles
   */
  _isVisible(styles) {
    if (styles.display === 'none') return false;
    if (styles.visibility === 'hidden') return false;
    if (styles.opacity === '0') return false;
    return true;
  }

  /**
   * Extract elements using Playwright's accessibility snapshot
   * Faster but doesn't include bounding boxes
   */
  async _extractFromSnapshot() {
    try {
      const snapshot = await this.page.accessibility.snapshot();
      const elements = [];

      // Recursively process snapshot tree
      const processNode = (node, depth = 0) => {
        if (!node) return;

        // Check if interactive
        const interactiveRoles = [
          'button', 'link', 'textbox', 'checkbox', 
          'radio', 'combobox', 'menuitem', 'tab'
        ];

        if (interactiveRoles.includes(node.role)) {
          elements.push({
            role: node.role,
            label: node.name || '',
            value: node.value || '',
            tagName: node.role,
            bounds: null, // ❌ No bounding box in snapshot
            isVisible: true,
            isInteractive: true,
            actions: this._getActionsFromRole(node.role)
          });
        }

        // Process children
        if (node.children) {
          for (const child of node.children) {
            processNode(child, depth + 1);
          }
        }
      };

      processNode(snapshot);
      return elements;

    } catch (error) {
      logger.warn('Accessibility snapshot failed', { error: error.message });
      return [];
    }
  }

  /**
   * Get actions from accessibility role
   */
  _getActionsFromRole(role) {
    const actionMap = {
      'button': ['click'],
      'link': ['click'],
      'textbox': ['focus', 'type', 'clear'],
      'checkbox': ['click', 'toggle'],
      'radio': ['click'],
      'combobox': ['select'],
      'menuitem': ['click']
    };

    return actionMap[role] || [];
  }

  /**
   * Extract all interactive elements from current page
   */
  async _extractElements() {
    const selectors = [
      'button',
      'a[href]',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[onclick]',
      '[tabindex]:not([tabindex="-1"])'
    ];

    const elements = [];

    for (const selector of selectors) {
      try {
        const locators = await this.page.locator(selector).all();

        for (const locator of locators) {
          const element = await this._getElementInfo(locator, selector);
          if (element) {
            elements.push(element);
          }
        }
      } catch (err) {
        logger.warn('Failed to query selector', { selector, error: err.message });
      }
    }

    // Remove duplicates (same element matched by multiple selectors)
    return this._deduplicateElements(elements);
  }

  /**
   * Get detailed information about an element
   */
  async _getElementInfo(locator, selector) {
    try {
      // Check if element is visible
      const isVisible = await locator.isVisible().catch(() => false);
      if (!isVisible) {
        return null;
      }

      // Get bounding box
      const box = await locator.boundingBox().catch(() => null);
      if (!box) {
        return null;
      }

      // Get element properties
      const [tagName, role, label, value, attributes] = await Promise.all([
        locator.evaluate(el => el.tagName.toLowerCase()),
        locator.getAttribute('role').catch(() => null),
        this._getLabel(locator),
        this._getValue(locator),
        this._getAttributes(locator)
      ]);

      const element = {
        selector,
        tagName,
        role: role || this._inferRole(tagName),
        label,
        value,
        bounds: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height)
        },
        attributes,
        isVisible: true,
        isInteractive: true,
        actions: this._getActions(tagName, attributes)
      };

      return element;

    } catch (error) {
      logger.warn('Failed to get element info', { selector, error: error.message });
      return null;
    }
  }

  /**
   * Get element label
   */
  async _getLabel(locator) {
    try {
      // Try aria-label first
      const ariaLabel = await locator.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;

      // Try text content
      const text = await locator.textContent();
      if (text && text.trim()) {
        // Clean up: normalize whitespace
        let cleaned = text.trim().replace(/\s+/g, ' ');
        
        // For links, try to intelligently parse and reformat product information
        const role = await locator.getAttribute('role');
        const tagName = await locator.evaluate(el => el.tagName.toLowerCase());
        
        if (role === 'link' || tagName === 'a') {
          cleaned = this._formatProductLabel(cleaned);
        }
        
        return cleaned.substring(0, 200);
      }

      // Try placeholder
      const placeholder = await locator.getAttribute('placeholder');
      if (placeholder) return placeholder;

      // Try title
      const title = await locator.getAttribute('title');
      if (title) return title;

      // Try alt (for images)
      const alt = await locator.getAttribute('alt');
      if (alt) return alt;

      return '';

    } catch {
      return '';
    }
  }

  /**
   * Format product label by intelligently parsing text content
   * Works across all e-commerce sites (Amazon, eBay, Target, etc.)
   */
  _formatProductLabel(text) {
    // Strategy: Find the longest meaningful text segment (likely the product name)
    // after removing common e-commerce noise patterns
    
    // Extract discount percentage
    const discountMatch = text.match(/(\d+)\s*%\s*off/i);
    const discount = discountMatch ? discountMatch[0] : null;
    
    // Extract prices
    const pricePattern = /[\$€£¥]\s*\d+[\.,]?\d*/g;
    const prices = text.match(pricePattern) || [];
    
    // Remove noise patterns to isolate product name
    let cleaned = text;
    
    // Remove discount badges and timers
    cleaned = cleaned.replace(/\d+\s*%\s*off/gi, '|');
    cleaned = cleaned.replace(/Ends in \d{1,2}:\d{2}:\d{2}/gi, '|');
    cleaned = cleaned.replace(/Limited time deal/gi, '|');
    cleaned = cleaned.replace(/Deal of the day/gi, '|');
    
    // Remove prices
    prices.forEach(price => {
      cleaned = cleaned.replace(price, '|');
    });
    
    // Remove "List:", "Typical:", etc. with their values
    cleaned = cleaned.replace(/\b(List|Typical|Was|Now):\s*[\$€£¥]?\d+[\.,]?\d*/gi, '|');
    
    // Split by delimiter and find the longest meaningful segment
    const segments = cleaned.split('|')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    // Find the longest segment (likely the product name)
    let productName = '';
    for (const segment of segments) {
      // Skip segments that are just numbers or very short
      if (segment.length > productName.length && segment.length > 10 && !/^\d+$/.test(segment)) {
        productName = segment;
      }
    }
    
    // Clean up whitespace
    productName = productName.replace(/\s+/g, ' ').trim();
    
    // Rebuild in clean format: [Product Name] - [Price] ([Discount])
    const parts = [];
    
    if (productName) {
      parts.push(productName);
    }
    
    // Add the first (current) price if found
    if (prices.length > 0) {
      parts.push(`- ${prices[0]}`);
    }
    
    // Add discount if found
    if (discount) {
      parts.push(`(${discount})`);
    }
    
    return parts.join(' ');
  }

  /**
   * Get element value (for inputs)
   */
  async _getValue(locator) {
    try {
      const tagName = await locator.evaluate(el => el.tagName.toLowerCase());
      
      if (tagName === 'input' || tagName === 'textarea') {
        const value = await locator.inputValue();
        return value || '';
      }

      return '';

    } catch {
      return '';
    }
  }

  /**
   * Get element attributes
   */
  async _getAttributes(locator) {
    try {
      return await locator.evaluate(el => {
        const attrs = {};
        for (const attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }
        return attrs;
      });
    } catch {
      return {};
    }
  }

  /**
   * Infer role from tag name
   */
  _inferRole(tagName) {
    const roleMap = {
      'button': 'button',
      'a': 'link',
      'input': 'textbox',
      'textarea': 'textbox',
      'select': 'combobox',
      'img': 'image',
      'nav': 'navigation',
      'header': 'banner',
      'footer': 'contentinfo',
      'main': 'main',
      'aside': 'complementary'
    };

    return roleMap[tagName] || 'generic';
  }

  /**
   * Get available actions for element
   */
  _getActions(tagName, attributes) {
    const actions = [];

    if (tagName === 'button' || tagName === 'a') {
      actions.push('click');
    }

    if (tagName === 'input' || tagName === 'textarea') {
      actions.push('focus', 'type', 'clear');
    }

    if (tagName === 'select') {
      actions.push('select');
    }

    if (attributes.onclick || attributes.href) {
      if (!actions.includes('click')) {
        actions.push('click');
      }
    }

    return actions;
  }

  /**
   * Remove duplicate elements (same position and label)
   */
  _deduplicateElements(elements) {
    const seen = new Set();
    const unique = [];

    for (const element of elements) {
      const key = `${element.bounds.x},${element.bounds.y},${element.label}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(element);
      }
    }

    return unique;
  }

  /**
   * Deep scan - scroll through entire page and extract all elements
   * @param {string} url - URL to scan
   * @param {Object} options - Scan options
   * @returns {Promise<Array>} All elements found with positions
   */
  async deepScanPage(url, options = {}) {
    const {
      maxScrolls = 50,
      scrollDelay = 1000,
      windowBounds = null
    } = options;

    try {
      logger.info('🔍 Starting deep scan', { url, maxScrolls });

      // Create new page with proper viewport
      const viewportWidth = windowBounds?.width || 1920;
      const viewportHeight = windowBounds?.height || 1080;
      
      const page = await this.context.newPage();
      await page.setViewportSize({ width: viewportWidth, height: viewportHeight });

      // Navigate to URL
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });

      await page.waitForTimeout(2000); // Wait for initial content

      const allElements = [];
      let scrollCount = 0;
      let previousHeight = 0;

      while (scrollCount < maxScrolls) {
        // Extract all interactive elements at current scroll position
        const elements = await page.evaluate(() => {
          const results = [];
          
          // Selectors for interactive elements
          const selectors = [
            'a[href]',
            'button',
            'input',
            'textarea',
            'select',
            '[role="button"]',
            '[role="link"]',
            '[onclick]',
            '[data-component-type="s-search-result"]', // Amazon products
            '.product', // Generic product class
            '[data-product-id]' // Product with ID
          ];

          const elements = new Set();
          selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => elements.add(el));
          });

          elements.forEach((el, index) => {
            const rect = el.getBoundingClientRect();
            const absoluteY = rect.y + window.scrollY;
            const absoluteX = rect.x + window.scrollX;

            // Get element info
            const tagName = el.tagName.toLowerCase();
            let role = el.getAttribute('role') || tagName;
            let label = '';

            // Extract label based on element type
            if (tagName === 'a') {
              label = el.textContent?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '';
            } else if (tagName === 'button') {
              label = el.textContent?.trim() || el.getAttribute('aria-label') || '';
            } else if (tagName === 'input') {
              label = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || '';
              role = 'input';
            } else {
              label = el.textContent?.trim() || el.getAttribute('aria-label') || '';
            }

            // Truncate long labels
            if (label.length > 100) {
              label = label.substring(0, 97) + '...';
            }

            // Check if element is visible
            const isVisible = rect.width > 0 && rect.height > 0 && 
                             window.getComputedStyle(el).visibility !== 'hidden' &&
                             window.getComputedStyle(el).display !== 'none';

            if (isVisible && label) {
              results.push({
                role,
                label,
                bounds: {
                  x: Math.round(absoluteX),
                  y: Math.round(absoluteY),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height)
                },
                viewport: {
                  top: Math.round(rect.top),
                  bottom: Math.round(rect.bottom),
                  inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight
                },
                url: tagName === 'a' ? el.href : null,
                value: el.value || null
              });
            }
          });

          return results;
        });

        // Add new elements (deduplicate by position)
        elements.forEach(element => {
          const exists = allElements.some(existing => 
            Math.abs(existing.bounds.y - element.bounds.y) < 10 &&
            Math.abs(existing.bounds.x - element.bounds.x) < 10 &&
            existing.label === element.label
          );
          if (!exists) {
            allElements.push(element);
          }
        });

        logger.info(`📊 Scroll ${scrollCount + 1}: Found ${elements.length} new elements, ${allElements.length} total`);

        // Check if we've reached the bottom
        const currentHeight = await page.evaluate(() => document.body.scrollHeight);
        if (currentHeight === previousHeight) {
          logger.info('✅ Reached bottom of page');
          break;
        }

        // Scroll down
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
        await page.waitForTimeout(scrollDelay);

        previousHeight = currentHeight;
        scrollCount++;
      }

      await page.close();

      logger.info(`✅ Deep scan complete: ${allElements.length} elements found after ${scrollCount} scrolls`);
      return allElements;

    } catch (error) {
      logger.error('Deep scan failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Close browser
   */
  async close() {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.context = null;
        this.page = null;
        logger.info('Playwright browser closed');
      }
    } catch (error) {
      logger.error('Failed to close browser', { error: error.message });
    }
  }
}

/**
 * Helper function to extract URL from browser address bar using AppleScript
 */
export async function getBrowserUrl(browserName) {
  try {
    let script;

    if (browserName === 'Google Chrome' || browserName === 'Chromium') {
      script = `
        tell application "Google Chrome"
          get URL of active tab of front window
        end tell
      `;
    } else if (browserName === 'Safari') {
      script = `
        tell application "Safari"
          get URL of current tab of front window
        end tell
      `;
    } else if (browserName === 'Firefox') {
      // Firefox doesn't support AppleScript URL access
      // Would need to use CDP or browser extension
      return null;
    } else {
      return null;
    }

    const { stdout } = await execAsync(`osascript -e '${script}'`);
    const url = stdout.trim();

    logger.info('Extracted URL from browser', { browserName, url });
    return url;

  } catch (error) {
    logger.error('Failed to get browser URL', { browserName, error: error.message });
    return null;
  }
}

/**
 * Get URLs for all windows of a browser (for deduplication)
 * Returns array of { title, url }
 */
export async function getAllBrowserWindowUrls(browserName) {
  try {
    let script;

    if (browserName === 'Google Chrome' || browserName === 'Chromium') {
      // Use simple delimited format instead of AppleScript records
      script = `
        tell application "Google Chrome"
          set output to ""
          repeat with w in windows
            try
              set windowTitle to title of w
              set tabUrl to URL of active tab of w
              set output to output & windowTitle & "|||" & tabUrl & "\\n"
            end try
          end repeat
          return output
        end tell
      `;
    } else if (browserName === 'Safari') {
      script = `
        tell application "Safari"
          set output to ""
          repeat with w in windows
            try
              set windowTitle to name of w
              set tabUrl to URL of current tab of w
              set output to output & windowTitle & "|||" & tabUrl & "\\n"
            end try
          end repeat
          return output
        end tell
      `;
    } else {
      return [];
    }

    const { stdout } = await execAsync(`osascript <<'EOF'\n${script}\nEOF`);
    const output = stdout.trim();
    
    logger.info('Raw AppleScript output', { 
      browserName, 
      outputLength: output.length,
      output: output.substring(0, 200) 
    });
    
    if (!output) {
      logger.warn('No output from getAllBrowserWindowUrls', { browserName });
      return [];
    }
    
    // Parse delimited format: "Title|||URL\n"
    const windows = [];
    const lines = output.split('\n').filter(line => line.trim());
    
    logger.info('Parsing lines', { lineCount: lines.length, lines: lines.slice(0, 3) });
    
    for (const line of lines) {
      const parts = line.split('|||');
      if (parts.length === 2) {
        windows.push({
          title: parts[0].trim(),
          url: parts[1].trim()
        });
      } else {
        logger.warn('Line does not have 2 parts', { line, parts: parts.length });
      }
    }

    logger.info('Extracted URLs for all browser windows', { 
      browserName, 
      count: windows.length,
      windows: windows.map(w => ({ title: w.title, url: w.url.substring(0, 50) + '...' }))
    });
    
    return windows;

  } catch (error) {
    logger.error('Failed to get all browser window URLs', { browserName, error: error.message });
    return [];
  }
}
