# Serein Context

## Purpose

Serein is a private personal-finance product that answers how much a user can safely
spend today while preserving an explainable, conservative view of their finances.

## Ubiquitous language

- **Finance workspace**: the user-scoped financial state from which the backend derives projections.
- **Allowance snapshot**: the versioned, authoritative backend projection of safe-to-spend,
  genuine availability, carry, freshness, and explanations.
- **Genuine availability**: cash available after deferred-card liabilities, approved
  reservations, and the safety buffer; it is not a bank balance.
- **Safe to spend today**: the non-negative pacing amount available today from an approved plan.
- **Carry**: the signed difference between daily allowance and discretionary spending across days.
- **Reservation**: an approved virtual commitment (for example, a bill, goal, or sinking fund)
  that reduces spendability before cash moves.
- **Quick Add**: a provisional purchase entered before its corresponding bank activity is imported.

## Boundaries

The API owns financial calculation and state transitions. Web and iOS render backend
projections and submit versioned user commands; neither client calculates an alternative
allowance.
