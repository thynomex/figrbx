import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OdtDocument } from '@figrbx/core';
import type { RbxDocument } from '@figrbx/core';

export type StoredSpec = {
  code: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  odt: OdtDocument;
  spec: RbxDocument;
};

/**
 * Six characters from an alphabet without look-alikes (no 0/O, 1/I/L).
 * The commercial version uses this as a human-typed transfer code; here it
 * also doubles as the key the Studio plugin fetches from loopback.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return code;
}

export class SpecStore {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, StoredSpec>();

  constructor(dir: string, ttlMs = 24 * 60 * 60 * 1000) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    mkdirSync(dir, { recursive: true });
    this.prune();
  }

  /** Store a new conversion, or update an existing code for live sync. */
  put(odt: OdtDocument, spec: RbxDocument, existingCode?: string): StoredSpec {
    const now = Date.now();
    let record: StoredSpec;

    if (existingCode) {
      const existing = this.get(existingCode);
      if (existing) {
        record = {
          ...existing,
          revision: existing.revision + 1,
          updatedAt: now,
          odt,
          spec,
        };
        this.cache.set(existingCode, record);
        this.write(record);
        return record;
      }
    }

    let code = generateCode();
    let attempts = 0;
    while (this.cache.has(code) || existsSync(join(this.dir, `${code}.json`))) {
      code = generateCode();
      if (++attempts > 100) throw new Error('Could not allocate a transfer code');
    }

    record = { code, revision: 1, createdAt: now, updatedAt: now, odt, spec };
    this.cache.set(code, record);
    this.write(record);
    return record;
  }

  get(code: string): StoredSpec | null {
    const normalized = code.trim().toUpperCase();
    const cached = this.cache.get(normalized);
    if (cached) {
      if (this.isExpired(cached)) {
        this.delete(normalized);
        return null;
      }
      return cached;
    }
    const file = join(this.dir, `${normalized}.json`);
    if (!existsSync(file)) return null;
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as StoredSpec;
      if (this.isExpired(record)) {
        this.delete(normalized);
        return null;
      }
      this.cache.set(normalized, record);
      return record;
    } catch {
      return null;
    }
  }

  /** Live sync: return the record only when it changed after `revision`. */
  getSince(code: string, revision: number): StoredSpec | null {
    const record = this.get(code);
    if (!record) return null;
    return record.revision > revision ? record : null;
  }

  list(): Array<Omit<StoredSpec, 'odt' | 'spec'>> {
    this.prune();
    return [...this.cache.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ code, revision, createdAt, updatedAt }) => ({
        code,
        revision,
        createdAt,
        updatedAt,
      }));
  }

  delete(code: string): boolean {
    const normalized = code.trim().toUpperCase();
    this.cache.delete(normalized);
    const file = join(this.dir, `${normalized}.json`);
    if (existsSync(file)) {
      rmSync(file, { force: true });
      return true;
    }
    return false;
  }

  private isExpired(record: StoredSpec): boolean {
    return this.ttlMs > 0 && Date.now() - record.updatedAt > this.ttlMs;
  }

  private write(record: StoredSpec): void {
    writeFileSync(join(this.dir, `${record.code}.json`), JSON.stringify(record), { mode: 0o600 });
  }

  private prune(): void {
    if (!existsSync(this.dir)) return;
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith('.json')) continue;
      const file = join(this.dir, entry);
      try {
        const record = JSON.parse(readFileSync(file, 'utf8')) as StoredSpec;
        if (this.isExpired(record)) rmSync(file, { force: true });
      } catch {
        rmSync(file, { force: true });
      }
    }
  }
}
