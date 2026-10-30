/**
 * Control plane: builds each router's routing table (RIB) from connected networks, static routes
 * and RIP / OSPF / EIGRP, the way a converged network would look. Recomputed from scratch for a
 * topology, so it always reflects the current configs and cables.
 */
import { classfulMask, inNet, intToIp, ipToInt, maskToPrefix, network } from '../model/ip';
import type { Device, Iface } from '../model/types';
import type { Endpoint, Topo } from './network';

export type RouteCode = 'C' | 'L' | 'S' | 'S*' | 'R' | 'O' | 'O IA' | 'O*E2' | 'D' | 'D EX' | 'R*' | 'D*';

export interface Route {
  code: RouteCode;
  network: string;
  mask: string;
  ad: number;
  metric: number;
  /** next-hop address */
  via?: string;
  /** outgoing interface */
  iface?: string;
}

export const AD: Record<string, number> = { C: 0, L: 0, S: 1, D: 90, O: 110, R: 120, 'D EX': 170 };

/* ------------------------------------------------------------------ */
/*  Reading the routing protocol config                                */
/* ------------------------------------------------------------------ */

export interface RipCfg {
  version: 1 | 2;
  networks: string[];
  autoSummary: boolean;
  passive: Set<string>;
  passiveDefault: boolean;
  defaultOriginate: boolean;
}
export interface OspfCfg {
  pid: number;
  networks: { ip: string; wild: string; area: string }[];
  routerId?: string;
  passive: Set<string>;
  passiveDefault: boolean;
  defaultOriginate: boolean;
  refBw: number;
}
export interface EigrpCfg {
  as: number;
  networks: { ip: string; wild?: string }[];
  passive: Set<string>;
  passiveDefault: boolean;
  autoSummary: boolean;
}
export interface Protocols {
  rip?: RipCfg;
  ospf: OspfCfg[];
  eigrp: EigrpCfg[];
}

/** split the `router …` blocks out of a device's stored config lines */
export function protocolsOf(d: Device): Protocols {
  const out: Protocols = { ospf: [], eigrp: [] };
  const lines = d.ios?.extraPost ?? [];
  for (let k = 0; k < lines.length; k++) {
    const head = lines[k];
    let m: RegExpMatchArray | null;
    const body: string[] = [];
    for (let j = k + 1; j < lines.length && lines[j].startsWith(' '); j++) body.push(lines[j].trim());
    const passiveDefault = body.includes('passive-interface default');
    const passive = passiveDefault
      ? new Set(body.filter((b) => b.startsWith('no passive-interface ')).map((b) => b.slice(21).toLowerCase()))
      : new Set(body.filter((b) => b.startsWith('passive-interface ') && b !== 'passive-interface default').map((b) => b.slice(18).toLowerCase()));
    if (head === 'router rip') {
      out.rip = {
        version: body.includes('version 2') ? 2 : 1,
        networks: body.filter((b) => /^network \S+$/.test(b)).map((b) => b.split(' ')[1]),
        autoSummary: !body.includes('no auto-summary'),
        passive,
        passiveDefault,
        defaultOriginate: body.includes('default-information originate'),
      };
    } else if ((m = head.match(/^router ospf (\d+)$/))) {
      const cfg: OspfCfg = {
        pid: Number(m[1]),
        networks: body
          .map((b) => b.match(/^network (\S+) (\S+) area (\S+)$/))
          .filter((x): x is RegExpMatchArray => !!x)
          .map((x) => ({ ip: x[1], wild: x[2], area: x[3] })),
        routerId: body.find((b) => b.startsWith('router-id '))?.slice(10),
        passive,
        passiveDefault,
        defaultOriginate: body.some((b) => b.startsWith('default-information originate')),
        refBw: Number(body.find((b) => b.startsWith('auto-cost reference-bandwidth '))?.split(' ')[2]) || 100,
      };
      out.ospf.push(cfg);
    } else if ((m = head.match(/^router eigrp (\d+)$/))) {
      out.eigrp.push({
        as: Number(m[1]),
        networks: body
          .map((b) => b.match(/^network (\S+)(?: (\S+))?$/))
          .filter((x): x is RegExpMatchArray => !!x)
          .map((x) => ({ ip: x[1], wild: x[2] })),
        passive,
        passiveDefault,
        autoSummary: body.includes('auto-summary'),
      });
    }
  }
  return out;
}

