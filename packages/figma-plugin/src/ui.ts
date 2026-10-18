/**
 * Figma plugin UI.
 *
 * Owns the bridge connection because the UI iframe runs network requests
 * through Figma's allowed-domain proxy. The sandbox only serializes.
 */

type Settings = {
  bridgeUrl: string;
  token: string;
  textMode: 'live' | 'exact' | 'auto';
  liveSync: boolean;
};

type ImagePayload = {
  ref: string;
  name: string;
  mime: string;
  base64?: string;
  dataBase64: string;
};

type OdtDocument = {
  version: 1;
  root: unknown;
  images: Array<{ ref: string; name: string; sha256?: string; assetId?: string }>;
  options: { textMode: string; imageScale: number; strokeScale: number };
  meta?: Record<string, unknown>;
};

type ExportPayload = {
  type: 'export-payload';
  odt: OdtDocument;
  images: ImagePayload[];
  truncated: boolean;
};

type LogTone = 'step' | 'dim' | 'prompt' | 'ok' | 'err';

type LogEntry = { t: string; msg: string; tone: LogTone };

type Selection = { name: string; type: string; width: number; height: number };

const DEFAULT_SETTINGS: Settings = {
  bridgeUrl: 'http://127.0.0.1:17341',
  token: '',
  textMode: 'auto',
  liveSync: false,
};

const MODES: Record<Settings['textMode'], { label: string; desc: string }> = {
  auto: { label: 'Auto', desc: 'Bakes only fonts Roblox has no match for.' },
  live: { label: 'Live', desc: 'Always keeps text editable; fonts may substitute.' },
  exact: { label: 'Exact', desc: 'Bakes every font Roblox cannot match to an image.' },
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const panel = $('panel');
const panelBody = $('panelBody');
const bridgeStatus = $('bridgeStatus');
const bridgeStatusText = $('bridgeStatusText');
const bridgeUrl = $<HTMLInputElement>('bridgeUrl');
const bridgeToken = $<HTMLInputElement>('bridgeToken');
const toggleToken = $<HTMLButtonElement>('toggleToken');
const tokenEye = $('tokenEye');
const testBridgeBtn = $<HTMLButtonElement>('testBridge');
const testLabel = $('testLabel');
const bridgeHint = $('bridgeHint');
const connectRoblox = $<HTMLButtonElement>('connectRoblox');
const connectLabel = $('connectLabel');
const selectionEl = $('selection');
const selName = $('selName');
const selType = $('selType');
const selSize = $('selSize');
const modeTrigger = $<HTMLButtonElement>('modeTrigger');
const modeValue = $('modeValue');
const modeDesc = $('modeDesc');
const modeMenu = $('modeMenu');
const exportBtn = $<HTMLButtonElement>('exportBtn');
const exportSpinner = $('exportSpinner');
const exportIcon = $('exportIcon');
const exportLabelText = $('exportLabelText');
const exportKbd = $('exportKbd');
const jsonBtn = $<HTMLButtonElement>('jsonBtn');
const liveSyncInput = $<HTMLInputElement>('liveSync');
const liveTag = $('liveTag');
const activityCard = $('activityCard');
const activityState = $('activityState');
const logEl = $('log');
const progress = $('progress');
const progressFill = $('progressFill');
const resultCard = $('resultCard');
const codeEl = $('code');
const copyBtn = $<HTMLButtonElement>('copyBtn');
const copyLabel = $('copyLabel');
const copyIcon = $('copyIcon');
const warns = $('warns');
const warnsTitle = $('warnsTitle');
const warnsList = $('warnsList');
const cleanRow = $('cleanRow');
const versionEl = $('version');

let settings: Settings = { ...DEFAULT_SETTINGS };
let lastPayload: ExportPayload | null = null;
let lastCode: string | null = null;
let lastRevision = 0;

const state = {
  bridge: 'offline' as 'offline' | 'online' | 'linked',
  testing: false,
  linking: false,
  exporting: false,
  progress: 0,
  selection: null as Selection | null,
  selectionCount: 0,
  result: null as { code: string; warnings: string[] } | null,
  copied: false,
  log: [] as LogEntry[],
};

let runId = 0;

/* ---------- log ---------- */

function renderLog(): void {
  logEl.replaceChildren(
    ...state.log.map((entry) => {
      const row = document.createElement('div');
      row.className = 'log-line';
      row.dataset.tone = entry.tone;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = entry.t;
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = entry.msg;
      row.append(t, m);
      return row;
    }),
  );
}

function pushLog(entry: LogEntry): void {
  state.log.push(entry);
  if (state.log.length > 3) state.log.shift();
  renderLog();
}

function setLog(entries: LogEntry[]): void {
  state.log = entries.slice(-3);
  renderLog();
}

/* ---------- bridge ---------- */

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.bridgeUrl;
}

