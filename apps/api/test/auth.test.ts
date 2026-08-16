import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuth0AccessTokenVerifier } from '../src/auth.js';

const domain = 'tenant.eu.auth0.com';
const audience = 'https://api.serein.local';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Auth0 access-token verification', () => {
  it('accepts an RS256 token with the configured issuer, audience, subject, and scopes', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: [publicJwk] }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }),
      ),
    );

    const accessToken = await signAccessToken(privateKey, {
      scope: 'read:workspace write:workspace',
      sub: 'auth0|verified-user',
    });
    const verifier = createAuth0AccessTokenVerifier({ audience, domain });

    await expect(verifier.verify(accessToken)).resolves.toEqual({
      scopes: new Set(['read:workspace', 'write:workspace']),
      subject: 'auth0|verified-user',
    });
  });

  it('rejects a token issued for a different audience', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: [publicJwk] }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }),
      ),
    );

    const accessToken = await signAccessToken(privateKey, {
      aud: 'https://another-api.example',
      scope: 'read:workspace',
      sub: 'auth0|verified-user',
    });
    const verifier = createAuth0AccessTokenVerifier({ audience, domain });

    await expect(verifier.verify(accessToken)).rejects.toThrow();
  });

  it('rejects an expired token and a token without a subject', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: [publicJwk] }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }),
      ),
    );

    const expiredToken = await signAccessToken(privateKey, {
      expirationTime: '-1h',
      scope: 'read:workspace',
      sub: 'auth0|verified-user',
    });
    const tokenWithoutSubject = await signAccessToken(privateKey, {
      scope: 'read:workspace',
    });
    const verifier = createAuth0AccessTokenVerifier({ audience, domain });

    await expect(verifier.verify(expiredToken)).rejects.toThrow();
    await expect(verifier.verify(tokenWithoutSubject)).rejects.toThrow(
      'does not contain a subject',
    );
  });
});

async function signAccessToken(
  privateKey: CryptoKey,
  claims: { aud?: string; expirationTime?: string; scope: string; sub?: string },
) {
  const token = new SignJWT({ scope: claims.scope })
    .setAudience(claims.aud ?? audience)
    .setExpirationTime(claims.expirationTime ?? '5m')
    .setIssuedAt()
    .setIssuer(`https://${domain}/`)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' });

  if (claims.sub) {
    token.setSubject(claims.sub);
  }

  return token.sign(privateKey);
}
