import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isDhlEnRouteToDistributionCenter,
  mapRawStatus,
  type StatusMapping,
} from './status.js';

const TM_INFORECEIVED: StatusMapping[] = [
  {
    source: 'trackingmore',
    raw_status: 'inforeceived',
    raw_substatus_code: 'inforeceived001',
    internal_status: 'LABEL_CREATED',
    status_rank: 30,
  },
];

test('isDhlEnRouteToDistributionCenter matches DHL DC wording', () => {
  assert.equal(
    isDhlEnRouteToDistributionCenter(
      'EN ROUTE TO DHL ECOMMERCE DISTRIBUTION CENTER OR AWAITING PROCESSING',
    ),
    true,
  );
  assert.equal(isDhlEnRouteToDistributionCenter('LABEL CREATED'), false);
  assert.equal(isDhlEnRouteToDistributionCenter(null), false);
});

test('DHL en-route-to-DC inforeceived maps to IN_TRANSIT', () => {
  const mapped = mapRawStatus(TM_INFORECEIVED, {
    source: 'trackingmore',
    rawStatus: 'inforeceived',
    rawSubstatusCode: 'inforeceived001',
    description: 'EN ROUTE TO DHL ECOMMERCE DISTRIBUTION CENTER OR AWAITING PROCESSING',
  });
  assert.deepEqual(mapped, { internalStatus: 'IN_TRANSIT', statusRank: 40 });
});

test('plain LABEL CREATED inforeceived stays LABEL_CREATED', () => {
  const mapped = mapRawStatus(TM_INFORECEIVED, {
    source: 'trackingmore',
    rawStatus: 'inforeceived',
    rawSubstatusCode: 'inforeceived001',
    description: 'LABEL CREATED',
  });
  assert.deepEqual(mapped, { internalStatus: 'LABEL_CREATED', statusRank: 30 });
});
