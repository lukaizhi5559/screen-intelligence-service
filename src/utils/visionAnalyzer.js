/**
 * Vision Analyzer - GPT-4o Vision for Screen Understanding
 * 
 * ⚠️ DEPRECATED: This analyzer is being phased out in favor of local vision models.
 * Use SemanticAnalyzer (OWLv2 + OCR + DuckDB) for streaming vision instead.
 * 
 * This file is kept for backward compatibility only.
 * 
 * Uses OpenAI's GPT-4o vision model to analyze screenshots
 * and extract structured information about screen content.
 */

import { screen } from '@nut-tree-fork/nut-js';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import sharp from 'sharp';

const execAsync = promisify(exec);

export class VisionAnalyzer {
  constructor() {
    this.provider = process.env.VISION_PROVIDER || 'openai';
    this.model = process.env.VISION_MODEL || 'gpt-4o';
    this.apiKey = process.env.OPENAI_API_KEY;
    this.enabled = !!this.apiKey;
    
    console.log(`🔍 [VISION] Initialized: ${this.enabled ? 'ENABLED' : 'DISABLED'}`);
    if (this.enabled) {
      console.log(`🔍 [VISION] Provider: ${this.provider}, Model: ${this.model}`);
    }
  }

  /**
   * Analyze screen using GPT-4o vision
   * @param {string} query - User's query about the screen
   * @param {Buffer} screenshotBuffer - Optional screenshot buffer (if already captured)
   * @returns {Promise<Object>}
   */
  async analyzeScreen(query = 'Analyze this screen', screenshotBuffer = null) {
    if (!this.enabled) {
      throw new Error('Vision API not configured - OPENAI_API_KEY missing');
    }

    const startTime = Date.now();
    console.log(`🔍 [VISION] Starting analysis: "${query.substring(0, 50)}..."`);

    try {
      // 1. Capture screenshot if not provided
      let imageBuffer = screenshotBuffer;
      if (!imageBuffer) {
        console.log('📸 [VISION] Capturing screenshot...');
        const tempFile = `/tmp/vision-screenshot-${Date.now()}.png`;
        
        // Determine capture strategy based on query
        const queryLower = query.toLowerCase();
        const isDesktopQuery = /\b(desktop|file|folder|icon|finder)\b/i.test(queryLower);
        
        if (isDesktopQuery) {
          // For desktop queries, capture full screen to see desktop files
          console.log('📸 [VISION] Desktop query detected - capturing full screen');
          await execAsync(`screencapture -x "${tempFile}"`);
        } else {
          // For app-specific queries, try to capture frontmost window only (excludes overlays)
          try {
            // Get the frontmost window ID and capture just that window
            const { stdout: windowId } = await execAsync(`osascript -e 'tell application "System Events" to get id of first window of (first process whose frontmost is true)'`);
            
            if (windowId && windowId.trim()) {
              // Capture specific window by ID (excludes floating overlays)
              await execAsync(`screencapture -x -l ${windowId.trim()} "${tempFile}"`);
              console.log('📸 [VISION] Captured frontmost window only (excluding overlays)');
            } else {
              throw new Error('No window ID found');
            }
          } catch (windowError) {
            // Fallback to full screen if window capture fails
            console.warn('⚠️ [VISION] Window capture failed, using full screen:', windowError.message);
            await execAsync(`screencapture -x "${tempFile}"`);
          }
        }
        
        imageBuffer = await fs.readFile(tempFile);
        await fs.unlink(tempFile).catch(() => {});
      }
      
      // Compress image to reduce API call time and cost
      console.log(`📸 [VISION] Original screenshot size: ${Math.round(imageBuffer.length / 1024)}KB`);
      imageBuffer = await sharp(imageBuffer)
        .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      console.log(`📸 [VISION] Compressed screenshot size: ${Math.round(imageBuffer.length / 1024)}KB`);
      
      const base64Image = imageBuffer.toString('base64');
      console.log(`📸 [VISION] Screenshot captured (${Math.round(base64Image.length / 1024)}KB)`);

      // 2. Build prompt for structured extraction
      const systemPrompt = `Extract visible screen content as JSON. Be thorough but concise.

Return ONLY valid JSON (no markdown):
{
  "summary": "Brief description",
  "app": "Active application name",
  "windowTitle": "Window title if visible",
  "url": "Browser URL if applicable, else null",
  "emails": [
    {"from": "Sender", "subject": "Subject", "time": "Time"}
  ],
  "desktopFiles": ["file1.txt", "folder2"],
  "openFiles": ["doc.pdf", "report.xlsx"],
  "browserTabs": ["Tab 1", "Tab 2"],
  "mainContent": "Primary text content visible",
  "numbers": ["2,641", "$100"],
  "time": "Current time if visible",
  "other": "Any other important visible content"
}

RULES:
- For Gmail/email: extract ALL visible email senders, subjects, times
- For desktop: list ALL visible files/folders with extensions
- For browsers: list visible tab titles
- Preserve exact formatting of numbers
- Use null for missing fields, [] for empty arrays
- Never truncate or summarize - include full text
- IGNORE chat overlays - focus on main content`;

      const userPrompt = `User query: "${query}"

IGNORE any chat bubbles, message windows, or AI assistant overlays.
Look THROUGH them to analyze the REAL underlying content (browser, email, documents, desktop, etc.).
Pay special attention to:
- Open documents, PDFs, spreadsheets, presentations
- Charts, graphs, dashboards, screenshots-within-screenshots
- File lists and extensions
- Browser URLs and tab titles
- Desktop icons (check background edges carefully)

Return ONLY the JSON. No explanations. No markdown.`;

      // 3. Call OpenAI GPT-4o Vision API
      console.log('🌐 [VISION] Calling OpenAI API...');
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: this.model,
          max_tokens: 1200, // Reduced for faster response
          temperature: 0.1, // Low temperature for accuracy
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: userPrompt
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${base64Image}`,
                    detail: 'high' // High detail for better accuracy
                  }
                }
              ]
            }
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000 // 60 second timeout for large images
        }
      );

      const rawResponse = response.data.choices[0].message.content;
      console.log(`✅ [VISION] API response received (${rawResponse.length} chars)`);

      // 4. Parse JSON response
      let visionData;
      try {
        // Remove markdown code blocks if present
        const jsonMatch = rawResponse.match(/```json\n?([\s\S]*?)\n?```/) || 
                         rawResponse.match(/```\n?([\s\S]*?)\n?```/);
        const jsonText = jsonMatch ? jsonMatch[1] : rawResponse;
        visionData = JSON.parse(jsonText);
      } catch (parseError) {
        console.warn('⚠️ [VISION] Failed to parse JSON, using raw text');
        visionData = {
          summary: rawResponse,
          mainContent: rawResponse,
          numbers: [],
          emails: [],
          uiElements: [],
          keyInfo: {}
        };
      }

      const elapsed = Date.now() - startTime;
      console.log(`✅ [VISION] Analysis complete (${elapsed}ms)`);
      console.log(`📊 [VISION] Extracted: ${visionData.numbers?.length || 0} numbers, ${visionData.emails?.length || 0} emails`);

      return {
        success: true,
        visionData,
        rawResponse,
        model: this.model,
        provider: this.provider,
        elapsed
      };

    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(`❌ [VISION] Analysis failed (${elapsed}ms):`, error.message);
      
      if (error.response) {
        console.error('❌ [VISION] API error:', error.response.status, error.response.data);
        throw new Error(`Vision API error: ${error.response.data?.error?.message || error.response.statusText}`);
      }
      
      throw error;
    }
  }

  /**
   * Format vision data as text for LLM context
   * @param {Object} visionData - Parsed vision response
   * @returns {string}
   */
  formatAsText(visionData) {
    const parts = [];
    
    // Summary & App
    if (visionData.summary) {
      parts.push(`Summary: ${visionData.summary}`);
    }
    
    if (visionData.app) {
      parts.push(`Application: ${visionData.app}`);
    }
    
    if (visionData.windowTitle) {
      parts.push(`Window: ${visionData.windowTitle}`);
    }
    
    if (visionData.url) {
      parts.push(`URL: ${visionData.url}`);
    }
    
    // Emails
    if (visionData.emails && visionData.emails.length > 0) {
      parts.push(`\nEmails:`);
      visionData.emails.forEach((email, idx) => {
        if (typeof email === 'string') {
          parts.push(`${idx + 1}. ${email}`);
        } else {
          parts.push(`${idx + 1}. From: ${email.from}`);
          parts.push(`   Subject: ${email.subject}`);
          parts.push(`   Time: ${email.time}`);
        }
      });
    }
    
    // Desktop Files
    if (visionData.desktopFiles && visionData.desktopFiles.length > 0) {
      parts.push(`\nDesktop Files:`);
      visionData.desktopFiles.forEach((file, idx) => {
        parts.push(`${idx + 1}. ${file}`);
      });
    }
    
    // Open Files
    if (visionData.openFiles && visionData.openFiles.length > 0) {
      parts.push(`\nOpen Files:`);
      visionData.openFiles.forEach((file, idx) => {
        parts.push(`${idx + 1}. ${file}`);
      });
    }
    
    // Browser Tabs
    if (visionData.browserTabs && visionData.browserTabs.length > 0) {
      parts.push(`\nBrowser Tabs:`);
      visionData.browserTabs.forEach((tab, idx) => {
        parts.push(`${idx + 1}. ${tab}`);
      });
    }
    
    // Main Content
    if (visionData.mainContent) {
      parts.push(`\nContent:\n${visionData.mainContent}`);
    }
    
    // Numbers
    if (visionData.numbers && visionData.numbers.length > 0) {
      parts.push(`\nNumbers: ${visionData.numbers.join(', ')}`);
    }
    
    // Time
    if (visionData.time) {
      parts.push(`\nTime: ${visionData.time}`);
    }
    
    // Other
    if (visionData.other) {
      parts.push(`\nOther: ${visionData.other}`);
    }
    
    return parts.join('\n');
  }
}
