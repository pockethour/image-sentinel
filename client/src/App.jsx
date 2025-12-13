import React, { useState, useEffect } from 'react';
import axios from 'axios';
// 请确保安装: npm install react-icons
import { FaShieldAlt, FaCloudUploadAlt, FaMagic, FaDownload, FaLock, FaCheckCircle, FaExclamationTriangle, FaFingerprint } from 'react-icons/fa';

const API_BASE = '/api';

function App() {
    const [fileId, setFileId] = useState(null);
    const [status, setStatus] = useState('IDLE'); // IDLE, UPLOADING, UPLOADED, PROCESSING, READY_PAY, PAID
    const [previewUrl, setPreviewUrl] = useState(null);
    const [algorithm, setAlgorithm] = useState('');
    const [evidence, setEvidence] = useState(null); // [核心] 存储 C++ 的证据数据
    const [error, setError] = useState('');

    useEffect(() => {
        const query = new URLSearchParams(window.location.search);
        if (query.get('status') === 'paid' && query.get('fileId')) {
            setFileId(query.get('fileId'));
            setStatus('PAID');
            window.history.replaceState({}, '', '/');
        }
    }, []);

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
            setError('上传失败');
            setStatus('IDLE');
        }
    };

    const startProcessing = async (algo) => {
        setStatus('PROCESSING');
        setAlgorithm(algo);
        try {
            const res = await axios.post(`${API_BASE}/process`, {
                fileId,
                algorithm: algo
            });

            if (res.data.success) {
                setPreviewUrl(res.data.previewUrl);
                // [核心] 提取除了 success/previewUrl 之外的所有数据作为证据
                const { success, previewUrl, ...rest } = res.data;
                setEvidence(rest); 
                setStatus('READY_PAY');
            }
        } catch (err) {
            setError(err.response?.data?.error || '处理失败');
            setStatus('UPLOADED');
        }
    };

    const handlePayment = async () => {
        try {
            const res = await axios.post(`${API_BASE}/pay`, { fileId });
            if (res.data.success) {
                document.write(res.data.formHtml);
                document.close();
            }
        } catch (err) {
            setError('支付初始化失败');
        }
    };

    const resetFlow = () => {
        setStatus('IDLE');
        setFileId(null);
        setPreviewUrl(null);
        setEvidence(null);
        setError('');
    };

    return (
        <div className="min-vh-100 bg-light font-sans-serif">
            {/* Header */}
            <div className="bg-dark text-white text-center py-5 mb-4">
                <h1 className="fw-bold"><FaShieldAlt className="text-warning me-2"/>图像卫士 Sentinel</h1>
                <p className="opacity-75">企业级隐形水印 & AI 取证平台</p>
            </div>

            <div className="container" style={{maxWidth: '900px'}}>
                {error && <div className="alert alert-danger">{error}</div>}

                <div className="card shadow-lg border-0">
                    <div className="card-body p-5">
                        
                        {/* 1. Upload */}
                        {(status === 'IDLE' || status === 'UPLOADED') && (
                            <div className="text-center">
                                <label className="d-block w-100 p-5 border border-2 border-dashed rounded cursor-pointer bg-white">
                                    <input type="file" hidden onChange={handleFileChange} accept="image/*" />
                                    {status === 'UPLOADED' ? (
                                        <div className="text-success animate__animated animate__bounceIn">
                                            <FaCheckCircle size={50} className="mb-3"/>
                                            <h4>图片就绪</h4>
                                        </div>
                                    ) : (
                                        <div className="text-muted">
                                            <FaCloudUploadAlt size={50} className="mb-3 text-primary"/>
                                            <h5>点击上传图片</h5>
                                            <p className="small">支持 JPG/PNG (Max 50MB)</p>
                                        </div>
                                    )}
                                </label>

                                {status === 'UPLOADED' && (
                                    <div className="row g-3 mt-4">
                                        <div className="col-md-6">
                                            <button onClick={() => startProcessing('watermark')} className="btn btn-outline-primary w-100 p-4 h-100 border-2 text-start">
                                                <h5 className="fw-bold"><FaLock className="me-2"/>隐形水印</h5>
                                                <small className="text-muted d-block mt-2">嵌入肉眼不可见版权信息，抗截图、抗压缩。</small>
                                            </button>
                                        </div>
                                        <div className="col-md-6">
                                            <button onClick={() => startProcessing('forensics')} className="btn btn-outline-danger w-100 p-4 h-100 border-2 text-start">
                                                <h5 className="fw-bold"><FaMagic className="me-2"/>防篡改取证</h5>
                                                <small className="text-muted d-block mt-2">生成 ELA 热力图，计算真实性评分。</small>
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* 2. Processing */}
                        {(status === 'UPLOADING' || status === 'PROCESSING') && (
                            <div className="text-center py-5">
                                <div className="spinner-border text-primary mb-3" style={{width: '3rem', height: '3rem'}}></div>
                                <h5 className="text-muted">{status === 'UPLOADING' ? '正在加密上传...' : 'C++ 核心引擎计算中...'}</h5>
                            </div>
                        )}

                        {/* 3. Evidence & Pay (核心付费转化页) */}
                        {status === 'READY_PAY' && evidence && (
                            <div className="animate__animated animate__fadeIn">
                                <div className="text-center mb-4">
                                    <h3 className="fw-bold text-success"><FaCheckCircle className="me-2"/>分析完成</h3>
                                    <p className="text-muted">请查阅下方的分析摘要</p>
                                </div>

                                <div className="row g-0 border rounded overflow-hidden mb-4 shadow-sm">
                                    {/* 左侧：预览图 */}
                                    <div className="col-md-6 bg-dark d-flex align-items-center justify-content-center p-3">
                                        <img src={previewUrl} className="img-fluid rounded" style={{maxHeight: '300px'}} alt="Result" />
                                    </div>
                                    
                                    {/* 右侧：证据卡片 */}
                                    <div className="col-md-6 bg-white p-4 d-flex flex-column justify-content-center">
                                        {algorithm === 'watermark' ? (
                                            <>
                                                <h5 className="text-primary fw-bold mb-3"><FaFingerprint className="me-2"/>嵌入验证报告</h5>
                                                <div className="alert alert-success border-0 bg-success bg-opacity-10 mb-3">
                                                    <small className="fw-bold text-uppercase text-success">Extracted ID</small>
                                                    <div className="fs-5 font-monospace text-dark">{evidence.extractedId}</div>
                                                </div>
                                                <ul className="list-unstyled small text-muted mb-0">
                                                    <li className="mb-1">✅ 频域嵌入强度: {evidence.strength}</li>
                                                    <li>✅ 鲁棒性: {evidence.robustness}</li>
                                                </ul>
                                            </>
                                        ) : (
                                            <>
                                                <h5 className="text-danger fw-bold mb-3"><FaExclamationTriangle className="me-2"/>真实性分析</h5>
                                                <div className="d-flex align-items-end mb-3">
                                                    <span className={`display-4 fw-bold lh-1 me-2 ${evidence.score < 60 ? 'text-danger' : 'text-success'}`}>
                                                        {evidence.score}
                                                    </span>
                                                    <span className="text-muted mb-2">/ 100 分</span>
                                                </div>
                                                <ul className="list-unstyled small text-muted mb-0">
                                                    <li className="mb-1">
                                                        {evidence.riskLevel === 'High' ? '❌ 高风险: 检测到明显篡改痕迹' : '✅ 低风险: 未见异常'}
                                                    </li>
                                                    <li>📊 异常强度: {evidence.anomalyIntensity.toFixed(2)}</li>
                                                </ul>
                                            </>
                                        )}
                                        
                                        <p className="small text-muted mt-3 mb-0 border-top pt-2">
                                            <strong>付费权益：</strong> 下载无损、无水印的完整文件及详细 PDF 报告。
                                        </p>
                                    </div>
                                </div>

                                <button onClick={handlePayment} className="btn btn-success btn-lg w-100 py-3 fw-bold shadow-sm">
                                    立即支付 ¥5.00 获取完整结果
                                </button>
                                <button onClick={resetFlow} className="btn btn-link text-muted w-100 mt-2 text-decoration-none">放弃并重新开始</button>
                            </div>
                        )}

                        {/* 4. Success */}
                        {status === 'PAID' && (
                            <div className="text-center py-5">
                                <FaShieldAlt className="text-success mb-3" size={80}/>
                                <h2 className="fw-bold">支付成功</h2>
                                <p className="text-muted mb-4">您的文件已准备就绪。</p>
                                <button onClick={() => window.open(`${API_BASE}/download/${fileId}`)} className="btn btn-primary btn-lg px-5 shadow">
                                    <FaDownload className="me-2"/>下载文件
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default App;