# Serein design and accessibility baseline

The product uses the Serein Ink Blue system: calm, restrained, and evidence-led. The
design system distinguishes facts, forecasts, provisional data, and risk without using
color alone.

## Token source

`@serein/design-tokens` is the source of shared foundation values:

- `web.css` exposes semantic CSS custom properties for light and dark themes.
- `native` exports the same semantic role names as React Native values.
- Spacing follows the 4 pt scale: 4, 8, 12, 16, 24, 32, 48, and 64.
- Corners are 8 pt for controls, 12 pt for fields, 16 pt for cards, and 28 pt for sheets.
- Motion uses 100 ms press feedback, 180 ms micro-interactions, and 320 ms route changes.
  Reduced Motion resolves these durations to zero.

Typography uses Jost for web UI and financial values with tabular figures. Native screens
use the platform's legible sans fallback until native font assets are introduced; they
retain the same size, spacing, and semantic roles.

## Semantic status rule

Every status pairs a color with text and, where an icon exists, a named accessibility
label. Do not convey meaning using red, green, or an icon alone.

| Status      | Text pattern                          | Semantic role |
| ----------- | ------------------------------------- | ------------- |
| Current     | `Updated now`                         | success       |
| Stale       | `Updated 2 days ago — refresh needed` | warning       |
| Provisional | `Includes 2 Quick Adds`               | info          |
| Forecast    | `Forecast salary · expected 28 Aug`   | info          |
| Partial     | `2 accounts need import`              | warning       |
| Error       | `Import failed — retry`               | danger        |

## Core-control states

| State            | Web treatment                                                    | iOS treatment                                        | Accessibility requirement                                   |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| Default          | Semantic surface, label, and border                              | Semantic surface and label                           | Name describes the action.                                  |
| Hover / pressed  | 100–180 ms color or elevation change                             | Brief native press feedback                          | Never be the only feedback.                                 |
| Focus            | 3 px focus ring, 3 px offset                                     | Native focus order and visible focus where supported | Keyboard focus is always visible on web.                    |
| Disabled         | Reduced contrast and no action                                   | Reduced contrast and no action                       | Explain the prerequisite when the action is consequential.  |
| Loading          | Keep last confirmed financial value; use local skeleton/progress | Keep last confirmed value; use local progress        | Do not replace money with `€0`; announce progress politely. |
| Error            | Inline text identifies failure, retained data, and recovery      | Same content near the affected control               | Errors are programmatically associated with fields.         |
| Success / status | Text chip plus color and optional icon                           | Text chip plus color and optional symbol             | Status is announced without moving focus.                   |

## Platform primitives

- Web: semantic landmarks, skip link, native `button`/`input` controls, a minimum 44 px
  interactive target where practical, and logical keyboard order.
- iOS: a minimum 44 × 44 pt target, accessible labels/hints for icon-only controls,
  Dynamic Type-safe layouts, and VoiceOver/Voice Control names that match visible labels.
- Money: use tabular figures; always include a minus sign for negative values and spoken
  negative meaning such as `€5 over plan`.
