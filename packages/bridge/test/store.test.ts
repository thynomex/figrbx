import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_OPTIONS, type OdtDocument, convertDocument } from '@figrbx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecStore, generateCode } from '../src/store.js';

function sampleDoc(): OdtDocument {
  return {
    version: 1,
    root: { id: 'root', rawName: 'Screen', type: 'FRAME', x: 0, y: 0, w: 1600, h: 900 },
    images: [],
    options: { ...DEFAULT_OPTIONS },
  };
}

describe('generateCode', () => {
  it('produces six unambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
});

describe('SpecStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'figrbx-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('stores and retrieves a conversion by code', () => {
    const store = new SpecStore(dir);
    const odt = sampleDoc();
    const record = store.put(odt, convertDocument(odt));
    const fetched = store.get(record.code);
    expect(fetched?.code).toBe(record.code);
    expect(fetched?.revision).toBe(1);
    expect(fetched?.spec.screenGui.className).toBe('ScreenGui');
  });

  it('increments the revision when updating an existing code', () => {
    const store = new SpecStore(dir);
    const odt = sampleDoc();
    const first = store.put(odt, convertDocument(odt));
    const second = store.put(odt, convertDocument(odt), first.code);
    expect(second.code).toBe(first.code);
    expect(second.revision).toBe(2);
    expect(store.getSince(first.code, 1)?.revision).toBe(2);
    expect(store.getSince(first.code, 2)).toBeNull();
  });

  it('reloads records from disk', () => {
    const store = new SpecStore(dir);
    const odt = sampleDoc();
    const record = store.put(odt, convertDocument(odt));
    const reopened = new SpecStore(dir);
    expect(reopened.get(record.code)?.revision).toBe(1);
  });

  it('expires records after the TTL', () => {
    vi.useFakeTimers();
    const store = new SpecStore(dir, 1000);
    const odt = sampleDoc();
    const record = store.put(odt, convertDocument(odt));
    vi.advanceTimersByTime(2000);
    expect(store.get(record.code)).toBeNull();
  });

  it('deletes records', () => {
    const store = new SpecStore(dir);
    const odt = sampleDoc();
    const record = store.put(odt, convertDocument(odt));
    expect(store.delete(record.code)).toBe(true);
    expect(store.get(record.code)).toBeNull();
  });

  it('normalizes lowercase codes', () => {
    const store = new SpecStore(dir);
    const odt = sampleDoc();
    const record = store.put(odt, convertDocument(odt));
    expect(store.get(record.code.toLowerCase())?.code).toBe(record.code);
  });
});
