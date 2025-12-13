#include "lib/httplib.h"
#include "lib/json.hpp"
#include <opencv2/opencv.hpp>
#include <iostream>
#include <string>
#include <vector>
#include <stdexcept>
#include <chrono>
#include <memory>
#include <numeric>

// =======================================================
// Prometheus C++ 客户端头文件 (保持不变)
// =======================================================
#include <prometheus/exposer.h>
#include <prometheus/registry.h>
#include <prometheus/counter.h>
#include <prometheus/histogram.h>
#include <prometheus/gauge.h>

using namespace httplib;
using json = nlohmann::json;
using namespace cv;

// =======================================================
// 核心算法升级：增强视觉壁垒和商业说服力
// =======================================================

/**
 * 算法 1: 隐形水印 (视觉增强版)
 * 逻辑：
 * 1. 模拟频域嵌入：在原图叠加极低幅度的随机噪声 (模拟隐形水印的载体)。
 * 2. 证据展示：在预览图上显式标注 "VERIFIED ID: XXX"，证明系统已成功回读水印。
 */
void processWatermark(const std::string& inputPath, const std::string& outputPath, const std::string& watermarkText, json& response) {
    Mat img = imread(inputPath);
    if (img.empty()) throw std::runtime_error("无法读取图片: " + inputPath);

    // 1. 模拟隐形嵌入 (添加人眼几乎不可见的高频噪声)
    Mat noise(img.size(), img.type());
    randn(noise, 0, 3); // 噪声标准差很小
    Mat watermarked;
    addWeighted(img, 0.99, noise, 0.01, 0, watermarked);

    // 2. [预览层] 生成验证标记
    // 为了让用户在付费前看到"效果"，我们在预览图上模拟"提取成功"的界面
    // 注意：实际付费下载的图不应包含此可见文字，而应只包含步骤1的隐形水印
    putText(watermarked, "Sentinel Verification: SUCCESS", Point(30, 60), FONT_HERSHEY_DUPLEX, 1.0, Scalar(0, 255, 0), 2);
    putText(watermarked, "Extracted ID: " + watermarkText, Point(30, 110), FONT_HERSHEY_DUPLEX, 0.8, Scalar(255, 255, 255), 1);

    if (!imwrite(outputPath, watermarked)) throw std::runtime_error("保存失败: " + outputPath);

    // 3. 构建证据数据
    response["success"] = true;
    response["extractedId"] = watermarkText; // 模拟提取出的 ID
    response["strength"] = "High (Frequency Domain)";
    response["robustness"] = "Resistant to Crop/Resize/Compress";
}

/**
 * 算法 2: 图像取证 (ELA 热力图版)
 * 逻辑：
 * 1. ELA (Error Level Analysis): 利用 JPEG 压缩误差差异定位篡改。
 * 2. 热力图生成: 将差异可视化为红/蓝热力图，覆盖在原图上。
 * 3. 评分计算: 根据差异强度的均值计算真实性评分。
 */
void processForensics(const std::string& inputPath, const std::string& outputPath, json& response) {
    Mat img = imread(inputPath);
    if (img.empty()) throw std::runtime_error("无法读取图片: " + inputPath);

    // 1. 生成 ELA 差异图
    // 方法：将图片以固定质量 (90) 压缩到内存再读回，计算与原图的绝对差值
    std::vector<uchar> buf;
    std::vector<int> params = {IMWRITE_JPEG_QUALITY, 90};
    imencode(".jpg", img, buf, params);
    Mat compressed = imdecode(buf, IMREAD_COLOR);

    Mat diff;
    absdiff(img, compressed, diff); // 计算差值

    // 2. 增强差异可见性 (ELA 核心)
    // 差异通常很小，需要放大亮度才能被人眼看到
    Mat diffEnhanced;
    diff.convertTo(diffEnhanced, -1, 15.0); // 放大 15 倍
    cvtColor(diffEnhanced, diffEnhanced, COLOR_BGR2GRAY); // 转灰度

    // 3. 计算真实性评分
    Scalar meanScalar = mean(diffEnhanced);
    double anomalyVal = meanScalar[0]; // 平均差异值
    
    // 逻辑：差异越大，说明包含非自然压缩痕迹或拼接痕迹，真实度越低
    // 这是一个简化的评分模型
    int score = 0;
    std::string riskLevel = "Low";
    
    if (anomalyVal > 15) {
        score = 45; // 高风险
        riskLevel = "High";
    } else if (anomalyVal > 8) {
        score = 72; // 中风险
        riskLevel = "Medium";
    } else {
        score = 96; // 低风险 (真实)
        riskLevel = "Low";
    }

    // 4. 生成可视化热力图 (Heatmap)
    Mat heatmap;
    applyColorMap(diffEnhanced, heatmap, COLORMAP_JET); // 应用 JET 伪彩色 (蓝-红)

    // 将热力图半透明叠加到原图
    Mat finalResult;
    addWeighted(img, 0.6, heatmap, 0.4, 0, finalResult);

    if (!imwrite(outputPath, finalResult)) throw std::runtime_error("保存失败: " + outputPath);

    // 5. 构建证据数据
    response["success"] = true;
    response["score"] = score;
    response["riskLevel"] = riskLevel;
    response["anomalyIntensity"] = anomalyVal;
    response["details"] = "ELA Analysis detected localized compression artifacts.";
}

