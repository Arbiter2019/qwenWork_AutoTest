import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [react()], build: { outDir: '../../dist/web', emptyOutDir: true, rollupOptions:{output:{manualChunks(id){if(id.includes('node_modules')){if(/node_modules\/(react|react-dom|scheduler)\//.test(id))return 'react';if(/node_modules\/(antd|@ant-design|@rc-component|rc-)/.test(id))return 'antd';return 'vendor';}}}} }, server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4317' } } });
