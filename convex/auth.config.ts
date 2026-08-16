import type { AuthConfig } from 'convex/server';

const domain = process.env.AUTH0_DOMAIN!;

export default {
  providers: [
    {
      algorithm: 'RS256',
      applicationID: process.env.AUTH0_AUDIENCE!,
      issuer: `https://${domain}/`,
      jwks: `https://${domain}/.well-known/jwks.json`,
      type: 'customJwt',
    },
  ],
} satisfies AuthConfig;
