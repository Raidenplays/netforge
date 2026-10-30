import { broadcast, inNet, intToIp, ipToInt, isIp, maskToPrefix, network } from '../model/ip';
import type { Device, Iface, Link, Project } from '../model/types';
import { isHost } from '../model/catalog';

/* ------------------------------------------------------------------ */
/*  Topology: L2 segments, interface status, L3 endpoints              */
/* ------------------------------------------------------------------ */

export interface Endpoint {
  dev: Device;
  iface: string; // interface name or 'LAN' for home router bridge
  ip: string;
  mask: string;
  node: string;
}

export interface Edge {
  to: string;
  link?: string; // link id when the edge is a cable
}

export interface Topo {
  devs: Map<string, Device>;
  links: Link[];
  wireless: Link[];
  upLinks: Set<string>;
  parent: Map<string, string>;
  adj: Map<string, Edge[]>;
  endpoints: Endpoint[];
}

const node = (dev: string, iface: string) => `${dev}::${iface}`;

const WIFI_RANGE = 520;
const HOME_LAN = ['Ethernet 1', 'Ethernet 2', 'Ethernet 3', 'Ethernet 4', 'Wireless'];

export const ifaceOf = (d: Device | undefined, name: string) => d?.ifaces.find((i) => i.name === name);

/** Wi-Fi clients associate with the nearest home router in range. */
export function wirelessLinks(p: Project): Link[] {
  const aps = p.devices.filter((d) => d.kind === 'homerouter' && d.powered);
  const out: Link[] = [];
  for (const d of p.devices) {
    if (!d.powered || d.kind === 'homerouter') continue;
    const w = d.ifaces.find((i) => i.media === 'wireless' && !i.shutdown);
    if (!w) continue;
    let best: Device | undefined;
    let bd = Infinity;
    for (const ap of aps) {
      if ((d.ssid ?? 'Default') !== ap.home?.ssid) continue;
      const dist = Math.hypot(ap.x - d.x, ap.y - d.y);
      if (dist < bd && dist <= WIFI_RANGE) {
        bd = dist;
        best = ap;
      }
    }
    if (best) out.push({ id: `wifi_${d.id}`, a: { dev: d.id, iface: w.name }, b: { dev: best.id, iface: 'Wireless' }, cable: 'auto' });
  }
  return out;
}

export function buildTopo(p: Project): Topo {
  const devs = new Map(p.devices.map((d) => [d.id, d]));
  const parent = new Map<string, string>();
  const adj = new Map<string, Edge[]>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string, link?: string) => {
    parent.set(find(a), find(b));
    (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, link });
    (adj.get(b) ?? adj.set(b, []).get(b)!).push({ to: a, link });
  };

  const wireless = wirelessLinks(p);
  const upLinks = new Set<string>();
  for (const l of [...p.links, ...wireless]) {
    const da = devs.get(l.a.dev);
    const db = devs.get(l.b.dev);
    const ia = ifaceOf(da, l.a.iface);
    const ib = ifaceOf(db, l.b.iface);
    if (!da || !db || !ia || !ib) continue;
    if (!da.powered || !db.powered || ia.shutdown || ib.shutdown) continue;
    upLinks.add(l.id);
    union(node(da.id, ia.name), node(db.id, ib.name), l.id);
  }

  // bridging devices
  for (const d of p.devices) {
    if (!d.powered) continue;
    if (d.kind === 'switch') {
      const ports = d.ifaces.filter((i) => !i.shutdown && (i.media !== 'virtual' || i.name.startsWith('Vlan')));
      for (let k = 1; k < ports.length; k++) union(node(d.id, ports[0].name), node(d.id, ports[k].name));
    }
    if (d.kind === 'homerouter') {
      for (const n of HOME_LAN) if (ifaceOf(d, n)) union(node(d.id, 'LAN'), node(d.id, n));
    }
  }

  const endpoints: Endpoint[] = [];
  const linkUp = (d: Device, i: Iface) =>
    i.media === 'virtual' ||
    [...p.links, ...wireless].some(
      (l) => upLinks.has(l.id) && ((l.a.dev === d.id && l.a.iface === i.name) || (l.b.dev === d.id && l.b.iface === i.name)),
    );

  for (const d of p.devices) {
    if (!d.powered) continue;
    if (d.kind === 'homerouter' && d.home) {
      endpoints.push({ dev: d, iface: 'LAN', ip: d.home.lanIp, mask: d.home.lanMask, node: node(d.id, 'LAN') });
      const wan = ifaceOf(d, 'Internet');
      if (wan && isIp(d.home.wanIp) && d.home.wanIp !== '0.0.0.0' && linkUp(d, wan))
        endpoints.push({ dev: d, iface: 'Internet', ip: d.home.wanIp, mask: d.home.wanMask, node: node(d.id, 'Internet') });
      continue;
    }
    for (const i of d.ifaces) {
      if (i.shutdown || !i.ip || !i.mask || !isIp(i.ip)) continue;
      if (!linkUp(d, i)) continue;
      endpoints.push({ dev: d, iface: i.name, ip: i.ip, mask: i.mask, node: node(d.id, i.name) });
    }
  }
  for (const e of endpoints) find(e.node);

  return { devs, links: p.links, wireless, upLinks, parent, adj, endpoints };
}

