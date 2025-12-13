require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const axios = require('axios');
const { AlipaySdk } = require('alipay-sdk');
const cron = require('node-cron');

const app = express();
const PORT = 8080;
const CPP_SERVICE_URL = 'http://127.0.0.1:9000';

// --- 支付宝 SDK 初始化 ---
const alipaySdk = new AlipaySdk({
    appId: process.env.ALIPAY_APP_ID,
    privateKey: process.env.ALIPAY_PRIVATE_KEY,
    alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY,
    gateway: process.env.ALIPAY_GATEWAY,
    signType: 'RSA2',
    camelcase: true,
});

// --- 目录配置 ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const CLIENT_DIST_DIR = path.join(__dirname, 'client/dist');

// 确保目录存在
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- 定时清理任务 (每天凌晨 03:00 执行) ---
cron.schedule('0 3 * * *', () => {
    console.log('[Cron] 开始执行每日清理任务...');
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const oldFiles = db.prepare('SELECT * FROM files WHERE createdAt < ?').all(oneDayAgo.toISOString());

    if (oldFiles.length === 0) {
        console.log('[Cron] 没有过期文件需要清理。');
        return;
    }

    let deletedCount = 0;
    oldFiles.forEach(file => {
        if (file.uploadPath && fs.existsSync(file.uploadPath)) {
            try { fs.unlinkSync(file.uploadPath); } catch (e) { console.error(`Failed to delete source: ${e.message}`); }
        }
        if (file.outputPath && fs.existsSync(file.outputPath)) {
            try { fs.unlinkSync(file.outputPath); } catch (e) { console.error(`Failed to delete output: ${e.message}`); }
        }
        if (file.previewFilePath && fs.existsSync(file.previewFilePath)) {
            try { fs.unlinkSync(file.previewFilePath); } catch (e) { console.error(`Failed to delete preview: ${e.message}`); }
        }
        deletedCount++;
    });

    const deleteStmt = db.prepare('DELETE FROM files WHERE createdAt < ?');
    const result = deleteStmt.run(oneDayAgo.toISOString());

    console.log(`[Cron] 清理完成。物理删除文件: ${deletedCount} 个，数据库清理记录: ${result.changes} 条。`);
});

// --- 中间件 ---
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `${uuidv4()}${ext}`);
        }
    }),
    limits: { fileSize: 50 * 1024 * 1024 }
});

// --- API 接口 ---

