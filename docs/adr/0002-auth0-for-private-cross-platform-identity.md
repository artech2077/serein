# ADR 0002: Use Auth0 for private cross-platform identity

## Status

Accepted

## Context

Serein is a private personal-finance product. Its authentication boundary must
support an approved-user launch, an Expo native OAuth/OIDC flow using
Authorization Code with PKCE, a secure web session, revocation, and a single
identity that the API can use to scope a finance workspace.

The web specification requires a secure HttpOnly session cookie. The iOS
specification requires authentication in the system browser and a verified
return to the app. The API, rather than either client, owns finance-workspace
authorization and state transitions.

## Decision

Use **Auth0** as Serein's identity provider. Create one Auth0 tenant with a
Regular Web Application for `apps/web` and a Native Application for `apps/ios`.

The API will validate Auth0-issued access tokens and treat the validated OIDC
`sub` claim as the immutable external identity key. It will create or look up
the finance workspace from that key. Clients must never send a user or workspace
identifier as an authorization substitute.

Use `@auth0/nextjs-auth0` for the web application. Its encrypted, HttpOnly
session cookie satisfies the web-session requirement. Use `react-native-auth0`
for iOS in an Expo development build. It will authenticate through the system
browser with PKCE and return via the configured custom-scheme callback.

At launch, use the approved-user policy: disable public sign-up and create each
approved user through the Auth0 Dashboard or Management API. If Serein later
adopts invitations, add a blocking Pre User Registration Action backed by a
server-maintained allowlist or unconsumed invitation; it must fail closed when
the allowlist cannot be checked.

Register only these intended redirect patterns, replacing placeholders during
environment setup:

| Client                    | Callback                                                           | Logout                                                             |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Web development           | `http://localhost:3000/auth/callback`                              | `http://localhost:3000`                                            |
| Web production            | `https://<web-host>/auth/callback`                                 | `https://<web-host>`                                               |
| iOS                       | `serein://<tenant-domain>/ios/com.artech2077.serein/callback`      | `serein://<tenant-domain>/ios/com.artech2077.serein/callback`      |
| Android (once configured) | `serein://<tenant-domain>/android/<android-package-name>/callback` | `serein://<tenant-domain>/android/<android-package-name>/callback` |

Add only deliberately required HTTPS web origins, and do not enable preview
origins by default. Verify email before treating an identity as eligible for a
finance workspace. Do not put financial records or authorization state in
mutable identity-provider metadata.

## Consequences

Web and native sessions remain intentionally platform-specific. They identify
the same person through the shared Auth0 tenant and validated `sub`, not through
cookie or credential sharing.

The implementation must add Auth0 tenant configuration and deployment secrets;
install the Auth0 web and native SDKs; validate issuer, audience, signature,
expiry, and `sub` in Fastify; and test approved access, rejection of unapproved
registration, callback validation, API token rejection, and refresh-token
revocation. The Android package identifier must be set before its redirect URL
is registered.

Auth0 introduces dashboard configuration and two application registrations, but
avoids weakening the explicit HttpOnly web-session requirement. See the
[provider evaluation](../research/auth-provider-evaluation.md) for the
source-backed comparison, official documentation links, and detailed setup
steps.
