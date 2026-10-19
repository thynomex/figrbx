import { createHash, randomBytes } from 'node:crypto';
import type { Config, StoredTokens } from './config.js';
import { configPath, hasApiKey, hasOAuth, redirectUri, writeConfig } from './config.js';

const AUTHORIZE_URL = 'https://apis.roblox.com/oauth/v1/authorize';
const TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
const USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';
const SCOPES = 'openid profile asset:read asset:write';

export type AuthStatus =
  | { mode: 'oauth'; connected: false; reason: string }
  | { mode: 'oauth'; connected: true; userId: string; userName: string; expiresAt: number }
  | { mode: 'apikey'; connected: true; userId: string; userName: string }
  | { mode: 'none'; connected: false; reason: string };

type PendingAuthorization = {
  verifier: string;
  createdAt: number;
};

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

export class RobloxAuth {
  private pending = new Map<string, PendingAuthorization>();
  private refreshInFlight: Promise<string> | null = null;

  constructor(
    private config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  status(): AuthStatus {
    if (hasOAuth(this.config)) {
      if (!this.config.tokens) {
        return {
          mode: 'oauth',
          connected: false,
          reason: 'Roblox account not connected yet',
        };
      }
      return {
        mode: 'oauth',
        connected: true,
        userId: this.config.tokens.userId,
        userName: this.config.tokens.userName,
        expiresAt: this.config.tokens.expiresAt,
      };
    }
    if (hasApiKey(this.config)) {
      return {
        mode: 'apikey',
        connected: true,
        userId: this.config.creatorUserId,
        userName: 'Open Cloud API key',
      };
    }
    return {
      mode: 'none',
      connected: false,
      reason:
        'Set a Roblox OAuth client (FIGRBX_CLIENT_ID) or an Open Cloud key (FIGRBX_API_KEY + FIGRBX_USER_ID)',
    };
  }

  /** Build the authorization URL and remember the PKCE verifier. */
  start(): { url: string } {
    if (!hasOAuth(this.config)) {
      throw new AuthError(
        [
          'No Roblox OAuth client is configured, so images cannot be uploaded.',
          'Fix it one of these ways:',
          `  1. Register an app at https://create.roblox.com/dashboard/credentials (category "Creation & Productivity Tools", scopes asset:read and asset:write, redirect URI ${redirectUri(this.config.port)}), then put its client id and secret in "oauth" inside ${configPath()} and restart the bridge.`,
          '  2. Or set FIGRBX_CLIENT_ID and FIGRBX_CLIENT_SECRET before starting the bridge.',
          '  3. Or skip OAuth entirely with an Open Cloud key: FIGRBX_API_KEY plus FIGRBX_USER_ID.',
          'Designs with no images still export without any of this.',
        ].join('\n'),
        400,
      );
    }
    const { verifier, challenge } = createPkce();
    const state = base64Url(randomBytes(24));
    this.pending.set(state, { verifier, createdAt: Date.now() });
    this.prunePending();

    const params = new URLSearchParams({
      client_id: this.config.oauth.clientId,
      redirect_uri: redirectUri(this.config.port),
      scope: SCOPES,
      response_type: 'code',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      nonce: base64Url(randomBytes(16)),
    });
    return { url: `${AUTHORIZE_URL}?${params.toString()}` };
  }

  /** Complete the authorization code flow. */
  async complete(code: string, state: string): Promise<void> {
    const pending = this.pending.get(state);
    if (!pending) throw new AuthError('Unknown or expired authorization state', 400);
    this.pending.delete(state);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(this.config.port),
      client_id: this.config.oauth.clientId,
      code_verifier: pending.verifier,
    });
    if (this.config.oauth.clientSecret) {
      body.set('client_secret', this.config.oauth.clientSecret);
    }

    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await readJson(response);
    if (!response.ok) {
      throw new AuthError(`Roblox token exchange failed: ${data?.error ?? response.status}`, 502);
    }

    const profile = await this.fetchProfile(data.access_token);
    const tokens: StoredTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + Number(data.expires_in ?? 900) * 1000,
      userId: profile.userId,
      userName: profile.userName,
    };
    this.config.tokens = tokens;
    writeConfig(this.config);
  }

  private async fetchProfile(accessToken: string): Promise<{ userId: string; userName: string }> {
    try {
      const response = await this.fetchImpl(USERINFO_URL, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(String(response.status));
      return {
        userId: String(data.sub ?? ''),
        userName: String(data.preferred_username ?? data.nickname ?? data.name ?? 'Roblox user'),
      };
    } catch {
      return { userId: '', userName: 'Roblox user' };
    }
  }

  /** A valid bearer token, refreshing when it is about to expire. */
  async getAccessToken(): Promise<string> {
    if (this.config.tokens && this.config.tokens.expiresAt - 60_000 > Date.now()) {
      return this.config.tokens.accessToken;
    }
    if (!this.config.tokens?.refreshToken) {
      throw new AuthError('Roblox account is not connected', 401);
    }
    return this.refresh();
  }

  private refresh(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<string> {
    const refreshToken = this.config.tokens!.refreshToken;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.oauth.clientId,
    });
    if (this.config.oauth.clientSecret) body.set('client_secret', this.config.oauth.clientSecret);

    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await readJson(response);
    if (!response.ok) {
      // The refresh token may have been revoked or already rotated. Clear it so
      // the UI can prompt for a fresh authorization instead of looping.
      this.config.tokens = null;
      writeConfig(this.config);
      throw new AuthError('Roblox session expired; reconnect your account', 401);
    }
    const previous = this.config.tokens!;
    this.config.tokens = {
      accessToken: data.access_token,
      // Refresh tokens are single-use: the old one is dead as soon as this
      // response is issued, so persist the replacement immediately.
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + Number(data.expires_in ?? 900) * 1000,
      userId: previous.userId,
      userName: previous.userName,
    };
    writeConfig(this.config);
    return this.config.tokens.accessToken;
  }

  /** Called after a 401 from an API; forces a refresh on the next request. */
  invalidate(): void {
    if (this.config.tokens) {
      this.config.tokens.expiresAt = 0;
    }
  }

  logout(): void {
    this.config.tokens = null;
    this.pending.clear();
    writeConfig(this.config);
  }

  get apiKey(): string | null {
    return hasApiKey(this.config) ? this.config.apiKey : null;
  }

  get creatorUserId(): string | null {
    return hasApiKey(this.config) ? this.config.creatorUserId : null;
  }

  private prunePending(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [state, pending] of this.pending) {
      if (pending.createdAt < cutoff) this.pending.delete(state);
    }
  }
}
