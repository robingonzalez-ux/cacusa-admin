# CACUSA — panel admin

Panel de administración de CACUSA by Taitus, publicado en **https://admin.cacusabytaitus.com** (GitHub Pages, repo propio).

Vive separado de la tienda (`cacusabytaitus.com`, repo `cacusa`) a propósito: así la sesión del admin no comparte origen con páginas públicas que cargan scripts de terceros.

- Sin build: `index.html` es React + Babel Standalone en el navegador.
- Todo pasa por el Worker `cacusa-admin` (login, pedidos, subir fotos). Cuando se publica el catálogo, el Worker lo commitea a `data/products.json` en el repo `cacusa`, no acá.
- `sw.js`: service worker de avisos push.

## Navegación e Inicio (27 nov)

- **Inicio** (pantalla por defecto): pedidos por preparar (Nuevo / Confirmado / En proceso), cajas de
  Lovers sin sus 2 piezas, agotados (activos con stock 0), "se están acabando" (stock 1 y vendidos en
  los últimos 30 días) y ventas de hoy vs. ayer (misma cuenta que Ventas). Cada tarjeta abre su vista
  filtrada; accesos rápidos: Nuevo producto, Agregar pieza (lleva a Pedidos: la pieza se carga dentro
  de un pedido), Registrar fotos y Preparar pedidos (tablero).
- **Teléfono (< 768 px)**: barra inferior fija Inicio · Productos · Pedidos · Ventas · Más; "Más" abre
  las demás secciones agrupadas (Clientas, Marketing, Tienda, Ajustes). **Escritorio**: barra lateral
  con los mismos grupos y "Publicar cambios" arriba (gris si no hay nada que publicar).
- **Cambios sin publicar**: `dirty` sigue mandando (publish() no cambió); el panel solo cuenta cuántos
  cambios hay contra lo último cargado/publicado (piezas nuevas/editadas/borradas, el orden y cada
  bloque de configuración). En el teléfono aparece la barra "Tienes N cambios sin publicar · Publicar".
- **WhatsApp para pedidos** vive en Ajustes. Los avisos de pedidos (antes 🔔) están en Ajustes y en el
  menú de la cuenta.
- **Productos**: vista de lista (por defecto en el teléfono; stock − / + que guarda con `/stock/set`
  un instante después del último toque, ⋯ con Pausar/Activar y Eliminar) o cuadrícula (por defecto en
  escritorio); la elección se recuerda por tipo de pantalla (`cacusa-admin-prodview-m` / `-d`).
  Etiquetas, Selección múltiple, Registrar fotos, Actualizar recomendaciones, Ordenar (▲▼) y TikTok
  Shop están en "Herramientas".
- **Foto del producto**: una sola vista previa cuadrada con el encuadre de la tienda (focalX/focalY/
  zoom), con "Cambiar foto", ✕ y "Ajustar encuadre" (arrastrar, flechas, − / +) sobre la misma foto.

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
  queda con la mano o el fondo. (28 nov: sí se usa u2netp para la similitud entre productos, ver
  "Similitud solo de la pieza".)

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

### Similitud solo de la pieza (28 nov)

Robin vio que las funciones que comparan productos entre sí juntaban piezas por el **fondo**: los 8
anillos fotografiados en la misma bandeja gris sobre el cartel rosado salían "gemelos", AN023 y AN025
(misma plantilla beige con el logo y los íconos) "parecidos", y "Se parece a" de Sugerir datos mostraba
anillos que no tenían nada que ver. Ahora **gemelas** ("Se parece a" en Registrar fotos), **Sugerir
datos** (vecinas, voto de categoría/material/precio), **"¿ya existe?"**, **"similar"** de la tienda y
**Lovers** ("no parecido a lo que ya recibió") usan una huella aparte, solo de la pieza:

1. **u2netp** (U²-Netp, Apache-2.0, 4,6 MB, `models/u2netp/`, ver `SOURCE.md`; corre en el mismo ONNX
   Runtime que DINOv2) estima lo saliente de la foto. Si lo saliente es un contenedor (más del 35 % de
   la foto y tocando 2 bordes o más: la bandeja), se acerca a esa zona y prueba otra vez (hasta 3
   pasadas; el acercamiento vale solo si da algo compacto y seguro).
