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

const SET_INVENTORY = `
  mutation setInventory($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
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

      const inventoryItemId = variant.inventoryItem.id;

      const setResp = await graphql(SET_INVENTORY, {
        input: {
          reason: 'correction',
          name: 'available',
          quantities: [
            {
              inventoryItemId,
              locationId: gidLocation,
              quantity: update.inventory,
            },
          ],
        },
      });

      const setErrors = setResp?.data?.inventorySetQuantities?.userErrors;
      if (setErrors?.length) {
        logger.error(`SKU ${update.sku}: inventory set failed — ${setErrors[0].message}`);
        errors++;
        continue;
      }

      logger.info(`SKU ${update.sku}: stock → ${update.inventory}`);
      processed++;
    } catch (err) {
      logger.error(`SKU ${update.sku}: ${err.message}`);
      errors++;
    }
  }

  logger.info(`Stock sync: ${processed} updated, ${notFound} not found, ${errors} errors`);
  return { processed, errors, notFound };
}