function headers(): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${settings.token}`,
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; data: any }> {
  const response = await fetch(url, init);
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

async function health(): Promise<any | null> {
  try {
    const result = await fetchJson(`${normalizeBase(settings.bridgeUrl)}/api/health`, {
      method: 'GET',
    });
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

function renderBridge(): void {
  const bridge = state.bridge;
  bridgeStatus.dataset.tone = bridge === 'linked' ? 'ok' : bridge === 'online' ? 'warn' : 'err';
  bridgeStatusText.textContent =
    bridge === 'linked' ? 'Online' : bridge === 'online' ? 'Unlinked' : 'Offline';

  connectRoblox.hidden = bridge !== 'online';
  connectRoblox.disabled = state.linking || state.exporting;
  connectLabel.textContent = state.linking ? 'Waiting for browser…' : 'Connect Roblox';

  bridgeHint.textContent =
    bridge === 'offline'
      ? 'Helper not running on this machine'
      : bridge === 'online'
        ? 'Bridge online · Roblox account not linked'
        : 'Token accepted · image uploads enabled';
}

/* ---------- selection / export controls ---------- */

function canExport(): boolean {
  return state.bridge !== 'offline' && !!state.selection && !state.exporting && !state.testing;
}

function renderSelection(): void {
  if (!state.selection) {
    selectionEl.classList.add('is-empty');
    selName.textContent =
      state.selectionCount > 1
        ? `${state.selectionCount} layers selected — pick one frame`
        : 'Nothing selected';
    selName.title = '';
    selType.hidden = true;
    selSize.hidden = true;
    return;
  }
  selectionEl.classList.remove('is-empty');
  selName.textContent = state.selection.name;
  selName.title = state.selection.name;
  selType.textContent = state.selection.type;
  selType.hidden = false;
  selSize.textContent = `${Math.round(state.selection.width)} × ${Math.round(
    state.selection.height,
  )}`;
  selSize.hidden = false;
}

function renderExport(): void {
  const mode = MODES[settings.textMode];
  modeValue.textContent = mode.label;
  modeDesc.textContent = mode.desc;
  modeTrigger.disabled = state.exporting;

  testBridgeBtn.disabled = state.exporting || state.testing;
  testBridgeBtn.classList.toggle('is-busy', state.testing);
  testLabel.textContent = state.testing ? 'Testing…' : 'Test';

  exportBtn.disabled = !canExport();
  exportBtn.classList.toggle('is-busy', state.exporting);
  exportSpinner.hidden = !state.exporting;
  exportIcon.hidden = state.exporting;
  exportKbd.hidden = state.exporting;
  exportLabelText.textContent = state.exporting ? 'Exporting…' : 'Export to Studio';
  exportBtn.title = state.exporting
    ? 'Export in progress'
    : !state.selection
      ? 'Select a frame on the canvas first'
      : state.bridge === 'offline'
        ? 'Bridge is offline — test the connection first'
        : '';

  jsonBtn.disabled = !state.selection || state.exporting;
  liveTag.hidden = !settings.liveSync;

  const hasError = state.log.some((entry) => entry.tone === 'err');
  activityCard.classList.toggle('is-error', hasError);
  activityState.textContent = state.exporting
    ? `${state.progress}%`
    : hasError
      ? 'error'
      : state.result
        ? 'done'
        : 'idle';
  activityState.dataset.tone = state.exporting
    ? 'idle'
    : hasError
      ? 'error'
      : state.result
        ? 'done'
        : 'idle';

  progress.hidden = !state.exporting;
  progressFill.style.width = `${state.progress}%`;
}

function renderResult(): void {
  if (!state.result) {
    resultCard.hidden = true;
    return;
  }
  resultCard.hidden = false;
  codeEl.textContent = state.result.code;

  const list = state.result.warnings;
  warns.hidden = list.length === 0;
  cleanRow.hidden = list.length > 0;
  warnsTitle.textContent = `${list.length} ${list.length === 1 ? 'approximation' : 'approximations'}`;
  warnsList.replaceChildren(
    ...list.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
  renderCopy();
}

function renderCopy(): void {
  copyLabel.textContent = state.copied ? 'Copied' : 'Copy';
  copyIcon.querySelector('use')!.setAttribute('href', state.copied ? '#i-check' : '#i-copy');
  codeEl.classList.toggle('is-copied', state.copied);
}

function render(): void {
  renderBridge();
  renderSelection();
  renderExport();
  renderResult();
}

function focusResult(): void {
  requestAnimationFrame(() => {
    panelBody.scrollTo({ top: panelBody.scrollHeight, behavior: 'smooth' });
    resultCard.focus({ preventScroll: true });
  });
}

/* ---------- settings ---------- */

function saveSettings(): void {
  settings.bridgeUrl = normalizeBase(bridgeUrl.value);
  settings.token = bridgeToken.value.trim();
  settings.liveSync = liveSyncInput.checked;
  parent.postMessage({ pluginMessage: { type: 'save-settings', settings } }, '*');
}

function applySettings(next: Partial<Settings>): void {
  settings = { ...DEFAULT_SETTINGS, ...next };
  bridgeUrl.value = settings.bridgeUrl;
  bridgeToken.value = settings.token;
  liveSyncInput.checked = settings.liveSync;
  for (const option of modeMenu.querySelectorAll<HTMLElement>('.mode-opt')) {
    option.setAttribute('aria-selected', String(option.dataset.mode === settings.textMode));
  }
}

/* ---------- actions ---------- */

async function testConnection(): Promise<void> {
  if (state.testing || state.exporting) return;
  const my = ++runId;
  state.testing = true;
  renderExport();
  setLog([{ t: '›', msg: `probing ${settings.bridgeUrl}…`, tone: 'step' }]);

  const data = await health();
  if (my !== runId) return;

  state.testing = false;
  if (!data) {
    state.bridge = 'offline';
    setLog([
      { t: '!', msg: 'bridge unreachable — is it running?', tone: 'err' },
      { t: '·', msg: `expected ${settings.bridgeUrl}`, tone: 'dim' },
      { t: '·', msg: 'start it with `npx figrbx`', tone: 'dim' },
    ]);
  } else if (data.auth?.connected) {
    state.bridge = 'linked';
    setLog([
      { t: '›', msg: 'bridge online', tone: 'step' },
      { t: '·', msg: `Roblox account: ${data.auth.userName ?? 'connected'}`, tone: 'dim' },
      { t: '·', msg: 'image uploads enabled', tone: 'dim' },
    ]);
  } else {
    state.bridge = 'online';
    // Health is deliberately unauthenticated: reaching it proves the bridge is
    // up, not that the pasted token is right. Only the first authenticated call
    // can confirm the token, so this message must not claim it did.
    setLog([
      { t: '›', msg: 'bridge online', tone: 'step' },
      { t: '·', msg: 'Roblox account not linked', tone: 'dim' },
      { t: '·', msg: 'link an account to upload images', tone: 'dim' },
    ]);
  }
  render();
}

async function connectAccount(): Promise<void> {
  if (state.linking || state.exporting) return;
  state.linking = true;
  renderBridge();
  pushLog({ t: '›', msg: 'opening Roblox sign-in…', tone: 'step' });

  try {
    const result = await fetchJson(`${settings.bridgeUrl}/api/auth/start`, {
      method: 'POST',
      headers: headers(),
    });
    if (!result.ok || !result.data?.url) {
      throw new Error(result.data?.error ?? 'Could not start Roblox authorization');
    }
    window.open(result.data.url, '_blank');
    setLog([
      { t: '›', msg: 'finish the sign-in in your browser', tone: 'step' },
      { t: '·', msg: 'the bridge catches the redirect', tone: 'dim' },
      { t: '·', msg: 'press Test when you are done', tone: 'dim' },
    ]);
  } catch (error) {
    setLog([{ t: '!', msg: error instanceof Error ? error.message : String(error), tone: 'err' }]);
  } finally {
    state.linking = false;
    render();
  }
}

async function uploadImages(payload: ExportPayload): Promise<OdtDocument> {
  const odt = JSON.parse(JSON.stringify(payload.odt)) as OdtDocument;
  const total = payload.images.length;
  if (total === 0) return odt;

  const data = await health();
  if (!data?.auth?.connected) {
    throw new Error('Roblox is not connected. Press "Connect Roblox" first.');
  }

  for (let index = 0; index < total; index++) {
    const image = payload.images[index]!;
    state.progress = Math.round(((index + 1) / (total + 1)) * 90);
    pushLog({ t: '›', msg: `uploading image ${index + 1} of ${total}…`, tone: 'step' });
    renderExport();

    const result = await fetchJson(`${settings.bridgeUrl}/api/images`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: image.name, mime: image.mime, dataBase64: image.dataBase64 }),
    });
    if (!result.ok) {
      throw new Error(result.data?.error ?? `Upload failed for ${image.name}`);
    }
    const target = odt.images.find((entry) => entry.ref === image.ref);
    if (target) target.assetId = String(result.data.assetId);
  }
  return odt;
}

async function handlePayload(payload: ExportPayload): Promise<void> {
  if (state.exporting) return;
  const my = ++runId;
  state.exporting = true;
  state.progress = 4;
  state.result = null;
  state.copied = false;
  state.log = [];
  render();
  pushLog({ t: '›', msg: `reading frame “${state.selection?.name ?? 'selection'}”`, tone: 'step' });

  try {
    const odt = await uploadImages(payload);
    if (my !== runId) return;

    state.progress = 94;
    pushLog({ t: '›', msg: 'converting…', tone: 'step' });
    renderExport();

    const base = normalizeBase(settings.bridgeUrl);
    const body: Record<string, unknown> = { odt };
    if (lastCode) body.code = lastCode;

    const result = await fetchJson(`${base}/api/convert`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!result.ok) {
      throw new Error(result.data?.error ?? 'Conversion failed');
    }

    lastCode = String(result.data.code);
    lastRevision = Number(result.data.revision ?? 1);
    const warnings: string[] = result.data.warnings ?? [];
    if (payload.truncated) {
      warnings.push('The frame was larger than the export limit and was truncated.');
    }

    state.result = { code: lastCode, warnings };
    state.progress = 100;
    state.exporting = false;
    setLog([
      { t: '›', msg: 'converting…', tone: 'step' },
      { t: '✓', msg: `done · code ${lastCode}`, tone: 'ok' },
      {
        t: '·',
        msg: warnings.length
          ? `${warnings.length} ${warnings.length === 1 ? 'approximation' : 'approximations'}`
          : 'no approximations',
        tone: 'dim',
      },
    ]);
    render();
    focusResult();
    parent.postMessage(
      { pluginMessage: { type: 'notify', message: `figrbx code ${lastCode}` } },
      '*',
    );
  } catch (error) {
    if (my !== runId) return;
    state.exporting = false;
    state.progress = 0;
    const message = error instanceof Error ? error.message : String(error);
    setLog([
      { t: '!', msg: message, tone: 'err' },
      { t: '·', msg: 'nothing was written to Studio', tone: 'dim' },
    ]);
    renderExport();
  }
}

function downloadJson(): void {
  if (!lastPayload) {
    pushLog({ t: '·', msg: 'export a frame first', tone: 'dim' });
    return;
  }
  const bundle = {
    version: 1,
    odt: lastPayload.odt,
    images: lastPayload.images.map((image) => ({
      ref: image.ref,
      name: image.name,
      mime: image.mime,
      dataBase64: image.dataBase64,
    })),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const slug = (lastPayload.odt.meta?.name as string | undefined)
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  anchor.href = href;
  anchor.download = `figrbx-${slug || 'export'}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
  pushLog({ t: '·', msg: `json saved · ${anchor.download}`, tone: 'dim' });
}

