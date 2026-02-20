import Tesseract from 'tesseract.js';
import crypto from 'crypto';
import logger from '../utils/logger.js';

// --- OCR Text Processing Helpers ---

function cleanOcrText(raw) {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

/**
 * Filter out gibberish OCR fragments.
 * Uses multiple strategies to remove noise from icons, avatars, UI chrome.
 * Replaces gibberish with --- delimiters so LLMs see context boundaries.
 * Preserves timestamps, file metadata, and meaningful content.
 */
function filterGibberish(text) {
  const DELIMITER = ' --- ';
  const PLACEHOLDER_PREFIX = 'XXTIMESTAMPXX';

  // Step 0: Protect timestamps before filtering
  const timestampPatterns = [
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z]*\d{1,2}\s+\d{1,2}:\d{2}\s*[AP]M/gi,
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[A-Za-z]*\s*\d{1,2}\s+\d{1,2}:\d{2}\s*[AP]M/gi,
    /\d{1,2}:\d{2}\s*[AP]M/gi,
    /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?/g,
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}/gi,
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}(?:\s+at\s+\d{1,2}:\d{2}\s*[AP]M)?/gi
  ];
  const placeholderMap = {};
  let placeholderIdx = 0;
  const allMatches = [];
  for (const pattern of timestampPatterns) {
    let match;
    const re = new RegExp(pattern.source, pattern.flags);
    while ((match = re.exec(text)) !== null) {
      allMatches.push({ value: match[0], index: match.index, length: match[0].length });
    }
  }
  allMatches.sort((a, b) => b.length - a.length);
  const replacedRanges = [];
  for (const m of allMatches) {
    const overlaps = replacedRanges.some(r =>
      m.index < r.index + r.length && m.index + m.length > r.index
    );
    if (overlaps) continue;
    const placeholder = `${PLACEHOLDER_PREFIX}${placeholderIdx}`;
    placeholderMap[placeholder] = m.value;
    text = text.replace(m.value, placeholder);
    replacedRanges.push(m);
    placeholderIdx++;
  }

  // Common English words + tech/OS terms that should never be removed
  const protectedWords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
    'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who',
    'did', 'get', 'let', 'say', 'she', 'too', 'use', 'him', 'man', 'run', 'set', 'try', 'ask',
    'own', 'put', 'big', 'end', 'few', 'got', 'why', 'yes', 'yet', 'ago', 'add', 'also', 'back',
    'been', 'call', 'came', 'come', 'each', 'find', 'from', 'give', 'good', 'have', 'help',
    'here', 'high', 'home', 'just', 'keep', 'know', 'last', 'left', 'life', 'like', 'line',
    'list', 'long', 'look', 'made', 'make', 'many', 'more', 'most', 'much', 'must', 'name',
    'next', 'only', 'open', 'over', 'part', 'play', 'read', 'real', 'same', 'show', 'side',
    'some', 'such', 'sure', 'take', 'tell', 'text', 'than', 'that', 'them', 'then', 'they',
    'this', 'time', 'turn', 'used', 'very', 'want', 'well', 'went', 'what', 'when', 'will',
    'with', 'word', 'work', 'year', 'your', 'about', 'after', 'again', 'being', 'below',
    'between', 'both', 'build', 'check', 'close', 'could', 'every', 'first', 'found', 'great',
    'group', 'house', 'large', 'later', 'learn', 'never', 'night', 'number', 'order', 'other',
    'place', 'point', 'right', 'shall', 'since', 'small', 'start', 'state', 'still', 'story',
    'think', 'three', 'under', 'until', 'using', 'water', 'where', 'which', 'while', 'world',
    'would', 'write', 'young', 'before', 'change', 'create', 'delete', 'during', 'follow',
    'memory', 'screen', 'search', 'server', 'should', 'system', 'update', 'window',
    'at', 'of', 'in', 'to', 'or', 'an', 'is', 'it', 'on', 'by', 'no', 'if', 'do', 'so', 'up',
    'as', 'be', 'he', 'we', 'me',
    'KB', 'MB', 'GB', 'TB', 'PDF', 'PNG', 'JPG', 'SVG', 'ZIP', 'CSV', 'DOC', 'XLS',
    'Document', 'Image', 'Folder', 'Network', 'Shared', 'Tags', 'Modified', 'Created',
    'Information',
    'File', 'Edit', 'View', 'Go', 'Name', 'Size', 'Kind', 'Date', 'Type', 'Window', 'Help',
    'AirDrop', 'Recents', 'Desktop', 'Documents', 'Downloads', 'Applications',
    'iCloud', 'Drive', 'Locations', 'Favorites', 'Finder', 'Safari', 'Chrome', 'Warp',
    'Markup', 'More', 'Show',
    'info', 'level', 'message', 'error', 'warn', 'debug', 'confidence', 'threshold',
    'capture', 'stored', 'Screen', 'Diff', 'main', 'true', 'false', 'null',
    'AI', 'ML', 'SDK', 'LLM', 'RAG', 'NLP',
    'POST', 'GET', 'PUT', 'DELETE', 'MCP', 'API', 'URL', 'HTTP', 'HTTPS',
    'HTML', 'CSS', 'JSON', 'SQL', 'OCR', 'NPM', 'CLI', 'IDE', 'GUI',
    'RAM', 'CPU', 'GPU', 'SSD', 'USB', 'DOM', 'SSH', 'FTP', 'DNS',
    'TCP', 'UDP', 'AWS', 'GCP', 'ENV', 'PM', 'AM', 'EST', 'UTC', 'PST', 'CST',
    'misc', 'data', 'test', 'config', 'index', 'setup'
  ]);
  const protectedLower = new Set([...protectedWords].map(w => w.toLowerCase()));

  // Step A: Replace sequences of 4+ consecutive single-letter words (clear OCR noise)
  text = text.replace(/(?:\b[a-zA-Z]\b[\s.,;:!?-]*){4,}/g, DELIMITER);

  // Step B: Replace punctuation-heavy fragments with delimiter
  text = text.replace(/(?:[^a-zA-Z0-9\s]{2,}\s*){3,}/g, DELIMITER);

  // Step C: Sliding window — flag windows dense with short/nonsense words
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const windowSize = 6;
  const gibberishRanges = [];

  function isNonsenseWord(w) {
    if (w.startsWith(PLACEHOLDER_PREFIX)) return false;
    if (w === '---') return false;
    const clean = w.replace(/[^a-zA-Z0-9-]/g, '');
    if (protectedLower.has(clean.toLowerCase())) return false;
    if (/^\d+$/.test(w)) return false;
    if (/\d/.test(w) && w.length >= 3) return false;
    if (/\.[a-zA-Z]{2,4}$/.test(w)) return false;
    if (/-/.test(w) && w.length >= 5) return false;
    const alpha = w.replace(/[^a-zA-Z]/g, '');
    if (alpha.length === 0) return false;
    if (alpha.length <= 2) return true;
    const vowels = alpha.replace(/[^aeiouAEIOU]/g, '').length;
    if (vowels === 0) return true;
    if (alpha.length <= 4 && vowels / alpha.length < 0.2) return true;
    if (/^[^aeiouAEIOU]{3,}/i.test(alpha) && alpha.length <= 5) return true;
    if (/[^aeiouAEIOU]{4,}$/i.test(alpha)) return true;
    return false;
  }

  for (let i = 0; i <= words.length - windowSize; i++) {
    const window = words.slice(i, i + windowSize);
    const nonsenseCount = window.filter(isNonsenseWord).length;
    if (nonsenseCount >= 4) {
      gibberishRanges.push([i, i + windowSize]);
    }
  }

  if (gibberishRanges.length > 0) {
    const merged = [gibberishRanges[0]];
    for (let i = 1; i < gibberishRanges.length; i++) {
      const last = merged[merged.length - 1];
      if (gibberishRanges[i][0] <= last[1]) {
        last[1] = Math.max(last[1], gibberishRanges[i][1]);
      } else {
        merged.push(gibberishRanges[i]);
      }
    }
    const removeSet = new Set();
    for (const [start, end] of merged) {
      for (let i = start; i < end && i < words.length; i++) {
        removeSet.add(i);
      }
    }
    let lastWasRemoved = false;
    const filtered = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (removeSet.has(i) && !w.startsWith(PLACEHOLDER_PREFIX) && !protectedLower.has(w.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase())) {
        if (!lastWasRemoved) filtered.push('---');
        lastWasRemoved = true;
      } else {
        filtered.push(w);
        lastWasRemoved = false;
      }
    }
    text = filtered.join(' ');
  }

  // Step D: Remove individual nonsense words that survived the sliding window
  {
    const cleanedWords = text.split(/\s+/).filter(w => w.length > 0);
    const result = [];
    let lastWasRemoved = false;
    for (let i = 0; i < cleanedWords.length; i++) {
      const w = cleanedWords[i];
      if (w === '---' || w.startsWith(PLACEHOLDER_PREFIX)) {
        result.push(w);
        lastWasRemoved = false;
        continue;
      }
      const clean = w.replace(/[^a-zA-Z0-9-]/g, '');
      if (protectedLower.has(clean.toLowerCase())) {
        result.push(w);
        lastWasRemoved = false;
        continue;
      }
      const alpha = w.replace(/[^a-zA-Z]/g, '');
      if (alpha.length === 0) {
        result.push(w);
        lastWasRemoved = false;
        continue;
      }
      if (/\.[a-zA-Z]{2,4}$/.test(w) || (/-/.test(w) && w.length >= 5) || (/\d/.test(w) && w.length >= 3)) {
        result.push(w);
        lastWasRemoved = false;
        continue;
      }
      const vowels = alpha.replace(/[^aeiouAEIOU]/g, '').length;
      const isLikelyNonsense = (
        (alpha.length <= 2) ||
        (alpha.length >= 3 && vowels === 0) ||
        (alpha.length <= 4 && vowels / alpha.length < 0.2) ||
        (/^[^aeiouAEIOU]{3,}/i.test(alpha) && alpha.length <= 5) ||
        /[^aeiouAEIOU]{4,}$/i.test(alpha)
      );
      if (isLikelyNonsense) {
        if (!lastWasRemoved) result.push('---');
        lastWasRemoved = true;
      } else {
        result.push(w);
        lastWasRemoved = false;
      }
    }
    text = result.join(' ');
  }

  // Step E: Restore preserved timestamps
  for (const [placeholder, ts] of Object.entries(placeholderMap)) {
    text = text.replace(new RegExp(placeholder, 'g'), ts);
  }

  // Collapse multiple consecutive delimiters into one
  text = text.replace(/(?:\s*---\s*)+/g, ' --- ');

  // Remove leading/trailing delimiters and collapse whitespace
  text = text.replace(/^\s*---\s*/, '').replace(/\s*---\s*$/, '');
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

