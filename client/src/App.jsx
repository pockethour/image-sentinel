import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { FaShieldAlt, FaCloudUploadAlt, FaMagic, FaDownload, FaLock, FaCheckCircle } from 'react-icons/fa';

// 基础 API 路径 (相对路径，由 Nginx/Express 转发)
const API_BASE = '/api';

function App() {
    // --- 状态管理 ---
    const [fileId, setFileId] = useState(null);
    // 状态机: IDLE (空闲) -> UPLOADING (上传中) -> UPLOADED (已上传) -> PROCESSING (处理中) -> READY_PAY (待支付) -> PAID (已支付)
    const [status, setStatus] = useState('IDLE');
    const [previewUrl, setPreviewUrl] = useState(null);
    const [error, setError] = useState('');

    // --- 核心逻辑 1: 检测支付回调 ---
    // 当用户支付完成后，支付宝会将页面重定向回 http://你的域名/?status=paid&fileId=xxx
    useEffect(() => {
        const query = new URLSearchParams(window.location.search);
        const urlStatus = query.get('status');
        const urlFileId = query.get('fileId');

        if (urlStatus === 'paid' && urlFileId) {
            setFileId(urlFileId);
            setStatus('PAID');
            // 可选：清理 URL 栏的参数，让界面更干净
            window.history.replaceState({}, document.title, "/");
        }
    }, []);

    // --- 核心逻辑 2: 文件上传 ---
    const handleFileChange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('image', file);

        setStatus('UPLOADING');
        setError('');

        try {
            const res = await axios.post(`${API_BASE}/upload`, formData);
            if (res.data.success) {
                setFileId(res.data.fileId);
                setStatus('UPLOADED');
            }
        } catch (err) {
            console.error(err);
            setError('上传失败，请检查网络或图片格式');
            setStatus('IDLE');
        }
    };

    // --- 核心逻辑 3: AI 处理调用 ---
    const startProcessing = async (algorithm) => {
        setStatus('PROCESSING');
        setError('');
        try {
            const res = await axios.post(`${API_BASE}/process`, {
                fileId,
                algorithm
            });
            if (res.data.success) {
                // 后端返回的 previewUrl 已经是相对路径
                setPreviewUrl(res.data.previewUrl);
                setStatus('READY_PAY');
            }
        } catch (err) {
            console.error(err);
            setError('处理失败：' + (err.response?.data?.error || '服务器内部错误'));
            setStatus('UPLOADED'); // 回退到已上传状态
        }
    };

    // --- 核心逻辑 4: 发起真实支付宝支付 ---
    const handlePayment = async () => {
        setError('');
        try {
            // 1. 请求后端，获取支付宝 HTML 表单
            const res = await axios.post(`${API_BASE}/pay`, { fileId });

            if (res.data.success && res.data.formHtml) {
                // 2. 自动跳转逻辑
                // 支付宝返回的是一个完整的 HTML (含 <form> 和 <script>document.forms[0].submit()</script>)
                // 直接写入文档流，浏览器会自动执行脚本并跳转
                document.write(res.data.formHtml);
                document.close();
            } else {
                setError('支付初始化异常：未获取到支付表单');
            }
        } catch (err) {
            console.error(err);
            setError('支付发起失败，请稍后重试');
        }
    };

    // --- 核心逻辑 5: 下载文件 ---
    const handleDownload = () => {
        if (!fileId) return;
        // 在新窗口打开下载链接
        window.open(`${API_BASE}/download/${fileId}`, '_blank');
    };

    // --- 辅助：重置流程 ---
    const resetFlow = () => {
        setStatus('IDLE');
        setFileId(null);
        setPreviewUrl(null);
        setError('');
    };

    // --- 渲染界面 ---
    return (
        <div className="min-vh-100 d-flex flex-column">
            {/* 顶部 Hero 区域 */}
            <div className="hero-section text-center">
                <div className="container">
                    <h1 className="display-4 fw-bold mb-3">
                        <FaShieldAlt className="me-3" />
                        图像卫士 Image Sentinel
                    </h1>
                    <p className="lead opacity-75">
                        企业级隐形水印 & 图像防篡改取证服务<br />
                        保护您的创作版权，识别 AI 生成痕迹
                    </p>
                </div>
            </div>

            {/* 主内容区域 */}
            <div className="container flex-grow-1">
                <div className="row justify-content-center">
                    <div className="col-md-8">

                        {/* 错误提示条 */}
                        {error && (
                            <div className="alert alert-danger shadow-sm text-center" role="alert">
                                {error}
                            </div>
                        )}

                        {/* 核心卡片 */}
                        <div className="card p-4 step-card mb-5 bg-white">

                            {/* 状态 1: 上传 / 选择文件 */}
                            {(status === 'IDLE' || status === 'UPLOADED') && (
                                <div className="text-center">
                                    <h3 className="mb-4 text-muted">第一步：上传待保护的图片</h3>

                                    <label className="upload-box w-100 d-block">
                                        <input type="file" hidden onChange={handleFileChange} accept="image/jpeg,image/png" />
                                        {status === 'UPLOADED' ? (
                                            <div className="text-success">
                                                <FaCheckCircle size={50} className="mb-3" />
                                                <h5>文件上传成功！</h5>
                                                <p className="text-muted">点击下方按钮选择服务</p>
                                            </div>
                                        ) : (
                                            <div>
                                                <FaCloudUploadAlt size={50} className="text-primary mb-3" />
                                                <h5 className="text-primary">点击或拖拽上传图片</h5>
                                                <p className="text-secondary small">支持 JPG, PNG (最大 20MB)</p>
                                            </div>
                                        )}
                                    </label>

                                    {/* 状态 2: 选择算法 (仅在文件上传后显示) */}
                                    {status === 'UPLOADED' && (
                                        <div className="mt-4 animate__animated animate__fadeIn">
                                            <h3 className="mb-4">第二步：选择防护服务</h3>
                                            <div className="row g-3">
                                                <div className="col-md-6">
                                                    <button onClick={() => startProcessing('watermark')} className="btn btn-outline-primary w-100 p-4 h-100 border-2">
                                                        <FaLock size={28} className="mb-3" /><br />
                                                        <strong className="fs-5">隐形水印嵌入</strong>
                                                        <p className="small m-0 mt-2 text-muted">肉眼不可见，抗截图压缩，用于版权追踪</p>
                                                    </button>
                                                </div>
                                                <div className="col-md-6">
                                                    <button onClick={() => startProcessing('forensics')} className="btn btn-outline-dark w-100 p-4 h-100 border-2">
                                                        <FaMagic size={28} className="mb-3" /><br />
                                                        <strong className="fs-5">防篡改检测</strong>
                                                        <p className="small m-0 mt-2 text-muted">生成真实性分析报告，识别 Deepfake 痕迹</p>
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* 状态 3: 处理中 Loading */}
                            {(status === 'UPLOADING' || status === 'PROCESSING') && (
                                <div className="text-center py-5">
                                    <div className="spinner-border text-primary" role="status" style={{ width: '3rem', height: '3rem' }}></div>
                                    <p className="mt-3 text-muted fs-5">
                                        {status === 'UPLOADING' ? '正在加密传输...' : 'AI 引擎正在计算 (模拟 C++ 核心)...'}
                                    </p>
                                </div>
                            )}

                            {/* 状态 4: 待支付 (展示预览图) */}
                            {status === 'READY_PAY' && (
                                <div className="text-center animate__animated animate__fadeIn">
                                    <h3 className="mb-3 text-success">
                                        <FaCheckCircle className="me-2" />处理完成！
                                    </h3>

                                    {previewUrl && (
                                        <div className="mb-4 bg-light p-3 rounded">
                                            <p className="text-muted small mb-2">处理结果预览 (低清/带水印)</p>
                                            <img src={previewUrl} alt="Preview" className="img-fluid rounded shadow-sm" style={{ maxHeight: '300px' }} />
                                        </div>
                                    )}

                                    <div className="bg-light p-4 rounded mb-4 border">
                                        <div className="d-flex justify-content-between align-items-center">
                                            <span>服务项目：</span>
                                            <strong>专业版图像防护</strong>
                                        </div>
                                        <hr />
                                        <div className="d-flex justify-content-between align-items-center">
                                            <span className="fs-5">支付金额：</span>
                                            <span className="text-danger fw-bold fs-3">¥ 5.00</span>
                                        </div>
                                        <p className="small text-muted mt-2 mb-0">支付后即可下载全尺寸、无损结果文件</p>
                                    </div>

                                    <button onClick={handlePayment} className="btn btn-success btn-lg w-100 py-3 fw-bold">
                                        立即支付 (支付宝)
                                    </button>
                                    <button onClick={resetFlow} className="btn btn-link text-muted mt-3">
                                        放弃并重新开始
                                    </button>
                                </div>
                            )}

                            {/* 状态 5: 支付成功 / 可下载 */}
                            {status === 'PAID' && (
                                <div className="text-center py-5 animate__animated animate__fadeIn">
                                    <div className="mb-4 text-success">
                                        <FaShieldAlt size={80} />
                                    </div>
                                    <h2 className="fw-bold mb-3">支付成功！</h2>
                                    <p className="text-muted mb-4">您的文件已准备就绪，系统将为您保留 24 小时。</p>

                                    <button onClick={handleDownload} className="btn btn-primary btn-lg w-100 py-3 mb-3 fw-bold shadow">
                                        <FaDownload className="me-2" /> 下载结果文件
                                    </button>

                                    <button onClick={resetFlow} className="btn btn-outline-secondary w-100">
                                        处理下一张图片
                                    </button>
                                </div>
                            )}

                        </div>
                    </div>
                </div>
            </div>

            {/* 底部 Footer */}
            <footer className="text-center py-4 text-muted small bg-white border-top">
                <div className="mb-2">© 2024 Image Sentinel. 图像卫士技术有限公司提供支持.</div>
                <div>
                    备案号：
                    <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="text-muted text-decoration-none ms-2">
                        蜀ICP备2024114874号-1
                    </a>
                </div>
            </footer>
        </div>
    );
}

export default App;