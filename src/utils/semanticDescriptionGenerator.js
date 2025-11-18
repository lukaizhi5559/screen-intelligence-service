/**
 * Semantic Description Generator
 * Converts UI tree nodes into human-readable descriptions for embedding
 * Based on ScreenAI research paper approach
 */

class SemanticDescriptionGenerator {
  /**
   * Generate a semantic description for a single UI node
   * @param {Object} node - UI semantic node
   * @param {Object} context - Additional context (parent, siblings, screen info)
   * @returns {string} Human-readable description
   */
  generateNodeDescription(node, context = {}) {
    const parts = [];

    // 1. Element type and role
    const typeDesc = this._getTypeDescription(node.type);
    parts.push(typeDesc);

    // 2. Text content (if any)
    if (node.text && node.text.trim()) {
      parts.push(`"${node.text.trim()}"`);
    }

    // 3. Icon or image description
    if (node.metadata.iconType) {
      parts.push(`with ${node.metadata.iconType} icon`);
    }
    if (node.metadata.imageCaption) {
      parts.push(`showing "${node.metadata.imageCaption}"`);
    }

    // 4. Location context
    if (node.metadata.screenRegion) {
      parts.push(`in ${node.metadata.screenRegion}`);
    }

    // 5. Hierarchy context
    if (node.hierarchyPath && node.hierarchyPath.length > 1) {
      const parentPath = node.hierarchyPath.slice(0, -1).join(' > ');
      parts.push(`within ${parentPath}`);
    }

    // 6. Application context
    if (context.app) {
      parts.push(`on ${context.app}`);
    }

    // 7. URL context (for browsers)
    if (context.url) {
      const domain = this._extractDomain(context.url);
      parts.push(`at ${domain}`);
    }

    // 8. Interactive state
    if (node.metadata.clickable) {
      parts.push('(clickable)');
    }
    if (node.metadata.interactive && node.type === 'input') {
      parts.push('(editable)');
    }

    return parts.join(' ');
  }

  /**
   * Generate a semantic description for a subtree/region
   * @param {Object} subtree - UI subtree
   * @param {Array} nodes - All nodes in the subtree
   * @param {Object} context - Additional context
   * @returns {string} Human-readable description
   */
  generateSubtreeDescription(subtree, nodes, context = {}) {
    const parts = [];

    // 1. Region type and title
    parts.push(`${this._capitalizeFirst(subtree.type)}`);
    if (subtree.title) {
      parts.push(`titled "${subtree.title}"`);
    }

    // 2. Summarize contents
    const contentSummary = this._summarizeSubtreeContents(nodes);
    if (contentSummary) {
      parts.push(`containing ${contentSummary}`);
    }

    // 3. Key interactive elements
    const interactiveElements = nodes.filter(n => n.metadata.clickable || n.metadata.interactive);
    if (interactiveElements.length > 0) {
      const elementTypes = this._groupByType(interactiveElements);
      const elementDesc = Object.entries(elementTypes)
        .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
        .join(', ');
      parts.push(`with ${elementDesc}`);
    }

    // 4. Application context
    if (context.app) {
      parts.push(`in ${context.app}`);
    }

    return parts.join(' ');
  }

  /**
   * Generate a semantic description for an entire screen state
   * @param {Object} screenState - UI screen state
   * @returns {string} Human-readable description
   */
  generateScreenDescription(screenState) {
    const parts = [];

    // 1. Application and window title
    parts.push(`${screenState.app} window`);
    if (screenState.windowTitle) {
      parts.push(`showing "${screenState.windowTitle}"`);
    }

    // 2. URL (for browsers)
    if (screenState.url) {
      const domain = this._extractDomain(screenState.url);
      parts.push(`at ${domain}`);
    }

    // 3. Main regions/subtrees
    if (screenState.subtrees && screenState.subtrees.length > 0) {
      const regionTypes = screenState.subtrees.map(s => s.type);
      const uniqueRegions = [...new Set(regionTypes)];
      parts.push(`with ${uniqueRegions.join(', ')} regions`);
    }

    // 4. Key content summary
    const allNodes = Array.from(screenState.nodes.values());
    const textNodes = allNodes.filter(n => n.type === 'text' && n.text.length > 3);
    const buttonNodes = allNodes.filter(n => n.type === 'button');
    const inputNodes = allNodes.filter(n => n.type === 'input');

    const contentParts = [];
    if (textNodes.length > 0) {
      contentParts.push(`${textNodes.length} text elements`);
    }
    if (buttonNodes.length > 0) {
      contentParts.push(`${buttonNodes.length} buttons`);
    }
    if (inputNodes.length > 0) {
      contentParts.push(`${inputNodes.length} input fields`);
    }

    if (contentParts.length > 0) {
      parts.push(`containing ${contentParts.join(', ')}`);
    }

    // 5. Notable elements (extract key buttons/actions)
    const notableElements = this._extractNotableElements(allNodes);
    if (notableElements.length > 0) {
      const elementTexts = notableElements.map(n => `"${n.text}"`).join(', ');
      parts.push(`including ${elementTexts}`);
    }

    return parts.join(' ');
  }

  /**
   * Generate descriptions for a batch of nodes
   * @param {Array} nodes - Array of UI nodes
   * @param {Object} context - Shared context
   * @returns {Array} Array of nodes with updated descriptions
   */
  generateBatchDescriptions(nodes, context = {}) {
    return nodes.map(node => ({
      ...node,
      description: this.generateNodeDescription(node, context)
    }));
  }

  // ==================== Helper Methods ====================

  _getTypeDescription(type) {
    const typeMap = {
      button: 'Button',
      input: 'Input field',
      text: 'Text',
      image: 'Image',
      pictogram: 'Icon',
      dialog: 'Dialog',
      modal: 'Modal',
      panel: 'Panel',
      list: 'List',
      list_item: 'List item',
      checkbox: 'Checkbox',
      radio: 'Radio button',
      dropdown: 'Dropdown menu',
      menu: 'Menu',
      menu_item: 'Menu item',
      link: 'Link',
      icon: 'Icon',
      tab: 'Tab',
      window: 'Window',
      section: 'Section',
      container: 'Container',
      unknown: 'UI element'
    };
    return typeMap[type] || 'UI element';
  }

  _capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  _extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch (e) {
      return url;
    }
  }

  _summarizeSubtreeContents(nodes) {
    if (nodes.length === 0) return '';

    // Group by type
    const typeGroups = this._groupByType(nodes);
    const summary = Object.entries(typeGroups)
      .filter(([type, count]) => count > 0)
      .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
      .slice(0, 3) // Top 3 types
      .join(', ');

    return summary;
  }

  _groupByType(nodes) {
    const groups = {};
    for (const node of nodes) {
      const type = this._getTypeDescription(node.type).toLowerCase();
      groups[type] = (groups[type] || 0) + 1;
    }
    return groups;
  }

  _extractNotableElements(nodes) {
    // Extract buttons with action-oriented text
    const actionKeywords = ['save', 'submit', 'send', 'create', 'delete', 'cancel', 'ok', 'confirm', 'export', 'download', 'upload', 'login', 'signup', 'search'];
    
    const notableButtons = nodes.filter(n => {
      if (n.type !== 'button') return false;
      const text = n.text.toLowerCase();
      return actionKeywords.some(keyword => text.includes(keyword));
    });

    return notableButtons.slice(0, 5); // Top 5 notable elements
  }
}

export default SemanticDescriptionGenerator;
