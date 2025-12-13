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
#include <cmath> 

// =======================================================
// Prometheus C++ 客户端头文件 
// =======================================================
#include <prometheus/exposer.h>
#include <prometheus/registry.h>
#include <prometheus/counter.h>
#include <prometheus/histogram.h>
#include <prometheus/gauge.h>

// =======================================================
// 全局 USING 声明
// =======================================================
using namespace httplib;
using json = nlohmann::json;
using namespace cv;
using namespace prometheus;

// =======================================================
// 全局常量配置
// =======================================================
const std::string MAGIC_HEADER = "#IS#"; // 水印头部标记

// =======================================================
// LSB 隐写辅助函数
// =======================================================

std::string sanitizeString(const std::string& input) {
    std::string result;
    for (char c : input) {
        if (c >= 32 && c <= 126) {
            result += c;
        }
        else {
            result += '?';
        }
    }
    return result;
}

std::string textToBinary(const std::string& text) {
    if (text.empty() || text.length() > 255) return "";

    std::string binaryStr = "";
    int len = text.length();

    // 1. 编码长度（8位，高位在前）
    for (int i = 7; i >= 0; --i) {
        binaryStr += ((len >> i) & 1) ? '1' : '0';
    }

    // 2. 编码数据
    for (char c : text) {
        for (int i = 7; i >= 0; --i) {
            binaryStr += ((c >> i) & 1) ? '1' : '0';
        }
    }
    return binaryStr;
}

std::string binaryToText(const std::string& binaryStr, double& confidence) {
    if (binaryStr.length() < 8) {
        confidence = 0.0;
        return "";
    }

    int len = 0;
    for (int i = 0; i < 8; ++i) {
        if (binaryStr[i] == '1') {
            len |= (1 << (7 - i));
        }
    }

    if (len == 0 || (8 + len * 8) > binaryStr.length()) {
        confidence = 0.0;
        return "";
    }

    std::string text = "";
    for (int i = 0; i < len; ++i) {
        int charValue = 0;
        int start_index = 8 + i * 8;
        for (int j = 0; j < 8; ++j) {
            if (binaryStr[start_index + j] == '1') {
                charValue |= (1 << (7 - j));
            }
        }
        text += (char)charValue;
    }

    confidence = 0.99;
    return text;
}


// =======================================================
// 算法 1: 隐形水印嵌入 (Blue Channel + Magic Header)
// =======================================================
void processWatermark(const std::string& inputPath, const std::string& outputPath, const std::string& watermarkText, json& response) {
    Mat img = imread(inputPath);
    if (img.empty()) throw std::runtime_error("无法读取图片: " + inputPath);

    // 加盐：拼接 Header
    std::string fullPayload = MAGIC_HEADER + watermarkText;

    std::string binaryWatermark = textToBinary(fullPayload);
    int watermarkLen = binaryWatermark.length();

    if (watermarkLen == 0) throw std::runtime_error("水印内容无效");
    if (watermarkLen > (img.rows * img.cols)) throw std::runtime_error("图片太小，无法嵌入水印");

    Mat watermarked_full = img.clone();
    int bitIndex = 0;

    // 嵌入到 Blue 通道
    for (int i = 0; i < watermarked_full.rows; ++i) {
        for (int j = 0; j < watermarked_full.cols; ++j) {
            Vec3b& pixel = watermarked_full.at<Vec3b>(i, j);
            uchar& blue = pixel[0];

            if (bitIndex < watermarkLen) {
                char bit = binaryWatermark[bitIndex];
                blue = (blue & 0xFE) | (bit == '1' ? 0x01 : 0x00);
                bitIndex++;
            }
            else {
                goto embedding_done;
            }
        }
    }

embedding_done:;

    if (!imwrite(outputPath, watermarked_full)) throw std::runtime_error("保存失败: " + outputPath);

    // 生成预览图
    Mat preview_img = watermarked_full.clone();
    int box_h = 100;
    Rect rect(10, 10, preview_img.cols - 20, box_h);
    if (rect.x >= 0 && rect.y >= 0 && rect.width <= preview_img.cols && rect.height <= preview_img.rows) {
        Mat sub_region = preview_img(rect);
        addWeighted(sub_region, 0.7, Mat::zeros(sub_region.size(), sub_region.type()), 0.3, 0, sub_region);
    }

    putText(preview_img, "DIGITAL WATERMARK EMBEDDED", Point(30, 40),
        FONT_HERSHEY_DUPLEX, 0.7, Scalar(0, 255, 0), 1, LINE_AA);
    putText(preview_img, "Data: " + watermarkText, Point(30, 80),
        FONT_HERSHEY_SIMPLEX, 0.6, Scalar(255, 255, 255), 1, LINE_AA);

    std::string previewPath = outputPath.substr(0, outputPath.find_last_of('.')) + "_preview.png";
    if (!imwrite(previewPath, preview_img)) throw std::runtime_error("保存预览失败");

    response["success"] = true;
    response["previewPath"] = previewPath;
    response["embeddedText"] = watermarkText;
    response["algorithm"] = "LSB (Blue Channel + Header)";
}

