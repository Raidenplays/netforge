/**
 * Thin layer over the Tauri backend. In a plain browser (dev mode / tests) it falls
 * back to file inputs; .pkt decoding needs the native backend.
 */
import type { Project } from '../model/types';
import { exportPkt, importPkt, type ImportReport } from './pkt';

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function tauri() {
  const core = await import('@tauri-apps/api/core');
  const dialog = await import('@tauri-apps/plugin-dialog');
  return { invoke: core.invoke, dialog };
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export interface Opened {
  report?: ImportReport;
  project?: Project;
}

function parseNative(text: string, name: string, path?: string): Project {
  const data = JSON.parse(text);
  if (data.format !== 'netforge' || !data.project) throw new Error('Not a NetForge project file.');
  return { ...data.project, fileName: name, filePath: path };
}

export async function openPath(path: string): Promise<Opened> {
  const { invoke } = await tauri();
  const res = await invoke<{ kind: 'pkt' | 'text'; content: string }>('open_file', { path });
  if (res.kind === 'pkt') return { report: importPkt(res.content, baseName(path), path) };
  return { project: parseNative(res.content, baseName(path), path) };
}

export async function openDialog(): Promise<Opened | null> {
  if (isTauri()) {
    const { dialog } = await tauri();
    const path = await dialog.open({
      multiple: false,
      filters: [
        { name: 'All supported', extensions: ['pkt', 'pka', 'netforge'] },
        { name: 'Packet Tracer', extensions: ['pkt', 'pka'] },
        { name: 'NetForge project', extensions: ['netforge'] },
      ],
    });
    if (!path || Array.isArray(path)) return null;
    return openPath(path);
  }
  // browser fallback: .netforge JSON or decoded Packet Tracer XML
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.netforge,.xml,.json';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
  if (!file) return null;
  const text = await file.text();
  if (text.trimStart().startsWith('<')) return { report: importPkt(text, file.name) };
  return { project: parseNative(text, file.name) };
}

export const serializeNative = (p: Project) =>
  JSON.stringify({ format: 'netforge', version: 1, project: { ...p, filePath: undefined, fileName: undefined } }, null, 1);

/** Save. Returns the path written (or null if cancelled). */
export async function saveProject(p: Project, as: 'auto' | 'pkt' | 'netforge', forceDialog = false) {
  const wantPkt = as === 'pkt' || (as === 'auto' && !!p.sourceXml && /\.pk[ta]$/i.test(p.filePath ?? ''));
  let notExported: string[] = [];
  let payload: { kind: 'pkt' | 'text'; content: string };
  if (wantPkt) {
    const r = exportPkt(p);
    notExported = r.notExported;
    payload = { kind: 'pkt', content: r.xml };
  } else payload = { kind: 'text', content: serializeNative(p) };

  if (!isTauri()) {
    // browser: no file system; hand back the content
    return { path: null as string | null, content: payload.content, notExported };
  }
  const { invoke, dialog } = await tauri();
  let path = p.filePath;
  const ptExt = p.activity || /\.pka$/i.test(p.fileName ?? '') ? 'pka' : 'pkt';
  const ext = wantPkt ? ptExt : 'netforge';
  if (forceDialog || !path || !path.toLowerCase().endsWith(`.${ext}`)) {
    const stem = (p.fileName ?? 'Untitled').replace(/\.(pkt|pka|netforge)$/i, '');
    const chosen = await dialog.save({
      defaultPath: `${stem}.${ext}`,
      filters: [wantPkt ? { name: ptExt === 'pka' ? 'Packet Tracer activity' : 'Packet Tracer', extensions: [ptExt] } : { name: 'NetForge project', extensions: ['netforge'] }],
    });
    if (!chosen) return null;
    path = chosen;
  }
  await invoke('save_file', { path, kind: payload.kind, content: payload.content });
  return { path, content: null, notExported };
}

export async function startupFile(): Promise<string | null> {
  if (!isTauri()) return null;
  const { invoke } = await tauri();
  return invoke<string | null>('startup_file');
}

export async function setTitle(title: string) {
  if (!isTauri()) {
    document.title = title;
    return;
  }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(title);
  } catch {
    /* ignore */
  }
}
