import { createAdminApiClient } from '@shopify/admin-api-client';
import logger from '../logger.js';

let client = null;

const RATE_LIMIT_MS = 520;
let lastRequestTime = 0;

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

export function initClient() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!store || !token) {
    throw new Error('Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN in .env');
  }

  client = createAdminApiClient({
    storeDomain: store,
    apiVersion: '2026-04',
    accessToken: token,
  });

  return client;
}

export function getClient() {
  if (!client) throw new Error('Call initClient() first');
  return client;
}

export async function restGet(path) {
  await throttle();
  const response = await client.request(path, { method: 'GET' });
  return response;
}

export async function restPost(path, body) {
  await throttle();
  const response = await client.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response;
}

export async function restPut(path, body) {
  await throttle();
  const response = await client.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response;
}

/**
 * GraphQL request with automatic retry on throttle.
 *
 * @shopify/admin-api-client .request() returns { data, errors, extensions }
 * where errors can be an object, an array, or undefined.
 */
export async function graphql(query, variables = {}) {
  await throttle();
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await client.request(query, { variables });

    const cost = response?.extensions?.cost;
    if (cost?.throttleStatus?.currentlyAvailable < 100) {
      const waitMs = Math.ceil(cost.requestedQueryCost / cost.throttleStatus.restoreRate) * 1000;
      logger.info(`GraphQL throttle: waiting ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const errors = response?.errors;
    const errorList = Array.isArray(errors)
      ? errors
      : errors?.graphQLErrors ?? errors?.networkErrors ?? [];
    const isThrottled = Array.isArray(errorList) &&
      errorList.some((e) => (e.message || '').includes('Throttled'));

    if (isThrottled) {
      const backoff = 2000 * (attempt + 1);
      logger.warn(`GraphQL throttled, retry in ${backoff}ms (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    if (errorList.length > 0) {
      const msg = errorList.map((e) => e.message || JSON.stringify(e)).join('; ');
      throw new Error(`GraphQL error: ${msg}`);
    }

    return response;
  }

  throw new Error('GraphQL request failed after max retries (throttled)');
}