export const segOf = (t: Topo, n: string) => {
  let r = n;
  if (!t.parent.has(r)) return r;
  while (t.parent.get(r) !== r) r = t.parent.get(r)!;
  return r;
};

export function ifaceStatus(p: Project, t: Topo, d: Device, i: Iface) {
  if (i.media === 'virtual') return { admin: !i.shutdown, line: !i.shutdown };
  const cabled = [...p.links, ...t.wireless].some(
    (l) => (l.a.dev === d.id && l.a.iface === i.name) || (l.b.dev === d.id && l.b.iface === i.name),
  );
  const up = [...p.links, ...t.wireless].some(
    (l) => t.upLinks.has(l.id) && ((l.a.dev === d.id && l.a.iface === i.name) || (l.b.dev === d.id && l.b.iface === i.name)),
  );
  return { admin: !i.shutdown, line: up, cabled };
}

/** BFS through cables and bridges between two port nodes. Returns traversed link ids and device ids. */
export function l2Path(t: Topo, from: string, to: string) {
  const prev = new Map<string, { n: string; link?: string }>();
  const q = [from];
  prev.set(from, { n: '' });
  while (q.length) {
    const c = q.shift()!;
    if (c === to) break;
    for (const e of t.adj.get(c) ?? []) {
      if (prev.has(e.to)) continue;
      prev.set(e.to, { n: c, link: e.link });
      q.push(e.to);
    }
  }
  if (!prev.has(to)) return null;
  const links: string[] = [];
  const devs: string[] = [];
  let c = to;
  while (c) {
    const dev = c.split('::')[0];
    if (devs[0] !== dev) devs.unshift(dev);
    const pr = prev.get(c)!;
    if (pr.link) links.unshift(pr.link);
    c = pr.n;
  }
  return { links, devs };
}

/* ------------------------------------------------------------------ */
/*  L3 forwarding                                                      */
/* ------------------------------------------------------------------ */

interface Fwd {
  egress: Endpoint;
  nextHop: string;
}

function routeLookup(t: Topo, d: Device, dst: string): Fwd | { error: string } {
  const own = t.endpoints.filter((e) => e.dev.id === d.id);
  if (!own.length) return { error: 'no IP address configured' };

  // end hosts and switch SVIs: subnet or default gateway
  if (isHost(d) || d.kind === 'switch') {
    const e = own[0];
    if (inNet(dst, e.ip, e.mask)) return { egress: e, nextHop: dst };
    const gw = d.kind === 'switch' ? d.ios?.defaultGateway : d.gateway;
    if (!gw || !isIp(gw) || gw === '0.0.0.0') return { error: 'no default gateway' };
    return { egress: e, nextHop: gw };
  }

  // routers & home routers: longest prefix match over connected + static
  type Cand = { prefix: number; egress: Endpoint; nextHop: string };
  const cands: Cand[] = [];
  for (const e of own) if (inNet(dst, e.ip, e.mask)) cands.push({ prefix: maskToPrefix(e.mask), egress: e, nextHop: dst });

  const routes = [...(d.ios?.routes ?? [])];
  if (d.home) {
    const gw = d.home.wanGateway;
    if (isIp(gw) && gw !== '0.0.0.0') routes.push({ network: '0.0.0.0', mask: '0.0.0.0', via: gw });
  }
  for (const r of routes) {
    if (!inNet(dst, r.network, r.mask)) continue;
    let egress: Endpoint | undefined;
    let nh = dst;
    if (r.via) {
      egress = own.find((e) => inNet(r.via!, e.ip, e.mask));
      nh = r.via;
    } else if (r.iface) {
      egress = own.find((e) => e.iface.toLowerCase() === r.iface!.toLowerCase());
    }
    if (egress) cands.push({ prefix: maskToPrefix(r.mask), egress, nextHop: nh });
  }
  if (!cands.length) return { error: 'no route to host' };
  cands.sort((a, b) => b.prefix - a.prefix);
  return { egress: cands[0].egress, nextHop: cands[0].nextHop };
}

