import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { TRACKING_NUMBER_SHAPE, TrackingMoreClient } from './client.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string) => Promise<Response> | Response): void {
  globalThis.fetch = ((url: string) => Promise.resolve(handler(url))) as typeof fetch;
}

test('TRACKING_NUMBER_SHAPE rejects Excel-mangled scientific notation', () => {
  assert.equal(TRACKING_NUMBER_SHAPE.test('9.40011E+21'), false);
  assert.equal(TRACKING_NUMBER_SHAPE.test('9400111105503475252067'), true);
  assert.equal(TRACKING_NUMBER_SHAPE.test('1Z16D13WYW07095240'), true);
  assert.equal(TRACKING_NUMBER_SHAPE.test('202608261246STGVTL'), true);
  assert.equal(TRACKING_NUMBER_SHAPE.test(''), false);
  assert.equal(TRACKING_NUMBER_SHAPE.test('has space'), false);
  assert.equal(TRACKING_NUMBER_SHAPE.test('a,b'), false);
});

test('getTrackings drops a malformed tracking_number instead of failing the whole batch', async () => {
  const tm = new TrackingMoreClient({ apiKey: 'k', apiBase: 'https://api.trackingmore.com/v4' });
  let sentNumbers: string | null = null;
  stubFetch((url) => {
    const u = new URL(url);
    sentNumbers = u.searchParams.get('tracking_numbers');
    return new Response(
      JSON.stringify({
        meta: { code: 200 },
        data: [{ tracking_number: 'GOOD123456', delivery_status: 'transit' }],
      }),
      { status: 200 },
    );
  });

  const result = await tm.getTrackings(['GOOD123456', '9.40011E+21']);

  // The poisoned value never reaches TrackingMore.
  assert.equal(sentNumbers, 'GOOD123456');
  assert.equal(result.has('GOOD123456'), true);
  assert.equal(result.has('9.40011E+21'), false);
});

test('getTrackings returns empty map without a request when every number is malformed', async () => {
  const tm = new TrackingMoreClient({ apiKey: 'k', apiBase: 'https://api.trackingmore.com/v4' });
  let called = false;
  stubFetch(() => {
    called = true;
    return new Response('{}', { status: 200 });
  });

  const result = await tm.getTrackings(['9.40011E+21', '']);

  assert.equal(called, false);
  assert.equal(result.size, 0);
});