function additionalCleanup(text) {
  // Remove square-bracketed log tags like [INFO], [DEBUG] etc.
  text = text.replace(/\[(?:INFO|DEBUG|WARN|ERROR|TRACE)\]/gi, '');
  // Remove emoji and miscellaneous symbols
  text = text.replace(/[\u2190-\u21FF\u2300-\u27BF\u2600-\u26FF\u2700-\u27BF\u2B50-\u2BFF\ud83c-\ud83e][\ufe0f]*/g, '');
  // Remove excessive whitespace and blank lines
  text = text.replace(/\s+/g, ' ').replace(/(\r?\n){2,}/g, '\n');
  return text.trim();
}

// --- OCR Service Class ---

class OCRService {
  constructor() {
    this.worker = null;
    this.isInitialized = false;
    this.lastTextHash = null;
  }

  /**
   * Initialize the Tesseract worker.
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      logger.info('Initializing Tesseract OCR worker...');
      this.worker = await Tesseract.createWorker('eng', 1, {
        logger: () => {} // suppress tesseract logs
      });
      this.isInitialized = true;
      logger.info('Tesseract OCR worker initialized');
    } catch (error) {
      logger.error('Failed to initialize Tesseract OCR', { error: error.message });
      throw error;
    }
  }

  /**
   * Run OCR on a screenshot buffer.
   * Returns the raw extracted text and confidence.
   */
  async extractText(imageBuffer) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const startTime = Date.now();
      const { data } = await this.worker.recognize(imageBuffer);
      const elapsed = Date.now() - startTime;

