import { describe, expect, it } from 'vitest';
import { resolveFont, shouldBakeText } from '../src/fonts.js';

describe('resolveFont', () => {
  it('treats Roblox-native families as exact', () => {
    expect(resolveFont('Roboto', 'Regular')).toMatchObject({
      robloxFont: 'Roboto',
      known: true,
      exact: true,
    });
    expect(resolveFont('Source Sans 3', 'Bold')).toMatchObject({
      robloxFont: 'SourceSansBold',
      exact: true,
    });
  });

  it('maps common design fonts onto Gotham and reports approximation', () => {
    const match = resolveFont('Inter', 'Semi Bold');
    expect(match.robloxFont).toBe('GothamBold');
    expect(match.known).toBe(true);
    expect(match.exact).toBe(false);
  });

  it('falls back for unknown families', () => {
    const match = resolveFont('Madimi One', 'Regular');
    expect(match.known).toBe(false);
    expect(match.exact).toBe(false);
    expect(match.robloxFont).toBe('GothamMedium');
  });

  it('handles italic and mono families', () => {
    expect(resolveFont('Source Sans 3', 'Italic').robloxFont).toBe('SourceSansItalic');
    expect(resolveFont('JetBrains Mono', 'Regular').robloxFont).toBe('RobotoMono');
  });
});

describe('shouldBakeText', () => {
  const exact = { robloxFont: 'Roboto', known: true, exact: true };
  const approximated = { robloxFont: 'GothamMedium', known: true, exact: false };
  const unknown = { robloxFont: 'GothamMedium', known: false, exact: false };

  it('never bakes in live mode', () => {
    expect(shouldBakeText('live', unknown)).toBe(false);
  });

  it('bakes anything not exact in exact mode', () => {
    expect(shouldBakeText('exact', exact)).toBe(false);
    expect(shouldBakeText('exact', approximated)).toBe(true);
    expect(shouldBakeText('exact', unknown)).toBe(true);
  });

  it('bakes only unknown families in auto mode', () => {
    expect(shouldBakeText('auto', approximated)).toBe(false);
    expect(shouldBakeText('auto', unknown)).toBe(true);
  });
});