2. Se recorta a la pieza (el logo y los íconos de la plantilla no son salientes: quedan afuera) y todo
   lo demás pasa a **blanco** (máscara suave). Si lo saliente es un exhibidor (busto, mano de maniquí:
   ≥ 33 % de la foto y mayormente gris claro sin color), esos píxeles también pasan a blanco.
3. Huella v3 de siempre sobre ese recorte (`embedPiece`).

Una foto en la que la pieza no se puede aislar (la bandeja con el anillo diminuto: AN008, AN010,
AN013; la hoja de stickers de HO001; fotos con modelo) **no participa**: mejor no comparar que comparar
fondos. Esos productos quedan sin gemela, con "similar" vacío y fuera de las listas de los demás hasta
que tengan foto de producto (fondo blanco). "¿ya existe?" igual reconoce la **misma foto** (coseno de la
foto entera ≥ `DUP_SAME` = 0,93; dos piezas distintas del catálogo nunca pasan de 0,84). El
**identificador** (Pedidos, "Agregar pieza con foto", fotos reales aprendidas, el Worker) **no cambia**.

Archivos: `models/catalog-refs-v3-piece.json` + `.bin` (1 vector int8 de 896 por foto de producto;
`offset: null` = no se pudo aislar) los genera `tools/build-catalog-refs.mjs` (también con
`--keep-proj`, sin reaprender proyecciones); `models/recog-v3.json` suma la sección `piece`. Las fotos
nuevas o cambiadas se calculan en el panel (u2netp se baja la primera vez que hace falta, ~1 s + la
huella por foto) y se guardan en IndexedDB. Sin u2netp (motor v2/v1 de respaldo) estas funciones usan
la foto entera como antes. "Similar" al publicar se recalcula solo si las huellas de pieza ya estaban
listas en la sesión (nunca con la foto entera).

Medido con `node tools/eval-piece-sim.mjs --site … [--real <carpeta>]` (funciones reales del panel;
fotos del catálogo al 26 nov, 96 productos / 145 fotos; las 30 fotos reales del taller NO están en el
repo). Coseno entre las fotos ancla:

| pares | foto entera | solo pieza |
|---|---|---|
| bandeja (AN006–AN013, piezas distintas), máx / media / ≥ umbral de gemela | 0,84 / 0,55 / 4 de 15 | 0,28 / 0,21 / 0 (3 de 6 sin pieza aislable) |
| plantilla AN021–AN027 + AR003–AR006, máx / media | 0,64 / 0,19 | 0,64 / 0,22 (0 gemelas con 0,66) |
| AN023–AN025 | 0,64 | 0,62 |
| AN031–AN033 (solitarios dorados tubulares, sí parecidos) | 0,79 | 0,79 |
| AN032–AN003 / AN032–AN033 | 0,60 / 0,52 | 0,60 / 0,50 |
| busto CA010–CA017 (cadenas finas con dije), máx / media | 0,80 / 0,67 | 0,79 / 0,53 |

Cambio de fondo (17 piezas de fotos con fondo blanco, recortadas y pegadas en otros fondos sacados del
catálogo con la pieza borrada): misma pieza en ese fondo vs en blanco (media) | dos piezas distintas en
el mismo fondo (media):

| fondo | foto entera | solo pieza |
|---|---|---|
| plantilla beige con logo | 0,81 \| 0,19 | 0,95 \| 0,14 |
| otra plantilla (piedra) | 0,56 \| 0,40 | 0,94 \| 0,14 |
| bandeja, pieza chica (como las fotos reales) | −0,02 \| 0,83 | 0,74 \| 0,19 (3 de 17 sin aislar) |
| bandeja, pieza grande | 0,34 \| 0,48 | 0,80 \| 0,12 |
| terciopelo | 0,83 \| 0,20 | 0,91 \| 0,15 |
| cartel rosado | 0,53 \| 0,28 | 0,89 \| 0,14 |

Umbrales recalibrados (productos separados en mitades por código; se eligió con la de ajuste):

- `TWIN_MIN` 0,55 → **0,66**: gemelas 24 → 13 pares; ya ninguna por la bandeja (antes 4) ni por la
  plantilla; quedan AN031–AN033 y 12 pares de cadenas finas con dije del busto (piezas de verdad
  parecidas; el busto se blanquea).
- `SUGGEST_MIN` 0,40 → **0,60** (`SUGGEST_GAP` sigue 0,10): ninguna pieza nueva real llega a 0,50; de la
  plantilla solo pasan los 2 pares más cercanos (AN021–AN026 0,64, AN023–AN025 0,62: anillos dorados
  esculpidos, parecido de la pieza, no del fondo).
