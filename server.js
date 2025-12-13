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

const app = express();
const PORT = 8080;
const CPP_SERVICE_URL = 'http://127.0.0.1:9000';

// --- 支付宝 SDK 初始化 ---
// 警告: 必须确保 .env 文件包含 ALIPAY_APP_ID 等密钥
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
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB 限制
});

// --- API 接口 ---

// 1. 付费流程：原始文件上传
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });

    const fileId = path.parse(req.file.filename).name;

    try {
        db.prepare(`
            INSERT INTO files (id, originalName, storedName, uploadPath, size, mimeType, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(fileId, req.file.originalname, req.file.filename, req.file.path, req.file.size, req.file.mimetype, new Date().toISOString());

        res.json({ success: true, fileId });
    } catch (err) {
        console.error('DB Error:', err);
        res.status(500).json({ error: 'Database initialization failed' });
    }
});

// 2. 付费流程：核心处理 (调用 C++ 嵌入水印并生成预览)
app.post('/api/process', async (req, res) => {
    const { fileId, algorithm, customWatermarkText } = req.body;

    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const processedFilename = `watermarked_${fileId}.png`;
    const finalOutputPath = path.join(OUTPUT_DIR, processedFilename); // 最终下载文件的路径
    const watermarkData = customWatermarkText || `USER-${fileId.substring(0, 6).toUpperCase()}`;

    try {
        console.log(`[Node] Calling C++ Service for ${algorithm}. Data: ${watermarkData}`);

        // 3. 调用 C++ 微服务
        const cppResponse = await axios.post(`${CPP_SERVICE_URL}/process`, {
            inputPath: path.resolve(file.uploadPath),
            outputPath: path.resolve(finalOutputPath), // 最终文件的路径
            algorithm: algorithm,
            watermarkData: watermarkData
        });

        if (cppResponse.data.success) {
            const { success, previewPath, ...evidenceData } = cppResponse.data;
            const evidenceJson = JSON.stringify(evidenceData);

            // 4. 更新数据库，存储预览路径和最终输出路径
            db.prepare(`
                UPDATE files 
                SET processedName = ?, outputPath = ?, algorithmResult = ?, customWatermarkText = ?, previewFilePath = ? 
                WHERE id = ?
            `).run(processedFilename, finalOutputPath, evidenceJson, watermarkData, previewPath, fileId);

            // 返回预览 URL
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

// 3. 预览图片 (修正逻辑：从数据库获取精确路径)
app.get('/api/preview/:id', (req, res) => {
    const file = db.prepare('SELECT previewFilePath FROM files WHERE id = ?').get(req.params.id);

    const finalPath = file && file.previewFilePath ? file.previewFilePath : path.join(OUTPUT_DIR, `${req.params.id}_preview.png`);

    if (!file || !fs.existsSync(finalPath)) {
        console.error(`Preview file not found at: ${finalPath}. DB record: ${JSON.stringify(file)}`);
        return res.status(404).send('Preview image not found');
    }
    res.sendFile(finalPath);
});

// 4. 发起支付
app.post('/api/pay', async (req, res) => {
    const { fileId } = req.body;
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const outTradeNo = `${fileId}_${Date.now()}`;
    const amount = '5.00';

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
    const checkResult = alipaySdk.checkNotifySign(params);

    if (checkResult) {
        if (['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(params.trade_status)) {
            const fileId = params.out_trade_no.split('_')[0];
            db.prepare('UPDATE files SET isPaid = 1 WHERE id = ?').run(fileId);
        }
        res.send('success');
    } else {
        res.send('fail');
    }
});

// 6. 最终下载
app.get('/api/download/:id', (req, res) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).send('File not found');

    if (file.isPaid !== 1) return res.status(403).send('Payment required to download full resolution report');

    res.download(file.outputPath, `Sentinel_Protected_${file.originalName}`);
});

// 7. 免费流程：文件上传（专用于验证）
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

// 8. 免费流程：水印验证/查询接口 (*** 核心修正：智能选择验证目标路径 ***)
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

        // [核心修改]：无论 C++ 返回 true 还是 false，只要 HTTP 请求成功，都视为 API 调用成功
        // 我们通过 extractedText 是否为空来判断有没有水印
        if (cppResponse.data.success) {
            // 情况 A: 成功提取到水印
            res.json({
                success: true,
                found: true, // 明确标记找到了
                extractedText: cppResponse.data.extractedText,
                confidenceScore: cppResponse.data.confidenceScore
            });
        } else {
            // 情况 B: C++ 运行正常，但没发现水印 (Magic Header 不匹配)
            // 不抛出 Error，而是返回正常 JSON，告诉前端“没找到”
            res.json({
                success: true,
                found: false, // 明确标记没找到
                extractedText: null,
                confidenceScore: 0,
                message: "未检测到有效数字水印"
            });
        }

    } catch (err) {
        console.error('Verification Error:', err.message);
        // 只有真正的网络错误或程序崩溃才返回 500
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

// 服务器启动监听
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});