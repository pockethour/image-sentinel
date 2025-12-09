import React, { useState } from 'react';
import axios from 'axios';
import { FaShieldAlt, FaCloudUploadAlt, FaMagic, FaDownload, FaLock } from 'react-icons/fa';

// 1. 修改为相对路径
const API_BASE = '/api';

function App() {
    const [fileId, setFileId] = useState(null);
    const [status, setStatus] = useState('IDLE');
    const [previewUrl, setPreviewUrl] = useState(null);
    const [error, setError] = useState('');

    const handleFileChange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('image', file);

        setStatus('UPLOADING');
        setError('');

        try {
            const res = await axios.post(`${API_BASE}/upload`, formData);
            setFileId(res.data.fileId);
            setStatus('UPLOADED');
        } catch (err) {
            setError('上传失败，请重试');
            setStatus('IDLE');
        }
    };

    const startProcessing = async (algorithm) => {
        setStatus('PROCESSING');
        try {
            const res = await axios.post(`${API_BASE}/process`, {
                fileId,
                algorithm
            });
            // 2. 修改此处：后端返回的已经是 /api/preview/...，直接使用即可
            setPreviewUrl(res.data.previewUrl);
            setStatus('READY_PAY');
        } catch (err) {
            setError('处理失败：' + (err.response?.data?.error || err.message));
            setStatus('UPLOADED');
        }
    };

    const handlePayment = async () => {
        try {
            await axios.post(`${API_BASE}/pay`, { fileId });
            alert('模拟支付成功！(真实环境将跳转收银台)');
            setStatus('PAID');
        } catch (err) {
            setError('支付发起失败');
        }
    };

    const handleDownload = () => {
        window.open(`${API_BASE}/download/${fileId}`, '_blank');
    };

    return (
        <div className="min-vh-100 d-flex flex-column">
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

            <div className="container flex-grow-1">
                <div className="row justify-content-center">
                    <div className="col-md-8">

                        {error && (
                            <div className="alert alert-danger shadow-sm" role="alert">
                                {error}
                            </div>
                        )}

                        <div className="card p-4 step-card mb-5">
                            {status === 'IDLE' && (
                                <div className="text-center">
                                    <h3 className="mb-4 text-muted">第一步：上传待保护的图片</h3>
                                    <label className="upload-box w-100">
                                        <input type="file" hidden onChange={handleFileChange} accept="image/*" />
                                        <FaCloudUploadAlt size={50} className="text-primary mb-3" />
                                        <h5 className="text-primary">点击或拖拽上传图片</h5>
                                        <p className="text-secondary small">支持 JPG, PNG (最大 20MB)</p>
                                    </label>
                                </div>
                            )}

                            {status === 'UPLOADED' && (
                                <div className="text-center">
                                    <h3 className="mb-4">第二步：选择防护服务</h3>
                                    <div className="row g-3">
                                        <div className="col-md-6">
                                            <button onClick={() => startProcessing('watermark')} className="btn btn-outline-primary w-100 p-4 h-100">
                                                <FaLock size={24} className="mb-2" /><br />
                                                <strong>隐形水印嵌入</strong>
                                                <p className="small m-0 text-muted">肉眼不可见，抗截图压缩</p>
                                            </button>
                                        </div>
                                        <div className="col-md-6">
                                            <button onClick={() => startProcessing('forensics')} className="btn btn-outline-dark w-100 p-4 h-100">
                                                <FaMagic size={24} className="mb-2" /><br />
                                                <strong>防篡改检测</strong>
                                                <p className="small m-0 text-muted">生成真实性分析报告</p>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {(status === 'UPLOADING' || status === 'PROCESSING') && (
                                <div className="text-center py-5">
                                    <div className="spinner-border text-primary" role="status" style={{ width: '3rem', height: '3rem' }}></div>
                                    <p className="mt-3 text-muted">
                                        {status === 'UPLOADING' ? '正在加密上传...' : 'AI 引擎正在计算 (模拟 C++ 处理)...'}
                                    </p>
                                </div>
                            )}

                            {status === 'READY_PAY' && (
                                <div className="text-center">
                                    <h3 className="mb-3 text-success">处理完成！</h3>
                                    {previewUrl && (
                                        <div className="mb-4">
                                            <p className="text-muted">预览图 (低清/已压缩)</p>
                                            {/* 3. 修改此处：移除 localhost，直接使用 API_BASE 拼接或直接用 previewUrl */}
                                            {/* 注意：如果 server 返回的是 /api/preview/...，这里直接用 previewUrl 也可以 */}
                                            {/* 但为了保险起见，这里假设 previewUrl 已经是完整的相对路径 */}
                                            <img src={previewUrl} alt="Preview" className="img-thumbnail" style={{ maxHeight: '300px' }} />
                                        </div>
                                    )}
                                    <div className="bg-light p-4 rounded mb-3">
                                        <h4>服务费用：<span className="text-danger">¥ 5.00</span></h4>
                                        <p className="small text-muted">支付后即可下载全尺寸无损结果图</p>
                                    </div>
                                    <button onClick={handlePayment} className="btn btn-success btn-lg w-100">
                                        立即支付并下载
                                    </button>
                                </div>
                            )}

                            {status === 'PAID' && (
                                <div className="text-center py-4">
                                    <div className="mb-4 text-success">
                                        <FaShieldAlt size={60} />
                                    </div>
                                    <h3>支付成功</h3>
                                    <p className="text-muted">您的文件已准备就绪，有效期 24 小时。</p>
                                    <button onClick={handleDownload} className="btn btn-primary btn-lg w-100">
                                        <FaDownload className="me-2" /> 下载结果文件
                                    </button>
                                    <button onClick={() => { setStatus('IDLE'); setFileId(null); setPreviewUrl(null) }} className="btn btn-link mt-3 text-muted">
                                        处理下一张
                                    </button>
                                </div>
                            )}

                        </div>
                    </div>
                </div>
            </div>

            <footer className="text-center py-4 text-muted small bg-white border-top">
                <div className="mb-2">
                    © 2024 Image Sentinel. 图像卫士技术有限公司提供支持.
                </div>

                {/* 标准备案信息区域 */}
                <div>
                    备案号：
                    <a
                        href="https://beian.miit.gov.cn/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted text-decoration-none hover-primary"
                        style={{ marginLeft: '5px' }} // 加一点间距
                    >
                        蜀ICP备2024114874号-1
                    </a>
                </div>
            </footer>
        </div>
    );
}

export default App;