const wildMatch = (ip: string, net: string, wild: string) => {
  const a = ipToInt(ip);
  const n = ipToInt(net);
  const w = ipToInt(wild);
  if (a === null || n === null || w === null) return false;
  return ((a ^ n) & ~w) >>> 0 === 0;
};

const classfulNet = (ip: string) => intToIp(network(ip, classfulMask(ip)));

/** with `passive-interface default`, the set holds the exceptions (`no passive-interface X`) */
const isPassive = (passive: Set<string>, passiveDefault: boolean, iface: string) =>
  passiveDefault ? !passive.has(iface.toLowerCase()) : passive.has(iface.toLowerCase());

/* ------------------------------------------------------------------ */
/*  Interface metrics                                                  */
/* ------------------------------------------------------------------ */

const extraNum = (i: Iface, key: string) => {
  const v = (i.extra ?? []).find((e) => e.startsWith(key + ' '))?.split(' ')[key.split(' ').length];
  return v !== undefined ? Number(v) : undefined;
};

/** bandwidth in kbit/s */
export function bandwidthOf(i: Iface | undefined): number {
  if (!i) return 100000;
  const set = extraNum(i, 'bandwidth');
  if (set) return set;
  if (i.media === 'serial') return 1544;
  if (i.name.startsWith('Loopback')) return 8000000;
  if (i.media === 'virtual') return 100000;
  return (i.speed || 100) * 1000;
}

/** delay in microseconds */
export function delayOf(i: Iface | undefined): number {
  if (!i) return 100;
  const set = extraNum(i, 'delay');
  if (set) return set * 10;
  if (i.media === 'serial') return 20000;
  if (i.name.startsWith('Loopback')) return 5000;
  return (i.speed || 100) >= 1000 ? 10 : (i.speed || 100) >= 100 ? 100 : 1000;
}

export function ospfCost(i: Iface | undefined, refBw = 100): number {
  if (!i) return 1;
  const set = extraNum(i, 'ip ospf cost');
  if (set) return set;
  return Math.max(1, Math.floor((refBw * 1000) / bandwidthOf(i)));
}

/* ------------------------------------------------------------------ */
/*  Adjacencies                                                        */
/* ------------------------------------------------------------------ */

export interface Neighbor {
  dev: Device;
  /** my interface */
  iface: string;
  /** the neighbor's address on the shared link */
  ip: string;
  /** neighbor's interface */
  peerIface: string;
}

const routerLike = (d: Device) => !!d.ios && d.powered && (d.kind === 'router' || (d.kind === 'switch' && d.ios.extraPost.includes('ip routing')));

/** endpoints of `d` that sit on an L3 link (same segment, same subnet) with another routing device */
function linkPeers(t: Topo, d: Device, segOf: (n: string) => string): { mine: Endpoint; peer: Endpoint }[] {
  const out: { mine: Endpoint; peer: Endpoint }[] = [];
  const mine = t.endpoints.filter((e) => e.dev.id === d.id);
  for (const e of mine)
    for (const o of t.endpoints) {
      if (o.dev.id === d.id || !routerLike(o.dev)) continue;
      if (segOf(o.node) !== segOf(e.node)) continue;
      if (!inNet(o.ip, e.ip, e.mask) || o.mask !== e.mask) continue;
      out.push({ mine: e, peer: o });
    }
  return out;
}

const ospfArea = (cfg: OspfCfg, ip: string) => cfg.networks.find((n) => wildMatch(ip, n.ip, n.wild))?.area;
const eigrpOn = (cfg: EigrpCfg, ip: string) => cfg.networks.some((n) => (n.wild ? wildMatch(ip, n.ip, n.wild) : classfulNet(ip) === classfulNet(n.ip)));
const ripOn = (cfg: RipCfg, ip: string) => cfg.networks.some((n) => classfulNet(ip) === classfulNet(n));

/** OSPF router ID: configured, else the highest loopback address, else the highest interface address */
export function ospfRouterId(d: Device, cfg?: OspfCfg): string {
  if (cfg?.routerId) return cfg.routerId;
  const up = d.ifaces.filter((i) => i.ip && !i.shutdown);
  const loops = up.filter((i) => i.name.startsWith('Loopback'));
  const pick = (loops.length ? loops : up).map((i) => i.ip!).sort((a, b) => (ipToInt(b) ?? 0) - (ipToInt(a) ?? 0));
  return pick[0] ?? '0.0.0.0';
}

