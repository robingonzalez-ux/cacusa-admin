# Source — u2netp (U²-Netp, saliencia / recorte de la pieza)

- Model: U²-Netp, https://github.com/xuebinqin/U-2-Net — License: Apache-2.0 (`LICENSE` en esta carpeta).
- ONNX file: the rembg release artifact (https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx),
  copied byte for byte from the npm package `@planby-tech/rmbg-webgpu@0.2.1` (`models/u2netp.onnx`, whose
  THIRD_PARTY_NOTICES.md redistributes it under Apache-2.0). Not modified.
- Used only for the similarity features (gemelas, "Se parece a", "¿ya existe?", "similar", Lovers): see README,
  "Similitud solo de la pieza".

| File | Size (bytes) | sha256 |
|---|---|---|
| u2netp.onnx | 4574861 | 309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8 |
