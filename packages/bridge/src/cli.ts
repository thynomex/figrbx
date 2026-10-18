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
    `  http://127.0.0.1:${port}`,
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

  serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: '127.0.0.1',
    },
    (info) => {
      const status = auth.status();
      const label = status.connected
        ? `${status.mode} (${'userName' in status ? status.userName : 'connected'})`
        : status.reason;
      console.log(banner(info.port, config.token, label));

      if (wantsLogin) {
        try {
          const { url } = auth.start();
          console.log('  Opening Roblox authorization in your browser...\n');
          openBrowser(url);
        } catch (error) {
          console.error(`  ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    },
  );

  const shutdown = () => {
    console.log('\n  figrbx bridge stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
