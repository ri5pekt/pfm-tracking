import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const SEAL_PREFIX = 'v1:';

export function generatePublicToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashPublicToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sealKey(secret: string): Buffer {
  return createHash('sha256').update(`pfm-public-token:${secret}`).digest();
}

/** Encrypt token for CS/email link assembly. Raw plaintext is not stored. */
export function sealPublicToken(token: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(secret), iv);
  const enc = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SEAL_PREFIX}${Buffer.concat([iv, tag, enc]).toString('base64url')}`;
}

export function unsealPublicToken(sealed: string, secret: string): string | null {
  if (!sealed.startsWith(SEAL_PREFIX)) return null;
  try {
    const buf = Buffer.from(sealed.slice(SEAL_PREFIX.length), 'base64url');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', sealKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function mintPublicToken(secret: string): { token: string; hash: string; sealed: string } {
  const token = generatePublicToken();
  return {
    token,
    hash: hashPublicToken(token),
    sealed: sealPublicToken(token, secret),
  };
}