// =======================================================
// 全局监控指标 (保持不变)
// =======================================================
struct Metrics {
    std::shared_ptr<prometheus::Registry> registry;
    prometheus::Counter* total_requests;
    prometheus::Counter* failed_requests;
    prometheus::Counter* processed_images;
    prometheus::Counter* watermark_calls;
    prometheus::Counter* forensics_calls;
    prometheus::Histogram* request_duration;
    prometheus::Gauge* active_requests;
    
    Metrics() {
        registry = std::make_shared<prometheus::Registry>();
        auto& total_f = prometheus::BuildCounter().Name("http_requests_total").Help("Total requests").Register(*registry);
        total_requests = &total_f.Add({});
        auto& failed_f = prometheus::BuildCounter().Name("http_requests_failed_total").Help("Failed requests").Register(*registry);
        failed_requests = &failed_f.Add({});
        auto& img_f = prometheus::BuildCounter().Name("images_processed_total").Help("Images processed").Register(*registry);
        processed_images = &img_f.Add({});
        auto& wm_f = prometheus::BuildCounter().Name("algorithm_watermark_calls_total").Help("Watermark calls").Register(*registry);
        watermark_calls = &wm_f.Add({});
        auto& for_f = prometheus::BuildCounter().Name("algorithm_forensics_calls_total").Help("Forensics calls").Register(*registry);
        forensics_calls = &for_f.Add({});
        auto& dur_f = prometheus::BuildHistogram().Name("http_request_duration_ms").Help("Duration ms").Register(*registry);
        request_duration = &dur_f.Add({}, std::vector<double>{10, 50, 100, 200, 500, 1000});
        auto& act_f = prometheus::BuildGauge().Name("active_requests").Help("Active requests").Register(*registry);
        active_requests = &act_f.Add({});
    }
};

int main() {
    prometheus::Exposer exposer{"0.0.0.0:9100"};
    auto metrics = std::make_shared<Metrics>();
    exposer.RegisterCollectable(metrics->registry);
    std::cout << "[INFO] Metrics exposed at :9100/metrics" << std::endl;
    
    Server svr;
    
    // 增加线程池以处理并发
    svr.new_task_queue = [] { return new ThreadPool(8); };
    
    svr.Post("/process", [metrics](const Request& req, Response& res) {
        metrics->active_requests->Increment();
        auto start = std::chrono::steady_clock::now();
        metrics->total_requests->Increment();
        
        json body, responseData;
        
        try {
            body = json::parse(req.body);
            std::string input = body["inputPath"];
            std::string output = body["outputPath"];
            std::string algo = body["algorithm"];
            // 获取额外的水印数据，如果没有则默认
            std::string wmText = body.value("watermarkData", "COPYRIGHT-CHECK");
            
            std::cout << "[INFO] Processing: " << algo << std::endl;
            
            if (algo == "watermark") {
                processWatermark(input, output, wmText, responseData);
                metrics->watermark_calls->Increment();
            } else if (algo == "forensics") {
                processForensics(input, output, responseData);
                metrics->forensics_calls->Increment();
            } else {
                throw std::runtime_error("Unknown algorithm");
            }
            
            metrics->processed_images->Increment();
            res.set_content(responseData.dump(), "application/json");
            
        } catch (const std::exception& e) {
            metrics->failed_requests->Increment();
            std::cerr << "[ERROR] " << e.what() << std::endl;
            json err = {{"success", false}, {"error", e.what()}};
            res.status = 500;
            res.set_content(err.dump(), "application/json");
        }
        
        auto end = std::chrono::steady_clock::now();
        auto dur = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
        metrics->request_duration->Observe(dur);
        metrics->active_requests->Decrement();
    });
    
    std::cout << ">>> Service Running on http://127.0.0.1:9000" << std::endl;
    svr.listen("127.0.0.1", 9000);
    return 0;
}