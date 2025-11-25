#!/usr/bin/env node
/**
 * Diagnose DuckDB Bloat
 * Analyzes what's causing the semantic-ui.duckdb file to grow to 107GB
 */

import duckdb from 'duckdb';
import path from 'path';
import os from 'os';
import fs from 'fs';

const dbPath = path.join(os.homedir(), '.thinkdrop', 'semantic-ui.duckdb');

console.log('🔍 Diagnosing DuckDB Bloat');
console.log('=' .repeat(60));
console.log(`Database: ${dbPath}`);
console.log('');

// Check if file exists
if (!fs.existsSync(dbPath)) {
  console.log('✅ Database file does not exist (good!)');
  console.log('   The 107GB file has been deleted.');
  process.exit(0);
}

// Check file size
const stats = fs.statSync(dbPath);
const sizeGB = stats.size / (1024 * 1024 * 1024);
console.log(`📊 Current size: ${sizeGB.toFixed(2)} GB`);
console.log('');

if (sizeGB < 1) {
  console.log('✅ Database size is reasonable (<1GB)');
  process.exit(0);
}

console.log('⚠️  Database is large, analyzing contents...');
console.log('');

// Connect to database
const db = new duckdb.Database(dbPath);
const conn = db.connect();

// Helper to run queries
function query(sql) {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function analyze() {
  try {
    // 1. Check table sizes
    console.log('📊 Table Sizes:');
    console.log('-'.repeat(60));
    
    const tables = await query(`
      SELECT 
        table_name,
        estimated_size
      FROM duckdb_tables()
      WHERE schema_name = 'main'
      ORDER BY estimated_size DESC
    `);
    
    for (const table of tables) {
      const sizeMB = table.estimated_size / (1024 * 1024);
      console.log(`  ${table.table_name}: ${sizeMB.toFixed(2)} MB`);
    }
    console.log('');
    
    // 2. Count records in each table
    console.log('📊 Record Counts:');
    console.log('-'.repeat(60));
    
    const uiNodes = await query('SELECT COUNT(*) as count FROM ui_nodes');
    const screenStates = await query('SELECT COUNT(*) as count FROM ui_screen_states');
    const subtrees = await query('SELECT COUNT(*) as count FROM ui_subtrees');
    
    console.log(`  ui_nodes: ${uiNodes[0].count.toLocaleString()}`);
    console.log(`  ui_screen_states: ${screenStates[0].count.toLocaleString()}`);
    console.log(`  ui_subtrees: ${subtrees[0].count.toLocaleString()}`);
    console.log('');
    
    // 3. Check data age range
    console.log('📊 Data Age Range:');
    console.log('-'.repeat(60));
    
    const ageRange = await query(`
      SELECT 
        MIN(timestamp) as oldest,
        MAX(timestamp) as newest,
        COUNT(DISTINCT DATE_TRUNC('day', to_timestamp(timestamp/1000))) as days_of_data
      FROM ui_screen_states
    `);
    
    if (ageRange[0].oldest) {
      const oldestDate = new Date(ageRange[0].oldest);
      const newestDate = new Date(ageRange[0].newest);
      const ageInDays = (newestDate - oldestDate) / (1000 * 60 * 60 * 24);
      
      console.log(`  Oldest: ${oldestDate.toLocaleString()}`);
      console.log(`  Newest: ${newestDate.toLocaleString()}`);
      console.log(`  Age span: ${ageInDays.toFixed(1)} days`);
      console.log(`  Days with data: ${ageRange[0].days_of_data}`);
    }
    console.log('');
    
    // 4. Check average record size
    console.log('📊 Average Record Sizes:');
    console.log('-'.repeat(60));
    
    const avgNodeSize = (sizeGB * 1024 * 1024 * 1024) / uiNodes[0].count;
    console.log(`  Avg ui_node size: ${avgNodeSize.toFixed(0)} bytes`);
    
    // 5. Check for duplicate or redundant data
    console.log('📊 Potential Issues:');
    console.log('-'.repeat(60));
    
    const duplicates = await query(`
      SELECT COUNT(*) as dup_count
      FROM (
        SELECT text, description, COUNT(*) as cnt
        FROM ui_nodes
        WHERE text IS NOT NULL
        GROUP BY text, description
        HAVING COUNT(*) > 100
      )
    `);
    
    if (duplicates[0].dup_count > 0) {
      console.log(`  ⚠️  Found ${duplicates[0].dup_count} text/description combos with >100 duplicates`);
    }
    
    // 6. Check embedding storage
    const embeddingSize = 384 * 4; // 384 dimensions * 4 bytes per float
    const totalEmbeddingSize = embeddingSize * uiNodes[0].count / (1024 * 1024 * 1024);
    console.log(`  Embeddings: ${totalEmbeddingSize.toFixed(2)} GB (${embeddingSize} bytes × ${uiNodes[0].count.toLocaleString()} nodes)`);
    
    console.log('');
    
    // 7. Recommendations
    console.log('💡 Recommendations:');
    console.log('='.repeat(60));
    
    if (ageInDays > 7) {
      console.log('  ⚠️  Data is older than 7 days - cleanup service may not be running');
      console.log('     Run: curl -X POST http://localhost:3008/cleanup/force');
    }
    
    if (uiNodes[0].count > 1000000) {
      console.log('  ⚠️  Too many UI nodes (>1M) - reduce retention period');
      console.log('     Suggested: 3 days instead of 7 days');
    }
    
    if (totalEmbeddingSize > 50) {
      console.log('  ⚠️  Embeddings are taking up significant space');
      console.log('     Consider: Reduce embedding dimension or retention period');
    }
    
    if (sizeGB > 10) {
      console.log('  🔴 CRITICAL: Database is >10GB - immediate action needed');
      console.log('     1. Delete database: rm ~/.thinkdrop/semantic-ui.duckdb*');
      console.log('     2. Reduce retention: Change uiNodeRetentionDays to 3');
      console.log('     3. Enable aggressive cleanup: cleanupIntervalHours to 2');
    }
    
  } catch (error) {
    console.error('❌ Analysis failed:', error);
  } finally {
    conn.close();
    db.close();
  }
}

analyze();
