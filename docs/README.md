# Documentación LedsC4 B2B

> **v0.2** · actualizada el 16-may-2026 · documentación en construcción.

Este directorio contiene la documentación del proyecto **LedsC4 B2B**. Se publica automáticamente como sitio web con MkDocs Material en GitHub Pages tras cada merge en `main` que afecte a `docs/`, `mkdocs.yml` o el workflow de docs.

**Sitio público:** https://danielpenamad.github.io/shopify-ledsc4-theme/

## Audiencias

| Carpeta | Para quién |
| --- | --- |
| [`desarrollo/`](desarrollo/) | Equipo técnico. Arquitectura, modelo de datos, importer, theme Shopify, gate, registro B2B, backoffice, solicitudes, emails, i18n, multidivisa, Supabase, repositorio. |
| [`administracion/`](administracion/) | Administrador del negocio. Gestión de catálogo, categorías, emails y traducciones. |
| [`operador/`](operador/) | Operador de back-office. Flujo diario, aprobar altas, whitelist e incidencias. |

## Estado de los documentos

Leyenda: ✅ completo · ⚠️ parcial · 🚧 esqueleto.

### Desarrollo

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
| [`desarrollo/adrs/`](desarrollo/adrs/) | ✅ completo (D1–D14) |

Planificados, aún no escritos: 13 · GitHub Actions, 14 · Secrets, 15 · Scripts, 16 · Operations runbook.

### Administración

| Documento | Estado |
| --- | --- |
| [`administracion/00-vision-general.md`](administracion/00-vision-general.md) | ⚠️ parcial |
| [`administracion/01-gestion-productos.md`](administracion/01-gestion-productos.md) | ✅ completo |
| [`administracion/02-gestion-categorias-menu.md`](administracion/02-gestion-categorias-menu.md) | ✅ completo |
| [`administracion/03-gestion-emails.md`](administracion/03-gestion-emails.md) | ⚠️ parcial |
| [`administracion/04-traducciones.md`](administracion/04-traducciones.md) | ✅ completo |

### Operador

| Documento | Estado |
| --- | --- |
| [`operador/00-flujo-diario.md`](operador/00-flujo-diario.md) | ✅ completo |
| [`operador/01-aprobar-altas.md`](operador/01-aprobar-altas.md) | ✅ completo |
| [`operador/02-gestionar-whitelist.md`](operador/02-gestionar-whitelist.md) | ✅ completo |
| [`operador/03-quitar-acceso.md`](operador/03-quitar-acceso.md) | ✅ completo |
| [`operador/04-resolucion-incidencias.md`](operador/04-resolucion-incidencias.md) | 🚧 esqueleto |

## Build local

```bash
pip install mkdocs-material
mkdocs serve     # http://127.0.0.1:8000
mkdocs build     # genera site/
```

## Notas

- Los archivos sueltos en la raíz de `docs/` (`arquitectura.md`, `import-pipeline.md`, `data-model.md`, `historia-decisiones.md`, etc.) son documentación histórica anterior a la estructura por ejes. Su contenido vivo se ha ido refundiendo en los docs de `desarrollo/`; quedan pendientes de archivar en `docs/_archive/`.
- Para añadir un documento nuevo: crearlo bajo la subcarpeta correspondiente, añadirlo a `nav` en `mkdocs.yml`, a `desarrollo/index.md` (u el índice del eje correspondiente) y a la tabla de estado de este README.
