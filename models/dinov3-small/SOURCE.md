# DINOv3 ViT-S/16 (ONNX) — origen y licencia

> Solo para evaluar el identificador. No publicar en `main`.

## Origen

- Repo ONNX (no gated): https://huggingface.co/onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX
  - Revisión: `48988dfe73065df8d6f5ccc0edc7c8bcf307de41`
- Modelo base (oficial de Meta): https://huggingface.co/facebook/dinov3-vits16-pretrain-lvd1689m
  - Revisión: `114c1379950215c8b35dfcd4e90a5c251dde0d32`
  - **Gated (aprobación manual)**: los pesos devuelven 401 sin aceptar la licencia. No se descargó nada de este repo salvo la tarjeta pública (README).
- Fecha de descarga: 2026-11-25
- URL de cada archivo: `https://huggingface.co/onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX/resolve/48988dfe73065df8d6f5ccc0edc7c8bcf307de41/<ruta>`

## Archivos

| Archivo | Bytes | sha256 |
|---|---:|---|
| `onnx/model_quantized.onnx` (int8, grafo) | 183889 | `7686e8c849202c4fdd67d1cd336449c29bdddbcca535d765d3014f50d04d516d` |
| `onnx/model_quantized.onnx_data` (int8, pesos externos) | 21762048 | `51572f7fc3c272eb574a70509ea1eeb7e674e5ca2cd96fec1632edb38983d529` |
| `config.json` | 835 | `e9f41d1c030ec6589280ba417e630b916d6e4d0e38a3efae15c11aa12c22c984` |
| `preprocessor_config.json` | 585 | `960c41d1f3a7778b936365769a2d90550b318a6c0a53a0296957adacfe5e0dd7` |
| `LICENSE.md` (DINOv3 License, copia del repo ONNX) | 7502 | `aa878c2fe56729d87f735e1cab375b27079aa2ef5f9a06e85456a4ba2c89e7b8` |

Los sha256 de los archivos ONNX coinciden con los metadatos LFS de Hugging Face.

Notas:
- `model_quantized.onnx` usa formato de datos externos: `model_quantized.onnx_data` tiene que estar en la misma carpeta.
- No hay `model_fp16.onnx` en este repo (solo fp32 de 86 MB, q4 e int8), así que no se incluyó.
- Modelo: ViT-S/16, hidden 384, 12 capas, 4 register tokens, entrada 224×224, normalización ImageNet (mean 0.485/0.456/0.406, std 0.229/0.224/0.225).

## Licencia: "DINOv3 License" (Last Updated: August 14, 2025)

Texto completo en `LICENSE.md`. Cláusulas clave, verbatim:

> **1.a Grant of Rights.** You are granted a non-exclusive, worldwide, non-transferable and royalty-free limited license under Meta's intellectual property or other rights owned by Meta embodied in the DINO Materials to use, reproduce, distribute, copy, create derivative works of, and make modifications to the DINO Materials.

> **1.b.i** Distribution of DINO Materials, and any derivative works thereof, are subject to the terms of this Agreement. If you distribute or make the DINO Materials, or any derivative works thereof, available to a third party, you may only do so under the terms of this Agreement and you shall provide a copy of this Agreement with any such DINO Materials.

> **1.b.iv** Your use of the DINO Materials will not involve or encourage others to reverse engineer, decompile or discover the underlying components of the DINO Materials.

> **1.b.v** You are not the target of Trade Controls and your use of DINO Materials must comply with Trade Controls. You agree not to use, or permit others to use, DINO Materials for any activities subject to the International Traffic in Arms Regulations (ITAR) or end uses prohibited by Trade Controls, including those related to military or warfare purposes, nuclear industries or applications, espionage, or the development or use of guns or illegal weapons.

> By clicking "I Accept" below or by using or distributing any portion or element of the DINO Materials, you agree to be bound by this Agreement.

Resumen (no es asesoría legal): la licencia no prohíbe el uso comercial; es gratuita (royalty-free) y permite redistribuir y modificar, siempre que se incluya una copia de la licencia, se cumplan las leyes de control de exportaciones/sanciones y no haya usos militares ni de armas. Meta puede modificar los términos (sección 8) y terminar la licencia si se incumple (sección 6). Usar los pesos implica aceptar la licencia.
