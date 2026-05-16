# Documentación LedsC4 B2B

> **v0.7** · actualizada el 17-may-2026 · saneamiento docs/.

Este directorio contiene la documentación del proyecto **LedsC4 B2B**. Se publica automáticamente como sitio web con MkDocs Material en GitHub Pages tras cada merge en `main` que afecte a `docs/`, `mkdocs.yml` o el workflow de docs.

**Sitio público:** https://danielpenamad.github.io/shopify-ledsc4-theme/

## Audiencias

| Carpeta | Para quién |
| --- | --- |
| [`desarrollo/`](desarrollo/) | Equipo técnico. Arquitectura, modelo de datos, importer, theme Shopify, gate, registro B2B, backoffice, solicitudes, emails, i18n, multidivisa, Supabase, repositorio, GitHub Actions, secrets, scripts, runbook operacional. |
| [`administracion/`](administracion/) | Administrador del negocio. Gestión de catálogo, categorías, emails y traducciones. |
| [`operador/`](operador/) | Operador de back-office. Flujo diario, aprobar altas, whitelist e incidencias. |

## Estado de los documentos

Leyenda: ✅ completo · ⚠️ parcial · 🚧 esqueleto.

### Desarrollo

El eje de Desarrollo está completo: 17 documentos (00–16) más los 14 ADRs.

| Documento | Estado |
| --- | --- |
| [`desarrollo/00-arquitectura.md`](desarrollo/00-arquitectura.md) | ✅ completo |
| [`desarrollo/01-data-model.md`](desarrollo/01-data-model.md) | ✅ completo |
| [`desarrollo/02-importer.md`](desarrollo/02-importer.md) | ✅ completo |
| [`desarrollo/02b-importer-deploy.md`](desarrollo/02b-importer-deploy.md) | ✅ completo |
| [`desarrollo/03-theme-customizaciones.md`](desarrollo/03-theme-customizaciones.md) | ✅ completo |
| [`desarrollo/04-storefront-gate.md`](desarrollo/04-storefront-gate.md) | ✅ completo |
| [`desarrollo/05-registro-b2b.md`](desarrollo/05-registro-b2b.md) | ✅ completo |
| [`desarrollo/06-backoffice.md`](desarrollo/06-backoffice.md) | ✅ completo |
| [`desarrollo/07-solicitudes-pedido.md`](desarrollo/07-solicitudes-pedido.md) | ✅ completo |
| [`desarrollo/08-emails-transaccionales.md`](desarrollo/08-emails-transaccionales.md) | ✅ completo |
| [`desarrollo/09-i18n.md`](desarrollo/09-i18n.md) | ✅ completo |
| [`desarrollo/10-multicurrency.md`](desarrollo/10-multicurrency.md) | ✅ completo |
| [`desarrollo/11-supabase.md`](desarrollo/11-supabase.md) | ✅ completo |
| [`desarrollo/12-github-repo.md`](desarrollo/12-github-repo.md) | ✅ completo |
| [`desarrollo/13-github-actions.md`](desarrollo/13-github-actions.md) | ✅ completo |
| [`desarrollo/14-secrets.md`](desarrollo/14-secrets.md) | ✅ completo |
| [`desarrollo/15-scripts.md`](desarrollo/15-scripts.md) | ✅ completo |
| [`desarrollo/16-operations-runbook.md`](desarrollo/16-operations-runbook.md) | ✅ completo |
| [`desarrollo/adrs/`](desarrollo/adrs/) | ✅ completo (D1–D14) |

### Administración

| Documento | Estado |
| --- | --- |
| [`administracion/00-vision-general.md`](administracion/00-vision-general.md) | ✅ completo |
| [`administracion/01-gestion-productos.md`](administracion/01-gestion-productos.md) | ✅ completo |
| [`administracion/02-gestion-categorias-menu.md`](administracion/02-gestion-categorias-menu.md) | ✅ completo |
| [`administracion/03-gestion-emails.md`](administracion/03-gestion-emails.md) | ✅ completo |
| [`administracion/04-traducciones.md`](administracion/04-traducciones.md) | ✅ completo |

### Operador

| Documento | Estado |
| --- | --- |
| [`operador/00-flujo-diario.md`](operador/00-flujo-diario.md) | ✅ completo |
| [`operador/01-aprobar-altas.md`](operador/01-aprobar-altas.md) | ✅ completo |
| [`operador/02-gestionar-whitelist.md`](operador/02-gestionar-whitelist.md) | ✅ completo |
| [`operador/03-quitar-acceso.md`](operador/03-quitar-acceso.md) | ✅ completo |
| [`operador/04-resolucion-incidencias.md`](operador/04-resolucion-incidencias.md) | ✅ completo |

## Build local

```bash
pip install mkdocs-material
mkdocs serve     # http://127.0.0.1:8000
mkdocs build     # genera site/
```

## Notas

- La documentación histórica anterior a la estructura por ejes está archivada en `docs/_archive/` (excluida del build). Ver `docs/_archive/README.md`.
- Para añadir un documento nuevo: crearlo bajo la subcarpeta correspondiente, añadirlo a `nav` en `mkdocs.yml`, a `desarrollo/index.md` (u el índice del eje correspondiente) y a la tabla de estado de este README.