async function copyCode(): Promise<void> {
  if (!state.result) return;
  const text = state.result.code;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch {
      /* clipboard is unavailable; the code is selectable in the panel */
    }
    area.remove();
  }
  state.copied = true;
  renderCopy();
  setTimeout(() => {
    state.copied = false;
    renderCopy();
  }, 1700);
}

/* ---------- mode menu ---------- */

const closeOnScroll = () => closeMenu(false);

function openMenu(): void {
  const rect = modeTrigger.getBoundingClientRect();
  modeMenu.hidden = false;
  const height = modeMenu.offsetHeight;
  const width = modeMenu.offsetWidth;
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  modeMenu.style.left = `${left}px`;
  modeMenu.style.top = `${top}px`;
  modeTrigger.setAttribute('aria-expanded', 'true');
  const selected = modeMenu.querySelector<HTMLElement>('[aria-selected="true"]');
  const first = modeMenu.firstElementChild as HTMLElement | null;
  (selected ?? first)?.focus({ preventScroll: true });
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onMenuKeydown);
  panelBody.addEventListener('scroll', closeOnScroll, { passive: true });
  window.addEventListener('resize', closeOnScroll, { passive: true });
}

function closeMenu(refocus: boolean): void {
  if (modeMenu.hidden) return;
  modeMenu.hidden = true;
  modeTrigger.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onMenuKeydown);
  panelBody.removeEventListener('scroll', closeOnScroll);
  window.removeEventListener('resize', closeOnScroll);
  if (refocus) modeTrigger.focus({ preventScroll: true });
}

