import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeApiKey } from './api-key-auth.js';

describe('authorizeApiKey', () => {
  it('rejects when expected key missing', () => {
    assert.equal(authorizeApiKey({ headers: { 'x-api-key': 'abc' } }, null), false);
    assert.equal(authorizeApiKey({ headers: { 'x-api-key': 'abc' } }, undefined), false);
    assert.equal(authorizeApiKey({ headers: { 'x-api-key': 'abc' } }, ''), false);
  });

  it('accepts X-Api-Key', () => {
    assert.equal(authorizeApiKey({ headers: { 'x-api-key': 'secret' } }, 'secret'), true);
    assert.equal(authorizeApiKey({ headers: { 'x-api-key': 'wrong' } }, 'secret'), false);
  });

  it('accepts Authorization Bearer', () => {
    assert.equal(
      authorizeApiKey({ headers: { authorization: 'Bearer secret' } }, 'secret'),
      true,
    );
    assert.equal(
      authorizeApiKey({ headers: { authorization: 'Bearer wrong' } }, 'secret'),
      false,
    );
  });

  it('rejects missing/invalid headers', () => {
    assert.equal(authorizeApiKey({ headers: {} }, 'secret'), false);
    assert.equal(authorizeApiKey({ headers: { authorization: 1 } }, 'secret'), false);
  });
});
