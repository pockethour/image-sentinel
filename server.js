const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database'); // 引入 SQLite 数据库模块

const app = express();
const PORT = 8080;

// --- 目录配置 ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const CLIENT_DIST_DIR = path.join(__dirname, 'client/dist'); // Vite 构建后的前端目录

// 确保上传和输出目录存在
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
// 客户端 dist 目录将在 npm run build 时生成，这里不强制创建

// --- 中间件 ---
// 允许前端访问 (开发和生产环境通用)
app.use(cors());
app.use(express.json());

// 配置 Multer 上传存储
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        // 安全重命名：UUID + 扩展名，防止文件名注入攻击
        const ext = path.extname(file.originalname);
        cb(null, `${uuidv4()}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 } // 限制 20MB
});


// --- API 接口 ---

// 1. 文件上传
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });

    const fileId = path.parse(req.file.filename).name; // 使用 UUID 作为 ID

    // 将文件信息存入 SQLite 数据库
    const stmt = db.prepare(`
    INSERT INTO files (id, originalName, storedName, uploadPath, size, mimeType, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

    try {
        stmt.run(
            fileId,
            req.file.originalname,
            req.file.filename,
            req.file.path,
            req.file.size,
            req.file.mimetype,
            new Date().toISOString()
        );
        res.json({ success: true, fileId, message: '上传成功' });
    } catch (err) {
        console.error('数据库写入失败:', err);
        res.status(500).json({ error: '数据库写入失败' });
    }
});

// 2. 调用 AI/C++ 处理 (接口预留)
app.post('/api/process', async (req, res) => {
    const { fileId, algorithm } = req.body;

    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    // --- C++ 模拟部分 START ---
    // 这里将替换为你的 C++ 算法调用 (child_process.execFile 或其他)

    const processedFilename = `processed_${file.storedName}`;
    const outputPath = path.join(OUTPUT_DIR, processedFilename);

    console.log(`[C++ Core] 正在处理: ${file.uploadPath} -> 算法: ${algorithm}`);

    // 模拟耗时操作 (2秒)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 模拟生成结果文件 (这里简单复制一下源文件)
    fs.copyFileSync(file.uploadPath, outputPath);
    // --- C++ 模拟部分 END ---

    // 更新数据库，记录处理结果路径
    db.prepare('UPDATE files SET processedName = ?, outputPath = ? WHERE id = ?')
        .run(processedFilename, outputPath, fileId);

    // 返回预览图 URL
    res.json({
        success: true,
        // 预览图链接指向我们的预览接口
        previewUrl: `/api/preview/${fileId}`
    });
});

// 3. 预览图片接口 (无需鉴权，但图片路径必须安全)
app.get('/api/preview/:id', (req, res) => {
    const file = db.prepare('SELECT outputPath FROM files WHERE id = ?').get(req.params.id);

    if (!file || !file.outputPath) return res.status(404).send('Not found');

    // 使用 sendFile 安全地提供文件
    res.sendFile(file.outputPath);
});

// 4. 创建支付订单 (模拟)
app.post('/api/pay', async (req, res) => {
    const { fileId } = req.body;

    // 1. 检查文件是否存在
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    // 2. 真实场景：调用 Stripe/Alipay API 获取 paymentUrl 或 clientSecret

    // 3. 模拟成功：直接标记为已支付
    // **注意：在真实生产环境，isPaid 必须由支付平台 Webhook 回调更新**
    db.prepare('UPDATE files SET isPaid = 1 WHERE id = ?').run(fileId);

    // 返回给前端一个成功信息，前端会根据状态机进入 PAID 状态
    res.json({ success: true, message: '模拟支付成功，请进行下载' });
});

// 5. 安全下载接口
app.get('/api/download/:id', (req, res) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);

    if (!file) return res.status(404).send('文件不存在');

    // 🔒 关键安全检查：检查支付状态和文件路径
    if (file.isPaid !== 1) {
        return res.status(403).send('请先支付费用');
    }
    if (!file.outputPath || !fs.existsSync(file.outputPath)) {
        return res.status(404).send('处理结果文件丢失');
    }

    // 使用 res.download 强制浏览器下载，并设置原始文件名
    res.download(file.outputPath, `Sentinel_${file.originalName}`);
});


// --- 前端静态文件托管 (Vite/React) ---

// 1. 托管静态资源 (CSS, JS, 图像等)
// 只有当运行了 npm run build 之后，client/dist 目录才会存在
app.use(express.static(CLIENT_DIST_DIR));

// 2. 处理所有非 API 请求，返回 index.html (SPA 路由)
// **这必须是最后一个路由，否则会拦截你的 /api/* 请求**
app.get('*', (req, res) => {
    res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html'));
});


app.listen(PORT, () => {
    console.log(`Backend Server running on port ${PORT}`);
    console.log(`Frontend served from: ${CLIENT_DIST_DIR}`);
});