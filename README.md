# CACUSA — panel admin

Panel de administración de CACUSA by Taitus, publicado en **https://admin.cacusabytaitus.com** (GitHub Pages, repo propio).

Vive separado de la tienda (`cacusabytaitus.com`, repo `cacusa`) a propósito: así la sesión del admin no comparte origen con páginas públicas que cargan scripts de terceros.

- Sin build: `index.html` es React + Babel Standalone en el navegador.
- Todo pasa por el Worker `cacusa-admin` (login, pedidos, subir fotos). Cuando se publica el catálogo, el Worker lo commitea a `data/products.json` en el repo `cacusa`, no acá.
- `sw.js`: service worker de avisos push.

## Reconocimiento por foto ("📷 Agregar pieza con foto")

Gratis y en el navegador: TF.js 4.22.0 + MobileNet v2 (`models/mobilenet_v2/`). La foto del
taller se convierte en una huella de 1280 números y se compara con las huellas del catálogo.

### Referencias de entrenamiento (`models/catalog-refs-v1.bin` + `.json`)

MobileNet no se re-entrena: por cada foto de cada producto (`imageUrl` + `images[]`) se
precalculan variantes que imitan una foto del taller (recorte 60–95 %, giro ±15°, mesa de
fondo lisa con textura leve, luz cálida/fría, brillo/contraste/saturación, desenfoque leve,
espejo) y sus huellas quedan como referencias extra del producto. El panel:

- baja el `.json` (índice, ~30 KB) con revalidación y el `.bin` (~2 MB) solo si cambió su hash,
  y lo guarda en IndexedDB (sirve también sin conexión);
- usa las referencias de una foto **solo si el producto sigue teniendo esa misma URL de foto**
  (si se cambió la foto o el producto es nuevo, se ignoran);
- para productos nuevos o con foto cambiada calcula 4 variantes en el momento (misma función
  `augmentPhoto`, misma semilla) y las guarda en IndexedDB, así no hace falta regenerar el archivo
  cada vez que se agrega un producto;
- para los productos del archivo ya no necesita bajar la foto del catálogo la primera vez (el
  archivo trae su huella y su color).

### Regenerar (cuando haya muchos productos nuevos o fotos cambiadas)

```bash
cd tools
npm install && npx playwright install chromium   # una vez
node build-catalog-refs.mjs --download            # baja products.json + fotos de cacusabytaitus.com
# o, con una copia local del repo de la tienda (data/products.json + ui_kits/store/images/):
node build-catalog-refs.mjs --site ../../cacusa
```

Tarda ~6 s por foto en Chromium headless (≈10–15 min el catálogo entero) y escribe
`models/catalog-refs-v1.bin` y `.json`; después se comitean. Usa el código del propio panel
(bloque entre `// @@recog-begin` y `// @@recog-end` de `index.html`, sin JSX) para que las
huellas coincidan con las del navegador. Opciones: `--n 12` (variantes por foto), `--tfjs
<tf.min.js>` si no hay acceso a cdn.jsdelivr.net.

Si se cambia el modelo (`EMB_VERSION`) el panel ignora el archivo viejo hasta regenerarlo. Si
se cambia `augmentPhoto`, subir `AUG_VERSION` y regenerar.

### Medir

`node eval-catalog-refs.mjs --site ../../cacusa --cache /tmp/q.json --panel` arma fotos de
prueba con transformaciones distintas a las del entrenamiento (`eval-transforms.js`) y compara
hit@1/hit@5 antes y después, con y sin filtro de categoría.
