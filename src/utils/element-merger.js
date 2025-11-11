import logger from './logger.js';
import { batchProbeElements, getActionsForRole } from './element-probe.js';

/**
 * Check if two bounding boxes are near each other (within threshold)
 */
function areBoundsNear(bounds1, bounds2, threshold = 20) {
  if (!bounds1 || !bounds2) return false;
  
  // Calculate center points
  const center1 = {
    x: bounds1.x + bounds1.width / 2,
    y: bounds1.y + bounds1.height / 2
  };
  
  const center2 = {
    x: bounds2.x + bounds2.width / 2,
    y: bounds2.y + bounds2.height / 2
  };
  
  // Calculate distance between centers
  const distance = Math.sqrt(
    Math.pow(center1.x - center2.x, 2) + 
    Math.pow(center1.y - center2.y, 2)
  );
  
  return distance <= threshold;
}

/**
 * Find OCR text that overlaps or is near an Accessibility element
 */
function findMatchingOCRText(accBounds, ocrResults, threshold = 20) {
  if (!ocrResults || !ocrResults.lines) return null;
  
  // Try to find OCR text within or near the accessibility element bounds
  for (const ocrLine of ocrResults.lines) {
    if (areBoundsNear(accBounds, ocrLine.bounds, threshold)) {
      return ocrLine;
    }
  }
  
  return null;
}

/**
 * Check if OCR text is already matched to an Accessibility element
 */
function isOCRMatched(ocrBounds, accElements, threshold = 20) {
  for (const accEl of accElements) {
    if (areBoundsNear(ocrBounds, accEl.bounds, threshold)) {
      return true;
    }
  }
  return false;
}

/**
 * Merge Accessibility API elements with OCR text and probe unmatched OCR
 * 
 * Three-layer approach:
 * 1. Accessibility API - Gets structure (buttons, images with alt text, empty fields)
 * 2. OCR with bounds - Gets visible text content (works on authenticated pages)
 * 3. Point probe - Identifies element type for unmatched OCR text
 * 
 * @param {Array} accessibilityElements - Elements from Accessibility API
 * @param {Object} ocrResults - Results from OCR with bounds {words, lines, fullText}
 * @param {string} appName - Application name for probing
 * @param {Object} windowBounds - Window bounds {x, y, width, height} for coordinate validation
 * @returns {Promise<Array>} Merged and enriched elements
 */
