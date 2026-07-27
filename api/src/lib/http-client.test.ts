import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactHeaders } from './http-client.js';

describe('redactHeaders', () => {
  it('redacts Authorization and leaves others', () => {
    const out = redactHeaders({
      Authorization: 'Bearer secret-token',
      'Content-Type': 'application/json',
      'X-Api-Key': 'abc',
    });
    assert.equal(out.Authorization, '[REDACTED]');
    assert.equal(out['X-Api-Key'], '[REDACTED]');
    assert.equal(out['Content-Type'], 'application/json');
  });
});
