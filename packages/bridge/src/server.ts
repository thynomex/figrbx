import { timingSafeEqual } from 'node:crypto';
import { convertDocument, validateOdt } from '@figrbx/core';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthStatus, RobloxAuth } from './auth.js';
import { AuthError } from './auth.js';
import type { Config } from './config.js';
import type { SpecStore } from './store.js';
import type { ImageUploader } from './upload.js';

export type ServerDeps = {
  config: Config;
  auth: RobloxAuth;
  store: SpecStore;
  uploader: ImageUploader;
  version?: string;
};

const imageSchema = z.object({
  name: z.string().min(1).max(200),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  dataBase64: z.string().min(1),
});

const convertSchema = z.object({
  odt: z.unknown(),
  /** Existing code, used by live sync to update in place. */
  code: z.string().length(6).optional(),
});

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export function createApp(deps: ServerDeps): Hono {
  const { config, auth, store, uploader } = deps;
  const version = deps.version ?? '0.1.0';
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Headers', 'authorization, content-type');
    c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    c.header('Access-Control-Max-Age', '600');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });

  // Request log. Both plugins are silent clients, so without this a mistyped
  // token looks identical to a plugin that never reached the bridge.
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path === '/' || c.req.path === '/favicon.ico') return;
    const status = c.res.status;
    const mark = status >= 500 ? '!!' : status >= 400 ? ' !' : ' ·';
    console.log(
      `${mark} ${c.req.method.padEnd(6)} ${c.req.path} ${status} ${Date.now() - started}ms`,
    );
  });

  app.use('*', async (c, next) => {
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > MAX_BODY_BYTES) {
      return c.json({ ok: false, error: 'Request body too large' }, 413);
    }
    await next();
  });

  // Health is intentionally unauthenticated: both plugins use it to discover
  // the bridge before the user has pasted a token. It exposes no tokens.
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      name: 'figrbx',
      version,
      port: config.port,
      auth: auth.status(),
    }),
  );

  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(provided, config.token)) {
      return c.json({ ok: false, error: 'Invalid or missing bridge token' }, 401);
    }
    await next();
  });

  app.post('/api/auth/start', (c) => {
    try {
      return c.json({ ok: true, ...auth.start() });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get('/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    if (error) {
      return c.html(
        resultPage('Authorization failed', escapeHtml(c.req.query('error_description') ?? error)),
        400,
      );
    }
    if (!code || !state) {
      return c.html(resultPage('Authorization failed', 'Missing code or state.'), 400);
    }
    try {
      await auth.complete(code, state);
      return c.html(
        resultPage(
          'Roblox connected',
          'figrbx can upload images to your Roblox account. You can close this tab.',
        ),
      );
    } catch (err) {
      return c.html(resultPage('Authorization failed', escapeHtml(errorMessage(err))), 400);
    }
  });

  app.post('/api/auth/logout', (c) => {
    auth.logout();
    return c.json({ ok: true });
  });

  app.get('/api/auth/status', (c) => c.json({ ok: true, auth: auth.status() }));

  app.post('/api/images', async (c) => {
    const parsed = imageSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, error: 'Invalid image payload' }, 400);
    }
    const bytes = Buffer.from(parsed.data.dataBase64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      return c.json({ ok: false, error: 'Image must be between 1 byte and 20 MB' }, 413);
    }
    try {
      const result = await uploader.upload({ ...parsed.data, bytes });
      return c.json({ ok: true, ...result });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/api/convert', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = convertSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ ok: false, error: 'Invalid conversion payload' }, 400);
    }
    const validated = validateOdt(parsed.data.odt);
    if (!validated.ok) {
      return c.json({ ok: false, error: validated.error }, 400);
    }

    const spec = convertDocument(validated.doc);
    const record = store.put(validated.doc, spec, parsed.data.code);
    return c.json({
      ok: true,
      code: record.code,
      revision: record.revision,
      warnings: spec.warnings,
      meta: spec.meta,
    });
  });

  app.get('/api/spec/:code', (c) => {
    const code = c.req.param('code').toUpperCase();
    const since = Number(c.req.query('since') ?? '');
    if (Number.isFinite(since) && since > 0) {
      const changed = store.getSince(code, since);
      if (!changed) return c.body(null, 204);
      return c.json({ ok: true, ...changed });
    }
    const record = store.get(code);
    if (!record) return c.json({ ok: false, error: 'Unknown or expired code' }, 404);
    return c.json({ ok: true, ...record });
  });

  app.get('/api/specs', (c) => c.json({ ok: true, specs: store.list() }));

  app.delete('/api/specs/:code', (c) => {
    const removed = store.delete(c.req.param('code'));
    return c.json({ ok: true, removed });
  });

  app.get('/', (c) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><title>figrbx bridge</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;background:#0d0b12;color:#efecf6}code{background:#1d1929;padding:2px 6px;border-radius:4px}a{color:#c4b5fd}</style>
<h1>figrbx bridge</h1>
<p>This local service connects the Figma plugin to Roblox Studio. It is reachable only from this machine.</p>
<p>Status: <code>${escapeHtml(JSON.stringify(auth.status()))}</code></p>
<p>Open the Figma plugin and paste the bridge token from <code>~/.figrbx/config.json</code>.</p>`,
    ),
  );

  app.onError((error, c) => {
    if (error instanceof AuthError) {
      return c.json({ ok: false, error: error.message }, error.status as 400);
    }
    console.error(error);
    return c.json({ ok: false, error: 'Internal bridge error' }, 500);
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResponse(c: any, error: unknown): Response {
  if (error instanceof AuthError) {
    return c.json({ ok: false, error: error.message }, error.status);
  }
  console.error(error);
  return c.json({ ok: false, error: errorMessage(error) }, 500);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resultPage(title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;background:#0d0b12;color:#efecf6}h1{font-size:22px}p{color:#a79fbd}</style>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`;
}

export type { AuthStatus };
