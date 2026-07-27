import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dedupeKey,
  isDeliveryAttemptFailed,
} from './notifications.js';

test('dedupeKey is shipment + event type', () => {
  assert.equal(
    dedupeKey('abc', 'shipment.shipped'),
    'abc:shipment.shipped',
  );
});

test('isDeliveryAttemptFailed distinguishes attempt vs generic', () => {
  assert.equal(isDeliveryAttemptFailed('DeliveryAttemptFailed'), true);
  assert.equal(isDeliveryAttemptFailed('AttemptFail'), true);
  assert.equal(isDeliveryAttemptFailed('DeliveryException'), false);
  assert.equal(isDeliveryAttemptFailed('Exception'), false);
});