function onDocPointerDown(event: Event): void {
  const target = event.target as Node;
  if (!modeMenu.contains(target) && !modeTrigger.contains(target)) closeMenu(false);
}

function onMenuKeydown(event: KeyboardEvent): void {
  const options = Array.from(modeMenu.querySelectorAll<HTMLElement>('.mode-opt'));
  const index = options.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu(true);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    options[(index + 1 + options.length) % options.length]!.focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    options[(index - 1 + options.length) % options.length]!.focus();
  } else if (event.key === 'Tab') {
    closeMenu(false);
  }
}

function chooseMode(mode: Settings['textMode']): void {
  settings.textMode = mode;
  for (const option of modeMenu.querySelectorAll<HTMLElement>('.mode-opt')) {
    option.setAttribute('aria-selected', String(option.dataset.mode === mode));
  }
  closeMenu(true);
  saveSettings();
  renderExport();
}

/* ---------- pointer glow ---------- */

if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
  let glowFrame = 0;
  let lastPointer: PointerEvent | null = null;
  panel.addEventListener('pointermove', (event) => {
    lastPointer = event;
    if (glowFrame) return;
    glowFrame = requestAnimationFrame(() => {
      glowFrame = 0;
      if (!lastPointer) return;
      const rect = panel.getBoundingClientRect();
      panel.style.setProperty(
        '--mx',
        `${(((lastPointer.clientX - rect.left) / rect.width) * 100).toFixed(2)}%`,
      );
      panel.style.setProperty(
        '--my',
        `${(((lastPointer.clientY - rect.top) / rect.height) * 100).toFixed(2)}%`,
      );
      panel.style.setProperty('--glow', '1');
    });
  });
  panel.addEventListener('pointerleave', () => {
    if (glowFrame) cancelAnimationFrame(glowFrame);
    glowFrame = 0;
    panel.style.setProperty('--glow', '0');
  });
}

