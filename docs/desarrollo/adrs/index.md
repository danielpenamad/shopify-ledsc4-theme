# ADRs · Architecture Decision Records

!!! info "Estado del documento"
    **Versión:** 0.2 · 15-may-2026
    **Estado:** ⚠️ en construcción
    **Audiencia:** Equipo de desarrollo

## Qué es esto

Registro de las decisiones arquitectónicas del proyecto. Cada ADR documenta una decisión técnica relevante con su contexto, las alternativas consideradas y las consecuencias asumidas.

Las decisiones se numeran de forma estable (`D1`, `D2`, …) y se referencian desde el resto de la documentación. La numeración se mantiene aunque alguna decisión sea reemplazada o supersedida — el número no se reutiliza.

## Índice

| # | Decisión | Estado |
|---|---|---|
| [D1](d01-plan-grow.md) | Plan Grow de Shopify | ✅ aceptada |
| [D2](d02-b2b-nativo.md) | B2B nativo (Companies/Catalogs/Price Lists) | ✅ aceptada |
| D3 | Shopify Flow + Supabase Edge Functions | 🚧 esqueleto |
| D4 | Gate híbrido (Locksmith + Liquid) | 🚧 esqueleto |
| D5 | New customer accounts | 🚧 esqueleto |
| D6 | Catálogo único multi-ready | 🚧 esqueleto |
| D7 | Página backoffice con tag `backoffice` | 🚧 esqueleto |
| D8 | Mapping CSV `Predeterminado` pendiente | 🚧 esqueleto |
| D9 | Modelo de metafields ampliado | 🚧 esqueleto |
| D10 | 3 CSVs SFTP separados (importer) | 🚧 esqueleto |
| D11 | Pre-upload de imágenes a Shopify Files | 🚧 esqueleto |
| D12 | Pipeline split sftp-sync (Edge) → GHA | 🚧 esqueleto |
| D13 | Multidivisa con auto-rates de Shopify Markets | 🚧 esqueleto |
| D14 | Fingerprint cache en `private.sku_state` | 🚧 esqueleto |

Leyenda: ✅ completo · ⚠️ parcial · 🚧 esqueleto · ❌ obsoleta · ♻️ superseded por otra.

## Convenciones

- **Numeración estable**: si una decisión se revierte o reemplaza, el ADR original se marca como `superseded` y se crea uno nuevo con número siguiente.
- **Estado**: se actualiza en el documento del ADR y en esta tabla a la vez.
- **Plantilla**: Estado · Contexto · Decisión · Alternativas consideradas · Consecuencias.
