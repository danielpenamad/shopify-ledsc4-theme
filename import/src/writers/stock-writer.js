import { graphql } from './shopify-client.js';
import logger from '../logger.js';

const FIND_VARIANT_BY_SKU = `
  query findVariantBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      edges {
        node {
          id
          sku
          price
          inventoryItem {
            id
          }
          product {
            id
            title
          }
        }
      }
    }
  }
`;

const UPDATE_VARIANT_PRICE = `
  mutation updateVariantPrice($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant {
        id
        price
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ADJUST_INVENTORY = `
  mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const GET_INVENTORY_LEVEL = `
  query getInventoryLevel($inventoryItemId: ID!, $locationId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available"]) {
          name
          quantity
        }
      }
    }
  }
`;

/**
 * Write stock updates to Shopify.
 *
 * @param {Object[]} updates — array of { sku, inventory, price? }
 * @param {Object} options — { dryRun, locationId }
 * @returns {{ processed: number, errors: number, notFound: number }}
 */
export async function writeStockUpdates(updates, options = {}) {
  const { dryRun = false, locationId } = options;

  if (!locationId) throw new Error('SHOPIFY_LOCATION_ID is required for inventory updates');

  const gidLocation = locationId.startsWith('gid://')
    ? locationId
    : `gid://shopify/Location/${locationId}`;

  let processed = 0;
  let errors = 0;
  let notFound = 0;

  for (const update of updates) {
    try {
      const resp = await graphql(FIND_VARIANT_BY_SKU, { query: `sku:${update.sku}` });
      const variant = resp?.data?.productVariants?.edges?.[0]?.node;

      if (!variant) {
        logger.warn(`SKU ${update.sku}: not found in Shopify`);
        notFound++;
        continue;
      }

      if (dryRun) {
        const parts = [`SKU ${update.sku}: inventory → ${update.inventory}`];
        if (update.price) parts.push(`price → ${update.price}`);
        logger.info(`[DRY RUN] ${parts.join(', ')}`);
        processed++;
        continue;
      }

      if (update.price && update.price !== variant.price) {
        const priceResp = await graphql(UPDATE_VARIANT_PRICE, {
          input: { id: variant.id, price: update.price },
        });
        const priceErrors = priceResp?.data?.productVariantUpdate?.userErrors;
        if (priceErrors?.length) {
          logger.error(`SKU ${update.sku}: price update failed — ${priceErrors[0].message}`);
          errors++;
          continue;
        }
      }

      const inventoryItemId = variant.inventoryItem.id;

      const levelResp = await graphql(GET_INVENTORY_LEVEL, {
        inventoryItemId,
        locationId: gidLocation,
      });

      const currentQty = levelResp?.data?.inventoryItem?.inventoryLevel
        ?.quantities?.find((q) => q.name === 'available')?.quantity ?? 0;
      const delta = update.inventory - currentQty;

      if (delta !== 0) {
        const adjResp = await graphql(ADJUST_INVENTORY, {
          input: {
            reason: 'correction',
            name: 'available',
            changes: [
              {
                delta,
                inventoryItemId,
                locationId: gidLocation,
              },
            ],
          },
        });
        const adjErrors = adjResp?.data?.inventoryAdjustQuantities?.userErrors;
        if (adjErrors?.length) {
          logger.error(`SKU ${update.sku}: inventory adjust failed — ${adjErrors[0].message}`);
          errors++;
          continue;
        }
      }

      logger.info(`SKU ${update.sku}: updated (inv: ${currentQty} → ${update.inventory}${update.price ? `, price: ${update.price}` : ''})`);
      processed++;
    } catch (err) {
      logger.error(`SKU ${update.sku}: ${err.message}`);
      errors++;
    }
  }

  return { processed, errors, notFound };
}
