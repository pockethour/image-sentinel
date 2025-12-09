const Database = require('better-sqlite3');
const path = require('path');

// 数据库文件将自动创建在根目录
const db = new Database('sentinel.db', { verbose: console.log });

// 初始化表结构
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    originalName TEXT,
    storedName TEXT,
    processedName TEXT,
    uploadPath TEXT,
    outputPath TEXT,
    size INTEGER,
    mimeType TEXT,
    isPaid INTEGER DEFAULT 0,
    createdAt TEXT
  )
`);

module.exports = db;