const Database = require('better-sqlite3');
const path = require('path');

// 数据库文件将自动创建在根目录
const db = new Database('sentinel.db', { verbose: console.log });

// 初始化表结构
// 注意：如果您的数据库文件已存在，此处的 CREATE TABLE IF NOT EXISTS 将不会执行。
// 您可能需要手动执行 ALTER TABLE 命令来添加新字段。
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
    createdAt TEXT,
    
    -- [已添加] 存储用户自定义的水印内容
    customWatermarkText TEXT, 
    -- [已添加] 存储 C++ 服务返回的 JSON 证据（如 score, robustness）
    algorithmResult TEXT,
    -- [新增] 存储 C++ 服务生成的**高保真预览图**的精确路径
    previewFilePath TEXT 
  )
`);

module.exports = db;