export interface SimEvent {
  kind: 'ICMP' | 'ARP' | 'DHCP' | 'NAT';
  at: string;
  to?: string;
  info: string;
  ok: boolean;
}

export interface Hop {
  links: string[];
  devs: string[];
  kind: 'ICMP' | 'ARP';
  reply: boolean;
  fail?: boolean;
  /** index of the matching event */
  ev: number;
}

interface NatEntry {
  dev: string;
  inside: string;
  outside: string;
}

interface Leg {
  ok: boolean;
  reason?: string;
  reachedDev?: Device;
  finalSrc: string;
  routersIn: { dev: Device; ip: string }[];
}

function forward(
  t: Topo,
  start: Device,
  src: string,
  dst: string,
  reply: boolean,
  nat: NatEntry[],
  hops: Hop[],
  events: SimEvent[],
  arp: Set<string>,
): Leg {
  let cur = start;
  let ingress: Endpoint | undefined;
  let pkt = { src, dst };
  const routersIn: { dev: Device; ip: string }[] = [];
  for (let ttl = 30; ttl > 0; ttl--) {
    // NAT un-translation on the way back
    const back = nat.find((n) => n.dev === cur.id && n.outside === pkt.dst && reply);
    if (back) {
      events.push({ kind: 'NAT', at: cur.name, info: `Translate ${pkt.dst} → ${back.inside}`, ok: true });
      pkt = { ...pkt, dst: back.inside };
    }
    if (t.endpoints.some((e) => e.dev.id === cur.id && e.ip === pkt.dst))
      return { ok: true, reachedDev: cur, finalSrc: pkt.src, routersIn };

    const f = routeLookup(t, cur, pkt.dst);
    if ('error' in f) {
      events.push({ kind: 'ICMP', at: cur.name, info: `Dropped: ${f.error}`, ok: false });
      return { ok: false, reason: cur === start ? f.error : `Destination host unreachable (${cur.name})`, finalSrc: pkt.src, routersIn };
    }

    // NAT on the way out
    if (!reply && ingress) {
      const inIf = ifaceOf(cur, ingress.iface);
      const outIf = ifaceOf(cur, f.egress.iface);
      const routerNat =
        cur.ios && cur.ios.natRules.some((r) => /ip nat inside source/.test(r)) && inIf?.natRole === 'inside' && outIf?.natRole === 'outside';
      const homeNat = cur.kind === 'homerouter' && ingress.iface === 'LAN' && f.egress.iface === 'Internet';
      if (routerNat || homeNat) {
        const outside = f.egress.ip;
        nat.push({ dev: cur.id, inside: pkt.src, outside });
        events.push({ kind: 'NAT', at: cur.name, info: `Translate ${pkt.src} → ${outside}`, ok: true });
        pkt = { ...pkt, src: outside };
      }
    }

    const seg = segOf(t, f.egress.node);
    const target = t.endpoints.find((e) => e.ip === f.nextHop && segOf(t, e.node) === seg && e.dev.id !== cur.id);
    const arpKey = `${seg}|${f.nextHop}`;
    if (!arp.has(arpKey)) {
      arp.add(arpKey);
      events.push({
        kind: 'ARP',
        at: cur.name,
        info: target ? `Who has ${f.nextHop}? ${target.dev.name} replies` : `Who has ${f.nextHop}? No reply`,
        ok: !!target,
      });
    }
    if (!target) {
      hops.push({ links: [], devs: [cur.id], kind: 'ARP', reply, fail: true, ev: events.length - 1 });
      return { ok: false, reason: 'Request timed out.', finalSrc: pkt.src, routersIn };
    }
    const path = l2Path(t, f.egress.node, target.node);
    hops.push({ links: path?.links ?? [], devs: path?.devs ?? [cur.id, target.dev.id], kind: 'ICMP', reply, ev: events.length });
    events.push({
      kind: 'ICMP',
      at: cur.name,
      to: target.dev.name,
      info: `${reply ? 'Echo reply' : 'Echo request'} ${pkt.src} → ${pkt.dst}`,
      ok: true,
    });
    if (!isHost(target.dev) && target.dev.kind !== 'switch') routersIn.push({ dev: target.dev, ip: target.ip });
    ingress = target;
    cur = target.dev;
  }
  events.push({ kind: 'ICMP', at: cur.name, info: 'TTL expired in transit', ok: false });
  return { ok: false, reason: 'TTL expired in transit.', finalSrc: pkt.src, routersIn };
}

