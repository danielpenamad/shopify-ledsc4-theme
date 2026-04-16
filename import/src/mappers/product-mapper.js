import { productMapping } from '../../config/product-mapping.js';
import logger from '../logger.js';

function val(row, col) {
  const v = row[col];
  if (v === undefined || v === null || v === '') return '';
  return v.toString().trim();
}

function num(row, col) {
  const v = parseFloat(row[col]);
  return isNaN(v) ? null : v;
}

/**
 * Map raw Excel data (multi-sheet) to Shopify product objects.
 *
 * @param {Object} sheets — { 'Hoja1': [...], 'MF_ES': [...], ... }
 * @param {string} lang — 'es' | 'en' | 'fr'
 * @returns {{ products: Object[], skipped: Object[] }}
 */
export function mapProductRows(sheets, lang = 'es') {
  const fieldMap = productMapping.fields[lang];
  const imageColumns = productMapping.images[lang];
  const pdfMap = productMapping.pdfs[lang];
  const sheetName = productMapping.sheets[lang];
  const pf = productMapping.priceFields;

  if (!fieldMap || !sheetName) {
    throw new Error(`Unknown language: ${lang}`);
  }

  const detailRows = sheets[sheetName] || [];
  const priceRows = sheets[productMapping.priceSheet] || [];

  const priceIndex = new Map();
  for (const row of priceRows) {
    const sku = val(row, pf.sku);
    if (sku) priceIndex.set(sku, row);
  }

  const products = [];
  const skipped = [];
  const seenSkus = new Set();

  for (let i = 0; i < detailRows.length; i++) {
    const row = detailRows[i];
    const sku = val(row, fieldMap.sku);

    if (!sku) {
      skipped.push({ row: i + 2, reason: 'missing SKU' });
      continue;
    }

    if (seenSkus.has(sku)) {
      skipped.push({ row: i + 2, sku, reason: 'duplicate SKU' });
      continue;
    }
    seenSkus.add(sku);

    const priceRow = priceIndex.get(sku);
    const price = priceRow ? num(priceRow, pf.price) : null;
    const title = val(row, fieldMap.title) || sku;
    const bodyHtml = val(row, fieldMap.tenderText) || val(row, fieldMap.title);

    const images = imageColumns
      .map((col) => val(row, col))
      .filter((url) => url && url.startsWith('http'));

    const metafields = [];
    const ns = productMapping.metafields.namespace;

    const addMeta = (key, value, type = 'single_line_text_field') => {
      if (value !== '' && value !== null && value !== undefined) {
        metafields.push({ namespace: ns, key, value: value.toString(), type });
      }
    };

    addMeta('ean13', val(row, fieldMap.ean));
    addMeta('familia', val(row, fieldMap.familia));
    addMeta('tipologia', val(row, fieldMap.type));
    addMeta('catalogo', val(row, fieldMap.catalogo));
    addMeta('garantia', val(row, fieldMap.garantia));
    addMeta('material', val(row, fieldMap.material));
    addMeta('acabado', val(row, fieldMap.acabado));
    addMeta('largo_mm', val(row, fieldMap.largo));
    addMeta('ancho_mm', val(row, fieldMap.ancho));
    addMeta('alto_mm', val(row, fieldMap.alto));
    addMeta('proyeccion_mm', val(row, fieldMap.proyeccion));
    addMeta('fuente_luz', val(row, fieldMap.fuenteLuz));
    addMeta('incluye_bombilla', val(row, fieldMap.incluyeBombilla));
    addMeta('eficiencia_energetica', val(row, fieldMap.eficienciaEnergetica));
    addMeta('vatios', val(row, fieldMap.vatios));
    addMeta('lumenes', val(row, fieldMap.lumenes));
    addMeta('lumenes_reales', val(row, fieldMap.lumenesReales));
    addMeta('temperatura_k', val(row, fieldMap.temperatura));
    addMeta('cri', val(row, fieldMap.cri));
    addMeta('angulo_luz', val(row, fieldMap.anguloLuz));
    addMeta('regulacion', val(row, fieldMap.regulacion));
    addMeta('ip', val(row, fieldMap.ip));
    addMeta('ik', val(row, fieldMap.ik));
    addMeta('peso_neto_kg', val(row, fieldMap.pesoNeto));
    addMeta('peso_empaquetado_kg', val(row, fieldMap.pesoEmpaquetado));
    addMeta('volumen_m3', val(row, fieldMap.volumenUnidad));
    addMeta('etiqueta_vf', val(row, fieldMap.etiquetaVf));

    for (const [key, col] of Object.entries(pdfMap)) {
      const url = val(row, col);
      if (url && url.startsWith('http')) {
        addMeta(`pdf_${key}`, url, 'url');
      }
    }

    products.push({
      sku,
      title,
      body_html: bodyHtml,
      vendor: 'LedsC4',
      product_type: val(row, fieldMap.type),
      tags: [val(row, fieldMap.familia), val(row, fieldMap.catalogo)].filter(Boolean),
      variants: [{
        sku,
        price: price !== null ? price.toFixed(2) : '0.00',
        inventory_management: 'shopify',
        requires_shipping: true,
        barcode: val(row, fieldMap.ean),
      }],
      images: images.map((src) => ({ src })),
      metafields,
    });
  }

  // Products in Hoja1 but not in MF sheet
  for (const [sku, priceRow] of priceIndex) {
    if (!seenSkus.has(sku)) {
      products.push({
        sku,
        title: val(priceRow, pf.description) || sku,
        body_html: val(priceRow, pf.description),
        vendor: 'LedsC4',
        product_type: val(priceRow, pf.tipologia),
        tags: [val(priceRow, pf.familia)].filter(Boolean),
        variants: [{
          sku,
          price: (num(priceRow, pf.price) || 0).toFixed(2),
          inventory_management: 'shopify',
          requires_shipping: true,
        }],
        images: [],
        metafields: [],
      });
      seenSkus.add(sku);
    }
  }

  if (skipped.length > 0) {
    logger.warn(`Product mapper: ${skipped.length} rows skipped`);
    for (const s of skipped) {
      logger.warn(`  Row ${s.row}: ${s.reason}${s.sku ? ` (SKU: ${s.sku})` : ''}`);
    }
  }

  logger.info(`Product mapper: ${products.length} products (${priceIndex.size} with price)`);
  return { products, skipped };
}
