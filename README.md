# CACUSA — panel admin

Panel de administración de CACUSA by Taitus, publicado en **https://admin.cacusabytaitus.com** (GitHub Pages, repo propio).

Vive separado de la tienda (`cacusabytaitus.com`, repo `cacusa`) a propósito: así la sesión del admin no comparte origen con páginas públicas que cargan scripts de terceros.

- Sin build: `index.html` es React + Babel Standalone en el navegador.
- Todo pasa por el Worker `cacusa-admin` (login, pedidos, subir fotos). Cuando se publica el catálogo, el Worker lo commitea a `data/products.json` en el repo `cacusa`, no acá.
- `sw.js`: service worker de avisos push.
