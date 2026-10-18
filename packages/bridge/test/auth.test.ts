import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RobloxAuth, base64Url, createPkce } from '../src/auth.js';
import type { Config } from '../src/config.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'figrbx-auth-'));
  process.env.FIGRBX_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, 'FIGRBX_HOME');
});

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 17341,
    token: 'test-token',
    oauth: { clientId: 'client-id', clientSecret: '' },
    tokens: null,
    apiKey: '',
    creatorUserId: '',
    ...overrides,
  };
}

describe('PKCE', () => {
  it('produces a verifier and its S256 challenge', () => {
    const { verifier, challenge } = createPkce();
    const expected = base64Url(createHash('sha256').update(verifier).digest());
    expect(challenge).toBe(expected);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('RobloxAuth', () => {
  it('builds an authorization URL with PKCE and scopes', () => {
    const auth = new RobloxAuth(config());
    const { url } = auth.start();
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://apis.roblox.com/oauth/v1/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:17341/oauth/callback');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toContain('asset:write');
  });

  it('exchanges the code and stores tokens', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 900,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sub: '123', preferred_username: 'builder' }), {
          status: 200,
        }),
      );

    const cfg = config();
    const auth = new RobloxAuth(cfg, fetchMock as typeof fetch);
    const { url } = auth.start();
    const state = new URL(url).searchParams.get('state')!;
    await auth.complete('the-code', state);

    const status = auth.status();
    expect(status.connected).toBe(true);
    if (status.connected && status.mode === 'oauth') {
      expect(status.userId).toBe('123');
      expect(status.userName).toBe('builder');
    }
    expect(cfg.tokens?.refreshToken).toBe('refresh-1');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://apis.roblox.com/oauth/v1/token');
  });

  it('rejects an unknown state', async () => {
    const auth = new RobloxAuth(config(), vi.fn() as unknown as typeof fetch);
    await expect(auth.complete('code', 'bogus')).rejects.toThrow(/Unknown or expired/);
  });

  it('refreshes an expiring token and keeps the rotated refresh token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 900 }),
          { status: 200 },
        ),
      );
    const cfg = config({
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1000,
        userId: '123',
        userName: 'builder',
      },
    });
    const auth = new RobloxAuth(cfg, fetchMock as typeof fetch);
    const token = await auth.getAccessToken();
    expect(token).toBe('access-2');
    expect(cfg.tokens?.refreshToken).toBe('refresh-2');
    const body = String((fetchMock.mock.calls[0]![1] as RequestInit).body);
    expect(body).toContain('grant_type=refresh_token');
  });

  it('clears tokens when refresh is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 }));
    const cfg = config({
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1000,
        userId: '123',
        userName: 'builder',
      },
    });
    const auth = new RobloxAuth(cfg, fetchMock as typeof fetch);
    await expect(auth.getAccessToken()).rejects.toThrow(/expired/);
    expect(cfg.tokens).toBeNull();
  });

  it('reports API-key mode when configured', () => {
    const auth = new RobloxAuth(
      config({ oauth: { clientId: '', clientSecret: '' }, apiKey: 'key', creatorUserId: '9' }),
    );
    expect(auth.status()).toMatchObject({ mode: 'apikey', connected: true, userId: '9' });
    expect(auth.apiKey).toBe('key');
  });
});
