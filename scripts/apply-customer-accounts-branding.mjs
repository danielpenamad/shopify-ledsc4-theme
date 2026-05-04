// Idempotently applies the new customer accounts branding (logo, fonts,
// colors) for the LedsC4 B2B Outlet store via the Branding API.
//
// See docs/shopify-customer-accounts-branding.md for the full context.
//
// Pre-requisites:
//   - Plan: Plus or Development (Shopify-imposed for the Branding API).
//   - Scopes: read_checkout_branding_settings, write_checkout_branding_settings.
//   - File `logo-ledsc4.png` uploaded to Shopify Files (Admin → Content →
//     Files). SVG is rejected by the API.
//
// Usage:
//   node --env-file=shopify-ledsc4-theme.env scripts/apply-customer-accounts-branding.mjs

import { gql, requireEnv } from './_shopify.mjs';

requireEnv();

const LOGO_FILENAME = 'logo-ledsc4.png';

// Brand tokens — mirror the Dawn theme's scheme-1 / type_header_font.
// If the theme palette changes, update both here and config/settings_data.json.
const BRAND = {
  brandColor: '#1A1A1A',
  scheme1Background: '#FFFFFF',
  scheme2Background: '#F5F5F5',
  fontFamily: 'Assistant',
  fontBaseWeight: 400,
  fontBoldWeight: 700,
  logoMaxWidth: 140,
};

async function findPublishedCheckoutProfileId() {
  const data = await gql(
    `{ checkoutProfiles(first: 20) { edges { node { id name isPublished } } } }`,
    {},
    { requestedCost: 5 },
  );
  const profile = data.checkoutProfiles.edges
    .map((e) => e.node)
    .find((n) => n.isPublished);
  if (!profile) throw new Error('No published CheckoutProfile found.');
  return profile.id;
}

async function findLogoMediaImageId() {
  const data = await gql(
    `query($q:String!){ files(first:1, query:$q){ edges { node { ... on MediaImage { id image { url } } } } } }`,
    { q: `filename:${LOGO_FILENAME}` },
    { requestedCost: 4 },
  );
  const node = data.files.edges[0]?.node;
  if (!node?.id) {
    throw new Error(
      `MediaImage "${LOGO_FILENAME}" not found in Shopify Files. Upload it first ` +
        `(Admin → Content → Files). Branding API rejects SVG.`,
    );
  }
  return node.id;
}

async function applyBranding(profileId, mediaImageId) {
  const mutation = `
    mutation upsert($input: CheckoutBrandingInput!, $id: ID!) {
      checkoutBrandingUpsert(checkoutBrandingInput: $input, checkoutProfileId: $id) {
        checkoutBranding {
          designSystem {
            colors { global { brand accent } schemes { scheme1 { base { background } } scheme2 { base { background } } } }
            typography { primary { name } secondary { name } }
          }
          customizations {
            header { logo { image { url } maxWidth } }
            favicon { image { url } }
          }
        }
        userErrors { code field message }
      }
    }`;

  const variables = {
    id: profileId,
    input: {
      designSystem: {
        colors: {
          global: { brand: BRAND.brandColor, accent: BRAND.brandColor },
          schemes: {
            scheme1: { base: { background: BRAND.scheme1Background } },
            scheme2: { base: { background: BRAND.scheme2Background } },
          },
        },
        typography: {
          primary: {
            shopifyFontGroup: {
              name: BRAND.fontFamily,
              baseWeight: BRAND.fontBaseWeight,
              boldWeight: BRAND.fontBoldWeight,
            },
          },
          secondary: {
            shopifyFontGroup: {
              name: BRAND.fontFamily,
              baseWeight: BRAND.fontBaseWeight,
              boldWeight: BRAND.fontBoldWeight,
            },
          },
        },
      },
      customizations: {
        header: {
          logo: {
            image: { mediaImageId },
            maxWidth: BRAND.logoMaxWidth,
          },
        },
        favicon: { mediaImageId },
      },
    },
  };

  const data = await gql(mutation, variables, { requestedCost: 30 });
  const errs = data.checkoutBrandingUpsert.userErrors;
  if (errs?.length) {
    throw new Error(`userErrors: ${JSON.stringify(errs, null, 2)}`);
  }
  return data.checkoutBrandingUpsert.checkoutBranding;
}

async function main() {
  console.log('• Resolving published CheckoutProfile…');
  const profileId = await findPublishedCheckoutProfileId();
  console.log(`  ${profileId}`);

  console.log(`• Resolving "${LOGO_FILENAME}" in Shopify Files…`);
  const mediaImageId = await findLogoMediaImageId();
  console.log(`  ${mediaImageId}`);

  console.log('• Applying branding (checkoutBrandingUpsert)…');
  const branding = await applyBranding(profileId, mediaImageId);

  console.log('\nDone. Persisted state:');
  console.log(JSON.stringify(branding, null, 2));
  console.log(
    '\nVerify visually:\n  https://ledsc4-b2b-outlet.myshopify.com/account/login',
  );
}

main().catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});
