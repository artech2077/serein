# ADR 0001: Test behavior through the finance workspace contract

## Status

Accepted

## Context

The product's most important shared seam is the deterministic, user-scoped finance
workspace. Its observable outcomes must agree across web and iOS, independent of UI or
provider implementation.

## Decision

Tests will supply normalized workspace data, apply visible commands, and assert returned
allowance snapshots, review state, plans, alerts, and explanations. Shared fixtures live
in `@serein/fixtures`; public contract types live in `@serein/contracts`.

## Consequences

Tests do not assert private helpers, storage layout, prompt wording, or component
implementation. Property and table-driven tests can be introduced at this boundary as
the finance workspace is implemented.