      const rawText = data.text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n')
        .trim();

      logger.debug('OCR completed', {
        elapsed,
        confidence: data.confidence,
        textLength: rawText.length
      });

      return {
        text: rawText,
        confidence: data.confidence,
        elapsed
      };
    } catch (error) {
      logger.error('OCR extraction failed', { error: error.message });
      return { text: '', confidence: 0, elapsed: 0 };
    }
  }

  /**
   * Process raw OCR text through the full cleanup pipeline.
   * Returns cleaned text ready for LLM consumption.
   */
  static cleanText(rawOcrText) {
    // Step 1: Normalize and sanitize
    const cleaned = cleanOcrText(rawOcrText);

    // Step 2: Additional cleanup (remove log tags, emoji, etc.)
    const additionalCleaned = additionalCleanup(cleaned);

    // Step 3: Filter out gibberish OCR noise
    const filtered = filterGibberish(additionalCleaned);

    return filtered;
  }

  /**
   * Full pipeline: extract text from image buffer and clean it.
   * This is the main method for the StateGraph node.
   */
  async extractAndClean(imageBuffer) {
    const { text: rawText, confidence, elapsed } = await this.extractText(imageBuffer);

    if (!rawText || rawText.length === 0) {
      return { text: '', confidence: 0, elapsed };
    }

    const cleanedText = OCRService.cleanText(rawText);

    return {
      text: cleanedText,
      rawText,
      confidence,
      elapsed
    };
  }

  /**
   * Check if OCR text is different from the last capture.
   * Uses SHA-256 hash comparison.
   */
  checkTextChanged(text) {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const isDifferent = hash !== this.lastTextHash;
    this.lastTextHash = hash;
    return { isDifferent, hash };
  }

  /**
   * Shut down the Tesseract worker.
   */
  async terminate() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      logger.info('Tesseract OCR worker terminated');
    }
  }
}

let instance = null;

export function getOCRService() {
  if (!instance) {
    instance = new OCRService();
  }
  return instance;
}

export default OCRService;
