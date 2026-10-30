import { create } from 'zustand';
import { produce, setAutoFreeze } from 'immer';
import type { Device, Link, Project } from './model/types';
import type { Hop, SimEvent } from './engine/network';
import { settleDhcp } from './engine/network';

setAutoFreeze(false);

export type Tool = 'select' | 'cable' | 'note' | 'pdu';
export type Mode = 'realtime' | 'simulation';

export interface LogEntry {
  id: number;
  time: string;
  ok: boolean;
  text: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'good' | 'bad';
}

export interface Flight {
  id: number;
  hops: Hop[];
  events: SimEvent[];
  step: number; // index into hops currently animating
  playing: boolean;
  ok: boolean;
  label: string;
}

interface State {
  project: Project;
  past: Project[];
  future: Project[];
  dirty: boolean;
  selected: string | null;
  selectedLink: string | null;
  tool: Tool;
  mode: Mode;
  cableFrom: { dev: string; iface: string } | null;
  pduFrom: string | null;
  view: { x: number; y: number; k: number };
  showPorts: boolean;
  theme: 'dark' | 'light';
  log: LogEntry[];
  toasts: Toast[];
  flight: Flight | null;
  speed: number;
  inspectorTab: 'overview' | 'config' | 'cli';
  palette: boolean;
  placing: string | null;
  bottomOpen: boolean;

  mutate: (fn: (p: Project) => void, opts?: { silent?: boolean }) => void;
  load: (p: Project) => void;
  undo: () => void;
  redo: () => void;
  set: (partial: Partial<State>) => void;
  addLog: (ok: boolean, text: string) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
}

const empty: Project = { devices: [], links: [], notes: [] };
let seq = 1;

const loadTheme = (): 'dark' | 'light' => {
  try {
    return (localStorage.getItem('nf-theme') as 'dark' | 'light') || 'dark';
  } catch {
    return 'dark';
  }
};

export const useStore = create<State>((set, get) => ({
  project: empty,
  past: [],
  future: [],
  dirty: false,
  selected: null,
  selectedLink: null,
  tool: 'select',
  mode: 'realtime',
  cableFrom: null,
  pduFrom: null,
  view: { x: 0, y: 0, k: 1 },
  showPorts: false,
  theme: loadTheme(),
  log: [],
  toasts: [],
  flight: null,
  speed: 1,
  inspectorTab: 'overview',
  palette: false,
  placing: null,
  bottomOpen: true,

  mutate: (fn, opts) => {
    const before = get().project;
    const next = produce(before, (draft) => {
      fn(draft);
      settleDhcp(draft);
    });
    if (next === before) return;
    set((s) => ({
      project: next,
      past: opts?.silent ? s.past : [...s.past.slice(-80), before],
      future: opts?.silent ? s.future : [],
      dirty: true,
    }));
  },
  load: (p) => {
    const settled = produce(p, (d) => {
      settleDhcp(d);
    });
    set({ project: settled, past: [], future: [], dirty: false, selected: null, selectedLink: null, flight: null, log: [] });
  },
  undo: () => {
    const { past, project, future } = get();
    if (!past.length) return;
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future], dirty: true });
  },
  redo: () => {
    const { past, project, future } = get();
    if (!future.length) return;
    set({ project: future[0], future: future.slice(1), past: [...past, project], dirty: true });
  },
  set: (partial) => set(partial as State),
  addLog: (ok, text) =>
    set((s) => ({ log: [...s.log.slice(-200), { id: seq++, ok, text, time: new Date().toLocaleTimeString() }] })),
  toast: (text, tone = 'info') => {
    const id = seq++;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
  },
}));

export const selectDevice = (p: Project, id: string | null): Device | undefined => p.devices.find((d) => d.id === id);
export const linksOf = (p: Project, id: string): Link[] => p.links.filter((l) => l.a.dev === id || l.b.dev === id);
