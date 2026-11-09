import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dedupeKey,
  isDeliveryAttemptFailed,
  notificationEventsFor,
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

const base = {
  statusRank: 50,
  internalStatus: 'OUT_FOR_DELIVERY',
  isStalled: false,
  latestRawStatus: 'OutForDelivery',
  latestDescription: 'Out for Delivery',
};

test('available for pickup replaces out for delivery', () => {
  assert.deepEqual(notificationEventsFor(base), [
    'shipment.in_transit',
    'shipment.out_for_delivery',
  ]);
  assert.deepEqual(
    notificationEventsFor({
      ...base,
      latestRawStatus: 'AvailableForPickup',
      latestDescription: 'Available for pickup',
    }),
    ['shipment.in_transit', 'shipment.available_for_pickup'],
  );
  assert.deepEqual(
    notificationEventsFor({
      ...base,
      latestRawStatus: 'pickup',
      latestDescription: 'OUT FOR DELIVERY',
    }),
    ['shipment.in_transit', 'shipment.out_for_delivery'],
  );
});

test('address and no access replace the generic exception', () => {
  assert.deepEqual(
    notificationEventsFor({
      ...base,
      statusRank: 55,
      internalStatus: 'EXCEPTION',
      latestRawStatus: 'DeliveryException',
      latestDescription: 'Invalid Address. Missing Apartment#',
    }),
    ['shipment.in_transit', 'shipment.address_problem'],
  );
  assert.deepEqual(
    notificationEventsFor({
      ...base,
      statusRank: 55,
      internalStatus: 'EXCEPTION',
      latestRawStatus: 'DeliveryAttemptFailed',
      latestDescription: 'No access — lack of an access code',
    }),
    ['shipment.in_transit', 'shipment.no_access'],
  );
});

test('return replaces in transit and exception', () => {
  assert.deepEqual(
    notificationEventsFor({
      ...base,
      statusRank: 40,
      internalStatus: 'IN_TRANSIT',
      latestRawStatus: 'ReturnToSender',
      latestDescription: 'Returning to sender',
    }),
    ['shipment.returned_to_sender'],
  );
});
