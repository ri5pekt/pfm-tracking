import assert from 'node:assert/strict';
import { test } from 'node:test';
import { klaviyoMetricName } from './client.js';

test('klaviyoMetricName maps PFM event types', () => {
  assert.equal(klaviyoMetricName('shipment.delivered'), 'PFM Shipment Delivered');
  assert.equal(
    klaviyoMetricName('shipment.delivery_attempt_failed'),
    'PFM Shipment Delivery Attempt Failed',
  );
});
