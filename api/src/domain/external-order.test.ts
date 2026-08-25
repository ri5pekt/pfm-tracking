import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeExternalOrderId,
  primaryCarrier,
  resolveCarrierTrackingUrl,
} from './external-order.js';

describe('external order helpers', () => {
  it('strips whitespace and a leading # from Woo order ids', () => {
    assert.equal(normalizeExternalOrderId('  #4081591  '), '4081591');
    assert.equal(normalizeExternalOrderId('4081591'), '4081591');
  });

  it('prefers stored carrier URL, else fills the template', () => {
    assert.equal(
      resolveCarrierTrackingUrl('https://dhl.example/abc', 'https://t/{tracking_number}', '1Z'),
      'https://dhl.example/abc',
    );
    assert.equal(
      resolveCarrierTrackingUrl(null, 'https://t/{tracking_number}', '1Z 99'),
      'https://t/1Z%2099',
    );
    assert.equal(resolveCarrierTrackingUrl(null, null, '1Z'), null);
  });

  it('picks the carrier of the shipment matching roll-up status', () => {
    assert.equal(
      primaryCarrier(
        [
          { status: 'DELIVERED', carrier: 'USPS' },
          { status: 'IN_TRANSIT', carrier: 'DHL eCommerce' },
        ],
        'IN_TRANSIT',
      ),
      'DHL eCommerce',
    );
    assert.equal(primaryCarrier([{ status: 'IN_TRANSIT', carrier: 'UPS' }], 'IN_TRANSIT'), 'UPS');
    assert.equal(primaryCarrier([], 'IN_TRANSIT'), null);
  });
});
