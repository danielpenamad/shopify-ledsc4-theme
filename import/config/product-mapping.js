/**
 * Product masterfile column mapping.
 *
 * Maps internal field names to Excel column headers per language sheet.
 * Will be populated when we receive the actual masterfile column names.
 *
 * Structure:
 *   fieldName: { column: 'Excel Header', transform?: (val) => val }
 */
export const productMapping = {
  sheets: {
    es: 'MF_ES',
    en: 'MF_ENG',
    fr: 'MF_FR',
  },

  fields: {
    sku: { column: 'SKU' },
    title: { column: 'TITULO' },
    description: { column: 'DESCRIPCION' },
    price: { column: 'PRECIO', transform: (v) => parseFloat(v) || 0 },
    ean: { column: 'EAN13' },
    familia: { column: 'FAMILIA' },
    tipologia: { column: 'TIPOLOGIA' },
    catalogo: { column: 'CATALOGO' },
  },

  images: {
    columns: ['IMG_1', 'IMG_2', 'IMG_3', 'IMG_4', 'IMG_5'],
  },

  pdfs: {
    ficha: { column: 'PDF_FICHA' },
    instrucciones: { column: 'PDF_INSTRUCCIONES' },
    energia: { column: 'PDF_ENERGIA' },
    fotometria: { column: 'PDF_FOTOMETRIA' },
    comercial: { column: 'PDF_COMERCIAL' },
    modelo_3d: { column: 'PDF_3D' },
    archivo_ies: { column: 'ARCHIVO_IES' },
    archivo_ldt: { column: 'ARCHIVO_LDT' },
  },

  metafields: {
    namespace: 'product',
    map: {
      cbm_caja: { column: 'CBM_CAJA', transform: (v) => parseFloat(v) || 0 },
      pdf_ficha: { column: 'PDF_FICHA' },
      pdf_instrucciones: { column: 'PDF_INSTRUCCIONES' },
      pdf_energia: { column: 'PDF_ENERGIA' },
      pdf_fotometria: { column: 'PDF_FOTOMETRIA' },
      pdf_comercial: { column: 'PDF_COMERCIAL' },
      pdf_3d: { column: 'PDF_3D' },
      archivo_ies: { column: 'ARCHIVO_IES' },
      archivo_ldt: { column: 'ARCHIVO_LDT' },
      familia: { column: 'FAMILIA' },
      tipologia: { column: 'TIPOLOGIA' },
      catalogo: { column: 'CATALOGO' },
      ean13: { column: 'EAN13' },
    },
  },
};