export async function mergeElements(accessibilityElements, ocrResults, appName, windowBounds = null) {
  logger.info('Merging elements', {
    accessibilityCount: accessibilityElements.length,
    ocrLinesCount: ocrResults.lines?.length || 0,
    ocrWordsCount: ocrResults.words?.length || 0
  });
  
  const mergedElements = [];
  
  // LAYER 1: Process Accessibility elements and enrich with OCR text
  for (const accEl of accessibilityElements) {
    // Try to find matching OCR text to enrich the element
    const matchingOCR = findMatchingOCRText(accEl.bounds, ocrResults);
    
    // Determine the best label
    let label = accEl.label || accEl.description || accEl.title || '';
    
    // If Accessibility element has no label but OCR found text there, use OCR
    if (!label && matchingOCR) {
      label = matchingOCR.text;
    }
    
    mergedElements.push({
      role: accEl.role,
      label: label,
      value: accEl.value || '',
      bounds: accEl.bounds,
      confidence: matchingOCR ? 0.95 : 0.85, // Higher confidence if OCR confirms
      actions: getActionsForRole(accEl.role),
      source: matchingOCR ? 'accessibility_with_ocr' : 'accessibility',
      elementType: accEl.elementType
    });
  }
  
  logger.info('Accessibility elements processed', { count: mergedElements.length });
  
  // LAYER 2: Find OCR text NOT matched to any Accessibility element
  const unmatchedOCR = (ocrResults.lines || []).filter(ocrLine => 
    !isOCRMatched(ocrLine.bounds, accessibilityElements)
  );
  
  logger.info('Unmatched OCR text found', { count: unmatchedOCR.length });
  
  if (unmatchedOCR.length === 0) {
    logger.info('All OCR text matched to Accessibility elements, skipping probe');
    return mergedElements;
  }
  
  // LAYER 3: Probe unmatched OCR text to identify element types
  // Limit probing to avoid performance issues
  const maxProbes = 50;
  const toProbe = unmatchedOCR.slice(0, maxProbes);
  
  if (unmatchedOCR.length > maxProbes) {
    logger.warn('Too many unmatched OCR elements, limiting probe', {
      total: unmatchedOCR.length,
      probing: maxProbes
    });
  }
  
  logger.info('Batch probing elements', { count: toProbe.length, app: appName });
  
  // Prepare probe points (center of each OCR text bounds) with OCR data for role prediction
  const probePoints = toProbe.map(ocr => ({
    x: Math.round(ocr.bounds.x + ocr.bounds.width / 2),
    y: Math.round(ocr.bounds.y + ocr.bounds.height / 2),
    ocrData: {
      text: ocr.text,
      bounds: ocr.bounds,
      confidence: ocr.confidence,
      value: '',
      description: ''
    }
  }));
  
  // Batch probe all points with window bounds validation and OCR data
  const probeResults = await batchProbeElements(
    probePoints,
    appName,
    windowBounds
  );
  
  // Add probed elements
  for (let i = 0; i < probeResults.length; i++) {
    const probeResult = probeResults[i];
    const ocrData = probePoints[i].ocrData;
    
    if (probeResult) {
      // Successfully probed - we know the element type
      mergedElements.push({
        role: probeResult.role,
        label: ocrData.text,
        value: probeResult.value || '',
        bounds: ocrData.bounds, // Use OCR bounds (more accurate for text)
        confidence: ocrData.confidence,
        actions: getActionsForRole(probeResult.role),
        source: 'ocr_with_probe',
        elementType: probeResult.role
      });
    } else {
      // Probe failed - add as plain text
      mergedElements.push({
        role: 'text_line',
        label: ocrData.text,
        value: ocrData.text,
        bounds: ocrData.bounds,
        confidence: ocrData.confidence,
        actions: [],
        source: 'ocr_only',
        elementType: 'text_line'
      });
    }
  }
  
  // Add remaining unprobed OCR text as plain text
  const unprobedOCR = unmatchedOCR.slice(maxProbes);
  for (const ocr of unprobedOCR) {
    mergedElements.push({
      role: 'text_line',
      label: ocr.text,
      value: ocr.text,
      bounds: ocr.bounds,
      confidence: ocr.confidence,
      actions: [],
      source: 'ocr_only',
      elementType: 'text_line'
    });
  }
  
  logger.info('Element merge complete', {
    total: mergedElements.length,
    fromAccessibility: accessibilityElements.length,
    fromOCRWithProbe: probeResults.filter(r => r !== null).length,
    fromOCROnly: unmatchedOCR.length - probeResults.filter(r => r !== null).length
  });
  
  return mergedElements;
}

/**
 * Simple merge without probing (faster, but less accurate)
 * Use this when performance is critical
 */
export function mergeElementsSimple(accessibilityElements, ocrResults) {
  logger.info('Simple merge (no probing)', {
    accessibilityCount: accessibilityElements.length,
    ocrLinesCount: ocrResults.lines?.length || 0
  });
  
  const mergedElements = [];
  
  // Add all Accessibility elements with OCR enrichment
  for (const accEl of accessibilityElements) {
    const matchingOCR = findMatchingOCRText(accEl.bounds, ocrResults);
    
    let label = accEl.label || accEl.description || accEl.title || '';
    if (!label && matchingOCR) {
      label = matchingOCR.text;
    }
    
    mergedElements.push({
      role: accEl.role,
      label: label,
      value: accEl.value || '',
      bounds: accEl.bounds,
      confidence: matchingOCR ? 0.95 : 0.85,
      actions: getActionsForRole(accEl.role),
      source: matchingOCR ? 'accessibility_with_ocr' : 'accessibility',
      elementType: accEl.elementType
    });
  }
  
  // Add unmatched OCR as plain text
  const unmatchedOCR = (ocrResults.lines || []).filter(ocrLine => 
    !isOCRMatched(ocrLine.bounds, accessibilityElements)
  );
  
  for (const ocr of unmatchedOCR) {
    mergedElements.push({
      role: 'text_line',
      label: ocr.text,
      value: ocr.text,
      bounds: ocr.bounds,
      confidence: ocr.confidence,
      actions: [],
      source: 'ocr_only',
      elementType: 'text_line'
    });
  }
  
  logger.info('Simple merge complete', { total: mergedElements.length });
  return mergedElements;
}
