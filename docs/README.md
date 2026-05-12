# Documentación LedsC4 B2B

> **v0.1** · publicada el 12-may-2026 · documentación en construcción.

Este directorio contiene la documentación del proyecto **LedsC4 B2B**. Se publica automáticamente como sitio web con MkDocs Material en GitHub Pages tras cada merge en `main` que afecte a `docs/`, `mkdocs.yml` o el workflow de docs.

**Sitio público:** https://danielpenamad.github.io/shopify-ledsc4-theme/

## Audiencias

| Carpeta | Para quién |
| --- | --- |
| [`desarrollo/`](desarrollo/) | Equipo técnico. Arquitectura, pipeline de datos, theme Shopify, Supabase, GitHub Actions, i18n. |
| [`administracion/`](administracion/) | Administrador del negocio. Gestión de catálogo, categorías, emails y traducciones. |
| [`operador/`](operador/) | Operador de back-office. Flujo diario, aprobar altas, whitelist e incidencias. |

## Estado de los documentos

Leyenda: ✅ completo · ⚠️ parcial · 🚧 esqueleto.

### Desarrollo

| Documento | Estado | Bloqueado por |
| --- | --- | --- |
| [`desarrollo/00-arquitectura.md`](desarrollo/00-arquitectura.md) | ⚠️ parcial | Emails W, multicurrency |
| [`desarrollo/01-pipeline-datos.md`](desarrollo/01-pipeline-datos.md) | ✅ completo | — |
| [`desarrollo/02-emails-transaccionales.md`](desarrollo/02-emails-transaccionales.md) | ⚠️ parcial | W5, migración emails |
| [`desarrollo/03-theme-customizaciones.md`](desarrollo/03-theme-customizaciones.md) | ✅ completo | — |
| [`desarrollo/04-currency-i18n.md`](desarrollo/04-currency-i18n.md) | 🚧 esqueleto | Multicurrency |
| [`desarrollo/05-github-repo.md`](desarrollo/05-github-repo.md) | 🚧 esqueleto | Transferencia |
| [`desarrollo/06-github-actions.md`](desarrollo/06-github-actions.md) | 🚧 esqueleto | Transferencia |
| [`desarrollo/07-supabase.md`](desarrollo/07-supabase.md) | 🚧 esqueleto | Transferencia |

### Administración

| Documento | Estado | Bloqueado por |
| --- | --- | --- |
| [`administracion/00-vision-general.md`](administracion/00-vision-general.md) | ⚠️ parcial | — |
| [`administracion/01-gestion-productos.md`](administracion/01-gestion-productos.md) | ✅ completo | — |
| [`administracion/02-gestion-categorias-menu.md`](administracion/02-gestion-categorias-menu.md) | ✅ completo | — |
| [`administracion/03-gestion-emails.md`](administracion/03-gestion-emails.md) | ⚠️ parcial | Emails admin internos |
| [`administracion/04-traducciones.md`](administracion/04-traducciones.md) | ✅ completo | — |

### Operador

| Documento | Estado | Bloqueado por |
| --- | --- | --- |
| [`operador/00-flujo-diario.md`](operador/00-flujo-diario.md) | ✅ completo | — |
| [`operador/01-aprobar-altas.md`](operador/01-aprobar-altas.md) | ✅ completo | — |
| [`operador/02-gestionar-whitelist.md`](operador/02-gestionar-whitelist.md) | ✅ completo | — |
| [`operador/03-quitar-acceso.md`](operador/03-quitar-acceso.md) | ✅ completo | — |
| [`operador/04-resolucion-incidencias.md`](operador/04-resolucion-incidencias.md) | 🚧 esqueleto | — |

## Build local

```bash
pip install mkdocs-material
mkdocs serve     # http://127.0.0.1:8000
mkdocs build     # genera site/
```

## Notas

- Los archivos sueltos en `docs/` (`arquitectura.md`, `import-pipeline.md`, etc.) son documentación histórica anterior a v0.1. Se irá migrando a la nueva estructura por audiencias.
- Para añadir un documento nuevo: crearlo bajo la subcarpeta correspondiente, añadirlo a `nav` en `mkdocs.yml` y a la tabla de estado de este README.
