import logger from '../../utils/logger.js';

/**
 * Accessibility Adapter Factory
 * Returns the appropriate adapter for the current platform
 * 
 * Platform Support:
 * - ✅ macOS: Enhanced AppleScript-based adapter (Phase 2 complete)
 * - 🚧 Windows: UIA adapter (see windows.js for implementation plan)
 * - 🚧 Linux: AT-SPI adapter (see linux.js for implementation plan)
 * - ✅ Fallback: Mock adapter for development/testing
 */

let adapter = null;

export async function initializeAccessibilityAdapter() {
  const platform = process.platform;
  
  logger.info('Initializing accessibility adapter', { platform });

  try {
    if (platform === 'darwin') {
      // ✅ macOS: Enhanced AppleScript adapter with caching and query methods
      const { EnhancedMacOSAccessibilityAdapter } = await import('./macos-enhanced.js');
      adapter = new EnhancedMacOSAccessibilityAdapter();
      await adapter.initialize();
      logger.info('✅ Enhanced macOS accessibility adapter initialized');
      
    } else if (platform === 'win32') {
      // 🚧 TODO: Windows UIA (UI Automation) adapter
      // See src/adapters/accessibility/windows.js for implementation plan
      // 
      // Implementation options:
      // 1. node-ffi-napi for native UIA COM APIs
      // 2. edge-js for .NET UIA libraries
      // 3. PowerShell scripts via child_process
      //
      // Key APIs: AutomationElement, TreeWalker, ControlPatterns
      logger.warn('⚠️  Windows UIA adapter not yet implemented');
      logger.warn('📝 See src/adapters/accessibility/windows.js for implementation guide');
      logger.warn('🔄 Using mock adapter for development');
      
      const { MockAccessibilityAdapter } = await import('./mock.js');
      adapter = new MockAccessibilityAdapter();
      await adapter.initialize();
      
    } else {
      // 🚧 TODO: Linux AT-SPI (Assistive Technology Service Provider Interface) adapter
      // See src/adapters/accessibility/linux.js for implementation plan
      //
      // Implementation options:
      // 1. node-dbus for D-Bus communication with AT-SPI daemon
      // 2. Python bridge to pyatspi2
      // 3. X11 automation as fallback
      //
      // Key concepts: Accessible tree, Component interface, D-Bus registry
      logger.warn('⚠️  Linux AT-SPI adapter not yet implemented');
      logger.warn('📝 See src/adapters/accessibility/linux.js for implementation guide');
      logger.warn('🔄 Using mock adapter for development');
      
      const { MockAccessibilityAdapter } = await import('./mock.js');
      adapter = new MockAccessibilityAdapter();
      await adapter.initialize();
    }

    return adapter;
  } catch (error) {
    logger.error('Failed to initialize accessibility adapter', { error: error.message });
    
    // Fallback to mock adapter
    logger.warn('🔄 Falling back to mock adapter');
    const { MockAccessibilityAdapter } = await import('./mock.js');
    adapter = new MockAccessibilityAdapter();
    await adapter.initialize();
    
    return adapter;
  }
}

export function getAccessibilityAdapter() {
  if (!adapter) {
    throw new Error('Accessibility adapter not initialized');
  }
  return adapter;
}