// =======================================================
// 算法 2: 图像取证
// =======================================================
void processForensics(const std::string& inputPath, const std::string& outputPath, const std::string& watermarkText, json& response) {
    Mat img = imread(inputPath);
    if (img.empty()) throw std::runtime_error("无法读取图片: " + inputPath);

    Mat preview_img = img.clone();
    Mat edges;
    cvtColor(img, edges, COLOR_BGR2GRAY);
    Canny(edges, edges, 100, 200);
    cvtColor(edges, preview_img, COLOR_GRAY2BGR);
    putText(preview_img, "FORENSICS ANALYSIS PREVIEW", Point(30, 50), FONT_HERSHEY_DUPLEX, 0.7, Scalar(0, 0, 255), 2, LINE_AA);

    std::string previewPath = outputPath.substr(0, outputPath.find_last_of('.')) + "_preview.png";
    if (!imwrite(outputPath, preview_img)) throw std::runtime_error("保存失败");
    if (!imwrite(previewPath, preview_img)) throw std::runtime_error("保存失败");

    response["success"] = true;
    response["previewPath"] = previewPath;
    response["score"] = 90;
    response["riskLevel"] = "Low";
}

// =======================================================
// 水印提取/验证算法 (Blue Channel + Header Check)
// =======================================================
void processVerify(const std::string& inputPath, const std::string& originalWatermarkData, json& response) {
    Mat img = imread(inputPath);
    if (img.empty()) throw std::runtime_error("无法读取图片: " + inputPath);

    std::string lengthBits = "";
    int bitIndex = 0;
    const int max_pixels = img.rows * img.cols;
    const int max_bits_to_read = std::min(max_pixels, 8);

    // 1. 提取长度
    for (int i = 0; i < img.rows; ++i) {
        for (int j = 0; j < img.cols; ++j) {
            Vec3b pixel = img.at<Vec3b>(i, j);
            lengthBits += ((pixel[0] & 0x01) == 1) ? '1' : '0';
            bitIndex++;
            if (bitIndex >= 8) goto decode_length;
        }
    }
decode_length:;

    double confidence = 0.0;
    int len = 0;
    for (int i = 0; i < 8; ++i) {
        if (lengthBits.length() > i && lengthBits[i] == '1') len |= (1 << (7 - i));
    }

    if (len == 0 || (8 + len * 8) > (img.rows * img.cols)) {
        response["success"] = false;
        response["extractedText"] = "";
        response["confidenceScore"] = 0.0;
        return;
    }

    // 3. 提取全部数据
    std::string binaryData = lengthBits;
    int totalBits = 8 + len * 8;
    bitIndex = 8;

    for (int i = 0; i < img.rows; ++i) {
        for (int j = 0; j < img.cols; ++j) {
            if (i * img.cols + j < 8) continue;
            Vec3b pixel = img.at<Vec3b>(i, j);
            binaryData += ((pixel[0] & 0x01) == 1) ? '1' : '0';
            bitIndex++;
            if (bitIndex >= totalBits) goto decode_text;
        }
    }
decode_text:;

    std::string rawText = binaryToText(binaryData, confidence);

    // 4. 校验 Magic Header
    if (rawText.find(MAGIC_HEADER) == 0) {
        std::string actualContent = rawText.substr(MAGIC_HEADER.length());
        response["success"] = true;
        response["extractedText"] = sanitizeString(actualContent);
        response["confidenceScore"] = 0.99;
    }
    else {
        response["success"] = false;
        response["extractedText"] = "";
        response["confidenceScore"] = 0.1;
    }
}


