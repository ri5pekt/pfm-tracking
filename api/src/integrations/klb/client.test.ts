import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { KlbClient } from './client.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string) => Promise<Response> | Response): void {
  globalThis.fetch = ((url: string) => Promise.resolve(handler(url))) as typeof fetch;
}

test('getCustomerOrderEmail returns null when credentials are missing', async () => {
  const klb = new KlbClient({ apiBase: 'https://app.zenventory.com/rest', legacySecureKey: '' });
  let called = false;
  stubFetch(() => {
    called = true;
    return new Response('{}', { status: 200 });
  });
  const email = await klb.getCustomerOrderEmail('4049748');
  assert.equal(email, null);
  assert.equal(called, false);
});

test('getCustomerOrderEmail parses email from customer-orders response', async () => {
  const klb = new KlbClient({
    apiBase: 'https://app.zenventory.com/rest',
    legacySecureKey: '',
    apiKey: 'k',
    apiSecret: 's',
  });
  stubFetch((url) => {
    assert.match(url, /\/customer-orders\?orderNumber=4049748/);
    return new Response(
      JSON.stringify({ customerOrders: [{ customer: { email: '  rio@example.com  ' } }] }),
      { status: 200 },
    );
  });
  const email = await klb.getCustomerOrderEmail('4049748');
  assert.equal(email, 'rio@example.com');
});

test('getCustomerOrder parses line items from customer-orders', async () => {
  const klb = new KlbClient({
    apiBase: 'https://app.zenventory.com/rest',
    legacySecureKey: '',
    apiKey: 'k',
    apiSecret: 's',
  });
  stubFetch(() =>
    new Response(
      JSON.stringify({
        customerOrders: [
          {
            customer: { email: 'sean@example.com' },
            items: [
              { sku: '860012469703', quantity: 3, description: 'Particle Anti-Gray Serum' },
              { sku: '636665869661', orderQuantity: 1, description: 'Shampoo' },
            ],
          },
        ],
      }),
      { status: 200 },
    ),
  );
  const row = await klb.getCustomerOrder('4083679');
  assert.equal(row?.items.length, 2);
  assert.deepEqual(row?.items[0], {
    sku: '860012469703',
    quantity: 3,
    title: 'Particle Anti-Gray Serum',
  });
});

test('getCustomerOrderEmail returns null when order not found', async () => {
  const klb = new KlbClient({
    apiBase: 'https://app.zenventory.com/rest',
    legacySecureKey: '',
    apiKey: 'k',
    apiSecret: 's',
  });
  stubFetch(() => new Response(JSON.stringify({ customerOrders: [] }), { status: 200 }));
  const email = await klb.getCustomerOrderEmail('does-not-exist');
  assert.equal(email, null);
});

test('getCustomerOrderEmail returns null on non-2xx status', async () => {
  const klb = new KlbClient({
    apiBase: 'https://app.zenventory.com/rest',
    legacySecureKey: '',
    apiKey: 'k',
    apiSecret: 's',
  });
  stubFetch(() => new Response('server error', { status: 500 }));
  const email = await klb.getCustomerOrderEmail('4049748');
  assert.equal(email, null);
});

test('getCustomerOrderEmail returns null on network error (never throws)', async () => {
  const klb = new KlbClient({
    apiBase: 'https://app.zenventory.com/rest',
    legacySecureKey: '',
    apiKey: 'k',
    apiSecret: 's',
  });
  stubFetch(() => {
    throw new Error('network down');
  });
  const email = await klb.getCustomerOrderEmail('4049748');
  assert.equal(email, null);
});
