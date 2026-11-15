import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Set VITE_API to the deployed site (https://xxxx.cloudfront.net) to use the AWS backend from localhost.
export default defineConfig({
  plugins: [react()],
  server: { proxy: process.env.VITE_API ? { '/api': { target: process.env.VITE_API, changeOrigin: true } } : undefined },
  preview: { proxy: process.env.VITE_API ? { '/api': { target: process.env.VITE_API, changeOrigin: true } } : undefined },
  build: { chunkSizeWarningLimit: 3000 },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
