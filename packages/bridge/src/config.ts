import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  /** Unix ms */
  expiresAt: number;
  userId: string;
  userName: string;
};

export type Config = {
  port: number;
  token: string;
  oauth: {
    clientId: string;
    clientSecret: string;
  };
  tokens: StoredTokens | null;
  /** Optional Open Cloud fallback when OAuth is not configured. */
  apiKey: string;
  creatorUserId: string;
};

export const DEFAULT_PORT = 17341;

export function homeDir(): string {
  return process.env.FIGRBX_HOME || join(homedir(), '.figrbx');
}

export function configPath(): string {
  return join(homeDir(), 'config.json');
}

function createToken(): string {
  return randomBytes(32).toString('hex');
}

function defaultConfig(): Config {
  return {
    port: Number(process.env.FIGRBX_PORT) || DEFAULT_PORT,
    token: process.env.FIGRBX_TOKEN || createToken(),
    oauth: {
      clientId: process.env.FIGRBX_CLIENT_ID || '',
      clientSecret: process.env.FIGRBX_CLIENT_SECRET || '',
    },
    tokens: null,
    apiKey: process.env.FIGRBX_API_KEY || '',
    creatorUserId: process.env.FIGRBX_USER_ID || '',
  };
}

/** Load config from disk, creating a token on first run. */
export function loadConfig(): Config {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true });
  const file = configPath();
  let config: Config;
  if (existsSync(file)) {
    try {
      config = {
        ...defaultConfig(),
        ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>),
      } as Config;
    } catch {
      // A corrupt config must not brick the bridge; preserve the file for inspection.
      const backup = `${file}.corrupt-${Date.now()}`;
      writeFileSync(backup, readFileSync(file));
      config = defaultConfig();
    }
  } else {
    config = defaultConfig();
  }

  // Environment overrides win over the file, so CI and one-off runs don't
  // rewrite a developer's saved credentials.
  if (process.env.FIGRBX_PORT) config.port = Number(process.env.FIGRBX_PORT);
  if (process.env.FIGRBX_CLIENT_ID) config.oauth.clientId = process.env.FIGRBX_CLIENT_ID;
  if (process.env.FIGRBX_CLIENT_SECRET)
    config.oauth.clientSecret = process.env.FIGRBX_CLIENT_SECRET;
  if (process.env.FIGRBX_API_KEY) config.apiKey = process.env.FIGRBX_API_KEY;
  if (process.env.FIGRBX_USER_ID) config.creatorUserId = process.env.FIGRBX_USER_ID;
  if (process.env.FIGRBX_TOKEN) config.token = process.env.FIGRBX_TOKEN;

  writeConfig(config);
  return config;
}

export function writeConfig(config: Config): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function redirectUri(port: number): string {
  return `http://localhost:${port}/oauth/callback`;
}

export function hasOAuth(config: Config): boolean {
  return config.oauth.clientId.length > 0;
}

export function hasApiKey(config: Config): boolean {
  return config.apiKey.length > 0 && config.creatorUserId.length > 0;
}
