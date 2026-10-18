import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RobloxAuth } from './auth.js';
import { AuthError } from './auth.js';

const ASSETS_URL = 'https://apis.roblox.com/assets/v1/assets';
const OPERATIONS_URL = 'https://apis.roblox.com/assets/v1/operations';
const MAX_BYTES = 20 * 1024 * 1024;
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

export type UploadInput = {
  /** Optional; verified against the bytes when supplied. */
  sha256?: string;
  name: string;
  mime: string;
  bytes: Buffer;
};

export type UploadResult = {
  assetId: string;
  cached: boolean;
  moderation?: string;
};

type CacheEntry = {
  assetId: string;
  name: string;
  uploadedAt: number;
};

export type UploaderOptions = {
  auth: RobloxAuth;
  cachePath: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/** Serializes uploads so a large design does not hammer the Assets API. */
export class ImageUploader {
  private readonly auth: RobloxAuth;
  private readonly cachePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private cache: Record<string, CacheEntry> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: UploaderOptions) {
    this.auth = options.auth;
    this.cachePath = options.cachePath;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async upload(input: UploadInput): Promise<UploadResult> {
    const digest = createHash('sha256').update(input.bytes).digest('hex');
    if (input.sha256 && digest !== input.sha256) {
      throw new AuthError('Image digest does not match the declared sha256', 400);
    }
    if (input.bytes.length > MAX_BYTES) {
      throw new AuthError(`Image "${input.name}" exceeds the 20 MB asset limit`, 413);
    }

    const cached = this.getCache()[digest];
    if (cached) return { assetId: cached.assetId, cached: true };

    return this.enqueue(() => this.uploadOnce(input, digest));
  }

  private async uploadOnce(input: UploadInput, digest: string): Promise<UploadResult> {
    // Another request may have filled the cache while this one waited.
    const again = this.getCache()[digest];
    if (again) return { assetId: again.assetId, cached: true };

    const operationPath = await this.createAsset(input);
    const result = await this.waitForOperation(operationPath);
    this.setCache(digest, {
      assetId: result.assetId,
      name: input.name,
      uploadedAt: Date.now(),
    });
    return result;
  }

  private async createAsset(input: UploadInput): Promise<string> {
    const form = new FormData();
    const request = {
      assetType: 'Decal',
      displayName: sanitizeAssetName(input.name),
      description: 'Imported by figrbx',
      creationContext: {
        creator: this.creatorField(),
      },
    };
    form.append('request', JSON.stringify(request));
    form.append(
      'fileContent',
      new Blob([new Uint8Array(input.bytes)], { type: input.mime }),
      input.name,
    );

    const response = await this.request(ASSETS_URL, { method: 'POST', body: form });
    const data = await readJson(response);
    if (!response.ok) {
      throw new AuthError(
        `Roblox asset upload failed (${response.status}): ${extractError(data)}`,
        502,
      );
    }
    const path = data?.path;
    if (typeof path !== 'string') {
      throw new AuthError('Roblox did not return an operation path', 502);
    }
    return path;
  }

  private creatorField(): { userId: string } | { groupId: string } {
    const userId = this.auth.creatorUserId;
    if (userId) return { userId };
    const status = this.auth.status();
    if (status.connected && 'userId' in status && status.userId) {
      return { userId: status.userId };
    }
    throw new AuthError('No Roblox user or group to upload into; reconnect your account', 401);
  }

  private async waitForOperation(path: string): Promise<UploadResult> {
    const url = operationUrl(path);
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await this.sleepImpl(POLL_INTERVAL_MS);
      const response = await this.request(url, { method: 'GET' });
      const data = await readJson(response);
      if (!response.ok) {
        throw new AuthError(
          `Roblox operation poll failed (${response.status}): ${extractError(data)}`,
          502,
        );
      }
      if (!data?.done) continue;

      if (data.error) {
        throw new AuthError(`Roblox rejected the asset: ${extractError(data.error)}`, 422);
      }
      const assetId = data.response?.assetId;
      if (!assetId) {
        throw new AuthError('Roblox operation finished without an assetId', 502);
      }
      const moderation = data.response?.moderationResult?.state;
      if (moderation === 'MODERATION_STATE_REJECTED') {
        throw new AuthError('Roblox moderation rejected the image', 422);
      }
      return { assetId: String(assetId), cached: false, moderation };
    }
    throw new AuthError('Timed out waiting for Roblox to process the image', 504);
  }

  /** Authenticated fetch with one retry after a token refresh. */
  private async request(url: string, init: RequestInit, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    const apiKey = this.auth.apiKey;
    if (apiKey) {
      headers.set('x-api-key', apiKey);
    } else {
      headers.set('authorization', `Bearer ${await this.auth.getAccessToken()}`);
    }

    const response = await this.fetchImpl(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(60_000),
    });

    if (response.status === 401 && !apiKey && !retried) {
      this.auth.invalidate();
      return this.request(url, init, true);
    }
    return response;
  }

  private getCache(): Record<string, CacheEntry> {
    if (this.cache) return this.cache;
    try {
      this.cache = existsSync(this.cachePath)
        ? (JSON.parse(readFileSync(this.cachePath, 'utf8')) as Record<string, CacheEntry>)
        : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private setCache(sha256: string, entry: CacheEntry): void {
    const cache = this.getCache();
    cache[sha256] = entry;
    mkdirSync(dirname(this.cachePath), { recursive: true });
    const temp = `${this.cachePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.cachePath);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function operationUrl(path: string): string {
  const id = path.replace(/^\/+/, '').replace(/^operations\//, '');
  return `${OPERATIONS_URL}/${id}`;
}

function sanitizeAssetName(name: string): string {
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim();
  return (base || 'figrbx image').slice(0, 50);
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function extractError(data: any): string {
  if (!data) return 'unknown error';
  if (typeof data === 'string') return data;
  return (
    data.message ??
    data.error_description ??
    data.error?.message ??
    data.error ??
    JSON.stringify(data).slice(0, 300)
  );
}
