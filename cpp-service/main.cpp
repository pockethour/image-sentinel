#include "lib/httplib.h"
#include "lib/json.hpp"
#include <opencv2/opencv.hpp>
#include <iostream>
#include <string>
#include <stdexcept>
#include <chrono>
#include <memory>

// =======================================================
// Prometheus C++ 客户端头文件
// =======================================================
#include <prometheus/exposer.h>
#include <prometheus/registry.h>
#include <prometheus/counter.h>
#include <prometheus/histogram.h>
#include <prometheus/gauge.h>

using namespace httplib;
using json = nlohmann::json;

// --- 算法实现保持不变 ---
void processWatermark(const std::string& inputPath, const std::string& outputPath) {
    cv::Mat img = cv::imread(inputPath);
    if (img.empty()) throw std::runtime_error("无法读取图片: " + inputPath);

    std::string text = "PROTECTED";
    int font = cv::FONT_HERSHEY_SIMPLEX;
    
    int baseline = 0;
    cv::Size textSize = cv::getTextSize(text, font, 1.0, 2, &baseline);
    cv::Point org(img.cols - textSize.width - 20, img.rows - 20);
    
    cv::putText(img, text, org, font, 1.0, cv::Scalar(0, 0, 0), 4);
    cv::putText(img, text, org, font, 1.0, cv::Scalar(255, 255, 255), 2);
    
    if (!cv::imwrite(outputPath, img)) throw std::runtime_error("保存失败: " + outputPath);
}

void processForensics(const std::string& inputPath, const std::string& outputPath) {
    cv::Mat img = cv::imread(inputPath);
    if (img.empty()) throw std::runtime_error("无法读取图片: " + inputPath);

    cv::Mat edges;
    cv::Canny(img, edges, 100, 200);
    
    cv::Mat result;
    cv::cvtColor(edges, result, cv::COLOR_GRAY2BGR);
    cv::putText(result, "FORENSICS ANALYSIS", cv::Point(50, 50), 
                cv::FONT_HERSHEY_SIMPLEX, 1, cv::Scalar(0, 0, 255), 2);
    
    if (!cv::imwrite(outputPath, result)) throw std::runtime_error("保存失败: " + outputPath);
}

// =======================================================
// 全局监控指标
// =======================================================
struct Metrics {
    std::shared_ptr<prometheus::Registry> registry;
    
    // 请求相关指标
    prometheus::Counter* total_requests;
    prometheus::Counter* failed_requests;
    prometheus::Counter* processed_images;
    
    // 算法调用统计
    prometheus::Counter* watermark_calls;
    prometheus::Counter* forensics_calls;
    
    // 响应时间直方图
    prometheus::Histogram* request_duration;
    
    // 系统状态
    prometheus::Gauge* active_requests;
    
    Metrics() {
        registry = std::make_shared<prometheus::Registry>();
        
        // 构建指标
        auto& total_counter_family = prometheus::BuildCounter()
            .Name("http_requests_total")
            .Help("Total HTTP requests")
            .Register(*registry);
        total_requests = &total_counter_family.Add({});
        
        auto& failed_counter_family = prometheus::BuildCounter()
            .Name("http_requests_failed_total")
            .Help("Total failed HTTP requests")
            .Register(*registry);
        failed_requests = &failed_counter_family.Add({});
        
        auto& images_counter_family = prometheus::BuildCounter()
            .Name("images_processed_total")
            .Help("Total images processed")
            .Register(*registry);
        processed_images = &images_counter_family.Add({});
        
        auto& watermark_counter_family = prometheus::BuildCounter()
            .Name("algorithm_watermark_calls_total")
            .Help("Total watermark algorithm calls")
            .Register(*registry);
        watermark_calls = &watermark_counter_family.Add({});
        
        auto& forensics_counter_family = prometheus::BuildCounter()
            .Name("algorithm_forensics_calls_total")
            .Help("Total forensics algorithm calls")
            .Register(*registry);
        forensics_calls = &forensics_counter_family.Add({});
        
        // 响应时间直方图 (单位: 毫秒)
        auto& duration_family = prometheus::BuildHistogram()
            .Name("http_request_duration_milliseconds")
            .Help("HTTP request duration in milliseconds")
            .Register(*registry);
        request_duration = &duration_family.Add(
            {}, 
            prometheus::Histogram::BucketBoundaries{10, 50, 100, 200, 500, 1000, 2000}
        );
        
        auto& gauge_family = prometheus::BuildGauge()
            .Name("active_requests")
            .Help("Number of active requests")
            .Register(*registry);
        active_requests = &gauge_family.Add({});
    }
};

