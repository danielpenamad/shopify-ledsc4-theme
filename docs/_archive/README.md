# Archivo de documentación legacy

Esta carpeta contiene la documentación del proyecto **anterior a la
estructura por ejes** (`desarrollo/`, `administracion/`, `operador/`).

Son documentos planos que vivían sueltos en la raíz de `docs/` durante
las fases A–D del proyecto. Cuando la documentación se reorganizó por
audiencias, su contenido vivo se refundió en los docs de los tres ejes.
Estos ficheros se conservan aquí como **referencia histórica**.

## Aviso

- **No es documentación viva.** Para el estado actual del proyecto,
  consulta los tres ejes en `docs/desarrollo/`, `docs/administracion/`
  y `docs/operador/`.
- Esta carpeta está **excluida del build de MkDocs** (`exclude_docs` en
  `mkdocs.yml`): no se publica en el sitio.
- Algunos enlaces relativos internos pueden no resolver — es material
  congelado, no se mantiene.
- Algunos de estos ficheros contienen secrets en ejemplos de código
  (HMAC, tokens). Son valores de la fase de desarrollo; la rotación de
  secrets se gestiona aparte.

## Mapeo aproximado a la documentación viva

| Documento archivado | Reemplazado por |
| --- | --- |
| `arquitectura.md` | `desarrollo/00-arquitectura.md` |
| `data-model.md` | `desarrollo/01-data-model.md` |
| `import-pipeline.md` | `desarrollo/02-importer.md`, `02b-importer-deploy.md` |
| `locksmith-rules.md` | `desarrollo/04-storefront-gate.md` |
| `pagina-acceso-profesional.md` | `desarrollo/05-registro-b2b.md` |
| `backoffice-page.md` | `desarrollo/06-backoffice.md` |
| `backoffice-aprobaciones.md` | `desarrollo/06-backoffice.md`, eje `operador/` |
| `backoffice-solicitudes.md` | `desarrollo/07-solicitudes-pedido.md` |
| `hardcoded-emails.md` | `desarrollo/08-emails-transaccionales.md` |
| `shopify-customer-accounts-branding.md` | `desarrollo/03-theme-customizaciones.md` |
| `secrets.md` | `desarrollo/14-secrets.md` |
| `operations-runbook.md` | `desarrollo/16-operations-runbook.md` |
| `historia-decisiones.md` | `desarrollo/adrs/` (D1–D14) |
| `grow-migration-checklist.md` | `desarrollo/16-operations-runbook.md` |
| `pendientes.md` | repartido entre los pendientes de los docs de `desarrollo/` |
| `test-scenarios*.md` | secciones de testing de los docs de `desarrollo/` |
