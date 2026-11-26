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

### v2.2 (23 nov): gemelas, aviso de duda, acierto real y prototipo de fotos reales

- **Gemelas** (`computeTwins`): para cada pieza, la otra que más se le parece (mejor par de
  referencias del catálogo, solo contra las 12 más parecidas por el promedio; ~0,4 s sin caché,
  luego en memoria/IndexedDB). "Registrar fotos" ordena la lista y "Siguiente pieza sin fotos" por
  la gemela más cercana y muestra "Se confunde con <código>".
- **Aviso de duda**: si el 1ro y el 2do quedan a menos de 0,04, "Duda entre 2 piezas: toma otra
  foto desde otro ángulo" y se resalta "＋ Otra foto" (no con 3 fotos). Mitad de ajuste: avisa en el
  16 % de las búsquedas, atrapa el 83 % de los errores, precisión 45 % (`--doubt`).
- **Acierto real**: al elegir una pieza después de identificar se guarda en localStorage (últimas
  50, sin datos de clientas) el puesto, la cantidad de fotos y los ms por foto; "Registrar fotos"
  muestra "Últimas N identificaciones en este teléfono: X al primer intento · Y s por foto".
- **Prototipo**: con 3 o más fotos reales de una pieza, su promedio normalizado es una referencia
  más (`learnedRefSet`; `--proto`: 81,6 % → 83,4 % hit@1 con 3 fotos simuladas por pieza).

### v2.3 (23 nov): fotos reales aprendidas sin confundir piezas

Cada pieza elegida aprende sola, así que se juntan fotos reales de muchas piezas con el mismo fondo
y luz, y una foto nueva se parecía a las fotos reales de OTRAS piezas (simulado: 91 % → 80 % si
todas tienen 3). Ahora: la foto real se guarda solo con la pieza recortada (`embRef`); con fotos
reales de 8 piezas o más se les resta el fondo común; margen 0,21 (prototipo 0,18)
(`prepareLearnedRefs`, `learnedScore`). `node eval-catalog-refs.mjs … --learned` (hit@1, mitad de
ajuste; a = todas con fotos reales, b = solo la correcta, c = 30 %, d = ninguna):

| | a | b | c | d | peor caso |
|---|---|---|---|---|---|
| v2.2 | 80,4 % | 97,8 % | 75,2 % | 91,2 % | 75,2 % |
| v2.3 | 90,9 % | 93,1 % | 90,4 % | 91,2 % | 90,4 % |

### v2.4 (24 nov): precarga y evaluación con fotos reales

- **Precarga**: al abrir la pestaña Pedidos o "Registrar fotos" se carga el motor y se preparan las
  huellas del catálogo en segundo plano (`prewarmRecognition` / `prepareCatalogShared`), una vez por
  sesión, nunca con Ahorro de datos; si falla no se muestra nada y se reintenta al usarlo.
- **Fotos reales**: `node eval-catalog-refs.mjs --site … --real <carpeta> [--tune]`, con
  `<carpeta>/labels.json` = `[{"file": "a.jpg", "sku": "AN001"}, …]`. Informa acierto con 1 foto
  (total y por categoría), fusión de 2 fotos de la misma pieza, el aviso de calidad y el de duda, y
  la simulación de "foto real aprendida" (otra foto de la pieza como referencia). `--tune` separa
  las piezas en 2 mitades por código y barre `PIECE_BOX`, las vistas de la pieza, el peso del
  color, el umbral de duda y el margen de las fotos reales (ajuste vs prueba).

### v2.5 (24 nov): fotos reales del taller y "✦ Sugerir datos desde la foto"

**Fotos reales** (30 fotos de 15 piezas nuevas, 2 por pieza; las fotos NO están en el repo):
`node eval-catalog-refs.mjs --site … --real <carpeta> --new` inscribe la foto 1 de cada pieza por
el mismo camino que una foto nueva del catálogo (900 px WebP + variantes en vivo) y busca con la 2
(y al revés). Resultado: hit@1 56,7 %, hit@5 83,3 %, dentro de la categoría 66,7 %; frente → frente
65 % vs frente → espalda/lado 40 %. 11 de las 13 confusiones son con OTRA pieza nueva (mismo mantel,
misma mano): el fondo del taller pesa. Probado y no se cambió (n = 15, sin mejora clara en la mitad
de prueba o con retroceso en las fotos sintéticas): peso del color, parámetros de `PIECE_BOX` y
vistas, quitar el "fondo del taller" aprendido de los bordes, y reajustar la proyección con estas
fotos (+3,3–6,7 pt en las reales pero −0,9 a −1,2 pt en las sintéticas). Aviso "no registrada": el
mejor umbral atrapa 50 % de las piezas no registradas con 6 % de falsas alarmas en las reales pero
10,1 % en las sintéticas: no se agregó. Sí cambió: `DOUBT_MARGIN` 0,04 → 0,06. El aviso de foto
oscura/movida no dio falsas alarmas en las 30 fotos (tampoco detectó las 2 movidas: el fondo está nítido).

