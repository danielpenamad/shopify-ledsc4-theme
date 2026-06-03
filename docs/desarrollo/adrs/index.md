# ADRs · Architecture Decision Records

!!! info "Estado del documento"
    **Versión:** 1.0 · 15-may-2026
    **Estado:** ✅ sección completa
    **Audiencia:** Equipo de desarrollo

## Qué es esto

Registro de las decisiones arquitectónicas del proyecto. Cada ADR documenta una decisión técnica relevante con su contexto, las alternativas consideradas y las consecuencias asumidas.

Las decisiones se numeran de forma estable (`D1`, `D2`, …) y se referencian desde el resto de la documentación. La numeración se mantiene aunque alguna decisión sea reemplazada o supersedida — el número no se reutiliza.

## Índice

| # | Decisión | Estado |
|---|---|---|
| [D1](d01-plan-grow.md) | Plan Grow de Shopify | ✅ aceptada |
| [D2](d02-b2b-nativo.md) | B2B nativo (Companies/Catalogs/Price Lists) | ✅ aceptada |
| [D3](d03-flow-supabase.md) | Shopify Flow + Supabase Edge Functions | ✅ aceptada |
| [D4](d04-gate-hibrido.md) | Gate híbrido (Liquid + Locksmith) | ✅ aceptada |
| [D5](d05-customer-accounts.md) | New customer accounts | ✅ aceptada (impuesta) |
| [D6](d06-catalogo-unico.md) | Catálogo único multi-ready | ✅ aceptada |
| [D7](d07-backoffice-page.md) | Página backoffice con tag `backoffice` | ✅ aceptada |
| [D8](d08-predeterminado.md) | Columna `Predeterminado`: importar sin exponer | ⚠️ provisional |
| [D9](d09-metafields-ampliados.md) | Modelo de metafields ampliado | ✅ aceptada |
| [D10](d10-3-csvs-sftp.md) | 3 CSVs SFTP separados (importer) | ✅ aceptada |
| [D11](d11-image-pre-upload.md) | Pre-upload de imágenes a Shopify Files | ✅ aceptada |
| [D12](d12-pipeline-split.md) | Pipeline split sftp-sync (Edge) → GHA | ✅ aceptada |
| [D13](d13-multicurrency.md) | Multidivisa con auto-rates de Shopify Markets | ♻️ superseded por D16 |
| [D14](d14-sku-state-fingerprint.md) | Fingerprint cache en `private.sku_state` | ⚠️ parcial |
| [D15](d15-image-cache-reconcile.md) | Reconciliación del image_cache · feed como fuente de verdad de imágenes | ✅ aceptada |
| [D16](d16-multicurrency-cosmetic.md) | Multidivisa cosmética sin tocar Markets | ✅ aceptada |

Leyenda: ✅ completo · ⚠️ parcial / provisional · 🚧 esqueleto · ❌ obsoleta · ♻️ superseded por otra.

## Convenciones

- **Numeración estable**: si una decisión se revierte o reemplaza, el ADR original se marca como `superseded` y se crea uno nuevo con número siguiente.
- **Estado**: se actualiza en el documento del ADR y en esta tabla a la vez.
- **Plantilla**: Estado · Contexto · Decisión · Alternativas consideradas · Consecuencias.
