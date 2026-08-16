# ADR 0003: Use Convex for durable finance workspace persistence

## Status

Accepted — 2026-08-16

## Context

The initial API established an Auth0-scoped finance workspace contract with an in-memory store.
That store was appropriate to settle the contract, but it loses data on an API restart and cannot
provide the durable record required for personal-finance data.

Serein uses Auth0 access tokens for its custom API audience. The web application keeps its Auth0
session in an HttpOnly cookie; browser JavaScript must not receive or persist an Auth0 refresh token
in local storage.

## Decision

Convex is Serein's durable database and function layer for finance workspaces. Convex functions:

- require a verified Auth0 JWT and derive the workspace owner exclusively from `identity.subject`;
- accept no user ID or workspace ID from a caller;
- use explicit tables and subject-leading indexes for workspaces and command receipts;
- enforce version checks and idempotency for workspace initialization; and
- validate every public function's arguments and return value.

The Fastify API remains a stateless adapter. After it verifies the incoming Auth0 access token and
its scope, it makes a server-side Convex request with that same token. It does not keep finance data
in process memory in production.

Convex uses a custom JWT provider configured with the Auth0 issuer, JWKS endpoint, RS256, and the
existing custom API audience. This validates the exact access token that Fastify already accepts.

## Consequences

- A development Convex deployment exists separately from a future production deployment.
- Convex environment values are configured in the deployment, never committed to Git.
- Tests may inject the in-memory store as a test double; production defaults to Convex and returns a
  clear configuration error if `CONVEX_URL` is absent.
- A future web subscription feature must preserve the HttpOnly session boundary. It must not adopt
  the Auth0/Convex browser example that stores refresh tokens in local storage.