- Lovers: "muy parecida a lo que ya recibió" = coseno de pieza > `TWIN_MIN` (antes > 0,8 con la foto
  entera); una pieza sin pieza aislada cuenta como no parecida.
- `DUP_HIGH` 0,55 → **0,66** (= `TWIN_MIN`: AN023/AN025 ya no son "ya existe"), `DUP_MEDIUM` 0,40 → **0,50**. "¿ya existe?" (detecta = el 1ro es la pieza
  correcta y pasa el umbral, con fotos del taller sintéticas y otra foto del producto; precisión =
  avisos correctos / avisos, contando como falsa alarma cada producto contra el catálogo sin él y las
  piezas nuevas reales). "Antes" = foto entera sin variantes ni color, mismo cálculo:

| | antes ajuste / prueba | ahora ajuste / prueba |
|---|---|---|
| alto (antes ≥ 0,55, ahora ≥ 0,66): precisión | 71 / 67 % | 88 / 85 % |
| alto: detecta | 37 / 35 % | 25 / 22 % |
| medio (antes ≥ 0,40, ahora ≥ 0,50): precisión | 72 / 68 % | 77 / 76 % |
| medio: detecta | 68 / 63 % | 41 / 42 % |
| falsa alarma en piezas nuevas reales (medio) | 0 / 0 % | 0 / 0 % |

Con la pieza sola el aviso medio avisa menos (las fotos sintéticas del taller cortan la pieza o la
tapan con un dedo) pero se equivoca menos. Probado y descartado: máscara por distancia al color del
borde en vez de u2netp (no saca el logo ni las sombras de la plantilla), blanquear siempre los grises
claros (borra las piezas plateadas), solo la parte DINOv2 o solo EfficientNet de la huella (no separan
AN023–AN025 de AN032–AN003).

### Regenerar (cuando haya muchos productos nuevos o fotos cambiadas)

```bash
cd tools
npm install && npx playwright install chromium   # una vez
node build-catalog-refs.mjs --download            # baja products.json + fotos de cacusabytaitus.com
# o, con una copia local del repo de la tienda (data/products.json + ui_kits/store/images/):
node build-catalog-refs.mjs --site ../../cacusa
```

**Fotos con modelo / de ambiente (26 nov):** una foto de galería se usa como referencia solo si es coherente con la foto de producto (coseno entre huellas base ≥ `REF_CONSIST_MIN` = 0,25; `galleryRefMask` en `index.html`). La foto principal se usa siempre; si la principal es la foto con modelo y una de galería es claramente la foto de producto (fondo mucho más limpio, `borderUniformity` + 0,3), esa pasa a ser el ancla. La herramienta aplica la misma función (v2 y v3, decide con v3), lista por SKU las fotos descartadas y las deja en `excluded` del índice (solo la huella base y el borde: el panel repite la regla sin bajarlas; la búsqueda por foto de la tienda solo lee `products`). En el panel la regla corre igual para fotos nuevas o cambiadas, antes de calcular sus variantes. Medido en el catálogo: fotos con modelo vs su principal ≤ 0,11, otra toma de la misma pieza ≥ 0,35.

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

## Gestión (26 nov): Ventas, Clientas, Preparar pedidos y Edición masiva

Todo se calcula en el navegador con lo que el panel ya carga (pedidos, productos, stock); no hay
rutas nuevas en el Worker. Fechas en la hora local del dispositivo.

- **◇ Ventas** (`SalesTab`, `computeSales`): hoy / esta semana (desde el lunes) / este mes contra el
  mismo tramo del período anterior (ingresos, pedidos, ticket promedio); barras de los últimos 30
  días (SVG, con resumen en texto y tabla); más vendidos por unidades e ingresos, por categoría y por
  canal. Venta = todo pedido no Cancelado. Canal: Lovers (`pago: 'Lovers'` o `lote`), Manual
  (`createdBy` = cuenta del panel), Tienda (el resto). Las cajas de Lovers se guardan en $0, así que
  no suman ingresos ni entran en el ticket/top: se cuentan aparte.
- **♡ Clientas** (`CustomersTab`, `buildCustomers`): una fila por correo (sin mayúsculas) o, sin correo,
  por teléfono; un pedido con correo y teléfono une la ficha "solo teléfono". Filtros recurrentes,
  top 20 por gasto, inactivas (+90 días), Lovers sí/no, búsqueda. CSV (BOM, celdas a prueba de
  fórmulas) con aviso de datos personales.