/* ---------- plugin messages ---------- */

window.onmessage = (event: MessageEvent) => {
  const message = event.data?.pluginMessage;
  if (!message) return;

  switch (message.type) {
    case 'boot':
      applySettings(message.settings ?? DEFAULT_SETTINGS);
      state.selection = message.selection ?? null;
      state.selectionCount = message.selectionCount ?? 0;
      if (message.version) versionEl.textContent = `v${message.version}`;
      render();
      void testConnection();
      return;

    case 'selection':
      state.selection = message.selection ?? null;
      state.selectionCount = message.selectionCount ?? 0;
      renderSelection();
      renderExport();
      return;

    case 'progress':
      pushLog({ t: '›', msg: String(message.message ?? ''), tone: 'step' });
      state.progress = Math.min(92, state.progress + 8);
      renderExport();
      return;

    case 'export-payload':
      lastPayload = message as ExportPayload;
      void handlePayload(message as ExportPayload);
      return;

    case 'error':
      state.exporting = false;
      setLog([
        { t: '!', msg: String(message.message ?? 'Unknown error'), tone: 'err' },
        { t: '·', msg: 'nothing was written to Studio', tone: 'dim' },
      ]);
      renderExport();
      return;

    case 'document-changed':
      if (settings.liveSync) {
        pushLog({ t: '·', msg: 'design changed, re-exporting…', tone: 'dim' });
        parent.postMessage({ pluginMessage: { type: 'export' } }, '*');
      }
      return;

    default:
      return;
  }
};

