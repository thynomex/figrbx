import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_OPTIONS, type OdtDocument } from '@figrbx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RobloxAuth } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { SpecStore } from '../src/store.js';
import type { ImageUploader } from '../src/upload.js';

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function config(): Config {
  return {
    port: 17341,
    token: TOKEN,
    oauth: { clientId: 'client-id', clientSecret: '' },
    tokens: null,
    apiKey: '',
    creatorUserId: '',
  };
}

function sampleDoc(): OdtDocument {
  return {
    version: 1,
    root: {
      id: 'root',
      rawName: 'Hud',
      type: 'FRAME',
      x: 0,
      y: 0,
      w: 1600,
      h: 900,
      children: [
        {
          id: 'label',
          rawName: 'Title',
          type: 'TEXT',
          x: 100,
          y: 50,
          w: 400,
          h: 80,
          text: {
            characters: 'Hello',
            fontSize: 32,
            fontFamily: 'Inter',
            fontStyle: 'Bold',
            alignH: 'LEFT',
            alignV: 'TOP',
          },
        },
      ],
    },
    images: [],
    options: { ...DEFAULT_OPTIONS },
  };
}

describe('bridge server', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'figrbx-server-'));
    process.env.FIGRBX_HOME = dir;
    const cfg = config();
    const auth = new RobloxAuth(cfg);
    const store = new SpecStore(join(dir, 'specs'));
    const uploader = { upload: vi.fn() } as unknown as ImageUploader;
    app = createApp({ config: cfg, auth, store, uploader, version: 'test' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, 'FIGRBX_HOME');
  });

  it('serves health without a token', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe('figrbx');
    expect(body.auth.mode).toBe('oauth');
  });

  it('rejects protected routes without a token', async () => {
    const response = await app.request('/api/specs');
    expect(response.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const response = await app.request('/api/specs', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(response.status).toBe(401);
  });

  it('converts and returns a code', async () => {
    const response = await app.request('/api/convert', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ odt: sampleDoc() }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(body.revision).toBe(1);
    expect(body.meta.aspectRatio).toBeCloseTo(1.77778, 4);
  });

  it('serves a stored spec and supports live-sync polling', async () => {
    const created = await (
      await app.request('/api/convert', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ odt: sampleDoc() }),
      })
    ).json();

    const full = await app.request(`/api/spec/${created.code}`, { headers: AUTH });
    expect(full.status).toBe(200);
    const record = await full.json();
    expect(record.spec.screenGui.name).toBe('Hud');

    const unchanged = await app.request(`/api/spec/${created.code}?since=1`, { headers: AUTH });
    expect(unchanged.status).toBe(204);

    const updated = await app.request('/api/convert', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ odt: sampleDoc(), code: created.code }),
    });
    expect((await updated.json()).revision).toBe(2);

    const changed = await app.request(`/api/spec/${created.code}?since=1`, { headers: AUTH });
    expect(changed.status).toBe(200);
    expect((await changed.json()).revision).toBe(2);
  });

  it('returns 404 for unknown codes', async () => {
    const response = await app.request('/api/spec/ZZZZZZ', { headers: AUTH });
    expect(response.status).toBe(404);
  });

  it('rejects an invalid document', async () => {
    const response = await app.request('/api/convert', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ odt: { version: 9 } }),
    });
    expect(response.status).toBe(400);
  });

  it('deletes specs', async () => {
    const created = await (
      await app.request('/api/convert', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ odt: sampleDoc() }),
      })
    ).json();
    const deleted = await app.request(`/api/specs/${created.code}`, {
      method: 'DELETE',
      headers: AUTH,
    });
    expect((await deleted.json()).removed).toBe(true);
  });

  it('answers CORS preflight', async () => {
    const response = await app.request('/api/convert', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});