- **Pedidos → ▦ Preparar (tablero)** (`FulfillmentBoard`): columnas = estados reales (Nuevo,
  Confirmado, En proceso, Enviado, Entregado de los últimos 14 días). Mover (botones o arrastrar) usa
  el mismo `order/update {estado}` que la tarjeta y las mismas reglas (`loversBlockMsg`; Enviado y
  Entregado no vuelven atrás). **Hoja de preparación** (`PackingSlipView`, una página por pedido,
  `@media print` oculta el panel): número, fecha, enviar a (del pedido), código + QR, cantidad,
  personalización y notas. También desde cada tarjeta ("▤ Hoja de preparación").
- **Productos → ☑ Selección múltiple** (`BulkEditModal`, `computeBulk`): precio (% o monto, redondeo
  .00/.99), oferta (% o precio fijo, etiqueta, "válida hasta"), quitar oferta, categoría,
  activar/pausar → vista previa antes/después → cambia el formulario y se sube con "Publicar cambios".
  Stock → `/stock/set` por producto, al instante. La tienda no entiende fecha de inicio de oferta
  (`promo.price`/`label`/`endsAt` solamente): la oferta empieza al publicar.

Prueba: `pwmgmt.js` (escritorio y 390 px).

## Ingreso de inventario (27 nov): lote, calidad de foto, factura, conteo, dictado y revisión antes de publicar

Pensado para el iPhone (390 px). Todo lo gratis corre en el teléfono; lo que usa Claude Haiku se llama
solo con un toque o dentro del lote, siempre con tope diario en el Worker.

### ✦ Ingreso por lote (Productos → Herramientas)

1. Se eligen muchas fotos de la galería a la vez (`<input type=file multiple>`, sin `capture`); máx. 80.
2. Por foto, una a la vez y cediendo la pantalla entre foto y foto: huella v3 de la foto entera y de la
   pieza sola (u2netp, la misma de "¿ya existe?"), aviso de calidad y hora de la toma (EXIF, si viene).
3. Grupos (`clusterPhotos`): similitud = 0,3 × pieza + 0,7 × foto entera (+ 0,3 si 2 fotos son seguidas
   y con ≤ 90 s entre sí según el EXIF); enlace completo con umbral `BATCH_LINK` = 0,38.
4. Por grupo: "¿ya existe?" con cada foto (`dupCandidates`, mismos umbrales `DUP_HIGH`/`DUP_MEDIUM` y la
   misma comparación lado a lado). Alto → propone "sumar al stock"; medio → muestra el candidato pero
   queda como producto nuevo. Si no, borrador con "Sugerir datos" (`suggestCore`, compartido con el
   formulario: vecinas → categoría/material/precio; `/product/describe` para nombre y textos). Como
   mucho 40 llamadas por lote; al primer 429 (tope diario de 40) o 503 deja de llamar y sigue con
   la sugerencia básica (plantillas).
5. Revisión: unir grupos, separar una foto (pieza nueva), moverla a otro grupo, "Repetir foto" en las
   que tienen aviso, editar campos, cantidad, costo (opcional), contar con foto, aprobar uno o todos.
   Aprobar un producto nuevo sube las fotos (principal + galería, igual que "Nuevo producto"), le da el
   código siguiente de su categoría (`createBatchProduct`, sin repetir entre aprobaciones seguidas) y
   queda para "Publicar cambios". Aprobar "sumar al stock" llama `/stock/set` al instante y aprende
   hasta 3 fotos como fotos reales de esa pieza.
6. Stock de piezas nuevas: `/stock/set` exige que la pieza ya esté en el catálogo publicado, así que
   la cantidad queda pendiente en el teléfono (`cacusa-admin-pending-stock`) y se manda sola cuando
   `/stock/list` ya la trae (al cargar el stock y a los 80/160/300 s de publicar).

Fotos reales del taller (30 fotos de 15 piezas, 2 por pieza: frente y otro ángulo, mismo mantel; NO
están en el repo), por el camino real del panel (`pwbatch`): **9 de 15 piezas agrupadas exactas**, 11 de
15 pares de la misma pieza juntos, 9 pares de piezas distintas juntados de más (17 grupos); ninguna pieza
nueva se propuso como "ya existe" y la foto de una pieza del catálogo sí ("sumar stock"). Barrido
(fotos sin hora): enlace completo con 0,3 de pieza fue lo mejor (promedio y simple, y más peso a la
pieza o al color, quedan en 7–8 de 15). Frente vs. espalda de la misma pieza se parece menos (0,12–0,83)
que 2 piezas distintas sobre el mismo mantel (hasta 0,71), por eso la revisión es parte del flujo. Si las
fotos traen la hora de la toma (simulado: fotos de cada pieza seguidas), sube a 12,4 de 15.

