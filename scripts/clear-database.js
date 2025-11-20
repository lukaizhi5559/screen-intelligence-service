#!/usr/bin/env node

/**
 * Clear DuckDB Database
 * 
 * Removes all indexed screen states and UI nodes from the semantic database.
 * Use this to start fresh with clean data.
 */

import duckdb from 'duckdb';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path
const dbPath = path.join(os.homedir(), '.thinkdrop', 'semantic-ui.duckdb');

console.log('🗑️  Clearing DuckDB database...');
console.log(`📁 Database: ${dbPath}`);

const db = new duckdb.Database(dbPath);

db.all(`SELECT COUNT(*) as count FROM ui_nodes`, (err, result) => {
  if (err) {
    console.error('❌ Error reading database:', err);
    process.exit(1);
  }
  
  const beforeCount = result[0].count;
  console.log(`📊 Current nodes: ${beforeCount}`);
  
  // Clear the tables
  db.run(`DELETE FROM ui_nodes`, (err) => {
    if (err) {
      console.error('❌ Error clearing ui_nodes:', err);
      process.exit(1);
    }
    
    console.log('✅ Cleared ui_nodes table');
    
    // Also clear screen_states if it exists
    db.run(`DELETE FROM screen_states`, (err) => {
      if (err && !err.message.includes('does not exist')) {
        console.error('❌ Error clearing screen_states:', err);
        process.exit(1);
      }
      
      if (!err) {
        console.log('✅ Cleared screen_states table');
      }
      
      // Verify
      db.all(`SELECT COUNT(*) as count FROM ui_nodes`, (err, result) => {
        if (err) {
          console.error('❌ Error verifying:', err);
          process.exit(1);
        }
        
        const afterCount = result[0].count;
        console.log(`📊 Nodes after clear: ${afterCount}`);
        console.log(`🎉 Removed ${beforeCount} nodes`);
        console.log('');
        console.log('✅ Database cleared successfully!');
        console.log('');
        console.log('Next steps:');
        console.log('1. Restart the screen-intelligence service');
        console.log('2. Start ScreenWatcher: curl -X POST http://localhost:3008/watcher/start');
        console.log('3. Wait for fresh captures');
        
        db.close();
        process.exit(0);
      });
    });
  });
});