export interface PingResult {
  ok: boolean;
  reason?: string;
  srcIp?: string;
  hops: Hop[];
  events: SimEvent[];
  routers: { name: string; ip: string }[];
}

export function ping(p: Project, srcId: string, dst: string): PingResult {
  const t = buildTopo(p);
  const src = t.devs.get(srcId);
  const events: SimEvent[] = [];
  const hops: Hop[] = [];
  if (!src) return { ok: false, reason: 'unknown device', hops, events, routers: [] };
  if (!isIp(dst)) return { ok: false, reason: `Ping request could not find host ${dst}.`, hops, events, routers: [] };

  let srcEp = t.endpoints.find((e) => e.dev.id === srcId);
  // routers source from the egress interface
  const look = routeLookup(t, src, dst);
  if (!('error' in look)) srcEp = look.egress;
  if (!srcEp) return { ok: false, reason: 'No IP address is configured on this device.', hops, events, routers: [] };

  const nat: NatEntry[] = [];
  const arp = new Set<string>();
  const there = forward(t, src, srcEp.ip, dst, false, nat, hops, events, arp);
  if (!there.ok || !there.reachedDev)
    return { ok: false, reason: there.reason, srcIp: srcEp.ip, hops, events, routers: there.routersIn.map((r) => ({ name: r.dev.name, ip: r.ip })) };
  const back = forward(t, there.reachedDev, dst, there.finalSrc, true, nat, hops, events, arp);
  return {
    ok: back.ok,
    reason: back.ok ? undefined : 'Request timed out.',
    srcIp: srcEp.ip,
    hops,
    events,
    routers: there.routersIn.map((r) => ({ name: r.dev.name, ip: r.ip })),
  };
}

/* ------------------------------------------------------------------ */
/*  DHCP                                                               */
/* ------------------------------------------------------------------ */

export interface DhcpOffer {
  ip: string;
  mask: string;
  gateway: string;
  dns: string;
  server: Device;
}

function usedIps(p: Project, exceptDev: string) {
  const s = new Set<string>();
  for (const d of p.devices) {
    if (d.id === exceptDev) continue;
    for (const i of d.ifaces) if (i.ip) s.add(i.ip);
    if (d.home) s.add(d.home.lanIp);
  }
  return s;
}

