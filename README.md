# CACUSA — panel admin

Panel de administración de CACUSA by Taitus, publicado en **https://admin.cacusabytaitus.com** (GitHub Pages, repo propio).

Vive separado de la tienda (`cacusabytaitus.com`, repo `cacusa`) a propósito: así la sesión del admin no comparte origen con páginas públicas que cargan scripts de terceros.

- Sin build: `index.html` es React + Babel Standalone en el navegador.
- Todo pasa por el Worker `cacusa-admin` (login, pedidos, subir fotos). Cuando se publica el catálogo, el Worker lo commitea a `data/products.json` en el repo `cacusa`, no acá.
- `sw.js`: service worker de avisos push.

## Reconocimiento por foto ("📷 Agregar pieza con foto")

Gratis y en el navegador (TF.js 4.22.0, WebGL). La foto del taller se convierte en una huella de
1280 números y se compara con las huellas del catálogo y con las fotos reales que ya se le
enseñaron (el Worker las guarda en `/identify/refs`, 1280 bytes int8 cada una, máx. 10 por pieza).

### v2 (22 nov, `RECOG_VERSION = 2`)

| Archivo | Qué es | Tamaño |
|---|---|---|
| `models/effv2b0_288/` | EfficientNetV2-B0 (ImageNet, Keras Applications, Apache 2.0) a 288 px, float16. Sale el GeM de la última capa (1280) + el de una capa media (672) | 11,7 MB |
| `models/recog-v2.json` | manifiesto: versión de la huella, vistas, pesos, calibración del % | 1 KB |
| `models/recog-v2-proj.bin` | proyección *learned whitening* 1952 → 512 (int8 por columna) | 1,0 MB |
| `models/catalog-refs-v2.bin` + `.json` | referencias precalculadas (13 por foto: base + 12 variantes; 512 int8 por vector) | 0,9 MB |

Huella de una foto: se estima la zona de la joya (`pieceBox`: distancia al color de los bordes,
Otsu) y se promedian 5 vistas (foto entera, centro 80 %, centro 60 %, pieza recortada con margen
1,25 y 1,6); cada vista = partes normalizadas de las 2 capas; promedio → proyección → normalizada
→ rellenada con ceros hasta 1280 (el Worker no cambia). Puntaje = 0,95 × coseno (mejor entre
foto del catálogo, fotos reales aprendidas y variantes − 0,03) + 0,05 × color.

Si `models/recog-v2.json` (o la red/proyección) no carga, el panel usa solo v1 (MobileNet v2,
`models/mobilenet_v2/` + `models/catalog-refs-v1.*`) y en ese modo **no guarda** fotos
aprendidas, para no mezclar huellas de dos versiones.

**Fotos reales aprendidas al pasar de v1 a v2**: el Worker no guarda la versión de cada una, así
que las que hay se tratan como v2. La primera vez que se abre el panel con v2, si el Worker tiene
alguna, aparece un aviso único con "Borrar fotos viejas" (llama `/identify/ref/clear` por pieza)
o "Mantenerlas". Nunca se borran solas. (Al 22 nov no había fotos reales registradas.)

Medido (fotos de prueba sintéticas, `eval-transforms.js`; productos separados en mitad para
ajustar / mitad de prueba — cifras de la mitad de prueba, 4 fotos por modo y producto):

| | hit@1 | hit@5 | con categoría hit@1 | hit@5 |
|---|---|---|---|---|
| v1 — A+B (pieza chica/descentrada + recorte con dedo) | 55,3 % | 80,9 % | 70,0 % | 87,5 % |
| v2 — A+B | 90,6 % | 96,9 % | 94,4 % | 98,1 % |
| v2 — A+B, proyección aprendida SIN esos productos (pieza nueva) | 89,1 % | 96,2 % | 92,5 % | 98,4 % |

Qué aporta cada parte (mitad de prueba, A+B hit@1): EfficientNetV2-B0 en vez de MobileNet v2 con
el mismo método (80 → 86 a 224 px; 90,6 a 288 px), proyección *learned whitening* (63 → 91 con la
misma red), aislamiento de la pieza (87,5 → 90,6), capa media (86 → 90,6). Probado y descartado por no mejorar:
concatenar más capas medias, voltear la foto, re-ranking (expansión de consulta, media de las 2
mejores), color de la zona de la pieza, más peso al color, MobileNetV3, EfficientNet-B0/V2-B1.

