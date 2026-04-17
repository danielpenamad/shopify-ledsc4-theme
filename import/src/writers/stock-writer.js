import { graphql } from './shopify-client.js';
import logger from '../logger.js';

const FIND_VARIANT_WITH_INVENTORY = `
  query findVariantBySku($query: String!, $locationId: ID!) {
    productVariants(first: 1, query: $query) {
      edges {
        node {
          id
          sku
          inventoryItem {
            id
            inventoryLevel(locationId: $locationId) {
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
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
 */
export async function writeStockUpdates(updates, options = {}) {
  const { dryRun = false, locationId } = options;

  if (!locationId) throw new Error('SHOPIFY_LOCATION_ID is required');

  const gidLocation = locationId.startsWith('gid://')
    ? locationId
    : `gid://shopify/Location/${locationId}`;

  let processed = 0;
  let errors = 0;
  let notFound = 0;

  for (const update of updates) {
    try {
      const resp = await graphql(FIND_VARIANT_WITH_INVENTORY, {
        query: `sku:${update.sku}`,
        locationId: gidLocation,
      });
      const variant = resp?.data?.productVariants?.edges?.[0]?.node;

      if (!variant) {
        notFound++;
        continue;
      }

      const currentQty = variant.inventoryItem?.inventoryLevel
        ?.quantities?.find((q) => q.name === 'available')?.quantity ?? 0;

      if (currentQty === update.inventory) {
        processed++;
        continue;
      }

      if (dryRun) {
        logger.info(`[DRY RUN] SKU ${update.sku}: ${currentQty} → ${update.inventory}`);
        processed++;
        continue;
      }

      const setResp = await graphql(SET_INVENTORY, {
        input: {
          reason: 'correction',
          name: 'available',
          quantities: [
            {
              inventoryItemId: variant.inventoryItem.id,
              locationId: gidLocation,
              quantity: update.inventory,
              changeFromQuantity: currentQty,
            },
          ],
        },
      });

      const ue = setResp?.data?.inventorySetQuantities?.userErrors;
      if (ue?.length) {
        logger.error(`SKU ${update.sku}: ${ue[0].message}`);
        errors++;
        continue;
      }

      logger.info(`SKU ${update.sku}: ${currentQty} → ${update.inventory}`);
      processed++;
    } catch (err) {
      logger.error(`SKU ${update.sku}: ${err.message}`);
      errors++;
    }
  }

  logger.info(`Stock sync: ${processed} updated, ${notFound} not found, ${errors} errors`);
  return { processed, errors, notFound };
}
