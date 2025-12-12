cmake_minimum_required(VERSION 3.10)
project(ImageService)

# ============================================
# 1. 启用 vcpkg 集成
# ============================================
set(CMAKE_TOOLCHAIN_FILE "/opt/vcpkg/scripts/buildsystems/vcpkg.cmake" CACHE STRING "")

# ============================================
# 2. 手动设置所有依赖库的配置文件路径
# ============================================
set(civetweb_DIR "/opt/vcpkg/installed/x64-linux/share/civetweb")
set(prometheus-cpp_DIR "/opt/vcpkg/installed/x64-linux/share/prometheus-cpp")

# ============================================
# 3. 查找依赖包
# ============================================
# 查找 OpenCV（使用传统模式）
find_package(OpenCV REQUIRED)
# 查找 prometheus-cpp
find_package(prometheus-cpp CONFIG REQUIRED)

# ============================================
# 4. 创建可执行文件
# ============================================
add_executable(image-service main.cpp)

# ============================================
# 5. 包含头文件目录（OpenCV 传统方式需要）
# ============================================
target_include_directories(image-service PRIVATE ${OpenCV_INCLUDE_DIRS})

# ============================================
# 6. 链接所有必需的库（关键修改部分）
# ============================================
target_link_libraries(image-service
    PRIVATE
        # OpenCV 库（使用传统变量，而非导入目标）
        ${OpenCV_LIBS}
        # 或者显式列出（如果 ${OpenCV_LIBS} 不起作用）：
        # opencv_core
        # opencv_imgproc
        # opencv_imgcodecs
        
        # Prometheus 监控库
        prometheus-cpp::core
        prometheus-cpp::pull
        prometheus-cpp::util
        
        # 系统库
        pthread
        ${CMAKE_DL_LIBS}  # 有时需要链接 dl 库
)

# ============================================
# 7. 设置 C++ 标准
# ============================================
set_target_properties(image-service PROPERTIES
    CXX_STANDARD 11
    CXX_STANDARD_REQUIRED ON
)

# ============================================
# 8. 可选：打印调试信息
# ============================================
message(STATUS "OpenCV found: ${OpenCV_VERSION}")
message(STATUS "OpenCV libs: ${OpenCV_LIBS}")
message(STATUS "OpenCV include dirs: ${OpenCV_INCLUDE_DIRS}")
