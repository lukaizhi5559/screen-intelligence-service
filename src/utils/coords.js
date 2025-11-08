import logger from './logger.js';

/**
 * Coordinate Conversion Utilities
 * Handles conversion between different coordinate systems
 */

/**
 * Convert macOS screen coordinates to absolute coordinates
 * macOS uses bottom-left origin, we need top-left
 */
export function macOSToAbsolute(x, y, screenHeight) {
  return {
    x,
    y: screenHeight - y
  };
}

/**
 * Convert absolute coordinates to macOS screen coordinates
 */
export function absoluteToMacOS(x, y, screenHeight) {
  return {
    x,
    y: screenHeight - y
  };
}

/**
 * Convert element bounds to center point
 */
export function boundsToCenter(bounds) {
  return {
    x: bounds.x + (bounds.width / 2),
    y: bounds.y + (bounds.height / 2)
  };
}

/**
 * Check if point is within bounds
 */
export function isPointInBounds(point, bounds) {
  return point.x >= bounds.x &&
         point.x <= bounds.x + bounds.width &&
         point.y >= bounds.y &&
         point.y <= bounds.y + bounds.height;
}

/**
 * Calculate distance between two points
 */
export function distance(point1, point2) {
  const dx = point2.x - point1.x;
  const dy = point2.y - point1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Find closest element to a point
 */
export function findClosestElement(point, elements) {
  if (!elements || elements.length === 0) {
    return null;
  }

  let closest = null;
  let minDistance = Infinity;

  for (const element of elements) {
    if (!element.bounds) continue;

    const center = boundsToCenter(element.bounds);
    const dist = distance(point, center);

    if (dist < minDistance) {
      minDistance = dist;
      closest = element;
    }
  }

  return closest;
}

/**
 * Check if two bounds overlap
 */
export function boundsOverlap(bounds1, bounds2) {
  return !(bounds1.x + bounds1.width < bounds2.x ||
           bounds2.x + bounds2.width < bounds1.x ||
           bounds1.y + bounds1.height < bounds2.y ||
           bounds2.y + bounds2.height < bounds1.y);
}

/**
 * Calculate overlap area between two bounds
 */
export function calculateOverlapArea(bounds1, bounds2) {
  if (!boundsOverlap(bounds1, bounds2)) {
    return 0;
  }

  const xOverlap = Math.min(bounds1.x + bounds1.width, bounds2.x + bounds2.width) -
                   Math.max(bounds1.x, bounds2.x);
  const yOverlap = Math.min(bounds1.y + bounds1.height, bounds2.y + bounds2.height) -
                   Math.max(bounds1.y, bounds2.y);

  return xOverlap * yOverlap;
}

/**
 * Scale bounds by a factor
 */
export function scaleBounds(bounds, scale) {
  return {
    x: bounds.x * scale,
    y: bounds.y * scale,
    width: bounds.width * scale,
    height: bounds.height * scale
  };
}

/**
 * Translate bounds by offset
 */
export function translateBounds(bounds, offsetX, offsetY) {
  return {
    x: bounds.x + offsetX,
    y: bounds.y + offsetY,
    width: bounds.width,
    height: bounds.height
  };
}

/**
 * Normalize bounds to 0-1 range based on screen size
 */
export function normalizeBounds(bounds, screenWidth, screenHeight) {
  return {
    x: bounds.x / screenWidth,
    y: bounds.y / screenHeight,
    width: bounds.width / screenWidth,
    height: bounds.height / screenHeight
  };
}

/**
 * Denormalize bounds from 0-1 range to absolute coordinates
 */
export function denormalizeBounds(normalizedBounds, screenWidth, screenHeight) {
  return {
    x: normalizedBounds.x * screenWidth,
    y: normalizedBounds.y * screenHeight,
    width: normalizedBounds.width * screenWidth,
    height: normalizedBounds.height * screenHeight
  };
}

/**
 * Get screen dimensions
 */
export async function getScreenDimensions() {
  try {
    // This would use native APIs in production
    // For now, return common dimensions
    return {
      width: 1920,
      height: 1080
    };
  } catch (error) {
    logger.error('Failed to get screen dimensions', { error: error.message });
    return {
      width: 1920,
      height: 1080
    };
  }
}

/**
 * Convert relative position (percentage) to absolute
 */
export function relativeToAbsolute(relativeX, relativeY, screenWidth, screenHeight) {
  return {
    x: relativeX * screenWidth,
    y: relativeY * screenHeight
  };
}

/**
 * Convert absolute position to relative (percentage)
 */
export function absoluteToRelative(x, y, screenWidth, screenHeight) {
  return {
    x: x / screenWidth,
    y: y / screenHeight
  };
}

export default {
  macOSToAbsolute,
  absoluteToMacOS,
  boundsToCenter,
  isPointInBounds,
  distance,
  findClosestElement,
  boundsOverlap,
  calculateOverlapArea,
  scaleBounds,
  translateBounds,
  normalizeBounds,
  denormalizeBounds,
  getScreenDimensions,
  relativeToAbsolute,
  absoluteToRelative
};