**Sugerir datos desde la foto** (Nuevo producto): las 7 piezas más parecidas votan categoría,
material y color; precio = mediana de esas 7; nombre y descripción con Claude Haiku
(`/product/describe` del Worker) o, si no está disponible (503 sin clave, 429 tope diario, red),
plantillas por categoría con un aviso. Solo completa campos vacíos o no tocados y marca cada uno
"sugerido" / "sugerido (IA)". Dejando afuera cada producto (`--autofill`, 91): categoría 75,8 %
(84,6 % con voto fuerte; siempre "Anillos" sería 31,9 %), material 68,1 % (siempre "Baño de oro 18k":
61,5 %), precio error mediano $3 / medio $5,8, tono dorado/plateado 70,8 %.

### v2.6 (24 nov): segunda opinión de Claude Haiku cuando el identificador duda

Solo si el 1ro y el 2do quedan a menos de `DOUBT_MARGIN` (0,06), una vez por búsqueda (con varias
fotos, la mejor: sin aviso de calidad, la más nueva), el panel llama a `/identify/rerank` del Worker
con la foto (~512 px JPEG) y las 2–5 primeras candidatas (sus fotos del catálogo, ~384 px, exportadas
del canvas: GitHub Pages manda `Access-Control-Allow-Origin: *` y se cargan con `crossOrigin`). Si
la IA elige una, sube al 1er puesto con "✓ 2ª opinión (IA)" (las demás siguen); si no está segura,
"La IA tampoco está segura: toma otra foto"; si falla (503/429/red/20 s sin respuesta), nada cambia.
Nunca agrega la pieza sola. El registro local de acierto guarda `rr` (1 = la IA confirmó el 1ro,
2 = lo cambió, 3 = no estaba segura) para medir el efecto real.

### v3 (25 nov, `RECOG_VERSION = 3`): EfficientNetV2-B0 + DINOv2-small

Huella = `[√α · v2 (512) ; √(1−α) · DINOv2 (384)]` con α = 0,45, rellenada con ceros hasta 1280
(el Worker no cambia). DINOv2-small (Meta, Apache-2.0; ONNX int8 de onnx-community, 24 MB, ver
`models/dinov2-small/SOURCE.md`) corre con ONNX Runtime Web 1.31.1 **en el repo**
(`vendor/onnxruntime-web/`: `ort.wasm.min.js` + wasm de 14,8 MB, sin CDN). El CSP suma
`'wasm-unsafe-eval'` en `script-src` (sin eso el navegador no compila WebAssembly); no hizo falta
tocar `connect-src`. GitHub Pages no aísla el origen, así que corre con 1 hilo. Si ONNX Runtime o
DINOv2 no cargan, el panel usa v2 (y si tampoco, v1) y en ese modo no guarda fotos reales.

| | v2.5/v2.6 | v3 |
|---|---|---|
| Fotos reales, piezas nuevas (30), hit@1 / hit@5 | 56,7 / 83,3 % | 70,0 / 93,3 % |
| … dentro de la categoría | 66,7 % | 76,7 % |
| Sintético, mitad de ajuste A+B hit@1 | 90,9 % | 91,4 % |
| Sintético, mitad de prueba A+B hit@1 | 90,6 % | 91,2 % |
| Descarga la primera vez | ~13,5 MB | ~53 MB (+ DINOv2 24 MB + wasm 15 MB) |
| DINOv2 por foto (5 vistas, wasm 1 hilo, CPU de escritorio) | — | ~1,8 s |

Probado y descartado: DINOv2 solo (real 80 % pero sintético −4,4 pt), con "registers" (peor),
fp16 (algo mejor pero 44 MB), recorte por saliencia de DINOv2 en lugar de `pieceBox` (peor), GeM de
los parches junto al CLS (no mejora). `tools/build-catalog-refs.mjs` genera también
`models/recog-v3.json`, `models/recog-v3-proj-dino.bin` y `models/catalog-refs-v3.*`.

### v3.1 (25 nov): segunda opinión más barata y en más casos

