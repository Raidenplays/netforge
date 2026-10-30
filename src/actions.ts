import { consolePort, createDevice, isHost, templateFor } from './model/catalog';
import type { Device, Iface, Project } from './model/types';
import { uid } from './model/types';
import { buildTopo, ping } from './engine/network';
import { type PduRec, useStore } from './store';

const st = () => useStore.getState();

export function addDevice(model: string, x: number, y: number) {
  const t = templateFor(model);
  if (!t) return;
  let id = '';
  st().mutate((p) => {
    const d = createDevice(t, x, y, p.devices.map((d) => d.name));
    id = d.id;
    p.devices.push(d);
  });
  st().set({ selected: id, selectedLink: null });
}

export function deleteSelection() {
  const { selected, selectedLink } = st();
  if (selected) {
    st().mutate((p) => {
      p.devices = p.devices.filter((d) => d.id !== selected);
      p.links = p.links.filter((l) => l.a.dev !== selected && l.b.dev !== selected);
      p.notes = p.notes.filter((n) => n.id !== selected);
    });
    st().set({ selected: null });
  } else if (selectedLink) {
    st().mutate((p) => {
      p.links = p.links.filter((l) => l.id !== selectedLink);
    });
    st().set({ selectedLink: null });
  }
}

export function duplicate(id: string) {
  const d = st().project.devices.find((x) => x.id === id);
  if (!d) return;
  const t = templateFor(d.model);
  if (t) addDevice(t.model, d.x + 40, d.y + 40);
  else st().toast('This imported device type can only be duplicated from the library.', 'info');
}

export const portUsed = (p: Project, dev: string, iface: string) =>
  p.links.some((l) => (l.a.dev === dev && l.a.iface === iface) || (l.b.dev === dev && l.b.iface === iface));

export const cablePorts = (d: Device): Iface[] => {
  const ports = d.ifaces.filter((i) => i.media !== 'wireless' && i.media !== 'virtual');
  const con = consolePort(d);
  return con ? [...ports, { name: con, media: 'console', speed: 0, mac: '', shutdown: false }] : ports;
};

export function autoPort(p: Project, d: Device, peer?: Device): Iface | undefined {
  const free = cablePorts(d).filter((i) => !portUsed(p, d.id, i.name) && i.media !== 'console');
  if (d.kind === 'homerouter' && peer) {
    const wanSide = peer.kind === 'router' || peer.kind === 'cloud' || peer.kind === 'homerouter';
    return wanSide ? free.find((i) => i.name === 'Internet') ?? free[0] : free.find((i) => i.name !== 'Internet') ?? free[0];
  }
  return free[0];
}

export function connect(a: { dev: string; iface: string }, b: { dev: string; iface: string }) {
  const p = st().project;
  if (a.dev === b.dev) return st().toast('Pick a port on a different device.', 'bad');
  if (portUsed(p, a.dev, a.iface) || portUsed(p, b.dev, b.iface)) return st().toast('That port already has a cable.', 'bad');
  const da = p.devices.find((d) => d.id === a.dev)!;
  const db = p.devices.find((d) => d.id === b.dev)!;
  const ia = cablePorts(da).find((i) => i.name === a.iface)!;
  const ib = cablePorts(db).find((i) => i.name === b.iface)!;
  if ((ia.media === 'console') !== (ib.media === 'console'))
    return st().toast('A console cable goes from a PC\'s RS 232 port to a router or switch Console port.', 'bad');
  if (ia.media === 'console') {
    if (da.kind !== 'pc' && da.kind !== 'laptop' && db.kind !== 'pc' && db.kind !== 'laptop') return st().toast('Console cables connect a PC or laptop to a router or switch.', 'bad');
    st().mutate((pr) => {
      pr.links.push({ id: uid('lnk'), a, b, cable: 'console' });
    });
    st().addLog(true, `Connected ${da.name} ${a.iface} ↔ ${db.name} ${b.iface} (console)`);
    return;
  }
  if ((ia.media === 'fiber') !== (ib.media === 'fiber')) return st().toast('Fiber ports can only connect to fiber ports.', 'bad');
  // MDI/MDIX: like-for-like devices need a crossover; modern gear auto-negotiates so we just label it
  const dce = (d: Device) => d.kind === 'switch' || d.kind === 'homerouter';
  const cable = ia.media === 'fiber' ? 'fiber' : ia.media === 'serial' ? 'serial' : dce(da) === dce(db) ? 'cross' : 'straight';
  st().mutate((pr) => {
    pr.links.push({ id: uid('lnk'), a, b, cable });
  });
  st().addLog(true, `Connected ${da.name} ${a.iface} ↔ ${db.name} ${b.iface} (${cable === 'cross' ? 'crossover' : cable})`);
}