// 1. 原始文件上传
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });

    const fileId = path.parse(req.file.filename).name;

    // --- 【修复代码 START】 ---
    // Multer 有时会以 Latin-1 编码读取 UTF-8 文件名，导致乱码。
    // 这里将其转换回 Buffer，再用 utf8 读取。
    let safeOriginalName = req.file.originalname;
    try {
        safeOriginalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    } catch (e) {
        console.warn('Filename encoding fix failed, using original:', e);
    }
    // --- 【修复代码 END】 ---

    try {
        db.prepare(`
            INSERT INTO files (id, originalName, storedName, uploadPath, size, mimeType, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            fileId,
            safeOriginalName, // 使用修复后的名字
            req.file.filename,
            req.file.path,
            req.file.size,
            req.file.mimetype,
            new Date().toISOString()
        );

        res.json({ success: true, fileId });
    } catch (err) {
        console.error('DB Error:', err);
        res.status(500).json({ error: 'Database initialization failed' });
    }
});

// 2. 核心处理
app.post('/api/process', async (req, res) => {
    const { fileId, algorithm, customWatermarkText } = req.body;

    // --- 安全验证 START ---
    if (customWatermarkText) {
        // 包含: < > : " / \ | ? * 以及 ASCII 0-31 (控制字符)
        const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/;

        if (INVALID_FILENAME_CHARS.test(customWatermarkText)) {
            return res.status(400).json({
                error: '水印内容包含非法字符，无法用于生成文件名 (禁止使用: < > : " / \\ | ? *)'
            });
        }
        if (customWatermarkText.length > 50) {
            return res.status(400).json({ error: '水印内容过长 (最多50字符)' });
        }
    }
    // --- 安全验证 END ---

    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    // --- 【修复方案】 ---
    // 如果算法是 LSB，或者原图是 JPG/JPEG，必须强制转为 PNG，否则水印会被有损压缩抹除
    let outputExt = path.extname(file.originalName) || '.png';

    // 检查是否需要强制转 PNG (LSB算法 必须 PNG)
    const isLossyFormat = ['.jpg', '.jpeg', '.webp'].includes(outputExt.toLowerCase());
    if (algorithm.startsWith('LSB') || isLossyFormat) {
        outputExt = '.png';
    }

    const processedFilename = `watermarked_${fileId}${outputExt}`;
    // -------------------
    const finalOutputPath = path.resolve(path.join(OUTPUT_DIR, processedFilename));
    const watermarkData = customWatermarkText || `USER-${fileId.substring(0, 6).toUpperCase()}`;

    try {
        console.log(`[Node] Calling C++ Service for ${algorithm}. Output: ${finalOutputPath}`);

        const cppResponse = await axios.post(`${CPP_SERVICE_URL}/process`, {
            inputPath: path.resolve(file.uploadPath),
            outputPath: finalOutputPath,
            algorithm: algorithm,
            watermarkData: watermarkData
        });

        if (cppResponse.data.success) {
            const { success, previewPath, ...evidenceData } = cppResponse.data;
            const evidenceJson = JSON.stringify(evidenceData);
            const absolutePreviewPath = previewPath ? path.resolve(previewPath) : null;

            db.prepare(`
                UPDATE files 
                SET processedName = ?, outputPath = ?, algorithmResult = ?, customWatermarkText = ?, previewFilePath = ? 
                WHERE id = ?
            `).run(processedFilename, finalOutputPath, evidenceJson, watermarkData, absolutePreviewPath, fileId);

            res.json({
                success: true,
                previewUrl: `/api/preview/${fileId}`,
                ...evidenceData
            });
        } else {
            throw new Error(cppResponse.data.error || 'Algorithm computation failed');
        }

    } catch (err) {
        console.error('Processing Error:', err.message);
        if (err.code === 'ECONNREFUSED') {
            return res.status(503).json({ error: 'AI 核心引擎未启动 (Port 9000 Unreachable)' });
        }
        res.status(500).json({ error: 'Processing failed: ' + (err.response?.data?.error || err.message) });
    }
});

// 3. 预览图片
app.get('/api/preview/:id', (req, res) => {
    const file = db.prepare('SELECT previewFilePath, outputPath FROM files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).send('File not found');

    let targetPath = file.previewFilePath;
    if (!targetPath || !fs.existsSync(targetPath)) {
        targetPath = file.outputPath;
    }

    if (targetPath && fs.existsSync(targetPath)) {
        res.sendFile(path.resolve(targetPath));
    } else {
        res.status(404).send('Preview image generation failed');
    }
});

// 4. 发起支付
app.post('/api/pay', async (req, res) => {
    const { fileId } = req.body;
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const outTradeNo = `${fileId}_${Date.now()}`;
    const amount = '4.99';

    try {
        const result = await alipaySdk.pageExec('alipay.trade.page.pay', {
            method: 'POST',
            bizContent: {
                out_trade_no: outTradeNo,
                product_code: 'FAST_INSTANT_TRADE_PAY',
                total_amount: amount,
                subject: 'Image Sentinel Pro Analysis',
                body: `File: ${file.originalName}`,
            },
            returnUrl: `${process.env.SERVER_HOST}/?status=paid&fileId=${fileId}`,
            notifyUrl: `${process.env.SERVER_HOST}/api/payment/notify`,
        });

        res.json({ success: true, formHtml: result });
    } catch (err) {
        console.error('Alipay Error:', err);
        res.status(500).json({ error: 'Payment initialization failed' });
    }
});

// 5. 支付宝回调
app.post('/api/payment/notify', (req, res) => {
    const params = req.body;
    try {
        const checkResult = alipaySdk.checkNotifySign(params);
        if (checkResult && ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(params.trade_status)) {
            const fileId = params.out_trade_no.split('_')[0];
            db.prepare('UPDATE files SET isPaid = 1 WHERE id = ?').run(fileId);
            res.send('success');
        } else {
            res.send('fail');
        }
    } catch (e) {
        console.error("Alipay Notify Error", e);
        res.send('fail');
    }
});

// 6. 最终下载
app.get('/api/download/:id', (req, res) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).send('File not found');

    if (file.isPaid !== 1) return res.status(403).send('Payment required to download full resolution report');

    const ext = path.extname(file.originalName);
    let baseName = path.basename(file.originalName, ext);

    // 清理旧前缀
    baseName = baseName.replace(/^(Sentinel_Protected_)+/, '');

    // 构建水印后缀
    let watermarkSuffix = '';
    if (file.customWatermarkText) {
        watermarkSuffix = `_${file.customWatermarkText}`;
    }

    const finalFileName = `${baseName}${watermarkSuffix}${ext}`;

    // --- 【下载头优化 START】 ---
    const encodedFileName = encodeURIComponent(finalFileName);

    // 1. Access-Control-Expose-Headers: 允许前端获取文件名 (如果是 AJAX 下载)
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    // 2. 规范的 Content-Disposition:
    // filename: 设置一个默认名（避免旧浏览器乱码，虽然现在很少见）
    // filename*: RFC 5987 标准，现代浏览器优先读取这个
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="download${ext}"; filename*=UTF-8''${encodedFileName}`
    );
    // --- 【下载头优化 END】 ---

    res.sendFile(file.outputPath, (err) => {
        if (err) {
            console.error('Download error:', err);
            if (!res.headersSent) res.status(500).send('Download failed');
        }
    });
});

