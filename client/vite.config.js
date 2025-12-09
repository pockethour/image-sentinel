import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],

    // 构建配置 (可选，但推荐用于生产环境路径)
    build: {
        // 确保生产环境构建路径正确（默认为 /）
        outDir: 'dist',
        emptyOutDir: true,
    },

    // 开发服务器配置 (可选，通常用于代理后端 API，但在这里我们使用 CORS 即可)
    server: {
        port: 5173, // 默认端口，确保在后端 server.js 中 CORS 设置了允许访问
        host: '0.0.0.0', // 允许局域网访问，方便移动端测试
    }
});