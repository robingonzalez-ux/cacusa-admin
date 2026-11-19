# Librerías de terceros copiadas tal cual (sin modificar)

Se sirven desde el propio panel (`script-src 'self'`) y se cargan recién cuando
hacen falta (etiquetas QR / escanear etiqueta). Copiadas byte a byte del paquete
publicado en npm:

| Archivo | Paquete npm | Licencia | sha384 |
|---|---|---|---|
| `qrcode-generator-1.4.4.js` | `qrcode-generator@1.4.4` (`qrcode.js`) | MIT, (c) 2009 Kazuhiko Arase (encabezado del archivo) | `8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k` |
| `jsqr-1.4.0.js` | `jsqr@1.4.0` (`dist/jsQR.js`) | Apache-2.0 (`jsqr-1.4.0.LICENSE`) | `b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx` |

Para actualizar: bajar el `.tgz` de `registry.npmjs.org`, copiar el archivo y
actualizar el hash `integrity` en `index.html`.
