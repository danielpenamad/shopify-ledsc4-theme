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

const PRODUCT_SET = `
  mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
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
        code
      }
    }
  }
`;

const CREATE_MEDIA = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        ... on MediaImage {
          id
          status
        }
      }
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

/**
 * Write products to Shopify using productSet (idempotent create/update).
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

      const input = {
        title: product.title,
        descriptionHtml: product.body_html || '',
        vendor: product.vendor || 'LedsC4',
        productType: product.product_type || '',
        tags: product.tags || [],
        metafields: product.metafields.map((mf) => ({
          namespace: mf.namespace,
          key: mf.key,
          value: mf.value,
          type: mf.type,
        })),
        variants: [{
          optionValues: [{ optionName: 'Title', name: 'Default Title' }],
          sku: product.sku,
          price: product.variants[0]?.price || '0.00',
          barcode: product.variants[0]?.barcode || '',
        }],
      };

      if (existing) {
        input.id = existing.product.id;
      }

      const setResp = await graphql(PRODUCT_SET, {
        input,
        synchronous: true,
      });

      const ue = setResp?.data?.productSet?.userErrors;
      if (ue?.length) {
        logger.error(`SKU ${product.sku}: ${ue.map((e) => e.message).join('; ')}`);
        errors++;
        continue;
      }

      const productId = setResp?.data?.productSet?.product?.id;

      if (productId && product.images.length > 0) {
        try {
          const media = product.images.map((img) => ({
            originalSource: img.src,
            mediaContentType: 'IMAGE',
          }));
          await graphql(CREATE_MEDIA, { productId, media });
        } catch (mediaErr) {
          logger.warn(`SKU ${product.sku}: images failed — ${mediaErr.message}`);
        }
      }

      if (existing) {
        logger.info(`SKU ${product.sku}: updated "${product.title}"`);
        updated++;
      } else {
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
