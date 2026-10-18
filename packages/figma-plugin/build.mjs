import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const watch = process.argv.includes('--watch');

mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  target: 'es2017',
  format: 'iife',
  logLevel: 'info',
  alias: {
    '@figrbx/core': join(here, '..', 'core', 'src', 'index.ts'),
  },
};

async function writeUiHtml() {
  const template = readFileSync(join(here, 'src', 'ui.html'), 'utf8');
  const js = readFileSync(join(dist, 'ui.js'), 'utf8');
  // The UI bundle is inlined because a plugin's ui file must be a single HTML
  // document; Figma does not resolve relative script tags inside it.
  writeFileSync(join(dist, 'ui.html'), template.replace('/*__UI_SCRIPT__*/', js));
}

async function run() {
  if (watch) {
    const codeCtx = await context({
      ...common,
      entryPoints: [join(here, 'src', 'code.ts')],
      outfile: join(dist, 'code.js'),
    });
    const uiCtx = await context({
      ...common,
      entryPoints: [join(here, 'src', 'ui.ts')],
      outfile: join(dist, 'ui.js'),
    });
    await codeCtx.watch();
    await uiCtx.watch();
    await writeUiHtml();
    console.log('Watching. Reload the plugin in Figma after each rebuild.');
    return;
  }

  await build({
    ...common,
    entryPoints: [join(here, 'src', 'code.ts')],
    outfile: join(dist, 'code.js'),
  });
  await build({
    ...common,
    entryPoints: [join(here, 'src', 'ui.ts')],
    outfile: join(dist, 'ui.js'),
  });
  await writeUiHtml();
  console.log('Built dist/code.js and dist/ui.html');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
