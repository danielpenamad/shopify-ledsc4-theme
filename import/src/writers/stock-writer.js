import { graphql } from './shopify-client.js';
import { randomUUID } from 'crypto';
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

function buildSetInventoryMutation(idempotencyKey) {
  return `
    mutation SetStock {
      inventorySetQuantities(
        input: {
          reason: "correction"
          name: "available"
          quantities: [
            {
              inventoryItemId: "$ITEM_ID"
              locationId: "$LOCATION_ID"
              quantity: $QUANTITY
              changeFromQuantity: $FROM_QTY
            }
          ]
        }
      ) @idempotent(key: "${idempotencyKey}") {
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
}

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

      const key = randomUUID();
      const mutation = buildSetInventoryMutation(key)
        .replace('$ITEM_ID', variant.inventoryItem.id)
        .replace('$LOCATION_ID', gidLocation)
        .replace('$QUANTITY', String(update.inventory))
        .replace('$FROM_QTY', String(currentQty));

      const setResp = await graphql(mutation);

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