/** Pick the address on `dst` that makes most sense to ping from `src`. */
export function targetIp(p: Project, srcId: string, dstId: string): string | null {
  const t = buildTopo(p);
  const cands = t.endpoints.filter((e) => e.dev.id === dstId).map((e) => e.ip);
  const d = p.devices.find((x) => x.id === dstId);
  if (!cands.length) {
    const any = d?.ifaces.find((i) => i.ip)?.ip;
    return any ?? null;
  }
  for (const ip of cands) if (ping(p, srcId, ip).ok) return ip;
  return cands[0];
}

const PDU_COLORS = ['#34d399', '#a3e635', '#5b9dff', '#c084fc', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c'];

/** mark a scenario PDU finished once its animation ends */
export function finishPdu(id: number | undefined, ok: boolean) {
  if (id === undefined) return;
  st().set({ pdus: st().pdus.map((x) => (x.id === id ? { ...x, status: ok ? 'Successful' : 'Failed' } : x)) });
}

export function runPing(srcId: string, dst: string, label?: string) {
  const p = st().project;
  const src = p.devices.find((d) => d.id === srcId);
  if (!src) return;
  const r = ping(p, srcId, dst);
  const dstName = p.devices.find((d) => d.ifaces.some((i) => i.ip === dst) || d.home?.lanIp === dst || d.home?.wanIp === dst)?.name;
  const text = `${src.name} → ${dstName ? `${dstName} (${dst})` : dst}: ${r.ok ? 'success' : r.reason ?? 'failed'}`;
  st().addLog(r.ok, text);
  let pduId: number | undefined;
  if (st().mode === 'simulation') {
    const list = st().pdus;
    const again = list.find((x) => x.srcId === srcId && x.dst === dst);
    pduId = again?.id ?? Date.now();
    const rec: PduRec = {
      id: pduId,
      num: again?.num ?? list.length,
      srcId,
      dst,
      srcName: src.name,
      dstName: dstName ?? dst,
      status: 'In Progress',
      color: again?.color ?? PDU_COLORS[list.length % PDU_COLORS.length],
      time: r.events.at(-1)?.time ?? 0,
    };
    st().set({ pdus: again ? list.map((x) => (x.id === pduId ? rec : x)) : [...list, rec] });
  }
  st().set({
    flight: {
      id: Date.now(),
      hops: r.hops,
      events: r.events,
      step: 0,
      playing: st().mode === 'realtime',
      ok: r.ok,
      label: label ?? text,
      sel: null,
      pdu: pduId,
    },
    bottomOpen: true,
  });
  if (st().mode === 'realtime') st().toast(text, r.ok ? 'good' : 'bad');
  return r;
}

export function primaryIp(d: Device) {
  if (d.home) return d.home.lanIp;
  return d.ifaces.find((i) => i.ip && !i.shutdown)?.ip ?? d.ifaces.find((i) => i.ip)?.ip;
}

export const canPing = (d: Device) => isHost(d) || !!d.ios || !!d.home;

export function fitView(w: number, h: number) {
  const ds = st().project.devices;
  if (!ds.length) return st().set({ view: { x: w / 2, y: h / 2, k: 1 } });
  const xs = ds.map((d) => d.x);
  const ys = ds.map((d) => d.y);
  const minX = Math.min(...xs) - 90;
  const maxX = Math.max(...xs) + 90;
  const minY = Math.min(...ys) - 80;
  const maxY = Math.max(...ys) + 100;
  const k = Math.max(0.3, Math.min(1.6, Math.min(w / (maxX - minX), h / (maxY - minY))));
  st().set({ view: { k, x: w / 2 - ((minX + maxX) / 2) * k, y: h / 2 - ((minY + maxY) / 2) * k } });
}
