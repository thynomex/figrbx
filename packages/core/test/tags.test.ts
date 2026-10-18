import { describe, expect, it } from 'vitest';
import { parseLayerName, textFormatString } from '../src/tags.js';

describe('parseLayerName', () => {
  it('strips a trailing behavior tag', () => {
    const parsed = parseLayerName('Shop_button');
    expect(parsed.name).toBe('Shop');
    expect(parsed.behaviors).toEqual([{ kind: 'button' }]);
  });

  it('keeps ordinary names intact', () => {
    const parsed = parseLayerName('Price row');
    expect(parsed.name).toBe('Price row');
    expect(parsed.behaviors).toEqual([]);
  });

  it('reads targeted tags', () => {
    const parsed = parseLayerName('OpenShop_open:Shop');
    expect(parsed.name).toBe('OpenShop');
    expect(parsed.behaviors).toEqual([{ kind: 'open', target: 'Shop' }]);
  });

  it('supports several tags and collapses whitespace', () => {
    const parsed = parseLayerName('Settings   _panel_close _closed');
    expect(parsed.name).toBe('Settings');
    expect(parsed.behaviors).toEqual([{ kind: 'panel' }, { kind: 'close' }, { kind: 'closed' }]);
  });

  it('is case-insensitive', () => {
    const parsed = parseLayerName('Body_SCROLL');
    expect(parsed.behaviors).toEqual([{ kind: 'scroll' }]);
  });

  it('collects attribute bindings without rewriting the name', () => {
    const parsed = parseLayerName('Coins: {Coins}');
    expect(parsed.name).toBe('Coins: {Coins}');
    expect(parsed.bindings).toEqual([{ name: 'Coins' }]);
  });

  it('does not eat underscore-prefixed words that are not tags', () => {
    const parsed = parseLayerName('_internal_name');
    expect(parsed.behaviors).toEqual([]);
    expect(parsed.name).toBe('_internal_name');
  });
});

describe('textFormatString', () => {
  it('replaces bindings in order', () => {
    expect(textFormatString('Coins: {Coins} · Gems: {Gems}')).toBe('Coins: %s · Gems: %s');
  });

  it('leaves text without bindings alone', () => {
    expect(textFormatString('Plain')).toBe('Plain');
  });
});
