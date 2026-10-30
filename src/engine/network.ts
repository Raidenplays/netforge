import { broadcast, inNet, intToIp, ipToInt, isIp, network } from '../model/ip';
import type { Device, Iface, Link, Project } from '../model/types';
import { isHost } from '../model/catalog';
import { computeControlPlane, lookup, type ControlPlane } from './routing';
import { accessGroup, aclAllows, type Pkt as AclPkt } from './acl';

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
  /** routing tables, filled in on first use */
  cp?: ControlPlane;
}

const node = (dev: string, iface: string) => `${dev}::${iface}`;

const WIFI_RANGE = 520;

export const ifaceOf = (d: Device | undefined, name: string) => d?.ifaces.find((i) => i.name === name);

/** Wi-Fi clients associate with the nearest home router in range. */
export function wirelessLinks(p: Project): Link[] {
  const aps = p.devices.filter((d) => (d.kind === 'homerouter' || d.kind === 'ap') && d.powered);
  const apSsid = (ap: Device) => (ap.kind === 'ap' ? (ap.ssid ?? 'Default') : ap.home?.ssid);
  const apRadio = (ap: Device) => (ap.kind === 'ap' ? (ap.ifaces.find((i) => i.media === 'wireless')?.name ?? 'Port 1') : 'Wireless');
  const out: Link[] = [];
  for (const d of p.devices) {
    if (!d.powered || d.kind === 'homerouter' || d.kind === 'ap') continue;
    const w = d.ifaces.find((i) => i.media === 'wireless' && !i.shutdown);
    if (!w) continue;
    let best: Device | undefined;
    let bd = Infinity;
    for (const ap of aps) {
      if ((d.ssid ?? 'Default') !== apSsid(ap)) continue;
      const dist = Math.hypot(ap.x - d.x, ap.y - d.y);
      if (dist < bd && dist <= WIFI_RANGE) {
        bd = dist;
        best = ap;
      }
    }
    if (best) out.push({ id: `wifi_${d.id}`, a: { dev: d.id, iface: w.name }, b: { dev: best.id, iface: apRadio(best) }, cable: 'auto' });
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
  const allLinks = [...p.links, ...wireless];

  // VLANs: switch ports are untagged members of one VLAN, trunks carry a tagged node per VLAN
  const vlanIds = projectVlans(p);
  const trunk = trunkPorts(p, devs);
  const tagged = (d: Device, i: Iface): Map<number, string> => {
    const out = new Map<number, string>();
    if (d.kind === 'switch' && trunk.has(node(d.id, i.name))) {
      const allowed = allowedOf(i);
      const db = d.ios?.vlans?.map((v) => v.id);
      for (const v of vlanIds) if ((allowed === 'all' || allowed.includes(v)) && (!db || db.includes(v)) && v !== (i.nativeVlan ?? 1)) out.set(v, `${node(d.id, i.name)}#${v}`);
    } else if (d.kind === 'router') {
      for (const sub of d.ifaces)
        if (sub.dot1q !== undefined && !sub.shutdown && sub.name.startsWith(i.name + '.') && !sub.extra?.includes('encapsulation-native')) out.set(sub.dot1q, node(d.id, sub.name));
    }
    return out;
  };

  for (const l of allLinks) {
    const da = devs.get(l.a.dev);
    const db = devs.get(l.b.dev);
    const ia = ifaceOf(da, l.a.iface);
    const ib = ifaceOf(db, l.b.iface);
    if (!da || !db || !ia || !ib) continue;
    if (!da.powered || !db.powered || ia.shutdown || ib.shutdown) continue;
    upLinks.add(l.id);
    union(node(da.id, ia.name), node(db.id, ib.name), l.id);
    const ta = tagged(da, ia);
    const tb = tagged(db, ib);
    for (const [v, n] of ta) if (tb.has(v)) union(n, tb.get(v)!, l.id);
  }

  // bridging devices
  for (const d of p.devices) {
    if (!d.powered) continue;
    if (d.kind === 'switch') {
      const members = new Map<number, string[]>();
      const add = (v: number, n: string) => (members.get(v) ?? members.set(v, []).get(v)!).push(n);
      for (const i of d.ifaces) {
        if (i.shutdown || i.media === 'wireless') continue;
        if (i.media === 'virtual') {
          const m = i.name.match(/^Vlan(\d+)$/);
          if (m) add(Number(m[1]), node(d.id, i.name));
          continue;
        }
        const n = node(d.id, i.name);
        if (trunk.has(n)) {
          const allowed = allowedOf(i);
          const nv = i.nativeVlan ?? 1;
          if (allowed === 'all' || allowed.includes(nv)) add(nv, n);
          for (const [v, tn] of tagged(d, i)) add(v, tn);
        } else add(i.accessVlan ?? 1, n);
      }
      for (const ns of members.values()) for (let k = 1; k < ns.length; k++) union(ns[0], ns[k]);
    }
    if (d.kind === 'router') {
      // a "native" subinterface takes the parent's untagged frames
      for (const sub of d.ifaces)
        if (sub.dot1q !== undefined && !sub.shutdown && sub.extra?.includes('encapsulation-native')) union(node(d.id, sub.name), node(d.id, sub.name.split('.')[0]));
    }
    if (d.kind === 'ap') {
      const ports = d.ifaces.filter((i) => !i.shutdown);
      for (let k = 1; k < ports.length; k++) union(node(d.id, ports[0].name), node(d.id, ports[k].name));
    }
    if (d.kind === 'router') {
      // EHWIC switch-module ports (e.g. FastEthernet0/1/0) carry no IP and belong to Vlan1
      const svi = d.ifaces.find((i) => /^Vlan\d+$/.test(i.name) && !i.shutdown && i.ip);
      if (svi)
        for (const i of d.ifaces)
          if (i.media === 'copper' && !i.ip && !i.shutdown && /^\D+\d+\/\d+\/\d+$/.test(i.name)) union(node(d.id, svi.name), node(d.id, i.name));
    }
    if (d.kind === 'homerouter') {
      for (const i of d.ifaces) if (i.name !== 'Internet' && !i.shutdown) union(node(d.id, 'LAN'), node(d.id, i.name));
    }
  }

  const endpoints: Endpoint[] = [];
  const linkUp = (d: Device, i: Iface): boolean => {
    if (i.dot1q !== undefined || (d.kind === 'router' && i.name.includes('.'))) {
      const parent = ifaceOf(d, i.name.split('.')[0]);
      return !!parent && !parent.shutdown && linkUp(d, parent);
    }
    return linkUpRaw(d, i);
  };
  const linkUpRaw = (d: Device, i: Iface) =>
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

/** every VLAN id mentioned anywhere in the project */
function projectVlans(p: Project): number[] {
  const s = new Set<number>([1]);
  for (const d of p.devices) {
    for (const v of d.ios?.vlans ?? []) if (v.id < 1002) s.add(v.id);
    for (const i of d.ifaces) {
      if (i.accessVlan) s.add(i.accessVlan);
      if (i.nativeVlan) s.add(i.nativeVlan);
      if (i.dot1q !== undefined) s.add(i.dot1q);
      const m = i.name.match(/^Vlan(\d+)$/);
      if (m) s.add(Number(m[1]));
    }
  }
  return [...s].sort((a, b) => a - b);
}

function allowedOf(i: Iface): number[] | 'all' {
  if (!i.allowedVlans || i.allowedVlans === 'all') return 'all';
  if (i.allowedVlans === 'none') return [];
  const out: number[] = [];
  for (const part of i.allowedVlans.split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let v = a; v <= (b ?? a); v++) out.push(v);
  }
  return out;
}

/**
 * Switch ports that end up trunking: `switchport mode trunk`, or a port left in the default
 * dynamic mode whose neighbour is a configured trunk (DTP negotiates a trunk, as in Packet Tracer).
 */
function trunkPorts(p: Project, devs: Map<string, Device>): Set<string> {
  const out = new Set<string>();
  for (const d of p.devices) if (d.kind === 'switch') for (const i of d.ifaces) if (i.swMode === 'trunk') out.add(node(d.id, i.name));
  for (const l of p.links) {
    const da = devs.get(l.a.dev);
    const db = devs.get(l.b.dev);
    const ia = ifaceOf(da, l.a.iface);
    const ib = ifaceOf(db, l.b.iface);
    if (!da || !db || !ia || !ib || da.kind !== 'switch' || db.kind !== 'switch') continue;
    if (ia.swMode === 'trunk' && ib.swMode === undefined) out.add(node(db.id, ib.name));
    if (ib.swMode === 'trunk' && ia.swMode === undefined) out.add(node(da.id, ia.name));
  }
  return out;
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
  /** route points at an interface: on point-to-point links the far end is the next hop */
  viaIface?: boolean;
}

/** the routing tables, computed once per topology */
export function controlPlane(t: Topo): ControlPlane {
  return (t.cp ??= computeControlPlane([...t.devs.values()], t, (n) => segOf(t, n)));
}

const routes = (d: Device) => d.ios && (d.kind === 'router' || (d.kind === 'switch' && d.ios.extraPost.includes('ip routing')));

function routeLookup(t: Topo, d: Device, dst: string): Fwd | { error: string } {
  const own = t.endpoints.filter((e) => e.dev.id === d.id);
  if (!own.length) return { error: 'no IP address configured' };

  // end hosts and layer 2 switches: subnet or default gateway
  if (isHost(d) || (d.kind === 'switch' && !routes(d))) {
    const e = own[0];
    if (inNet(dst, e.ip, e.mask)) return { egress: e, nextHop: dst };
    const gw = d.kind === 'switch' ? d.ios?.defaultGateway : d.gateway;
    if (!gw || !isIp(gw) || gw === '0.0.0.0') return { error: 'no default gateway' };
    return { egress: e, nextHop: gw };
  }

  // IOS routers and layer 3 switches: the routing table
  if (routes(d)) {
    const rib = controlPlane(t).ribs.get(d.id) ?? [];
    let r = lookup(rib, dst);
    if (!r) return { error: 'no route to host' };
    let nextHop = r.via ?? dst;
    // recursive lookup when the next hop isn't directly connected
    for (let k = 0; k < 4 && r.via && !own.some((e) => inNet(r!.via!, e.ip, e.mask)); k++) {
      const via: string = r.via;
      const rr = lookup(rib, via);
      if (!rr || rr === r) return { error: 'no route to host' };
      r = rr;
      nextHop = rr.via ?? via;
    }
    const egress = r.via ? own.find((e) => inNet(nextHop, e.ip, e.mask)) : own.find((e) => e.iface.toLowerCase() === (r!.iface ?? '').toLowerCase());
    if (!egress) return { error: 'no route to host' };
    const viaIface = !r.via && r.code !== 'C' && r.code !== 'L';
    return { egress, nextHop: r.via ? nextHop : dst, viaIface };
  }

  // home routers: connected LAN/WAN plus the WAN default gateway
  for (const e of own) if (inNet(dst, e.ip, e.mask)) return { egress: e, nextHop: dst };
  const gw = d.home?.wanGateway;
  const wan = own.find((e) => e.iface === 'Internet');
  if (gw && isIp(gw) && gw !== '0.0.0.0' && wan) return { egress: wan, nextHop: gw };
  return { error: 'no route to host' };
}

/** One OSI layer as shown in the packet inspector (index 0 = Layer 1). */
export interface PduLayers {
  /** text for layers 1..7 (empty string = not used at this step) */
  layers: string[];
  /** what the device does at this step, in order */
  steps: string[];
}

export interface PduFields {
  inPort?: string;
  outPort?: string;
  srcMac?: string;
  dstMac?: string;
  vlan?: number;
  srcIp?: string;
  dstIp?: string;
  ttl?: number;
  icmpType?: number;
  arp?: { op: 'request' | 'reply'; senderIp: string; senderMac: string; targetIp: string; targetMac: string };
  nat?: { from: string; to: string; side: 'source' | 'destination' };
}

export interface SimEvent {
  kind: 'ICMP' | 'ARP' | 'DHCP' | 'NAT';
  /** device that sent / handled it ("Last Device") */
  at: string;
  /** device it arrives at ("At Device") */
  to?: string;
  info: string;
  ok: boolean;
  /** simulated time in seconds */
  time?: number;
  in?: PduLayers;
  out?: PduLayers;
  fields?: PduFields;
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

/** what the packet carries above IP, for ACL checks */
export interface L4 {
  proto: 'icmp' | 'tcp' | 'udp';
  /** client source port and server port (swapped on the way back) */
  sport?: number;
  dport?: number;
}

interface Leg {
  ok: boolean;
  reason?: string;
  /** router that answered with "Destination host unreachable" */
  unreach?: string;
  reachedDev?: Device;
  finalSrc: string;
  routersIn: { dev: Device; ip: string }[];
}

const BROADCAST = 'FFFF.FFFF.FFFF';
const blank = () => ['', '', '', '', '', '', ''];

function macOf(d: Device, iface: string) {
  if (iface === 'LAN') return d.ifaces.find((i) => i.name !== 'Internet' && i.media !== 'console')?.mac ?? '0000.0000.0000';
  return ifaceOf(d, iface)?.mac ?? d.ifaces[0]?.mac ?? '0000.0000.0000';
}

/** the physical port an endpoint sends from (subinterfaces and SVIs use their parent / a member port) */
const portName = (iface: string) => iface.split('.')[0];

interface Pkt {
  src: string;
  dst: string;
  ttl: number;
}

const icmpName = (t: number) => (t === 8 ? 'Echo Request' : 'Echo Reply');

function l3Layers(pkt: Pkt, icmp: number, l1: string, l2: string): string[] {
  const L = blank();
  L[0] = l1;
  L[1] = l2;
  // like Packet Tracer, ICMP is shown with the IP header at layer 3
  L[2] = `IP Header Src. IP: ${pkt.src}, Dest. IP: ${pkt.dst}, TTL: ${pkt.ttl} · ICMP Message Type: ${icmp} (${icmpName(icmp)})`;
  return L;
}

/** ports a frame crosses at each switch / AP / home-router bridge along a layer 2 path */
function bridgeSteps(t: Topo, path: { links: string[]; devs: string[] }) {
  const links = path.links.map((id) => [...t.links, ...t.wireless].find((l) => l.id === id)).filter((l): l is Link => !!l);
  const out: { dev: Device; inPort: string; outPort: string }[] = [];
  for (let k = 0; k + 1 < links.length; k++) {
    const a = links[k];
    const b = links[k + 1];
    const shared = [a.a.dev, a.b.dev].find((d) => d === b.a.dev || d === b.b.dev);
    const dev = shared ? t.devs.get(shared) : undefined;
    if (!dev) continue;
    const inPort = a.a.dev === shared ? a.a.iface : a.b.iface;
    const outPort = b.a.dev === shared ? b.a.iface : b.b.iface;
    out.push({ dev, inPort, outPort });
  }
  return out;
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
  l4: L4 = { proto: 'icmp' },
  count = false,
): Leg {
  let cur = start;
  let ingress: Endpoint | undefined;
  const ttl0 = isHost(start) ? 128 : 255;
  let pkt: Pkt = { src, dst, ttl: ttl0 };
  const icmp = reply ? 0 : 8;
  const routersIn: { dev: Device; ip: string }[] = [];
  /** the event for the packet's arrival at `cur`, so its "out" side can be filled in */
  let arrival: SimEvent | undefined;

  for (let guard = 30; guard > 0; guard--) {
    const outSteps: string[] = [];
    if (!arrival) {
      // the packet's first appearance: an event at the source with only an outbound side
      arrival = { kind: 'ICMP', at: '--', to: cur.name, info: `${icmpName(icmp)} created`, ok: true, fields: { srcIp: pkt.src, dstIp: pkt.dst, ttl: pkt.ttl, icmpType: icmp } };
      events.push(arrival);
    }
    // NAT un-translation on the way back
    const back = nat.find((n) => n.dev === cur.id && n.outside === pkt.dst && reply);
    if (back) {
      events.push({
        kind: 'NAT',
        at: cur.name,
        info: `Translate ${pkt.dst} → ${back.inside}`,
        ok: true,
        fields: { nat: { from: pkt.dst, to: back.inside, side: 'destination' }, srcIp: pkt.src, dstIp: back.inside },
      });
      outSteps.push(`NAT finds a translation for ${pkt.dst} and changes the destination address to ${back.inside}.`);
      pkt = { ...pkt, dst: back.inside };
    }
    // inbound access list on the interface the packet arrived on
    const aclPkt = (): AclPkt => ({
      src: pkt.src,
      dst: pkt.dst,
      proto: l4.proto,
      sport: reply ? l4.dport : l4.sport,
      dport: reply ? l4.sport : l4.dport,
      icmpType: l4.proto === 'icmp' ? icmp : undefined,
    });
    const aclIn = cur !== start && ingress && cur.ios ? accessGroup(cur, ingress.iface, 'in') : undefined;
    if (aclIn && ingress) {
      const r = aclAllows(cur, aclIn, aclPkt(), count);
      if (!r.ok) {
        events.push({ kind: 'ICMP', at: cur.name, info: `Denied by access list ${aclIn} in on ${ingress.iface}`, ok: false });
        arrival.out = { layers: blank(), steps: [`Access list ${aclIn} is applied inbound on ${ingress.iface} and ${r.ace ? `entry "${r.ace.text}" denies` : 'the implicit deny at the end drops'} the packet.`, 'The router sends back an ICMP Destination Unreachable (administratively prohibited).'] };
        return { ok: false, reason: `Destination host unreachable (${cur.name})`, unreach: ingress.ip, finalSrc: pkt.src, routersIn };
      }
    }
    if (t.endpoints.some((e) => e.dev.id === cur.id && e.ip === pkt.dst)) {
      if (arrival?.in) arrival.in.steps.push(reply ? 'The ICMP process receives the Echo Reply. The ping is complete.' : 'The packet is addressed to this device, so it is processed here.');
      return { ok: true, reachedDev: cur, finalSrc: pkt.src, routersIn };
    }

    const f = routeLookup(t, cur, pkt.dst);
    if ('error' in f) {
      events.push({
        kind: 'ICMP',
        at: cur.name,
        info: `Dropped: ${f.error}`,
        ok: false,
      });
      arrival.out = { layers: blank(), steps: [...outSteps, `The device drops the packet: ${f.error}.`] };
      return { ok: false, reason: cur === start ? f.error : `Destination host unreachable (${cur.name})`, unreach: cur === start ? undefined : ingress?.ip, finalSrc: pkt.src, routersIn };
    }

    // outbound access list (not applied to traffic the router creates itself)
    const aclOut = cur !== start && cur.ios ? accessGroup(cur, f.egress.iface, 'out') : undefined;
    if (aclOut) {
      const r = aclAllows(cur, aclOut, aclPkt(), count);
      if (!r.ok) {
        events.push({ kind: 'ICMP', at: cur.name, info: `Denied by access list ${aclOut} out on ${f.egress.iface}`, ok: false });
        arrival.out = { layers: blank(), steps: [`Access list ${aclOut} is applied outbound on ${f.egress.iface} and ${r.ace ? `entry "${r.ace.text}" denies` : 'the implicit deny at the end drops'} the packet.`, 'The router sends back an ICMP Destination Unreachable (administratively prohibited).'] };
        return { ok: false, reason: `Destination host unreachable (${cur.name})`, unreach: ingress?.ip, finalSrc: pkt.src, routersIn };
      }
    }

    // routers decrement TTL when they forward
    if (cur !== start) {
      pkt = { ...pkt, ttl: pkt.ttl - 1 };
      outSteps.push(
        `The device looks up ${pkt.dst} in its routing table and forwards out ${f.egress.iface}${f.nextHop !== pkt.dst ? ` towards ${f.nextHop}` : ''}.`,
        `The TTL is decremented to ${pkt.ttl}.`,
      );
      if (pkt.ttl <= 0) {
        events.push({ kind: 'ICMP', at: cur.name, info: 'TTL expired in transit', ok: false });
        return { ok: false, reason: 'TTL expired in transit.', finalSrc: pkt.src, routersIn };
      }
    } else {
      outSteps.push(
        reply ? `The device creates an ICMP Echo Reply to ${pkt.dst}.` : `The ping process creates an ICMP Echo Request to ${pkt.dst}.`,
        f.nextHop === pkt.dst ? `${pkt.dst} is on a local network, so the packet goes straight to it.` : `${pkt.dst} is on another network, so the packet goes to the next hop ${f.nextHop}.`,
      );
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
        events.push({
          kind: 'NAT',
          at: cur.name,
          info: `Translate ${pkt.src} → ${outside}`,
          ok: true,
          fields: { nat: { from: pkt.src, to: outside, side: 'source' }, srcIp: outside, dstIp: pkt.dst },
        });
        outSteps.push(`NAT translates the inside source address ${pkt.src} to ${outside}.`);
        pkt = { ...pkt, src: outside };
      }
    }

    const seg = segOf(t, f.egress.node);
    let target = t.endpoints.find((e) => e.ip === f.nextHop && segOf(t, e.node) === seg && e.dev.id !== cur.id);
    if (!target && f.viaIface) {
      const peers = t.endpoints.filter((e) => segOf(t, e.node) === seg && e.dev.id !== cur.id);
      if (peers.length === 1) target = peers[0];
    }
    const myMac = macOf(cur, f.egress.iface);
    const arpKey = `${seg}|${f.nextHop}`;
    if (!arp.has(arpKey)) {
      arp.add(arpKey);
      // the target learns the sender's MAC from the request, so it won't need to ARP back
      arp.add(`${seg}|${f.egress.ip}`);
      outSteps.push(`The next-hop address ${f.nextHop} is not in the ARP table, so the device sends an ARP request first.`);
      const L = blank();
      L[0] = `Port ${portName(f.egress.iface)}`;
      L[1] = `Ethernet II Header ${myMac} >> ${BROADCAST}`;
      L[2] = `ARP Packet Src. IP: ${f.egress.ip}, Dest. IP: ${f.nextHop}`;
      events.push({
        kind: 'ARP',
        at: cur.name,
        to: target?.dev.name,
        info: target ? `Who has ${f.nextHop}? ${target.dev.name} replies` : `Who has ${f.nextHop}? No reply`,
        ok: !!target,
        out: {
          layers: L,
          steps: [
            `The device needs the MAC address of ${f.nextHop}.`,
            `It broadcasts an ARP request out ${portName(f.egress.iface)}: "Who has ${f.nextHop}? Tell ${f.egress.ip}".`,
            target ? `${target.dev.name} owns ${f.nextHop} and answers with its MAC address ${macOf(target.dev, target.iface)}.` : 'Nobody answers, so the packet can\'t be sent.',
          ],
        },
        fields: {
          outPort: portName(f.egress.iface),
          srcMac: myMac,
          dstMac: BROADCAST,
          arp: { op: 'request', senderIp: f.egress.ip, senderMac: myMac, targetIp: f.nextHop, targetMac: target ? macOf(target.dev, target.iface) : '0000.0000.0000' },
        },
      });
    }
    if (!target) {
      hops.push({ links: [], devs: [cur.id], kind: 'ARP', reply, fail: true, ev: events.length - 1 });
      arrival.out = { layers: blank(), steps: [...outSteps, 'The ARP request times out and the packet is dropped.'] };
      return { ok: false, reason: 'Request timed out.', finalSrc: pkt.src, routersIn };
    }
    const dstMac = macOf(target.dev, target.iface);
    const outL = l3Layers(pkt, icmp, `Port(s): ${portName(f.egress.iface)}`, `Ethernet II Header ${myMac} >> ${dstMac}`);
    arrival.out = { layers: outL, steps: [...outSteps, `The device sends the frame out ${portName(f.egress.iface)}.`] };

    const path = l2Path(t, f.egress.node, target.node);
    // frames cross switches (and other bridges) on the way: one event each, layer 2 only
    const firstEv = events.length;
    for (const b of path ? bridgeSteps(t, path) : []) {
      if (b.dev.kind !== 'switch' && b.dev.kind !== 'ap' && b.dev.kind !== 'homerouter') continue;
      const inI = ifaceOf(b.dev, b.inPort);
      const outI = ifaceOf(b.dev, b.outPort);
      const vlanIn = inI?.swMode === 'trunk' ? undefined : inI?.accessVlan ?? 1;
      const L2 = `Ethernet II Header ${myMac} >> ${dstMac}`;
      const inL = l3Layers(pkt, icmp, `Port ${b.inPort}`, L2);
      const outL2 = l3Layers(pkt, icmp, `Port(s): ${b.outPort}`, outI?.swMode === 'trunk' ? `Dot1q Header ${myMac} >> ${dstMac} (VLAN tag)` : L2);
      for (const L of [inL, outL2]) for (let k = 2; k < 7; k++) L[k] = '';
      events.push({
        kind: 'ICMP',
        at: events.length > firstEv ? events[events.length - 1].to! : cur.name,
        to: b.dev.name,
        info: `${icmpName(icmp)} ${pkt.src} → ${pkt.dst}`,
        ok: true,
        in: { layers: inL, steps: [`${b.inPort} receives the frame.`, ...(vlanIn ? [`The port is an access port in VLAN ${vlanIn}.`] : ['The port is a trunk; the frame keeps its 802.1Q VLAN tag.'])] },
        out: {
          layers: outL2,
          steps: [
            `The switch looks up ${dstMac} in its MAC address table.`,
            `It forwards the frame out ${b.outPort}${outI?.swMode === 'trunk' ? ', a trunk, with an 802.1Q tag' : ''}.`,
          ],
        },
        fields: { inPort: b.inPort, outPort: b.outPort, srcMac: myMac, dstMac, vlan: vlanIn, srcIp: pkt.src, dstIp: pkt.dst, ttl: pkt.ttl, icmpType: icmp },
      });
    }
    const lastDev = events.length > firstEv ? events[events.length - 1].to! : cur.name;
    hops.push({ links: path?.links ?? [], devs: path?.devs ?? [cur.id, target.dev.id], kind: 'ICMP', reply, ev: events.length });
    const inPort = portName(target.iface === 'LAN' ? (path ? lastPortOn(t, path, target.dev.id) ?? 'LAN' : 'LAN') : target.iface);
    arrival = {
      kind: 'ICMP',
      at: lastDev,
      to: target.dev.name,
      info: `${icmpName(icmp)} ${pkt.src} → ${pkt.dst}`,
      ok: true,
      in: {
        layers: l3Layers(pkt, icmp, `Port ${inPort}`, `Ethernet II Header ${myMac} >> ${dstMac}`),
        steps: [`${inPort} receives the frame.`, `The frame's destination MAC ${dstMac} matches the receiving port, so the device takes the packet out of the frame.`],
      },
      fields: { inPort, srcMac: myMac, dstMac, srcIp: pkt.src, dstIp: pkt.dst, ttl: pkt.ttl, icmpType: icmp },
    };
    events.push(arrival);
    if (!isHost(target.dev) && target.dev.kind !== 'switch') routersIn.push({ dev: target.dev, ip: target.ip });
    ingress = target;
    cur = target.dev;
  }
  events.push({ kind: 'ICMP', at: cur.name, info: 'TTL expired in transit', ok: false });
  return { ok: false, reason: 'TTL expired in transit.', finalSrc: pkt.src, routersIn };
}

/** simulated time: one millisecond per event, as in Packet Tracer's event list */
function stamp(events: SimEvent[]) {
  events.forEach((e, i) => (e.time = i / 1000));
}

function lastPortOn(t: Topo, path: { links: string[] }, dev: string) {
  const id = path.links[path.links.length - 1];
  const l = [...t.links, ...t.wireless].find((x) => x.id === id);
  if (!l) return undefined;
  return l.a.dev === dev ? l.a.iface : l.b.dev === dev ? l.b.iface : undefined;
}

export interface PingResult {
  ok: boolean;
  reason?: string;
  /** address of the router that sent "Destination host unreachable" */
  unreachFrom?: string;
  srcIp?: string;
  hops: Hop[];
  events: SimEvent[];
  routers: { name: string; ip: string }[];
}

export interface PingOpts {
  /** the transport the "ping" really is (HTTP, DNS, Telnet…) for ACL checks */
  l4?: L4;
  /** count ACL hits (user-visible traffic only) */
  count?: boolean;
}

export function ping(p: Project, srcId: string, dst: string, opts: PingOpts = {}): PingResult {
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
  const l4 = opts.l4 ?? { proto: 'icmp' as const };
  const there = forward(t, src, srcEp.ip, dst, false, nat, hops, events, arp, l4, opts.count);
  stamp(events);
  if (!there.ok || !there.reachedDev)
    return { ok: false, reason: there.reason, unreachFrom: there.unreach, srcIp: srcEp.ip, hops, events, routers: there.routersIn.map((r) => ({ name: r.dev.name, ip: r.ip })) };
  const back = forward(t, there.reachedDev, dst, there.finalSrc, true, nat, hops, events, arp, l4, opts.count);
  stamp(events);
  return {
    ok: back.ok,
    reason: back.ok ? undefined : back.unreach ? back.reason : 'Request timed out.',
    unreachFrom: back.unreach,
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

  const fromServer = (srv: Device, subnetIp: string): DhcpOffer | null => {
    const svc = srv.dhcpService;
    if (!svc?.enabled) return null;
    const pool = svc.pools.find((pl) => isIp(pl.network) && inNet(subnetIp, pl.network, pl.mask));
    if (!pool) return null;
    const offer = (ip: string) => ({ ip, mask: pool.mask, gateway: pool.router, dns: pool.dns, server: srv });
    const existing = svc.leases.find((l) => l.mac === mac && !used.has(l.ip) && inNet(l.ip, pool.network, pool.mask));
    if (existing) return offer(existing.ip);
    const start = ipToInt(pool.start) ?? network(pool.network, pool.mask) + 1;
    for (let k = 0; k < pool.max; k++) {
      const ip = intToIp(start + k);
      if (!inNet(ip, pool.network, pool.mask)) break;
      if (used.has(ip) || svc.leases.some((l) => l.ip === ip)) continue;
      svc.leases.push({ ip, mac });
      return offer(ip);
    }
    return null;
  };

  for (const e of t.endpoints) {
    if (segOf(t, e.node) !== seg || e.dev.id === clientId) continue;
    const s = e.dev;
    if (s.dhcpService) {
      const o = fromServer(s, e.ip);
      if (o) return o;
    }
    // DHCP relay: ip helper-address on the router interface facing the client
    const helper = ifaceOf(s, e.iface)?.extra?.map((x) => x.match(/^ip helper-address (\S+)/)?.[1]).find(Boolean);
    if (helper && s.ios) {
      const target = t.endpoints.find((x) => x.ip === helper);
      if (target && ping(p, s.id, helper).ok) {
        const o = target.dev.dhcpService ? fromServer(target.dev, e.ip) : null;
        if (o) return o;
      }
    }
    if (s.kind === 'homerouter' && s.home?.dhcpEnabled && e.iface === 'LAN') {
      const h = s.home;
      const base = network(h.lanIp, h.lanMask);
      const existing = h.leases.find((l) => l.mac === mac && !used.has(l.ip));
      if (existing) return { ip: existing.ip, mask: h.lanMask, gateway: h.lanIp, dns: h.dns || h.lanIp, server: s };
      for (let k = 0; k < h.maxUsers; k++) {
        const ip = intToIp(base + h.startHost + k);
        if (!used.has(ip) && !h.leases.some((l) => l.ip === ip)) {
          h.leases.push({ ip, mac });
          return { ip, mask: h.lanMask, gateway: h.lanIp, dns: h.dns || h.lanIp, server: s };
        }
      }
    }
    if (s.ios) {
      const pool = s.ios.pools.find((pl) => pl.network && pl.mask && inNet(e.ip, pl.network, pl.mask));
      if (!pool || !pool.network || !pool.mask) continue;
      const existing = s.ios.leases.find((l) => l.mac === mac && !used.has(l.ip) && inNet(l.ip, pool.network!, pool.mask!));
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
