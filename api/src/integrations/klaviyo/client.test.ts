import assert from 'node:assert/strict';
import { test } from 'node:test';
import { klaviyoMetricName } from './client.js';

test('klaviyoMetricName maps PFM event types', () => {
  assert.equal(klaviyoMetricName('shipment.delivered'), 'PFM Tracking - Received Delivery');
  assert.equal(
    klaviyoMetricName('shipment.delivery_attempt_failed'),
    'PFM Tracking - Failed Delivery Attempt',
  );
  assert.equal(
    klaviyoMetricName('shipment.available_for_pickup'),
    'PFM Tracking - Available For Pickup',
  );
  assert.equal(klaviyoMetricName('shipment.address_problem'), 'PFM Tracking - Address Problem');
  assert.equal(klaviyoMetricName('shipment.no_access'), 'PFM Tracking - No Access');
  assert.equal(
    klaviyoMetricName('shipment.returned_to_sender'),
    'PFM Tracking - Returned To Sender',
  );
});
