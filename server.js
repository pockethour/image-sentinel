require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

// ⬇️⬇️⬇️ 修复点：只引入核心 SDK，移除报错的 lib/form ⬇️⬇️⬇️
const { AlipaySdk } = require('alipay-sdk');
// ⬆️⬆️⬆️ 移除结束 ⬆️⬆️⬆️

const app = express();
const PORT = 8080;

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

// 2. 处理 (模拟)
app.post('/api/process', async (req, res) => {
    const { fileId, algorithm } = req.body;
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const processedFilename = `processed_${file.storedName}`;
    const outputPath = path.join(OUTPUT_DIR, processedFilename);

    // 模拟 C++ 处理耗时
    await new Promise(resolve => setTimeout(resolve, 1000));
    fs.copyFileSync(file.uploadPath, outputPath);

    db.prepare('UPDATE files SET processedName = ?, outputPath = ? WHERE id = ?')
        .run(processedFilename, outputPath, fileId);

    res.json({ success: true, previewUrl: `/api/preview/${fileId}` });
});

// 3. 预览
app.get('/api/preview/:id', (req, res) => {
    const file = db.prepare('SELECT outputPath FROM files WHERE id = ?').get(req.params.id);
    if (!file || !file.outputPath) return res.status(404).send('Not found');
    res.sendFile(file.outputPath);
});

// 4. 【核心】发起支付 (已修复：使用 pageExec)
app.post('/api/pay', async (req, res) => {
    const { fileId } = req.body;
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const outTradeNo = `${fileId}_${Date.now()}`;

    try {
        // ⬇️⬇️⬇️ 修复点：改用 pageExec，不需要手动创建 FormData ⬇️⬇️⬇️
        const result = await alipaySdk.pageExec('alipay.trade.page.pay', {
            method: 'POST', // 指定 POST，SDK 会自动生成 HTML 表单
            bizContent: {
                out_trade_no: outTradeNo,
                product_code: 'FAST_INSTANT_TRADE_PAY',
                total_amount: '0.10',
                subject: 'Image Sentinel Service',
                body: `File ID: ${fileId}`,
            },
            // 顶层参数直接放在这里
            returnUrl: `${process.env.SERVER_HOST}/?status=paid&fileId=${fileId}`,
            notifyUrl: `${process.env.SERVER_HOST}/api/payment/notify`,
        });

        // result 直接就是 HTML 表单字符串
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


// ⬇️⬇️⬇️ 自定义 AlipayFormData 类 (解决 import 报错) ⬇️⬇️⬇️
// 这是一个简单的 Mock 类，完全兼容 SDK 的要求
class AlipayFormData {
    constructor() {
        this.method = 'post';
        this.fields = [];
        this.files = [];
    }

    setMethod(method) {
        this.method = method;
    }

    addField(name, value) {
        this.fields.push({ name, value });
    }

    getFields() {
        return this.fields;
    }

    getMethod() {
        return this.method;
    }

    // 虽然 Page Pay 用不到文件上传，但为了完整性加上
    addFile(name, file) {
        this.files.push({ name, file });
    }

    getFiles() {
        return this.files;
    }
}
// ⬆️⬆️⬆️ 定义结束 ⬆️⬆️⬆️