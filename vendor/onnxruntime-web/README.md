# onnxruntime-web 1.31.1 (vendored)

Copied from the npm package `onnxruntime-web@1.31.1` (`dist/`), MIT License, © Microsoft Corporation
(https://github.com/microsoft/onnxruntime). Only the WebAssembly build is vendored:

- `ort.wasm.min.js` — runtime (WebAssembly execution provider only)
- `ort-wasm-simd-threaded.mjs` / `ort-wasm-simd-threaded.wasm` — loader and binary

Used by the photo identifier (DINOv2-small, `models/dinov2-small/`). Served from this repo, no CDN.
WebAssembly needs `'wasm-unsafe-eval'` in the CSP `script-src`.