### Aviso de calidad de foto (gratis)

En "Nuevo producto"/"Editar" (foto principal recién elegida, zona automática `pieceBox`) y en el lote
(zona de u2netp): oscura (luminancia media < 62), movida (varianza del laplaciano del recorte de la pieza
llevado a 256 px < 40), quemada (≥ 50 % de los píxeles de la pieza sin detalle) o pieza muy chica (< 0,5 %
de la foto). No bloquea: "Repetir foto". Catálogo (93 fotos): **0 falsas alarmas** con las 2 zonas
(mínimos: nitidez 50, quemado 0,40, pieza 0,65 %); fotos reales del taller: ver `pwbatch`. Sintéticas:
oscuras (brillo × 0,3) ~83 %, movidas (desenfoque 4 px) 48–60 %, quemadas (brillo × 2,2) 17–27 % (en fondo
blanco la pieza quemada se confunde con el fondo).

### Costo privado y precio sugerido

`data/products.json` es público, así que el costo NO va en el producto: vive en el Worker (KV
`admin_costs`, una sola llave, `/cost/list` + `/cost/set`; respaldada por `cacusa-backup`), como el
stock. `saveProduct` saca `_stock`/`_cost` antes de guardar el producto y el Worker además borra
`cost`/`costCurrency` de cualquier producto en `/save`. El costo es opcional (a mano, por factura o
dictado); el formulario y el lote muestran "Costo × margen" junto al precio de las parecidas (sin costo,
solo el de las parecidas). Margen en Ajustes (por defecto 3, privado, en la misma llave). Redondeo como
el catálogo (`roundCatalogPrice`: dólares enteros, o x,99 si la mayoría termina así; prefiere finales
que el catálogo usa: hoy 0, 5 y 8).

### Leer factura (opcional) y contar unidades con foto

- **Leer factura (opcional)** (lote): `/product/invoice` (Haiku 5.5, sin thinking, effort low,
  json_schema, foto ≤ 600 KB, tope 30/día) → líneas `{description, quantity, unit_cost, currency}`. Se
  proponen las piezas por palabras del nombre (`invoiceMatch`) y Robin confirma con "Aplicar". Nunca es
  un paso obligatorio ni se pide.
- **✦ Contar unidades con foto** (junto al stock, en el formulario y en el lote): `/product/count`
  (Haiku, foto ≤ 300 KB, tope 100/día) → `{count, by_color}`; Robin revisa el número antes de usarlo.
- Costo estimado (Haiku 5.5: US$ 0,10 / 0,50 por millón de tokens de entrada / salida): factura
  ~US$ 0,0006 (peor caso US$ 0,0013), conteo ~US$ 0,0002. El lote usa `/product/describe` (~US$ 0,0005
  por borrador, como mucho 40 por día).

### ◉ Dictar datos (gratis)

Botón en el formulario solo si el navegador tiene Web Speech API (`webkitSpeechRecognition`, es-EC o
es-US). `parseDictation` (local, sin llamadas) entiende números dichos ("doce noventa y nueve", "dos con
cincuenta") y saca nombre, cantidad, costo, precio, color (también el color de respaldo) y talla (se
agrega al nombre). Ej.: "aretes argolla dorada, cantidad doce, costo dos con cincuenta, precio veinticinco".

### Antes de publicar (gratis)

"Publicar cambios" revisa los productos nuevos o cambiados (contra lo último cargado/publicado) y avisa,
sin bloquear ("Publicar igual" / "Revisar"; tocar un producto abre su ficha): falta texto en inglés,
emojis de color en nombre/descripción, precio > 2× o < 0,5× la mediana de las piezas parecidas (huella de
pieza si el identificador ya preparó el catálogo en la sesión; si no, las de la misma categoría y
material), sin foto principal, producto nuevo con stock 0. Nunca avisa por el costo.

Pruebas: `pwbatch` (fotos reales, local), `pwquality`, `pwinvoice`, `pwcount`, `pwvoice`, `pwprepublish`.
