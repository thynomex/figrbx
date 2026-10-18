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
  dataBase64: string;
};

type OdtDocument = {
  version: 1;
  root: any;
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

const DEFAULT_SETTINGS: Settings = {
  bridgeUrl: 'http://127.0.0.1:17341',
  token: '',
  textMode: 'auto',
  liveSync: false,
};

let settings: Settings = { ...DEFAULT_SETTINGS };
let lastCode: string | null = null;
let lastPayload: ExportPayload | null = null;
let busy = false;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function log(message: string): void {
  const element = $('log');
  element.textContent = message;
}

function showError(message: string | null): void {
  const element = $('error');
  if (!message) {
    element.style.display = 'none';
    element.textContent = '';
    return;
  }
  element.style.display = 'block';
  element.textContent = message;
}

function setBusy(value: boolean): void {
  busy = value;
  ($('exportBtn') as HTMLButtonElement).disabled = value;
  ($('downloadBtn') as HTMLButtonElement).disabled = value;
  ($('testBtn') as HTMLButtonElement).disabled = value;
}

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
    const base = normalizeBase(settings.bridgeUrl);
    const result = await fetchJson(`${base}/api/health`, { method: 'GET' });
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

function renderHealth(data: any | null): void {
  const dot = $('bridgeDot');
  const status = $('bridgeStatus');
  const connect = $('connectBtn') as HTMLButtonElement;

  dot.className = 'dot';
  connect.style.display = 'none';

  if (!data) {
    dot.classList.add('off');
    status.textContent = 'Bridge unreachable';
    return;
  }
  const auth = data.auth ?? {};
  if (auth.connected) {
    dot.classList.add('on');
    status.textContent = `${data.name} ${data.version} · ${auth.userName ?? 'connected'}`;
  } else {
    dot.classList.add('off');
    status.textContent = 'Bridge up · Roblox not connected';
    connect.style.display = '';
  }
}

async function testConnection(): Promise<void> {
  showError(null);
  log('Checking the bridge…');
  const data = await health();
  renderHealth(data);
  if (!data) {
    log('No bridge answered. Start it with `npx figrbx` in a terminal.');
    return;
  }
  log(
    data.auth?.connected
      ? `Connected to the bridge as ${data.auth.userName ?? 'your Roblox account'}.`
      : 'Bridge is running. Connect your Roblox account before uploading images.',
  );
}

async function connectRoblox(): Promise<void> {
  showError(null);
  try {
    const base = normalizeBase(settings.bridgeUrl);
    const result = await fetchJson(`${base}/api/auth/start`, {
      method: 'POST',
      headers: headers(),
    });
    if (!result.ok || !result.data?.url) {
      throw new Error(result.data?.error ?? 'Could not start Roblox authorization');
    }
    window.open(result.data.url, '_blank');
    log('Finish the Roblox authorization in the browser, then press Test.');
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

function saveSettings(): void {
  settings.bridgeUrl = normalizeBase(($('bridgeUrl') as HTMLInputElement).value);
  settings.token = ($('token') as HTMLInputElement).value.trim();
  settings.textMode = ($('textMode') as HTMLSelectElement).value as Settings['textMode'];
  settings.liveSync = ($('liveSync') as HTMLInputElement).checked;
  parent.postMessage({ pluginMessage: { type: 'save-settings', settings } }, '*');
}

function applySettings(next: Settings): void {
  settings = { ...DEFAULT_SETTINGS, ...next };
  ($('bridgeUrl') as HTMLInputElement).value = settings.bridgeUrl;
  ($('token') as HTMLInputElement).value = settings.token;
  ($('textMode') as HTMLSelectElement).value = settings.textMode;
  ($('liveSync') as HTMLInputElement).checked = settings.liveSync;
}

function renderSelection(
  selection: { name: string; type: string; width: number; height: number } | null,
  count: number | undefined,
): void {
  const element = $('selection');
  if (!selection) {
    element.textContent =
      count && count > 1 ? `${count} layers selected — select one frame` : 'Nothing selected';
    return;
  }
  element.innerHTML = '';
  const name = document.createElement('strong');
  name.textContent = selection.name;
  element.append(name);
  element.append(
    ` · ${selection.type} · ${Math.round(selection.width)}×${Math.round(selection.height)}`,
  );
}

async function uploadImages(payload: ExportPayload): Promise<OdtDocument> {
  const odt = JSON.parse(JSON.stringify(payload.odt)) as OdtDocument;
  const base = normalizeBase(settings.bridgeUrl);

  if (payload.images.length === 0) return odt;

  const data = await health();
  renderHealth(data);
  if (!data?.auth?.connected) {
    throw new Error('Roblox is not connected. Press "Connect Roblox" first.');
  }

  for (let i = 0; i < payload.images.length; i++) {
    const image = payload.images[i]!;
    log(`Uploading image ${i + 1} of ${payload.images.length}…`);
    const result = await fetchJson(`${base}/api/images`, {
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
  if (busy) return;
  setBusy(true);
  showError(null);
  lastPayload = payload;

  try {
    const odt = await uploadImages(payload);
    log('Converting…');
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
    $('code').textContent = lastCode;
    $('result').classList.add('on');

    const warnings: string[] = result.data.warnings ?? [];
    const list = $('warnings');
    list.innerHTML = '';
    for (const warning of warnings.slice(0, 40)) {
      const item = document.createElement('li');
      item.textContent = warning;
      list.append(item);
    }

    if (payload.truncated) {
      const item = document.createElement('li');
      item.textContent = 'The frame was too large and was truncated.';
      list.append(item);
    }

    const revision =
      result.data.revision > 1 ? ` (live sync revision ${result.data.revision})` : '';
    log(`Done. Import code ${lastCode}${revision}.`);
    parent.postMessage(
      { pluginMessage: { type: 'notify', message: `figrbx code ${lastCode}` } },
      '*',
    );
  } catch (error) {
    log('Export failed.');
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

function downloadJson(): void {
  if (!lastPayload) {
    showError('Export a frame first.');
    return;
  }
  const bundle = {
    version: 1,
    odt: lastPayload.odt,
    images: lastPayload.images.map((image) => ({
      ref: image.ref,
      name: image.name,
      mime: image.mime,
      // Images travel with the bundle so the Studio plugin can upload them
      // through the bridge later, without Figma being open.
      dataBase64: image.dataBase64,
    })),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `figrbx-${(lastPayload.odt.meta?.name as string) ?? 'export'}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  log('Downloaded the JSON bundle.');
}

async function copyCode(): Promise<void> {
  if (!lastCode) return;
  try {
    await navigator.clipboard.writeText(lastCode);
    log(`Copied ${lastCode}.`);
  } catch {
    const input = document.createElement('textarea');
    input.value = lastCode;
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    log(`Copied ${lastCode}.`);
  }
}

window.onmessage = (event: MessageEvent) => {
  const message = event.data?.pluginMessage;
  if (!message) return;

  if (message.type === 'boot') {
    applySettings(message.settings ?? DEFAULT_SETTINGS);
    renderSelection(message.selection ?? null, message.selectionCount ?? 0);
    void testConnection();
    return;
  }

  if (message.type === 'selection') {
    renderSelection(message.selection ?? null, message.selectionCount ?? 0);
    return;
  }

  if (message.type === 'progress') {
    log(String(message.message ?? ''));
    return;
  }

  if (message.type === 'export-payload') {
    void handlePayload(message as ExportPayload);
    return;
  }

  if (message.type === 'error') {
    showError(String(message.message ?? 'Unknown error'));
    log('Export failed.');
    return;
  }

  if (message.type === 'document-changed') {
    if (settings.liveSync) {
      log('Design changed, re-exporting…');
      parent.postMessage({ pluginMessage: { type: 'export' } }, '*');
    }
  }
};

$('bridgeUrl').addEventListener('change', () => {
  saveSettings();
  void testConnection();
});
$('token').addEventListener('change', () => {
  saveSettings();
  void testConnection();
});
$('textMode').addEventListener('change', saveSettings);
$('liveSync').addEventListener('change', () => {
  saveSettings();
  parent.postMessage(
    {
      pluginMessage: {
        type: 'set-live-sync',
        enabled: ($('liveSync') as HTMLInputElement).checked,
      },
    },
    '*',
  );
});
$('testBtn').addEventListener('click', () => void testConnection());
$('connectBtn').addEventListener('click', () => void connectRoblox());
$('exportBtn').addEventListener('click', () => {
  showError(null);
  saveSettings();
  log('Starting export…');
  parent.postMessage({ pluginMessage: { type: 'export' } }, '*');
});
$('downloadBtn').addEventListener('click', downloadJson);
$('copyBtn').addEventListener('click', () => void copyCode());