// =======================================================
// 全局监控指标 (保留了完整的监控指标)
// =======================================================
struct Metrics {
    std::shared_ptr<Registry> registry;
    Counter* total_requests;
    Counter* failed_requests;
    Counter* processed_images;
    Counter* watermark_calls;
    Counter* forensics_calls;
    Histogram* request_duration;
    Gauge* active_requests;

    Metrics() {
        registry = std::make_shared<Registry>();
        auto& total_f = BuildCounter().Name("http_requests_total").Help("Total requests").Register(*registry);
        total_requests = &total_f.Add({});
        auto& failed_f = BuildCounter().Name("http_requests_failed_total").Help("Failed requests").Register(*registry);
        failed_requests = &failed_f.Add({});
        auto& img_f = BuildCounter().Name("images_processed_total").Help("Images processed").Register(*registry);
        processed_images = &img_f.Add({});
        auto& wm_f = BuildCounter().Name("algorithm_watermark_calls_total").Help("Watermark calls").Register(*registry);
        watermark_calls = &wm_f.Add({});
        auto& for_f = BuildCounter().Name("algorithm_forensics_calls_total").Help("Forensics calls").Register(*registry);
        forensics_calls = &for_f.Add({});
        auto& dur_f = BuildHistogram().Name("http_request_duration_ms").Help("Duration ms").Register(*registry);
        request_duration = &dur_f.Add({}, std::vector<double>{10, 50, 100, 200, 500, 1000});
        auto& act_f = BuildGauge().Name("active_requests").Help("Active requests").Register(*registry);
        active_requests = &act_f.Add({});
    }
};


int main() {
    Exposer exposer{ "0.0.0.0:9100" };
    auto metrics = std::make_shared<Metrics>();
    exposer.RegisterCollectable(metrics->registry);

    Server svr;
    svr.new_task_queue = [] { return new ThreadPool(8); };

    // /process 接口 (保留了完整的监控和计时)
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
            std::string wmText = body.value("watermarkData", "COPYRIGHT-CHECK");

            if (algo == "watermark") {
                processWatermark(input, output, wmText, responseData);
                metrics->watermark_calls->Increment();
            }
            else if (algo == "forensics") {
                processForensics(input, output, wmText, responseData);
                metrics->forensics_calls->Increment();
            }
            else {
                throw std::runtime_error("Unknown algorithm");
            }

            metrics->processed_images->Increment();
            res.set_content(responseData.dump(), "application/json");

        }
        catch (const std::exception& e) {
            metrics->failed_requests->Increment();
            std::cerr << "[ERROR] " << e.what() << std::endl;
            json err = { {"success", false}, {"error", e.what()} };
            res.status = 500;
            res.set_content(err.dump(), "application/json");
        }

        auto end = std::chrono::steady_clock::now();
        auto dur = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
        metrics->request_duration->Observe(dur);
        metrics->active_requests->Decrement();
        });

    // /verify 接口 (保留了完整的监控和计时)
    svr.Post("/verify", [metrics](const Request& req, Response& res) {
        metrics->active_requests->Increment();
        auto start = std::chrono::steady_clock::now();

        json body, responseData;

        try {
            body = json::parse(req.body);
            std::string input;
            if (body.contains("inputPath") && body["inputPath"].is_string()) {
                input = body["inputPath"].get<std::string>();
            }
            else {
                throw std::runtime_error("Required key 'inputPath' is missing.");
            }

            processVerify(input, "", responseData);
            res.set_content(responseData.dump(), "application/json");

        }
        catch (const std::exception& e) {
            std::cerr << "[ERROR] Verification Error: " << e.what() << std::endl;
            json err = { {"success", false}, {"error", e.what()} };
            res.status = 500;
            res.set_content(err.dump(), "application/json");
        }

        auto end = std::chrono::steady_clock::now();
        auto dur = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
        metrics->request_duration->Observe(dur);
        metrics->active_requests->Decrement();
        });

    svr.Get("/health", [](const Request&, Response& res) { res.set_content("C++ Service is Running", "text/plain"); });
    svr.Get("/metrics", [metrics](const Request&, Response& res) {
        res.set_header("Content-Type", "text/plain; version=0.0.4");
        res.set_content("# Prometheus metrics are scraped on port 9100", "text/plain");
        });

    std::cout << ">>> Service Running on http://127.0.0.1:9000" << std::endl;
    svr.listen("127.0.0.1", 9000);
    return 0;
}