// 7. 免费流程：文件上传
app.post('/api/upload_verify', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });
    const fileId = path.parse(req.file.filename).name;

    try {
        db.prepare(`
            INSERT INTO files (id, originalName, storedName, uploadPath, size, mimeType, isPaid, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, -1, ?)
        `).run(fileId, req.file.originalname, req.file.filename, req.file.path, req.file.size, req.file.mimetype, new Date().toISOString());

        res.json({ success: true, fileId });
    } catch (err) {
        console.error('DB Error:', err);
        res.status(500).json({ error: 'Database initialization failed' });
    }
});

// 8. 免费流程：水印验证
app.post('/api/verify_watermark_free', async (req, res) => {
    const { fileId } = req.body;
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    let targetPath = file.uploadPath;
    if (file.outputPath && fs.existsSync(file.outputPath)) {
        targetPath = file.outputPath;
    }

    try {
        const cppResponse = await axios.post(`${CPP_SERVICE_URL}/verify`, {
            inputPath: path.resolve(targetPath)
        });

        if (cppResponse.data.success) {
            res.json({
                success: true,
                found: true,
                extractedText: cppResponse.data.extractedText,
                confidenceScore: cppResponse.data.confidenceScore
            });
        } else {
            res.json({
                success: true,
                found: false,
                extractedText: null,
                confidenceScore: 0,
                message: "未检测到有效数字水印"
            });
        }
    } catch (err) {
        console.error('Verification Error:', err.message);
        res.status(500).json({ error: 'System error: ' + (err.response?.data?.error || err.message) });
    }
});

// 9. 前端托管
app.use(express.static(CLIENT_DIST_DIR));
app.get('*', (req, res) => {
    const indexHtml = path.join(CLIENT_DIST_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
    else res.send('Frontend is building...');
});

// 服务器启动
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Cron job scheduled for daily cleanup.`);
});