- `/identify/rerank` recibe la foto a 448 px y las candidatas a 256 px (antes 512 / 384): ~45 %
  menos tokens por llamada. Con ese ahorro se consulta cuando el margen 1ro − 2do es < 0,12 (antes
  0,06; el aviso de duda sigue en 0,06). Si la 4ta candidata está a más de 0,08 del 1ro, van solo 3.
  Con la huella v3 (Haiku 5.5: US$ 0,10 / 0,50 por millón de tokens de entrada / salida; imagen ≈
  ancho × alto / 750 tokens; ~250 de texto y ~40 de salida por llamada, estimados):

| | consultas | errores del 1ro que llegan a consulta | costo por 100 búsquedas |
|---|---|---|---|
| antes (sintético / real) | 25 % / 43 % | 97 % / 89 % | US$ 0,0043 / 0,0073 |
| después (sintético / real) | 37 % / 63 % | 100 % / 100 % | US$ 0,0036 / 0,0060 |

- Probado y descartado: reordenar las 5 primeras con coincidencias de parches de DINOv2 (vecinos
  mutuos dentro de la zona de la pieza): +1 búsqueda real de 30 como mucho, no llega a la regla
  (+2). DINOv3-small (licencia "DINOv3 License" de Meta, no Apache) en lugar de DINOv2: +1 búsqueda
  real y −0,5 pt en la mitad de ajuste sintética; no entra.

### Panel con IA (25 nov)

- **"También te puede gustar"**: cada producto activo guarda `similar` (hasta 8 ids, por coseno
  entre los vectores de producto de la huella v3: promedio de sus referencias). Se calcula con
  "✦ Actualizar recomendaciones" (Productos) o al publicar, solo si el identificador ya preparó el
  catálogo en esa sesión (nunca fuerza la descarga); si no, quedan los valores anteriores.
- **Lovers, "✦ Sugerir 2 piezas"**: candidatas con stock y de acero inoxidable (si no alcanzan,
  cualquiera, con aviso), sin repetir lo que ya recibió la suscriptora (pedidos de Lovers con su
  mismo email, o teléfono) ni piezas muy parecidas (coseno > 0,8); distintas entre sí (otra
  categoría si se puede). Cada una con una línea de por qué y "Agregar"; nunca se agregan solas.
- **Traducción ES→EN de fichas**: `/product/translate` del Worker (Claude Haiku); ante cualquier
  error (503, 429, red) MyMemory como antes, en silencio. Solo traduce campos vacíos.
- **Fondo parejo**: evaluado con u2netp (Apache-2.0, 4,6 MB) y no se agregó: recorta bien piezas
  sueltas sobre fondo liso, pero con la mano, el mantel estampado, cadenas finas o bandejas se
  queda con la mano o el fondo.

### "¿Ya existe?" en Nuevo producto (25 nov)

Al subir la foto de un producto nuevo se compara en segundo plano con el catálogo (huella v3, la
misma que luego reusa "Sugerir datos"). Puntaje del 1ro ≥ 0,55: "Parece que este producto ya
existe"; ≥ 0,40: "Se parece a estos productos" (hasta 3). "Sí, es el mismo: sumar N" lee el stock
(/stock/list; sin dato = 1), llama a /stock/set con stock + N, aprende la foto como foto real de
esa pieza y cierra sin crear el producto. Nunca suma solo; al editar no se revisa.

| umbral | duplicados detectados (sintético / real) | en el top 3 (sintético / real) | falsa alarma en piezas nuevas reales (vs catálogo) | falsa alarma sintética (otra pieza del catálogo) |
|---|---|---|---|---|
| alto ≥ 0,55 | 39 % / 53 % | 39 % / 57 % | 0 % | 1 % (precisión 99 %) |
| medio ≥ 0,40 | 73 % / 67 % | 74 % / 83 % | 0 % | 20 % (precisión 77 %) |

### Regenerar (cuando haya muchos productos nuevos o fotos cambiadas)

```bash
cd tools
npm install && npx playwright install chromium   # una vez
node build-catalog-refs.mjs --download            # baja products.json + fotos de cacusabytaitus.com
# o, con una copia local del repo de la tienda (data/products.json + ui_kits/store/images/):
node build-catalog-refs.mjs --site ../../cacusa
```

Con productos nuevos alcanza `--keep-proj`: no reaprende las proyecciones (usa las de `models/` tal cual) y solo recalcula las referencias (~1 min, las fotos ya calculadas salen de `tools/.cache/`). Sin esa opción, usa TODAS las fotos: `imageUrl` + `images[]` de todos los productos (también los pausados) y las
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
