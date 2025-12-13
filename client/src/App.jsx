import React, { useState, useEffect } from 'react';
import axios from 'axios';
// 确保安装: npm install react-icons
import {
    FaShieldAlt, FaCloudUploadAlt, FaMagic, FaDownload, FaLock,
    FaCheckCircle, FaExclamationTriangle, FaFingerprint, FaKey,
    FaSearch, FaDollarSign, FaTimesCircle, FaCheck
} from 'react-icons/fa';

const API_BASE = '/api';
const MAX_WATERMARK_LENGTH = 32;

// [安全配置] 文件名非法字符正则
// 包含: < > : " / \ | ? * 以及 ASCII 控制字符 (0-31)
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/;

function App() {
    const [fileId, setFileId] = useState(null);
    const [mode, setMode] = useState('EMBED'); // EMBED or VERIFY
    // 状态机: IDLE, UPLOADING, UPLOADED, PROCESSING, READY_PAY, PAID, VERIFYING, VERIFIED, QUICK_VERIFYING
    const [status, setStatus] = useState('IDLE');

    const [previewUrl, setPreviewUrl] = useState(null);
    const [algorithm, setAlgorithm] = useState('');
    const [evidence, setEvidence] = useState(null);
    const [error, setError] = useState('');

    const [customWatermarkText, setCustomWatermarkText] = useState('');
    const [verifyResult, setVerifyResult] = useState(null);
    const [quickVerifyResult, setQuickVerifyResult] = useState(null);
    const [hasDownloaded, setHasDownloaded] = useState(false);

    // [交互] 输入框非法字符拦截提示
    const [inputWarning, setInputWarning] = useState('');

    useEffect(() => {
        const query = new URLSearchParams(window.location.search);
        if (query.get('status') === 'paid' && query.get('fileId')) {
            setFileId(query.get('fileId'));
            setStatus('PAID');
            setMode('EMBED');
            setHasDownloaded(false);
            // 清理 URL 参数
            window.history.replaceState({}, '', '/');
        }
    }, []);

    // --- 防误触逻辑 ---
    useEffect(() => {
        const handleBeforeUnload = (e) => {
            const isPendingPayment = mode === 'EMBED' && status === 'READY_PAY';
            const isPaidButNotDownloaded = status === 'PAID' && !hasDownloaded;
            if (isPendingPayment || isPaidButNotDownloaded) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [mode, status, hasDownloaded]);

    const confirmExit = () => {
        if (mode === 'EMBED' && status === 'READY_PAY') {
            return window.confirm("⚠️ 警告：当前订单尚未支付。\n\n离开此页面将丢失已处理的预览图和嵌入数据。\n确定要放弃本次交易吗？");
        }
        if (status === 'PAID' && !hasDownloaded) {
            return window.confirm("🛑 警告：您尚未下载付费文件！\n\n一旦离开此页面，您可能无法再次找回该文件。\n\n确定要放弃下载并离开吗？");
        }
        return true;
    };

    const handleModeSwitch = (targetMode) => {
        if (mode === targetMode) return;
        if (confirmExit()) {
            resetFlow();
            setMode(targetMode);
        }
    };

    const handleReset = () => {
        if (confirmExit()) {
            resetFlow();
        }
    };

    const handleDownloadClick = () => {
        window.open(`${API_BASE}/download/${fileId}`);
        setHasDownloaded(true);
    };

    // --- 业务逻辑 ---

    const handleFileChange = async (e) => {
        if (!confirmExit()) {
            e.target.value = null;
            return;
        }
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('image', file);
        setStatus('UPLOADING');
        setError('');

        const uploadEndpoint = mode === 'EMBED' ? `${API_BASE}/upload` : `${API_BASE}/upload_verify`;

        try {
            const res = await axios.post(uploadEndpoint, formData);
            if (res.data.success) {
                setFileId(res.data.fileId);
                setStatus('UPLOADED');
                setVerifyResult(null);
                setQuickVerifyResult(null);
                setHasDownloaded(false);
            }
        } catch (err) {
            setError('上传失败');
            setStatus('IDLE');
        }
    };

    // [核心修改] 处理水印输入：拦截非法字符
    const handleWatermarkInput = (e) => {
        const val = e.target.value;

        // 1. 检查是否包含非法字符
        if (INVALID_FILENAME_CHARS.test(val)) {
            setInputWarning('不能包含特殊字符 (\\ / : * ? " < > |) 以便用于文件名');

            // 3秒后自动清除警告
            setTimeout(() => setInputWarning(''), 3000);

            // [关键] 直接返回，不更新 state，这样非法字符根本不会显示在输入框里
            return;
        }

        // 2. 检查长度
        if (val.length > MAX_WATERMARK_LENGTH) {
            // 虽然 input maxLength 属性已限制，但双重保险
            return;
        }

        // 验证通过，更新输入框
        setInputWarning('');
        setCustomWatermarkText(val);
    };

    const startProcessingOrVerifying = async (algo) => {
        setError('');
        if (mode === 'EMBED') {
            setStatus('PROCESSING');
            setAlgorithm(algo);
            try {
                const res = await axios.post(`${API_BASE}/process`, {
                    fileId,
                    algorithm: algo,
                    customWatermarkText: customWatermarkText.trim()
                });
                if (res.data.success) {
                    setPreviewUrl(res.data.previewUrl);
                    const { success, previewUrl, ...rest } = res.data;
                    setEvidence(rest);
                    setStatus('READY_PAY');
                }
            } catch (err) {
                setError(err.response?.data?.error || '处理失败');
                setStatus('UPLOADED');
            }
        } else if (mode === 'VERIFY') {
            setStatus('VERIFYING');
            try {
                const res = await axios.post(`${API_BASE}/verify_watermark_free`, { fileId });
                setVerifyResult(res.data);
                setStatus('VERIFIED');
            } catch (err) {
                setVerifyResult(null);
                setError(err.response?.data?.error || '查询失败');
                setStatus('UPLOADED');
            }
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

    const startQuickVerification = async () => {
        setStatus('QUICK_VERIFYING');
        setQuickVerifyResult(null);
        try {
            const res = await axios.post(`${API_BASE}/verify_watermark_free`, { fileId });
            if (res.data.found) {
                setQuickVerifyResult({
                    type: 'success',
                    message: `验证成功！提取信息：${res.data.extractedText}`,
                    extractedText: res.data.extractedText
                });
            } else {
                setQuickVerifyResult({
                    type: 'warning',
                    message: '未检测到数字水印。该图片可能未经过保护或水印已被破坏。'
                });
            }
        } catch (err) {
            setQuickVerifyResult({
                type: 'error',
                message: err.response?.data?.error || '服务器连接失败，请稍后重试。'
            });
        } finally {
            setStatus('READY_PAY');
            setTimeout(() => setQuickVerifyResult(null), 8000);
        }
    };

    const resetFlow = () => {
        setStatus('IDLE');
        setFileId(null);
        setPreviewUrl(null);
        setEvidence(null);
        setError('');
        setCustomWatermarkText('');
        setInputWarning('');
        setVerifyResult(null);
        setQuickVerifyResult(null);
        setHasDownloaded(false);
    };

    const getStepTitle = () => {
        if (status === 'IDLE') return mode === 'EMBED' ? '步骤 1: 上传图片并定制水印' : '步骤 1: 上传带水印图片';
        if (status === 'UPLOADED') return mode === 'EMBED' ? '步骤 2: 选择处理算法' : '步骤 2: 开始免费查询';
        return '处理中...';
    };

    return (
        <div className="min-vh-100 bg-light font-sans-serif">
            {/* Toast 提示 */}
            {quickVerifyResult && (
                <div className={`alert ${quickVerifyResult.type === 'success' ? 'alert-success' : quickVerifyResult.type === 'warning' ? 'alert-warning' : 'alert-danger'} animate__animated animate__fadeInDown position-fixed top-0 start-50 translate-middle-x mt-3 shadow`} style={{ zIndex: 1000, minWidth: '450px' }} role="alert">
                    <h5 className="alert-heading d-flex align-items-center">
                        {quickVerifyResult.type === 'success' && <FaCheckCircle className="me-2" />}
                        {quickVerifyResult.type === 'warning' && <FaExclamationTriangle className="me-2" />}
                        {quickVerifyResult.type === 'error' && <FaTimesCircle className="me-2" />}
                        {quickVerifyResult.type === 'success' ? '验证成功' : quickVerifyResult.type === 'warning' ? '结果提示' : '验证错误'}
                    </h5>
                    <p className="mb-0">{quickVerifyResult.message}</p>
                    {quickVerifyResult.extractedText && (
                        <p className="mt-2 mb-0 small font-monospace bg-white bg-opacity-50 p-2 rounded text-break">{quickVerifyResult.extractedText}</p>
                    )}
                </div>
            )}

            <div className="bg-dark text-white text-center py-5 mb-4">
                <h1 className="fw-bold" onClick={handleReset} style={{ cursor: 'pointer' }}>
                    <FaShieldAlt className="text-warning me-2" />图像卫士 Sentinel
                </h1>
                <p className="opacity-75">企业级隐形水印 & AI 取证平台</p>
            </div>

            <div className="container" style={{ maxWidth: '900px' }}>
                {error && <div className="alert alert-danger">{error}</div>}

                <div className="card shadow-lg border-0">
                    <div className="card-body p-5">
                        <div className="d-flex justify-content-center mb-4 p-3 bg-light rounded">
                            <button onClick={() => handleModeSwitch('EMBED')} className={`btn btn-lg fw-bold me-3 ${mode === 'EMBED' ? 'btn-primary' : 'btn-outline-primary'}`}>
                                <FaDollarSign className="me-2" />付费嵌入水印
                            </button>
                            <button onClick={() => handleModeSwitch('VERIFY')} className={`btn btn-lg fw-bold ${mode === 'VERIFY' ? 'btn-info' : 'btn-outline-info'}`}>
                                <FaSearch className="me-2" />免费查询水印
                            </button>
                        </div>

                        <h4 className="fw-bold mb-3">{getStepTitle()}</h4>

                        {mode === 'EMBED' && status !== 'READY_PAY' && status !== 'PAID' && (
                            <div className="mb-4">
                                <h5 className="text-start mb-2"><FaKey className="me-2 text-primary" />自定义水印内容 (Max {MAX_WATERMARK_LENGTH}字)</h5>
                                <input
                                    type="text"
                                    className={`form-control form-control-lg ${inputWarning ? 'is-invalid' : ''}`}
                                    placeholder="例如：版权属于张三 (将作为下载文件名的一部分)"
                                    maxLength={MAX_WATERMARK_LENGTH}
                                    value={customWatermarkText}
                                    onChange={handleWatermarkInput}
                                />
                                {inputWarning && <div className="invalid-feedback animate__animated animate__shakeX">{inputWarning}</div>}
                                <div className="text-muted small mt-1 text-end">剩余 {MAX_WATERMARK_LENGTH - customWatermarkText.length} 字</div>
                            </div>
                        )}

                        {(status === 'IDLE' || status === 'UPLOADED') && status !== 'READY_PAY' && status !== 'PAID' && (
                            <div className="text-center">
                                <label className="d-block w-100 p-5 border border-2 border-dashed rounded cursor-pointer bg-white position-relative">
                                    <input type="file" hidden onChange={handleFileChange} accept="image/*" />
                                    {status === 'UPLOADED' ? (
                                        <div className="text-success animate__animated animate__bounceIn">
                                            <FaCheckCircle size={50} className="mb-3" />
                                            <h4>图片就绪</h4>
                                            <p className="small text-muted">点击可重新上传</p>
                                        </div>
                                    ) : (
                                        <div className="text-muted">
                                            <FaCloudUploadAlt size={50} className="mb-3 text-primary" />
                                            <h5>点击上传图片</h5>
                                            <p className="small">支持 JPG/PNG (Max 50MB)</p>
                                        </div>
                                    )}
                                </label>

                                {status === 'UPLOADED' && mode === 'EMBED' && (
                                    <div className="row g-3 mt-4">
                                        <div className="col-md-6">
                                            <button onClick={() => startProcessingOrVerifying('watermark')} className="btn btn-outline-primary w-100 p-4 h-100 border-2 text-start" disabled={!customWatermarkText.trim() || !!inputWarning}>
                                                <h5 className="fw-bold"><FaLock className="me-2" />隐形水印 (嵌入)</h5>
                                                <small className="text-muted d-block mt-2">嵌入定制信息。¥4.99</small>
                                            </button>
                                        </div>
                                        <div className="col-md-6">
                                            <button onClick={() => startProcessingOrVerifying('forensics')} className="btn btn-outline-danger w-100 p-4 h-100 border-2 text-start">
                                                <h5 className="fw-bold"><FaMagic className="me-2" />防篡改取证</h5>
                                                <small className="text-muted d-block mt-2">ELA 热力图分析。¥4.99</small>
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {status === 'UPLOADED' && mode === 'VERIFY' && (
                                    <button onClick={() => startProcessingOrVerifying('verify')} className="btn btn-info btn-lg w-100 mt-4 py-3">
                                        <FaSearch className="me-2" />开始免费查询数字水印
                                    </button>
                                )}
                            </div>
                        )}

                        {(status === 'UPLOADING' || status === 'PROCESSING' || status === 'VERIFYING' || status === 'QUICK_VERIFYING') && (
                            <div className="text-center py-5">
                                <div className="spinner-border text-primary mb-3" style={{ width: '3rem', height: '3rem' }}></div>
                                <h5 className="text-muted">核心引擎计算中...</h5>
                            </div>
                        )}

                        {status === 'VERIFIED' && verifyResult && mode === 'VERIFY' && (
                            <div className="animate__animated animate__fadeIn">
                                <h3 className="fw-bold mb-4"><FaSearch className="me-2 text-info" />查询结果</h3>
                                {(() => {
                                    const isFound = verifyResult.found !== undefined ? verifyResult.found : !!verifyResult.extractedText;
                                    return (
                                        <div className={`alert ${isFound ? 'alert-success' : 'alert-warning'} border-0`}>
                                            <h5 className="fw-bold">
                                                {isFound ? (<><FaCheckCircle className="me-2" />水印验证成功！</>)
                                                    : (<><FaExclamationTriangle className="me-2" />结果提示</>)}
                                            </h5>
                                            {isFound ? (
                                                <div className="mt-3">
                                                    <strong className="text-primary d-block mb-1">提取到的定制信息:</strong>
                                                    <p className="fs-5 font-monospace text-dark bg-light p-3 rounded text-break">{verifyResult.extractedText}</p>
                                                    <small className="text-muted">置信度: {verifyResult.confidenceScore ? verifyResult.confidenceScore.toFixed(2) : 'N/A'}</small>
                                                </div>
                                            ) : (
                                                <p className="mt-2">{verifyResult.message || "未检测到有效数字水印。该图片可能未经过保护或水印已被破坏。"}</p>
                                            )}
                                        </div>
                                    );
                                })()}
                                <button onClick={handleReset} className="btn btn-secondary w-100 mt-3">重新查询</button>
                            </div>
                        )}

                        {status === 'READY_PAY' && evidence && mode === 'EMBED' && (
                            <div className="animate__animated animate__fadeIn">
                                <div className="text-center mb-4">
                                    <h3 className="fw-bold text-success"><FaCheckCircle className="me-2" />分析完成</h3>
                                    <p className="text-muted">请查阅下方的分析摘要</p>
                                </div>
                                <div className="row g-0 border rounded overflow-hidden mb-4 shadow-sm">
                                    <div className="col-md-6 bg-dark d-flex align-items-center justify-content-center p-3">
                                        <img src={previewUrl} className="img-fluid rounded" style={{ maxHeight: '300px' }} alt="Result" />
                                    </div>
                                    <div className="col-md-6 bg-white p-4 d-flex flex-column justify-content-center">
                                        {algorithm === 'watermark' ? (
                                            <>
                                                <h5 className="text-primary fw-bold mb-3"><FaFingerprint className="me-2" />嵌入验证报告</h5>
                                                <div className="alert alert-success border-0 bg-success bg-opacity-10 mb-3">
                                                    <small className="fw-bold text-uppercase text-success">Embedded Data</small>
                                                    <div className="fs-5 font-monospace text-dark text-break">{evidence.embeddedText}</div>
                                                </div>
                                                {/* 算法信息已移除 */}
                                                <button onClick={startQuickVerification} className="btn btn-sm btn-outline-info mt-3" disabled={status === 'QUICK_VERIFYING'}>
                                                    {status === 'QUICK_VERIFYING' ? '验证中...' : '点击快速验证水印 (免费)'}
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                <h5 className="text-danger fw-bold mb-3"><FaExclamationTriangle className="me-2" />真实性分析</h5>
                                                <div className="d-flex align-items-end mb-3">
                                                    <span className={`display-4 fw-bold lh-1 me-2 ${evidence.score < 60 ? 'text-danger' : 'text-success'}`}>{evidence.score}</span>
                                                    <span className="text-muted mb-2">/ 100 分</span>
                                                </div>
                                                <ul className="list-unstyled small text-muted mb-0">
                                                    <li className="mb-1">风险等级: {evidence.riskLevel}</li>
                                                    <li>📊 异常强度: {evidence.anomalyIntensity ? evidence.anomalyIntensity.toFixed(2) : 'N/A'}</li>
                                                </ul>
                                            </>
                                        )}
                                        <p className="small text-muted mt-3 mb-0 border-top pt-2"><strong>付费权益：</strong> 下载无损、无可见水印的完整文件。</p>
                                    </div>
                                </div>
                                <button onClick={handlePayment} className="btn btn-success btn-lg w-100 py-3 fw-bold shadow-sm">立即支付 ¥4.99 获取完整结果</button>
                                <button onClick={handleReset} className="btn btn-link text-muted w-100 mt-2 text-decoration-none">放弃并重新开始</button>
                            </div>
                        )}

                        {status === 'PAID' && mode === 'EMBED' && (
                            <div className="text-center py-5 animate__animated animate__zoomIn">
                                <FaShieldAlt className="text-success mb-3" size={80} />
                                <h2 className="fw-bold">支付成功</h2>
                                <p className="text-muted mb-4">您的文件已准备就绪，请务必在离开前下载。</p>
                                <button onClick={handleDownloadClick} className="btn btn-primary btn-lg px-5 shadow mb-3">
                                    <FaDownload className="me-2" />下载文件
                                </button>
                                {hasDownloaded && <div className="text-success small mb-3 animate__animated animate__fadeIn"><FaCheck className="me-1" /> 已下载</div>}
                                <div><button onClick={handleReset} className="btn btn-link text-muted w-100 text-decoration-none">返回主页</button></div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default App;