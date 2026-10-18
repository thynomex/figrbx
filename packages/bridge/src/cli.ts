#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { RobloxAuth } from './auth.js';
import { homeDir, loadConfig } from './config.js';
import { createApp } from './server.js';
import { SpecStore } from './store.js';
import { ImageUploader } from './upload.js';

const VERSION = '0.1.0';

function banner(port: number, token: string, auth: string): string {
  return [
    '',
    `  figrbx bridge ${VERSION}`,
    `  http://localhost:${port}`,
    `  bridge token: ${token}`,
    `  config: ${join(homeDir(), 'config.json')}`,
    `  auth: ${auth}`,
    '',
    '  Paste the bridge token into the Figma plugin and the Studio plugin.',
    '',
  ].join('\n');
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    console.log(`Open this URL to connect Roblox: ${url}`);
  }
}

function main(): void {
  const config = loadConfig();
  const auth = new RobloxAuth(config);
  const store = new SpecStore(join(homeDir(), 'specs'));
  const uploader = new ImageUploader({ auth, cachePath: join(homeDir(), 'images.json') });
  const app = createApp({ config, auth, store, uploader, version: VERSION });

  const wantsLogin = process.argv.includes('login');

  // Figma's manifest validator only accepts a hostname in allowedDomains, so
  // every client now calls http://localhost:17341. On Windows and macOS
  // "localhost" can resolve to ::1 before 127.0.0.1, so listen on both
  // loopback addresses; binding 0.0.0.0 would expose the bridge to the LAN.
  let announced = false;
  let listening = 0;

  const announce = (port: number): void => {
    if (announced) return;
    announced = true;
    const status = auth.status();
    const label = status.connected
      ? `${status.mode} (${'userName' in status ? status.userName : 'connected'})`
      : status.reason;
    console.log(banner(port, config.token, label));

    if (wantsLogin) {
      try {
        const { url } = auth.start();
        console.log('  Opening Roblox authorization in your browser...\n');
        openBrowser(url);
      } catch (error) {
        console.error(`  ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  };

  for (const hostname of ['127.0.0.1', '::1']) {
    try {
      const server = serve({ fetch: app.fetch, port: config.port, hostname }, (info) => {
        listening++;
        announce(info.port);
      });
      server.on('error', (error: NodeJS.ErrnoException) => {
        // One family may be unavailable (IPv6 disabled, port taken on that
        // stack). Only fail when neither loopback address came up.
        if (listening === 0 && error.code !== 'EADDRNOTAVAIL' && error.code !== 'EAFNOSUPPORT') {
          console.error(`  could not listen on ${hostname}: ${error.message}\n`);
        }
      });
    } catch (error) {
      console.error(`  could not listen on ${hostname}: ${String(error)}\n`);
    }
  }

  setTimeout(() => {
    if (listening === 0) {
      console.error(`  figrbx could not bind port ${config.port} on loopback\n`);
      process.exit(1);
    }
  }, 1500).unref();

  const shutdown = () => {
    console.log('\n  figrbx bridge stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
