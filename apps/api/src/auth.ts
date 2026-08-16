import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface AuthenticatedIdentity {
  scopes: ReadonlySet<string>;
  subject: string;
}

export interface AccessTokenVerifier {
  verify(accessToken: string): Promise<AuthenticatedIdentity>;
}

export interface Auth0AccessTokenConfig {
  audience: string;
  domain: string;
}

export function getAuth0AccessTokenConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Auth0AccessTokenConfig | undefined {
  const domain = environment.AUTH0_DOMAIN?.trim();
  const audience = environment.AUTH0_AUDIENCE?.trim();

  if (!domain || !audience) {
    return undefined;
  }

  return { audience, domain };
}

export function createAuth0AccessTokenVerifier(
  config: Auth0AccessTokenConfig,
): AccessTokenVerifier {
  const issuer = `https://${config.domain.replace(/^https:\/\//, '').replace(/\/$/, '')}/`;
  const keySet = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));

  return {
    async verify(accessToken) {
      const { payload } = await jwtVerify(accessToken, keySet, {
        algorithms: ['RS256'],
        audience: config.audience,
        issuer,
      });

      return toAuthenticatedIdentity(payload);
    },
  };
}

function toAuthenticatedIdentity(payload: JWTPayload): AuthenticatedIdentity {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('The access token does not contain a subject.');
  }

  return {
    scopes: new Set(
      typeof payload.scope === 'string'
        ? payload.scope.split(' ').filter((scope) => scope.length > 0)
        : [],
    ),
    subject: payload.sub,
  };
}
