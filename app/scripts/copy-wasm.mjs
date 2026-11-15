// Copies the WebAssembly runtimes for the on-device models into public/ so the kiosk
// serves them itself and does not depend on a CDN at the venue.
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('public/ort', { recursive: true });
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  cpSync(`node_modules/onnxruntime-web/dist/${f}`, `public/ort/${f}`);
}
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe/wasm', { recursive: true });
console.log('Copied ONNX Runtime and MediaPipe wasm files into public/');
