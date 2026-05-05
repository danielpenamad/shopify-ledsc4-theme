Ficheros de muestra entregados por el cliente el 2026-05-04 para
validar el diseño del pipeline de importación (ver
[`docs/import-pipeline.md`](../docs/import-pipeline.md)).
Encoding UTF-8 sin BOM, delimitador coma con quoting CSV estándar.
Decimales con coma (formato ES). Los CSVs reales del SFTP del
cliente sustituirán a estos cuando lleguen las credenciales (Fase
I4). Mientras tanto,
`scripts/import-report.mjs --samples-dir=samples/` los consume tal
cual.

No commitear datos sensibles aquí: si en el futuro el cliente
entrega ficheros con info comercial confidencial, mover a fuera del
repo y mover `samples/` a `.gitignore`.
