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

  it('collects player and attribute binding tokens', () => {
    const parsed = parseLayerName('Hi {PlayerName} {DisplayName} {attr:Rank}');
    expect(parsed.bindings).toEqual([
      { name: 'PlayerName' },
      { name: 'DisplayName' },
      { name: 'attr:Rank' },
    ]);
  });

  it('does not eat underscore-prefixed words that are not tags', () => {
    const parsed = parseLayerName('_internal_name');
    expect(parsed.behaviors).toEqual([]);
    expect(parsed.controls).toEqual([]);
    expect(parsed.name).toBe('_internal_name');
  });

  it('reads control tags and strips them from the name', () => {
    const parsed = parseLayerName('Hero_ignore_image_aspect');
    expect(parsed.name).toBe('Hero');
    expect(parsed.controls).toEqual(['ignore', 'bake', 'aspect']);
    expect(parsed.behaviors).toEqual([]);
  });

  it('maps every bake alias to one control', () => {
    for (const tag of ['_image', '_img', '_lock', '_IMAGE']) {
      const parsed = parseLayerName(`Hero${tag}`);
      expect(parsed.name).toBe('Hero');
      expect(parsed.controls).toEqual(['bake']);
    }
  });

  it('strips the # and img: prefixes', () => {
    const hash = parseLayerName('#Hero');
    expect(hash.name).toBe('Hero');
    expect(hash.controls).toEqual(['bake']);

    const prefix = parseLayerName('IMG:Hero');
    expect(prefix.name).toBe('Hero');
    expect(prefix.controls).toEqual(['bake']);
  });

  it('keeps behavior and control tags independent', () => {
    const parsed = parseLayerName('Shop_button_fit');
    expect(parsed.name).toBe('Shop');
    expect(parsed.behaviors).toEqual([{ kind: 'button' }]);
    expect(parsed.controls).toEqual(['fit']);
  });

  it('reads targeted actions and the exit alias', () => {
    expect(parseLayerName('Toggle_toggle:Shop').behaviors).toEqual([
      { kind: 'toggle', target: 'Shop' },
    ]);
    expect(parseLayerName('Close_close:Shop').behaviors).toEqual([
      { kind: 'close', target: 'Shop' },
    ]);
    expect(parseLayerName('Exit_exit').behaviors).toEqual([{ kind: 'exit' }]);
  });

  it('reads bare tabs and tab groups', () => {
    expect(parseLayerName('Audio_tab')).toEqual({
      name: 'Audio',
      behaviors: [{ kind: 'tab' }],
      controls: [],
      bindings: [],
    });
    expect(parseLayerName('Tabs_tabgroup').behaviors).toEqual([{ kind: 'tabgroup' }]);
    expect(parseLayerName('Weapons_tab:Shop').behaviors).toEqual([{ kind: 'tab', target: 'Shop' }]);
  });

  it('reads state tags', () => {
    expect(parseLayerName('Glow_hover').behaviors).toEqual([{ kind: 'hover' }]);
    expect(parseLayerName('Press_clicked').behaviors).toEqual([{ kind: 'clicked' }]);
    expect(parseLayerName('Idle_default').behaviors).toEqual([{ kind: 'default' }]);
    expect(parseLayerName('Lock_disabled').behaviors).toEqual([{ kind: 'disabled' }]);
    expect(parseLayerName('Chosen_active').behaviors).toEqual([{ kind: 'active' }]);
  });

  it('reads the select tag', () => {
    expect(parseLayerName('Weapon_select').behaviors).toEqual([{ kind: 'select' }]);
  });

  it('reads pointer and bind tags', () => {
    expect(parseLayerName('Card_lean').behaviors).toEqual([{ kind: 'lean' }]);
    expect(parseLayerName('Card_magnet').behaviors).toEqual([{ kind: 'magnet' }]);
    expect(parseLayerName('Card_nopointer').behaviors).toEqual([{ kind: 'nopointer' }]);
    expect(parseLayerName('Score_bind:leaderstats.Coins').behaviors).toEqual([
      { kind: 'bind', target: 'leaderstats.Coins' },
    ]);
  });

  it('reads host and hold tags with numeric parameters', () => {
    expect(parseLayerName('Sign_billboard:12').behaviors).toEqual([
      { kind: 'billboard', target: '12' },
    ]);
    expect(parseLayerName('Panel_surface:8').behaviors).toEqual([{ kind: 'surface', target: '8' }]);
    expect(parseLayerName('Crate_prompt').behaviors).toEqual([{ kind: 'prompt' }]);
    expect(parseLayerName('Ring_hold:1.5').behaviors).toEqual([{ kind: 'hold', target: '1.5' }]);
  });

  it('reads layout control tags', () => {
    expect(parseLayerName('Rows_list').controls).toEqual(['list']);
    expect(parseLayerName('Cards_grid').controls).toEqual(['grid']);
    expect(parseLayerName('Rows_nolist').controls).toEqual(['nolist']);
  });

  it('does not match a control token inside a longer word', () => {
    const parsed = parseLayerName('Hero_framework');
    expect(parsed.name).toBe('Hero_framework');
    expect(parsed.controls).toEqual([]);
  });
});

describe('textFormatString', () => {
  it('replaces bindings in order', () => {
    expect(textFormatString('Coins: {Coins} · Gems: {Gems}')).toBe('Coins: %s · Gems: %s');
  });

  it('replaces attribute binding tokens too', () => {
    expect(textFormatString('Rank: {attr:Rank}')).toBe('Rank: %s');
    expect(textFormatString('Hi {PlayerName}')).toBe('Hi %s');
  });

  it('leaves text without bindings alone', () => {
    expect(textFormatString('Plain')).toBe('Plain');
  });
});
