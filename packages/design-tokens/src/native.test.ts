import { describe, expect, it } from 'vitest';

import { nativeTokens } from './native.js';

describe('native design tokens', () => {
  it('keeps the documented 4-point spacing scale and control radii', () => {
    expect(nativeTokens.space).toEqual({
      1: 4,
      2: 8,
      3: 12,
      4: 16,
      6: 24,
      8: 32,
      12: 48,
      16: 64,
    });
    expect(nativeTokens.radius).toMatchObject({ card: 16, control: 8, field: 12 });
  });

  it('uses separate semantic status colors in both themes', () => {
    expect(nativeTokens.light.danger).not.toBe(nativeTokens.light.warning);
    expect(nativeTokens.dark.danger).not.toBe(nativeTokens.dark.warning);
    expect(nativeTokens.light.successSurface).toBeDefined();
    expect(nativeTokens.dark.successSurface).toBeDefined();
  });
});