### v2.1 (22 nov): varias fotos, "Marca la joya", consejo de toma y desempate por stock

- **Varias fotos** (hasta 3, "＋ Otra foto (otro ángulo)"): una sola búsqueda con el promedio de
  los puntajes de cada producto + 0,02 por cada foto extra en la que sale 1ro (`rankCatalogMulti`);
  al elegir la pieza aprende de todas las fotos. Mitad de prueba, hit@1: 1 foto 90,9 % → 2 fotos
  98,1 % → 3 fotos 100 % (`node eval-catalog-refs.mjs … --multi`).
- **"Marca la joya"**: recuadro (mouse, dedo o teclado) sobre la foto, precargado con la zona
  automática (`pieceBox`); si se marca, la huella usa `MANUAL_VIEWS` (centro 80/60 % + la zona con
  margen 1, 1,25 y 1,6). Con la caja exacta da lo mismo que la automática en las fotos de prueba
  (91,3 % vs 90,9 % hit@1, `--box`): sirve cuando la zona automática se equivoca (fondos con cosas).
- **Consejo de toma** ("fondo liso claro, sin sombra, que la joya llene el cuadro", con un cuadro
  guía) donde se toma una foto para el identificador, y aviso que no bloquea si la foto salió
  oscura (luminancia media < 62) o movida (varianza del laplaciano en la zona de la pieza < 100,
  gris de 160 px). Ninguna foto del catálogo lo dispara (`--quality`).
- **Desempate por stock** (`stockTiebreak`): si 2 candidatas seguidas están a ≤ 0,01 y la de arriba
  tiene stock 0 y la de abajo > 0, sube la que tiene stock. Nunca oculta piezas con stock 0.

### Regenerar (cuando haya muchos productos nuevos o fotos cambiadas)

```bash
cd tools
npm install && npx playwright install chromium   # una vez
node build-catalog-refs.mjs --download            # baja products.json + fotos de cacusabytaitus.com
# o, con una copia local del repo de la tienda (data/products.json + ui_kits/store/images/):
node build-catalog-refs.mjs --site ../../cacusa
```

Usa TODAS las fotos: `imageUrl` + `images[]` de todos los productos (también los pausados) y las
fotos de `ui_kits/store/images/` que ya no usa ningún producto (estas últimas solo para aprender
la proyección). Por cada foto calcula, con el código del propio panel (bloque entre
`// @@recog-begin` y `// @@recog-end` de `index.html`, sin JSX) en Chromium headless (backend
wasm), el descriptor sin proyectar de la foto y de 12 variantes (`augmentPhoto`: mesa, recorte,
giro, luz, desenfoque, espejo); aprende la proyección (autovalores de 2 matrices 1952×1952 con
`ml-matrix`) y escribe los 4 archivos de `models/` de la tabla. Tarda ~15 min; guarda los
descriptores en `tools/.cache/` para no recalcular las fotos que no cambiaron. Opciones: `--n 12`,
`--tfjs <tf.min.js>` si no hay acceso a cdn.jsdelivr.net.

El panel usa las referencias de una foto **solo si el producto sigue teniendo esa misma URL de
foto**; para productos nuevos o con foto cambiada calcula 4 variantes en el momento (misma
función, misma semilla) y las guarda en IndexedDB. Si se cambia algo de la huella (red, vistas,
capas, proyección), cambiar `emb` en `SPEC` de `build-catalog-refs.mjs`, regenerar y subir
`RECOG_VERSION` si las huellas dejan de ser comparables. Si se cambia `augmentPhoto`, subir
`AUG_VERSION` y regenerar. La red se exporta con `tools/export-effv2b0.py` (TensorFlow 2.15 +
tensorflowjs 4.17, pesos de storage.googleapis.com/tensorflow/keras-applications).

### Medir

`node eval-catalog-refs.mjs --site ../../cacusa --cache /tmp/q.json --panel` arma fotos de
prueba con transformaciones distintas a las del entrenamiento (`eval-transforms.js`) y compara
hit@1/hit@5 sin y con las referencias precalculadas, con y sin filtro de categoría, con las
funciones reales del panel (`prepareCatalogEmbeddings` + `rankCatalog`).
