import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generatePublicToken,
  hashPublicToken,
  mintPublicToken,
  sealPublicToken,
  unsealPublicToken,
} from './tokens.js';

test('hashPublicToken is stable sha256 hex', () => {
  const token = 'abc123';
  const a = hashPublicToken(token);
  const b = hashPublicToken(token);
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('seal/unseal round-trip', () => {
  const secret = 'test-secret-at-least-16';
  const token = generatePublicToken();
  const sealed = sealPublicToken(token, secret);
  assert.notEqual(sealed, token);
  assert.equal(unsealPublicToken(sealed, secret), token);
  assert.equal(unsealPublicToken(sealed, 'wrong-secret'), null);
});

test('mintPublicToken produces matching hash', () => {
  const minted = mintPublicToken('test-secret-at-least-16');
  assert.equal(hashPublicToken(minted.token), minted.hash);
  assert.equal(unsealPublicToken(minted.sealed, 'test-secret-at-least-16'), minted.token);
});
