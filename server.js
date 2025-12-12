require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const axios = require('axios'); // [新增] 用于调用 C++ 服务

// 引入支付宝 SDK
const { AlipaySdk } = require('alipay-sdk');

const app = express();
const PORT = 8080;

// [新增] C++ 核心微服务地址 (内网环回地址，速度快且安全)
const CPP_SERVICE_URL = 'http://127.0.0.1:9000';

// --- 支付宝初始化 ---
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

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// --- 中间件 ---
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${uuidv4()}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }
});

// --- API 接口 ---

// 1. 上传
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
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. 处理 (已修改：调用真实 C++ 微服务)
app.post('/api/process', async (req, res) => {
    const { fileId, algorithm } = req.body;

    // 1. 从数据库获取文件信息
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    // 2. 定义输出文件名和路径
    // 注意：确保后缀名与 C++ 输出一致 (通常是 .png 或保持原格式)
    const processedFilename = `processed_${fileId}_${algorithm}.png`;
    const outputPath = path.join(OUTPUT_DIR, processedFilename);

    try {
        console.log(`[Node] Calling C++ Service for ${fileId} using ${algorithm}...`);

        // 3. 发起 HTTP 请求给 C++ 服务
        // 关键点：必须使用 path.resolve 将路径转换为绝对路径，因为 C++ 服务不知道 Node 的相对路径上下文
        const cppResponse = await axios.post(`${CPP_SERVICE_URL}/process`, {
            inputPath: path.resolve(file.uploadPath),
            outputPath: path.resolve(outputPath),
            algorithm: algorithm
        });

        // 4. 检查 C++ 服务返回的结果
        if (cppResponse.data.success) {
            // C++ 处理成功，更新数据库
            db.prepare('UPDATE files SET processedName = ?, outputPath = ? WHERE id = ?')
                .run(processedFilename, outputPath, fileId);

            // 返回预览 URL
            res.json({ success: true, previewUrl: `/api/preview/${fileId}` });
        } else {
            // C++ 服务逻辑报错 (如 OpenCV 读取失败)
            throw new Error(cppResponse.data.error || 'Unknown C++ Service Error');
        }

    } catch (err) {
        console.error('Processing Error:', err.message);

        // 区分错误类型
        if (err.code === 'ECONNREFUSED') {
            return res.status(503).json({ error: '核心算法服务未启动，请联系管理员' });
        }

        res.status(500).json({
            error: '图像处理失败: ' + (err.response?.data?.error || err.message)
        });
    }
});

// 3. 预览
app.get('/api/preview/:id', (req, res) => {
    const file = db.prepare('SELECT outputPath FROM files WHERE id = ?').get(req.params.id);
    if (!file || !file.outputPath) return res.status(404).send('Not found');
    res.sendFile(file.outputPath);
});

// 4. 发起支付
app.post('/api/pay', async (req, res) => {
    const { fileId } = req.body;
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const outTradeNo = `${fileId}_${Date.now()}`;

    try {
        // 使用 pageExec 生成支付表单 HTML
        const result = await alipaySdk.pageExec('alipay.trade.page.pay', {
            method: 'POST',
            bizContent: {
                out_trade_no: outTradeNo,
                product_code: 'FAST_INSTANT_TRADE_PAY',
                total_amount: '0.10',
                subject: 'Image Sentinel Service',
                body: `File ID: ${fileId}`,
            },
            returnUrl: `${process.env.SERVER_HOST}/?status=paid&fileId=${fileId}`,
            notifyUrl: `${process.env.SERVER_HOST}/api/payment/notify`,
        });

        res.json({ success: true, formHtml: result });

    } catch (err) {
        console.error('Alipay Error:', err);
        res.status(500).json({ error: '支付发起失败: ' + err.message });
    }
});

// 5. 支付宝异步通知
app.post('/api/payment/notify', (req, res) => {
    const params = req.body;
    console.log('Received Alipay Notify:', params);

    // 验签
    const checkResult = alipaySdk.checkNotifySign(params);

    if (checkResult) {
        const outTradeNo = params.out_trade_no;
        const tradeStatus = params.trade_status;

        if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
            const fileId = outTradeNo.split('_')[0];
            db.prepare('UPDATE files SET isPaid = 1 WHERE id = ?').run(fileId);
        }
        res.send('success');
    } else {
        console.error('Alipay Verify Failed');
        res.send('fail');
    }
});

// 6. 下载
app.get('/api/download/:id', (req, res) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).send('文件不存在');
    if (file.isPaid !== 1) return res.status(403).send('请先支付费用');

    // 下载时使用原始文件名加前缀
    res.download(file.outputPath, `Sentinel_${file.originalName}`);
});

// 前端托管
app.use(express.static(CLIENT_DIST_DIR));
app.get('*', (req, res) => {
    const indexHtml = path.join(CLIENT_DIST_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
    else res.send('Frontend building...');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});