/* ---------- wiring ---------- */

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
exportKbd.querySelector('.kbd-mod')!.textContent = isMac ? 'Cmd' : 'Ctrl';

modeTrigger.addEventListener('click', () => {
  if (modeMenu.hidden) openMenu();
  else closeMenu(true);
});

for (const option of modeMenu.querySelectorAll<HTMLElement>('.mode-opt')) {
  option.addEventListener('click', () => chooseMode(option.dataset.mode as Settings['textMode']));
}

toggleToken.addEventListener('click', () => {
  const show = bridgeToken.type === 'password';
  bridgeToken.type = show ? 'text' : 'password';
  toggleToken.setAttribute('aria-pressed', String(show));
  toggleToken.setAttribute('aria-label', show ? 'Hide bridge token' : 'Show bridge token');
  tokenEye.setAttribute('href', show ? '#i-eye-off' : '#i-eye');
});

testBridgeBtn.addEventListener('click', () => void testConnection());
connectRoblox.addEventListener('click', () => void connectAccount());
exportBtn.addEventListener('click', () => {
  saveSettings();
  parent.postMessage({ pluginMessage: { type: 'export' } }, '*');
});
jsonBtn.addEventListener('click', downloadJson);
copyBtn.addEventListener('click', () => void copyCode());
codeEl.addEventListener('click', () => void copyCode());
codeEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void copyCode();
  }
});
codeEl.tabIndex = 0;
codeEl.setAttribute('role', 'button');
codeEl.setAttribute('aria-label', 'Copy transfer code');

bridgeUrl.addEventListener('change', () => {
  saveSettings();
  void testConnection();
});
bridgeToken.addEventListener('change', () => {
  saveSettings();
  void testConnection();
});

liveSyncInput.addEventListener('change', () => {
  saveSettings();
  renderExport();
  if (liveSyncInput.checked) {
    pushLog({ t: '·', msg: 'live sync on — watching the selection', tone: 'dim' });
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    if (!exportBtn.disabled) {
      saveSettings();
      parent.postMessage({ pluginMessage: { type: 'export' } }, '*');
    }
  }
});

render();
