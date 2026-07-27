import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEventHash } from './event-hash.js';

describe('buildEventHash', () => {
  it('is stable for same inputs', () => {
    const occurredAt = new Date('2026-07-01T12:00:00.000Z');
    const a = buildEventHash({
      shipmentId: 'abc',
      occurredAt,
      rawStatus: 'InTransit',
      rawSubstatusCode: 'InTransit_002',
      description: 'Arrival scan',
    });
    const b = buildEventHash({
      shipmentId: 'abc',
      occurredAt,
      rawStatus: 'InTransit',
      rawSubstatusCode: 'InTransit_002',
      description: 'Arrival scan',
    });
    assert.equal(a, b);
    assert.equal(a.length, 64);
  });

  it('changes when description changes', () => {
    const occurredAt = new Date('2026-07-01T12:00:00.000Z');
    const a = buildEventHash({
      shipmentId: 'abc',
      occurredAt,
      rawStatus: 'InTransit',
      rawSubstatusCode: null,
      description: 'A',
    });
    const b = buildEventHash({
      shipmentId: 'abc',
      occurredAt,
      rawStatus: 'InTransit',
      rawSubstatusCode: null,
      description: 'B',
    });
    assert.notEqual(a, b);
  });
});
