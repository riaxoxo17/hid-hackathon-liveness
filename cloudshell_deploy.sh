#!/usr/bin/env bash
# Builds and deploys the kiosk from AWS CloudShell (or any machine with AWS credentials).
# The large model and runtime files are fetched from their original sources and checked.
set -euo pipefail
cd "$(dirname "$0")"

echo "== AWS account"
aws sts get-caller-identity --query Account --output text

echo "== Kiosk app: install"
cd app
npm ci --no-audit --no-fund

echo "== Runtime files from the npm packages"
mkdir -p public/ort public/mediapipe/wasm public/models
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm public/ort/
cp node_modules/@mediapipe/tasks-vision/wasm/* public/mediapipe/wasm/

echo "== Models"
fetch() { # url file sha256
  [ -f "public/models/$2" ] || curl -fsSL -o "public/models/$2" "$1"
  got=$(sha256sum "public/models/$2" | cut -d' ' -f1)
  if [ "$got" = "$3" ]; then echo "ok   $2"; else echo "WARN $2 checksum differs from the tested file ($got)"; fi
}
fetch https://github.com/yakhyo/face-anti-spoofing/releases/download/weights/MiniFASNetV2.onnx MiniFASNetV2.onnx b32929adc2d9c34b9486f8c4c7bc97c1b69bc0ea9befefc380e4faae4e463907
fetch https://github.com/yakhyo/face-anti-spoofing/releases/download/weights/MiniFASNetV1SE.onnx MiniFASNetV1SE.onnx ebab7f90c7833fbccd46d3a555410e78d969db5438e169b6524be444862b3676
fetch https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task face_landmarker.task 64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff

echo "== Kiosk app: build"
npm run build

echo "== Infrastructure"
rm -rf node_modules; cd ../infra
npm ci --no-audit --no-fund
npx --yes aws-cdk@2 bootstrap --require-approval never >/dev/null 2>&1 || true
npx --yes aws-cdk@2 deploy --require-approval never --outputs-file ../outputs.json
echo
echo "== Done. Open this link in Chrome:"
grep -o '"KioskUrl": *"[^"]*"' ../outputs.json | cut -d'"' -f4
