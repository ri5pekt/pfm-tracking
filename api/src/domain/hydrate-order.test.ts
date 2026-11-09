import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hydrateIdentityAllowed, sourceCredentialsMatch } from './hydrate-order.js';

describe('sourceCredentialsMatch', () => {
  it('matches email case-insensitively', () => {
    assert.equal(
      sourceCredentialsMatch(
        { email: 'rio@example.com', postcode: '' },
        { email: '  RIO@example.com ', postcode: null },
      ),
      true,
    );
  });

  it('matches postcode ignoring spaces', () => {
    assert.equal(
      sourceCredentialsMatch(
        { email: '', postcode: 'WA66DD' },
        { email: null, postcode: 'WA6 6DD' },
      ),
      true,
    );
  });

  it('rejects mismatched email even when postcode empty on source', () => {
    assert.equal(
      sourceCredentialsMatch(
        { email: 'a@b.com', postcode: '' },
        { email: 'other@b.com', postcode: null },
      ),
      false,
    );
  });
});

describe('hydrateIdentityAllowed', () => {
  it('skips email/postcode when requireIdentity is false', () => {
    assert.equal(
      hydrateIdentityAllowed(false, { email: '', postcode: '' }, { email: null, postcode: null }),
      true,
    );
  });

  it('still requires a match when requireIdentity is true', () => {
    assert.equal(
      hydrateIdentityAllowed(true, { email: '', postcode: '' }, { email: 'a@b.com', postcode: null }),
      false,
    );
  });
});
