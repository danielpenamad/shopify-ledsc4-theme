-- Limpieza de semillas de CADENA mal puestas en company_domains.
--
-- Modelo de dominio invertido 2026-06-14 (decisión Víctor vía Dani): las
-- cadenas multi-delegación van como Companies SEPARADAS. La v34 de
-- create-company-for-customer auto-sembraba CADA dominio corporativo nuevo,
-- lo que colapsaba las cadenas (saltoki.es ya con 3 contactos fusionados que
-- no debían estarlo; elektracat.com sembrada a punto de hacer lo mismo).
--
-- Borramos SOLO las semillas de cadena. Se MANTIENEN:
--   - sedes únicas auto-sembradas que sí son una sola empresa:
--     velax.com.pe, techluz.com, iluvi.com
--   - semillas manuales de fusión deliberada:
--     ledsc4.com, leds-c4.com, coelca.com, iluminacioncoben.com,
--     hiperdeluz.es, bover.es
--   - thelux.es y gascon.es NO se tocan (pendientes de confirmación Víctor).
--
-- NO se reorganizan aquí los contactos ya fusionados de la company "Saltoki"
-- (9946497351) ni las dos SALTOKI VIGO: eso va en una pasada aparte cuando
-- Víctor defina la estructura de Saltoki. Esta migración solo evita que
-- FUTUROS registros de estos dominios se sigan uniendo.

delete from public.company_domains
where domain in ('saltoki.es', 'elektracat.com');
