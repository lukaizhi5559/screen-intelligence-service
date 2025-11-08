import logger from '../../utils/logger.js';

/**
 * Mock Accessibility Adapter
 * Used for development and unsupported platforms
 */
export class MockAccessibilityAdapter {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    logger.info('Initializing mock accessibility adapter...');
    this.initialized = true;
    logger.info('✅ Mock adapter ready (development mode)');
  }

  async getAllElements({ includeHidden = false } = {}) {
    logger.info('Mock: Getting all elements', { includeHidden });
    
    return [
      {
        role: 'window',
        label: 'VS Code - main.js',
        value: '',
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        actions: ['focus', 'minimize', 'close'],
        confidence: 0.95
      },
      {
        role: 'button',
        label: 'Run',
        value: '',
        bounds: { x: 100, y: 50, width: 60, height: 30 },
        actions: ['press'],
        confidence: 0.98
      },
      {
        role: 'button',
        label: 'Debug',
        value: '',
        bounds: { x: 170, y: 50, width: 60, height: 30 },
        actions: ['press'],
        confidence: 0.97
      },
      {
        role: 'textarea',
        label: 'Editor',
        value: 'console.log("Hello World");',
        bounds: { x: 50, y: 100, width: 1820, height: 900 },
        actions: ['focus', 'type'],
        confidence: 0.99
      },
      {
        role: 'text',
        label: 'Problems: 0',
        value: '0',
        bounds: { x: 50, y: 1010, width: 200, height: 30 },
        actions: [],
        confidence: 0.92
      }
    ];
  }

  async queryElements({ query, role } = {}) {
    logger.info('Mock: Querying elements', { query, role });
    
    const allElements = await this.getAllElements();
    
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
        return label.includes(queryLower) || value.includes(queryLower);
      });
    }
    
    return filtered;
  }
}