int main() {
    // =======================================================
    // 初始化 Prometheus Exposer (指标暴露端点)
    // =======================================================
    prometheus::Exposer exposer{"0.0.0.0:9100"};  // Prometheus 默认抓取端口
    auto metrics = std::make_shared<Metrics>();
    
    // 暴露指标给 Prometheus
    exposer.RegisterCollectable(metrics->registry);
    std::cout << "[INFO] Prometheus metrics exposed on http://0.0.0.0:9100/metrics" << std::endl;
    
    // 启动业务 HTTP 服务器
    Server svr;
    svr.new_task_queue = [] { return new ThreadPool(4); };
    
    // 健康检查接口
    svr.Get("/health", [](const Request&, Response& res) {
        res.set_content("C++ Image Service is Running", "text/plain");
    });
    
    // Prometheus 指标端点
    svr.Get("/metrics", [metrics](const Request&, Response& res) {
        res.set_header("Content-Type", "text/plain; version=0.0.4");
        // 这里实际由 exposer 处理，这里只是示例
        res.set_content("# Use port 9100 for Prometheus metrics", "text/plain");
    });
    
    // =======================================================
    // 核心处理接口：添加 Prometheus 埋点
    // =======================================================
    svr.Post("/process", [metrics](const Request& req, Response& res) {
        // 指标更新：活跃请求数 +1
        metrics->active_requests->Increment();
        
        auto start_time = std::chrono::steady_clock::now();
        metrics->total_requests->Increment();
        
        json body;
        std::string input, output, algo;
        bool success = false;
        
        try {
            // 解析请求体
            body = json::parse(req.body);
            input = body["inputPath"];
            output = body["outputPath"];
            algo = body["algorithm"];
            
            std::cout << "[INFO] Processing: " << algo << " | Input: " << input << std::endl;
            
            // 调用对应算法
            if (algo == "watermark") {
                processWatermark(input, output);
                metrics->watermark_calls->Increment();
                success = true;
            } 
            else if (algo == "forensics") {
                processForensics(input, output);
                metrics->forensics_calls->Increment();
                success = true;
            } 
            else {
                throw std::runtime_error("未知算法类型: " + algo);
            }
            
            // 处理成功
            metrics->processed_images->Increment();
            json ret = {{"success", true}, {"algorithm", algo}};
            res.set_content(ret.dump(), "application/json");
            
        } 
        catch (const std::exception& e) {
            // 处理失败
            metrics->failed_requests->Increment();
            std::cerr << "[ERROR] " << e.what() << std::endl;
            
            json err = {{"success", false}, {"error", e.what()}};
            res.status = 500;
            res.set_content(err.dump(), "application/json");
        }
        
        // 计算请求耗时
        auto end_time = std::chrono::steady_clock::now();
        auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
            end_time - start_time).count();
        
        // 记录响应时间
        metrics->request_duration->Observe(duration);
        
        // 活跃请求数 -1
        metrics->active_requests->Decrement();
        
        if (success) {
            std::cout << "[INFO] Request completed in " << duration << "ms" << std::endl;
        }
    });
    
    // =======================================================
    // 简单的业务指标接口
    // =======================================================
    svr.Get("/stats", [metrics](const Request&, Response& res) {
        json stats = {
            {"total_requests", metrics->total_requests->Value()},
            {"failed_requests", metrics->failed_requests->Value()},
            {"processed_images", metrics->processed_images->Value()},
            {"watermark_calls", metrics->watermark_calls->Value()},
            {"forensics_calls", metrics->forensics_calls->Value()},
            {"active_requests", metrics->active_requests->Value()}
        };
        res.set_content(stats.dump(2), "application/json");
    });
    
    // 启动服务器
    std::cout << ">>> HTTP Server 启动成功: http://127.0.0.1:9000" << std::endl;
    svr.listen("127.0.0.1", 9000);
    
    return 0;
}