/** Find a DHCP server on the client's broadcast domain and get a lease. */
export function dhcpDiscover(p: Project, clientId: string, ifaceName?: string): DhcpOffer | null {
  // Temporarily treat the client interface as reachable for segment calc
  const t = buildTopo(p);
  const client = t.devs.get(clientId);
  if (!client) return null;
  const iname = ifaceName ?? client.ifaces.find((i) => !i.shutdown && i.media !== 'virtual')?.name;
  if (!iname) return null;
  const n = node(clientId, iname);
  const seg = segOf(t, n);
  if (seg === n && !(t.adj.get(n)?.length)) return null;
  const mac = ifaceOf(client, iname)?.mac ?? '';
  const used = usedIps(p, clientId);

  for (const e of t.endpoints) {
    if (segOf(t, e.node) !== seg || e.dev.id === clientId) continue;
    const s = e.dev;
    if (s.kind === 'homerouter' && s.home?.dhcpEnabled && e.iface === 'LAN') {
      const h = s.home;
      const base = network(h.lanIp, h.lanMask);
      const existing = h.leases.find((l) => l.mac === mac);
      if (existing) return { ip: existing.ip, mask: h.lanMask, gateway: h.lanIp, dns: h.lanIp, server: s };
      for (let k = 0; k < h.maxUsers; k++) {
        const ip = intToIp(base + h.startHost + k);
        if (!used.has(ip) && !h.leases.some((l) => l.ip === ip)) {
          h.leases.push({ ip, mac });
          return { ip, mask: h.lanMask, gateway: h.lanIp, dns: h.lanIp, server: s };
        }
      }
    }
    if (s.ios) {
      const pool = s.ios.pools.find((pl) => pl.network && pl.mask && inNet(e.ip, pl.network, pl.mask));
      if (!pool || !pool.network || !pool.mask) continue;
      const existing = s.ios.leases.find((l) => l.mac === mac && inNet(l.ip, pool.network!, pool.mask!));
      const offer = (ip: string) => ({ ip, mask: pool.mask!, gateway: pool.router ?? '0.0.0.0', dns: pool.dns ?? '0.0.0.0', server: s });
      if (existing) return offer(existing.ip);
      const lo = network(pool.network, pool.mask) + 1;
      const hi = broadcast(pool.network, pool.mask) - 1;
      const excluded = (v: number) =>
        s.ios!.excluded.some((x) => {
          const a = ipToInt(x.from) ?? 0;
          const b = ipToInt(x.to || x.from) ?? a;
          return v >= a && v <= b;
        });
      for (let v = lo; v <= hi; v++) {
        const ip = intToIp(v);
        if (excluded(v) || used.has(ip) || s.ios.leases.some((l) => l.ip === ip)) continue;
        s.ios.leases.push({ ip, mac });
        return offer(ip);
      }
    }
  }
  return null;
}

const apipa = () => `169.254.${1 + Math.floor(Math.random() * 253)}.${1 + Math.floor(Math.random() * 253)}`;

/** Re-run DHCP for every client whose address is no longer valid. Mutates the project (call on a draft). */
export function settleDhcp(p: Project) {
  const log: string[] = [];
  for (const d of p.devices) {
    if (d.kind === 'homerouter' && d.home?.wanMode === 'dhcp') {
      const wanUp = p.links.some((l) => (l.a.dev === d.id && l.a.iface === 'Internet') || (l.b.dev === d.id && l.b.iface === 'Internet'));
      if (!wanUp) {
        d.home.wanIp = '0.0.0.0';
        continue;
      }
      if (d.home.wanIp !== '0.0.0.0') continue;
      const o = dhcpDiscover(p, d.id, 'Internet');
      if (o) {
        d.home.wanIp = o.ip;
        d.home.wanMask = o.mask;
        d.home.wanGateway = o.gateway;
        log.push(`${d.name} WAN got ${o.ip} from ${o.server.name}`);
      }
    }
  }
  for (const d of p.devices) {
    if (!isHost(d) || !d.dhcpClient) continue;
    const i = d.ifaces.find((x) => !x.shutdown);
    if (!i) continue;
    const valid = i.ip && !i.ip.startsWith('169.254.') && i.ip !== '0.0.0.0';
    if (valid) {
      // still valid if the server that gave it is in our domain
      continue;
    }
    const o = dhcpDiscover(p, d.id, i.name);
    if (o) {
      i.ip = o.ip;
      i.mask = o.mask;
      d.gateway = o.gateway;
      d.dns = o.dns;
      log.push(`${d.name} got ${o.ip} from ${o.server.name}`);
    } else if (!i.ip) {
      i.ip = apipa();
      i.mask = '255.255.0.0';
      d.gateway = '0.0.0.0';
    }
  }
  return log;
}

/** Release & renew for one host. Mutates. */
export function renew(p: Project, devId: string): DhcpOffer | null {
  const d = p.devices.find((x) => x.id === devId);
  if (!d) return null;
  const i = d.ifaces.find((x) => !x.shutdown);
  if (!i) return null;
  i.ip = undefined;
  i.mask = undefined;
  const o = dhcpDiscover(p, devId, i.name);
  if (o) {
    i.ip = o.ip;
    i.mask = o.mask;
    d.gateway = o.gateway;
    d.dns = o.dns;
  } else {
    i.ip = apipa();
    i.mask = '255.255.0.0';
    d.gateway = '0.0.0.0';
  }
  return o;
}