export interface Adjacency {
  proto: 'ospf' | 'eigrp' | 'rip';
  a: Device;
  b: Device;
  aIf: string;
  bIf: string;
  aIp: string;
  bIp: string;
  area?: string;
  as?: number;
}

export function adjacencies(t: Topo, segOf: (n: string) => string): Adjacency[] {
  const out: Adjacency[] = [];
  const routers = [...t.devs.values()].filter(routerLike);
  const prot = new Map(routers.map((d) => [d.id, protocolsOf(d)]));
  for (const d of routers) {
    const pd = prot.get(d.id)!;
    for (const { mine, peer } of linkPeers(t, d, segOf)) {
      if (peer.dev.id < d.id) continue; // each pair once
      const pp = prot.get(peer.dev.id);
      if (!pp) continue;
      for (const o of pd.ospf)
        for (const q of pp.ospf) {
          const aa = ospfArea(o, mine.ip);
          const ba = ospfArea(q, peer.ip);
          if (aa === undefined || ba === undefined || aa !== ba) continue;
          if (isPassive(o.passive, o.passiveDefault, mine.iface) || isPassive(q.passive, q.passiveDefault, peer.iface)) continue;
          if (ospfRouterId(d, o) === ospfRouterId(peer.dev, q)) continue;
          out.push({ proto: 'ospf', a: d, b: peer.dev, aIf: mine.iface, bIf: peer.iface, aIp: mine.ip, bIp: peer.ip, area: aa });
        }
      for (const o of pd.eigrp)
        for (const q of pp.eigrp) {
          if (o.as !== q.as || !eigrpOn(o, mine.ip) || !eigrpOn(q, peer.ip)) continue;
          if (isPassive(o.passive, o.passiveDefault, mine.iface) || isPassive(q.passive, q.passiveDefault, peer.iface)) continue;
          out.push({ proto: 'eigrp', a: d, b: peer.dev, aIf: mine.iface, bIf: peer.iface, aIp: mine.ip, bIp: peer.ip, as: o.as });
        }
      if (pd.rip && pp.rip && ripOn(pd.rip, mine.ip) && ripOn(pp.rip, peer.ip))
        out.push({ proto: 'rip', a: d, b: peer.dev, aIf: mine.iface, bIf: peer.iface, aIp: mine.ip, bIp: peer.ip });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  RIB computation                                                    */
/* ------------------------------------------------------------------ */

export interface ControlPlane {
  ribs: Map<string, Route[]>;
  adj: Adjacency[];
}

const key = (n: string, m: string) => `${n}/${maskToPrefix(m)}`;

function staticRoutes(d: Device, own: Endpoint[], all: Map<string, Route[]>): Route[] {
  const out: Route[] = [];
  for (const r of d.ios?.routes ?? []) {
    const ad = r.distance ?? 1;
    const def = r.network === '0.0.0.0' && r.mask === '0.0.0.0';
    if (r.iface) {
      if (!own.some((e) => e.iface.toLowerCase() === r.iface!.toLowerCase())) continue;
      out.push({ code: def ? 'S*' : 'S', network: r.network, mask: r.mask, ad, metric: 0, iface: r.iface });
    } else if (r.via) {
      // the next hop must be reachable (directly, or recursively through another route)
      const direct = own.find((e) => inNet(r.via!, e.ip, e.mask));
      const recursive = !direct && (all.get(d.id) ?? []).some((x) => x.code !== 'S' && x.code !== 'S*' && inNet(r.via!, x.network, x.mask));
      if (!direct && !recursive) continue;
      out.push({ code: def ? 'S*' : 'S', network: r.network, mask: r.mask, ad, metric: 0, via: r.via, iface: direct?.iface });
    }
  }
  return out;
}

/** Build every routing device's table. `segOf` maps a port node to its L2 segment. */
export function computeControlPlane(devices: Device[], t: Topo, segOf: (n: string) => string): ControlPlane {
  const ribs = new Map<string, Route[]>();
  const routers = devices.filter((d) => d.ios && d.powered && (d.kind === 'router' || d.kind === 'switch'));
  const own = new Map(routers.map((d) => [d.id, t.endpoints.filter((e) => e.dev.id === d.id)]));
  const connected = new Map<string, Route[]>();
  for (const d of routers) {
    const rs: Route[] = [];
    for (const e of own.get(d.id)!) {
      rs.push({ code: 'C', network: intToIp(network(e.ip, e.mask)), mask: e.mask, ad: 0, metric: 0, iface: e.iface });
      rs.push({ code: 'L', network: e.ip, mask: '255.255.255.255', ad: 0, metric: 0, iface: e.iface });
    }
    connected.set(d.id, rs);
  }
  const adj = adjacencies(t, segOf);
  const learned = new Map<string, Route[]>(routers.map((d) => [d.id, []]));
  const statics = new Map<string, Route[]>();
  for (const d of routers) statics.set(d.id, staticRoutes(d, own.get(d.id)!, new Map()));

  ripRoutes(routers, own, adj, learned, statics);
  ospfRoutes(routers, own, adj, learned, statics);
  eigrpRoutes(routers, own, adj, learned);

  for (const d of routers) {
    // static routes recursing through dynamic routes are resolved once the dynamic ones exist
    const st = staticRoutes(d, own.get(d.id)!, new Map([[d.id, [...connected.get(d.id)!, ...learned.get(d.id)!]]]));
    const best = new Map<string, Route[]>();
    for (const r of [...connected.get(d.id)!, ...st, ...learned.get(d.id)!]) {
      const k = key(r.network, r.mask) + (r.code === 'L' ? 'L' : '');
      const cur = best.get(k);
      if (!cur || r.ad < cur[0].ad || (r.ad === cur[0].ad && r.metric < cur[0].metric)) best.set(k, [r]);
      else if (r.ad === cur[0].ad && r.metric === cur[0].metric && r.via && !cur.some((x) => x.via === r.via)) cur.push(r);
    }
    ribs.set(d.id, [...best.values()].flat());
  }
  return { ribs, adj };
}

const nbrOf = (adj: Adjacency[], proto: Adjacency['proto'], d: Device) =>
  adj
    .filter((a) => a.proto === proto && (a.a.id === d.id || a.b.id === d.id))
    .map((a) => (a.a.id === d.id ? { dev: a.b, myIf: a.aIf, peerIp: a.bIp, peerIf: a.bIf, area: a.area, as: a.as } : { dev: a.a, myIf: a.bIf, peerIp: a.aIp, peerIf: a.aIf, area: a.area, as: a.as }));

function hasDefault(d: Device, statics: Map<string, Route[]>) {
  return (statics.get(d.id) ?? []).some((r) => r.network === '0.0.0.0' && r.mask === '0.0.0.0');
}

/* ---------------- RIP: distance vector, hop count ---------------- */

function ripRoutes(routers: Device[], own: Map<string, Endpoint[]>, adj: Adjacency[], learned: Map<string, Route[]>, statics: Map<string, Route[]>) {
  type Entry = { network: string; mask: string; metric: number; via?: string; iface?: string; def?: boolean };
  const table = new Map<string, Map<string, Entry>>();
  const cfg = new Map<string, RipCfg>();
  for (const d of routers) {
    const c = protocolsOf(d).rip;
    if (!c) continue;
    cfg.set(d.id, c);
    const t = new Map<string, Entry>();
    for (const e of own.get(d.id)!) if (ripOn(c, e.ip)) t.set(key(intToIp(network(e.ip, e.mask)), e.mask), { network: intToIp(network(e.ip, e.mask)), mask: e.mask, metric: 0, iface: e.iface });
    if (c.defaultOriginate && hasDefault(d, statics)) t.set('0.0.0.0/0', { network: '0.0.0.0', mask: '0.0.0.0', metric: 0, def: true });
    table.set(d.id, t);
  }
  for (let round = 0; round < 16; round++) {
    let changed = false;
    for (const d of routers) {
      const c = cfg.get(d.id);
      if (!c) continue;
      for (const n of nbrOf(adj, 'rip', d)) {
        const nc = cfg.get(n.dev.id)!;
        // the neighbour sends out its interface unless it's passive
        if (isPassive(nc.passive, nc.passiveDefault, n.peerIf)) continue;
        const myEp = own.get(d.id)!.find((e) => e.iface === n.myIf)!;
        for (const adv of table.get(n.dev.id)!.values()) {
          if (adv.via && adv.iface === n.peerIf) continue; // split horizon
          let net = adv.network;
          let mask = adv.mask;
          // classful summarisation at major-network boundaries (RIPv1, or v2 with auto-summary)
          const summarize = nc.version === 1 || nc.autoSummary;
          if (summarize && !adv.def && classfulNet(net) !== classfulNet(n.peerIp)) {
            net = classfulNet(net);
            mask = classfulMask(net);
          }
          // v1 has no masks: a subnet of the receiving interface's major net takes that interface's mask
          if (nc.version === 1 && !adv.def && classfulNet(net) === classfulNet(myEp.ip)) mask = myEp.mask;
          const metric = adv.metric + 1;
          if (metric > 15) continue;
          const k = key(net, mask);
          const cur = table.get(d.id)!.get(k);
          if (!cur || (cur.via !== undefined && metric < cur.metric)) {
            if (cur && cur.via === undefined) continue;
            table.get(d.id)!.set(k, { network: net, mask, metric, via: n.peerIp, iface: n.myIf, def: adv.def });
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  for (const d of routers) {
    const t = table.get(d.id);
    if (!t) continue;
    for (const e of t.values())
      if (e.via) learned.get(d.id)!.push({ code: e.def ? 'R*' : 'R', network: e.network, mask: e.mask, ad: 120, metric: e.metric, via: e.via, iface: e.iface });
  }
}

/* ---------------- OSPF: link state, Dijkstra ---------------- */

function ospfRoutes(routers: Device[], own: Map<string, Endpoint[]>, adj: Adjacency[], learned: Map<string, Route[]>, statics: Map<string, Route[]>) {
  const cfg = new Map<string, OspfCfg>();
  for (const d of routers) {
    const c = protocolsOf(d).ospf[0];
    if (c) cfg.set(d.id, c);
  }
  if (!cfg.size) return;
  // stub networks each router advertises, with their area and interface cost
  const stubs = new Map<string, { network: string; mask: string; cost: number; area: string }[]>();
  for (const d of routers) {
    const c = cfg.get(d.id);
    if (!c) continue;
    const list: { network: string; mask: string; cost: number; area: string }[] = [];
    for (const e of own.get(d.id)!) {
      const area = ospfArea(c, e.ip);
      if (area === undefined) continue;
      const i = d.ifaces.find((x) => x.name === e.iface);
      const loop = e.iface.startsWith('Loopback') && !(i?.extra ?? []).includes('ip ospf network point-to-point');
      list.push(loop ? { network: e.ip, mask: '255.255.255.255', cost: 1, area } : { network: intToIp(network(e.ip, e.mask)), mask: e.mask, cost: ospfCost(i, c.refBw), area });
    }
    stubs.set(d.id, list);
  }
  const edges = adj.filter((a) => a.proto === 'ospf');
  for (const src of routers) {
    const c = cfg.get(src.id);
    if (!c) continue;
    const myAreas = new Set(stubs.get(src.id)!.map((s) => s.area));
    // Dijkstra over routers; remember the first hop out of src
    const dist = new Map<string, number>([[src.id, 0]]);
    const first = new Map<string, { via: string; iface: string }>();
    const done = new Set<string>();
    for (;;) {
      let u: string | undefined;
      for (const [id, dv] of dist) if (!done.has(id) && (u === undefined || dv < dist.get(u)!)) u = id;
      if (u === undefined) break;
      done.add(u);
      const ud = routers.find((r) => r.id === u)!;
      const uc = cfg.get(u)!;
      for (const e of edges) {
        const out = e.a.id === u ? { to: e.b, myIf: e.aIf, peerIp: e.bIp } : e.b.id === u ? { to: e.a, myIf: e.bIf, peerIp: e.aIp } : null;
        if (!out || !cfg.has(out.to.id)) continue;
        const nd = dist.get(u)! + ospfCost(ud.ifaces.find((i) => i.name === out.myIf), uc.refBw);
        if (nd < (dist.get(out.to.id) ?? Infinity)) {
          dist.set(out.to.id, nd);
          first.set(out.to.id, u === src.id ? { via: out.peerIp, iface: out.myIf } : first.get(u)!);
        }
      }
    }
    const mine = new Set(stubs.get(src.id)!.map((s) => key(s.network, s.mask)));
    for (const [rid, dv] of dist) {
      if (rid === src.id) continue;
      const hop = first.get(rid);
      if (!hop) continue;
      const rd = routers.find((r) => r.id === rid)!;
      for (const s of stubs.get(rid) ?? []) {
        if (mine.has(key(s.network, s.mask))) continue;
        learned.get(src.id)!.push({ code: myAreas.has(s.area) ? 'O' : 'O IA', network: s.network, mask: s.mask, ad: 110, metric: dv + s.cost, via: hop.via, iface: hop.iface });
      }
      if (cfg.get(rid)!.defaultOriginate && hasDefault(rd, statics))
        learned.get(src.id)!.push({ code: 'O*E2', network: '0.0.0.0', mask: '0.0.0.0', ad: 110, metric: 1, via: hop.via, iface: hop.iface });
    }
  }
}

/* ---------------- EIGRP: composite metric ---------------- */

export const eigrpMetric = (minBwKbps: number, delayUs: number) => 256 * (Math.floor(10_000_000 / minBwKbps) + Math.floor(delayUs / 10));

function eigrpRoutes(routers: Device[], own: Map<string, Endpoint[]>, adj: Adjacency[], learned: Map<string, Route[]>) {
  type Entry = { network: string; mask: string; bw: number; delay: number; via?: string; iface?: string };
  const cfg = new Map<string, EigrpCfg>();
  for (const d of routers) {
    const c = protocolsOf(d).eigrp[0];
    if (c) cfg.set(d.id, c);
  }
  if (!cfg.size) return;
  const table = new Map<string, Map<string, Entry>>();
  for (const d of routers) {
    const c = cfg.get(d.id);
    if (!c) continue;
    const t = new Map<string, Entry>();
    for (const e of own.get(d.id)!) {
      if (!eigrpOn(c, e.ip)) continue;
      const i = d.ifaces.find((x) => x.name === e.iface);
      t.set(key(intToIp(network(e.ip, e.mask)), e.mask), { network: intToIp(network(e.ip, e.mask)), mask: e.mask, bw: bandwidthOf(i), delay: delayOf(i), iface: e.iface });
    }
    table.set(d.id, t);
  }
  const metricOf = (x: Entry) => eigrpMetric(x.bw, x.delay);
  for (let round = 0; round < 32; round++) {
    let changed = false;
    for (const d of routers) {
      const c = cfg.get(d.id);
      if (!c) continue;
      for (const n of nbrOf(adj, 'eigrp', d)) {
        const nc = cfg.get(n.dev.id)!;
        if (nc.as !== c.as) continue;
        const myIf = d.ifaces.find((i) => i.name === n.myIf);
        for (const adv of table.get(n.dev.id)!.values()) {
          if (adv.via && adv.iface === n.peerIf) continue; // split horizon
          let net = adv.network;
          let mask = adv.mask;
          if (nc.autoSummary && classfulNet(net) !== classfulNet(n.peerIp)) {
            net = classfulNet(net);
            mask = classfulMask(net);
          }
          const cand: Entry = { network: net, mask, bw: Math.min(adv.bw, bandwidthOf(myIf)), delay: adv.delay + delayOf(myIf), via: n.peerIp, iface: n.myIf };
          const k = key(net, mask);
          const cur = table.get(d.id)!.get(k);
          if (cur && cur.via === undefined) continue;
          if (!cur || metricOf(cand) < metricOf(cur)) {
            table.get(d.id)!.set(k, cand);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  for (const d of routers) {
    const t = table.get(d.id);
    if (!t) continue;
    for (const e of t.values()) if (e.via) learned.get(d.id)!.push({ code: 'D', network: e.network, mask: e.mask, ad: 90, metric: metricOf(e), via: e.via, iface: e.iface });
  }
}

/** the route a router uses for `dst` (longest prefix match) */
export function lookup(routes: Route[], dst: string): Route | undefined {
  let best: Route | undefined;
  for (const r of routes) {
    if (!inNet(dst, r.network, r.mask)) continue;
    if (!best || maskToPrefix(r.mask) > maskToPrefix(best.mask)) best = r;
  }
  return best;
}
