# Serein

Serein is a private personal-finance workspace. Its iOS and web clients consume the
same authoritative backend projection; finance calculation always remains on the backend.

## Workspace

- `apps/api` — Fastify API and the future finance workspace projection.
- `apps/web` — Next.js web client.
- `apps/ios` — Expo / React Native iPhone client.
- `packages/contracts` — versioned client-to-backend contract types.
- `packages/fixtures` — shared, non-sensitive fixtures for tests and local development.

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer (`corepack enable` is recommended)

## Start locally

```sh
pnpm install
pnpm dev
```

This starts the API at `http://localhost:3001`, the web client at
`http://localhost:3000`, and Expo's development server for iOS. Start a single client
with `pnpm --filter @serein/web dev`, `pnpm --filter @serein/api dev`, or
`pnpm --filter @serein/ios dev`.

## Quality checks

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

The GitHub Actions workflow runs the same checks on pull requests and pushes to `main`.
