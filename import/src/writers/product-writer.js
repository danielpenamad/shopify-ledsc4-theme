import { graphql } from './shopify-client.js';
import logger from '../logger.js';

const FIND_PRODUCT_BY_SKU = `
  query findProductBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      edges {
        node {
          id
          product {
            id
            title
          }
        }
      }
    }
  }
`;

const CREATE_PRODUCT = `
  mutation createProduct($input: ProductInput!, $media: [CreateMediaInput!]) {
    productCreate(input: $input, media: $media) {
      product {
        id
        title
        variants(first: 1) {
          edges {
            node {
              id
              sku
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_PRODUCT = `
  mutation updateProduct($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Write products to Shopify (create or update by SKU).
 *
 * @param {Object[]} products — mapped product objects
 * @param {Object} options — { dryRun }
 */
export async function writeProducts(products, options = {}) {
  const { dryRun = false } = options;

  let created = 0;
  let updated = 0;
  let errors = 0;

  for (const product of products) {
    try {
      const resp = await graphql(FIND_PRODUCT_BY_SKU, { query: `sku:${product.sku}` });
      const existing = resp?.data?.productVariants?.edges?.[0]?.node;

      if (dryRun) {
        const action = existing ? 'UPDATE' : 'CREATE';
        logger.info(`[DRY RUN] ${action} SKU ${product.sku}: "${product.title}" (${product.images.length} images, ${product.metafields.length} metafields)`);
        if (existing) updated++;
        else created++;
        continue;
      }

      if (existing) {
        const updateResp = await graphql(UPDATE_PRODUCT, {
          input: {
            id: existing.product.id,
            title: product.title,
            bodyHtml: product.body_html,
            metafields: product.metafields,
          },
        });
        const ue = updateResp?.data?.productUpdate?.userErrors;
        if (ue?.length) {
          logger.error(`SKU ${product.sku}: update failed — ${ue[0].message}`);
          errors++;
          continue;
        }
        logger.info(`SKU ${product.sku}: updated "${product.title}"`);
        updated++;
      } else {
        const media = product.images.map((img) => ({
          originalSource: img.src,
          mediaContentType: 'IMAGE',
        }));

        const createResp = await graphql(CREATE_PRODUCT, {
          input: {
            title: product.title,
            bodyHtml: product.body_html,
            variants: product.variants,
            metafields: product.metafields,
          },
          media,
        });
        const ue = createResp?.data?.productCreate?.userErrors;
        if (ue?.length) {
          logger.error(`SKU ${product.sku}: create failed — ${ue[0].message}`);
          errors++;
          continue;
        }
        logger.info(`SKU ${product.sku}: created "${product.title}"`);
        created++;
      }
    } catch (err) {
      logger.error(`SKU ${product.sku}: ${err.message}`);
      errors++;
    }
  }

  return { created, updated, errors };
}
