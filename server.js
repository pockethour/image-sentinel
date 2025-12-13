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

// 1. 上传文件
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });
    
    const fileId = path.parse(req.file.filename).name;
    
    try {
        // 插入初始记录
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

// 2. 核心处理 (调用 C++)
app.post('/api/process', async (req, res) => {
    const { fileId, algorithm } = req.body;
    
    // 1. 获取文件记录
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    // 2. 准备输出路径
    const processedFilename = `processed_${fileId}_${algorithm}.png`;
    const outputPath = path.join(OUTPUT_DIR, processedFilename);
    // 生成一个用于嵌入的模拟 ID (生产环境应来自用户账户)
    const watermarkData = `USER-${fileId.substring(0, 6).toUpperCase()}`;

    try {
        console.log(`[Node] Calling C++ Service for ${algorithm}...`);

        // 3. 调用 C++ 微服务
        const cppResponse = await axios.post(`${CPP_SERVICE_URL}/process`, {
            inputPath: path.resolve(file.uploadPath),
            outputPath: path.resolve(outputPath),
            algorithm: algorithm,
            watermarkData: watermarkData
        });

        // 4. 处理 C++ 响应
        if (cppResponse.data.success) {
            // [关键] 提取 C++ 返回的业务数据 (score, extractedId, riskLevel 等)
            // 这里的 ...evidenceData 是 ES6 剩余参数语法，表示"除了success之外的所有字段"
            const { success, ...evidenceData } = cppResponse.data;

            // 将证据数据序列化存入数据库 (确保 database.js 中已创建 algorithmResult 列)
            // 如果您的 DB 尚未更新结构，请先在 DB 中执行: ALTER TABLE files ADD COLUMN algorithmResult TEXT;
            const evidenceJson = JSON.stringify(evidenceData);

            db.prepare(`
                UPDATE files 
                SET processedName = ?, outputPath = ?, algorithmResult = ? 
                WHERE id = ?
            `).run(processedFilename, outputPath, evidenceJson, fileId);

            // 将所有证据数据返回给前端，用于渲染"证据卡片"
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
    const file = db.prepare('SELECT outputPath FROM files WHERE id = ?').get(req.params.id);
    if (!file || !file.outputPath || !fs.existsSync(file.outputPath)) {
        return res.status(404).send('Preview image not found');
    }
    res.sendFile(file.outputPath);
});

// 4. 发起支付
app.post('/api/pay', async (req, res) => {
    const { fileId } = req.body;
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const outTradeNo = `${fileId}_${Date.now()}`;
    // 定价策略：提升价格以显示专业度
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
    
    // 权限校验
    if (file.isPaid !== 1) return res.status(403).send('Payment required to download full resolution report');

    // 下载处理后的文件
    res.download(file.outputPath, `Sentinel_Protected_${file.originalName}`);
});

// 前端托管
app.use(express.static(CLIENT_DIST_DIR));
app.get('*', (req, res) => {
    const indexHtml = path.join(CLIENT_DIST_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
    else res.send('Frontend is building...');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});