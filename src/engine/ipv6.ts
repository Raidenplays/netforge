/**
 * IPv6: addresses on hosts and IOS interfaces, SLAAC and DHCPv6, the IPv6 routing table, and
 * ICMPv6 pings with Neighbor Discovery.
 */
import { isHost } from '../model/catalog';
import { bigToV6, inV6, isLinkLocal, isV6, linkLocal, normV6, slaac, splitPrefix, v6Prefix, v6ToBig } from '../model/ip6';
import type { Device, Iface, Project } from '../model/types';
import { buildTopo, ifaceStatus, l2Path, segOf, type Hop, type PingResult, type SimEvent, type Topo } from './network';

export interface V6Addr {
  addr: string;
  len: number;
}

export interface V6Info {
  enabled: boolean;
  ll?: string;
  globals: V6Addr[];
}

const iosLines = (i: Iface) => i.extra ?? [];

/** IPv6 addresses an interface has right now */
export function v6Of(d: Device, i: Iface): V6Info {
  if (i.media === 'wireless' && !isHost(d)) return { enabled: false, globals: [] };
  if (d.ios) {
    const lines = iosLines(i);
    const globals: V6Addr[] = [];
    let ll: string | undefined;
    for (const l of lines) {
      let m: RegExpMatchArray | null;
      if ((m = l.match(/^ipv6 address (\S+) link-local$/))) ll = normV6(m[1]);
      else if ((m = l.match(/^ipv6 address (\S+)\/(\d+) eui-64$/))) globals.push({ addr: slaac(m[1], i.mac), len: Number(m[2]) });
      else if ((m = l.match(/^ipv6 address (\S+)\/(\d+)$/))) {
        const sp = splitPrefix(`${m[1]}/${m[2]}`);
        if (sp) globals.push({ addr: sp[0], len: sp[1] });
      }
    }
    // addresses learned with "ipv6 address autoconfig" / "dhcp"
    for (const a of i.v6 ?? []) globals.push(a);
    const enabled = globals.length > 0 || !!ll || lines.some((l) => l === 'ipv6 enable' || l.startsWith('ipv6 address'));
    return { enabled, ll: enabled ? (ll ?? linkLocal(i.mac)) : undefined, globals };
  }
  if (!isHost(d)) return { enabled: false, globals: [] };
  return { enabled: true, ll: i.v6ll ?? linkLocal(i.mac), globals: i.v6 ?? [] };
}

export const v6Routing = (d: Device) => !!d.ios?.extraPre.includes('ipv6 unicast-routing') || !!d.ios?.extraPost.includes('ipv6 unicast-routing');

export interface Endpoint6 {
  dev: Device;
  iface: string;
  ll: string;
  globals: V6Addr[];
  node: string;
}

/** every IPv6-enabled interface that is up */
export function endpoints6(p: Project, t: Topo): Endpoint6[] {
  const out: Endpoint6[] = [];
  for (const d of p.devices) {
    if (!d.powered) continue;
    for (const i of d.ifaces) {
      if (i.shutdown || i.media === 'console') continue;
      const v = v6Of(d, i);
      if (!v.enabled || !v.ll) continue;
      if (i.media !== 'virtual' && !ifaceStatus(p, t, d, i).line) continue;
      out.push({ dev: d, iface: i.name, ll: v.ll, globals: v.globals, node: `${d.id}::${i.name}` });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  SLAAC and DHCPv6                                                   */
/* ------------------------------------------------------------------ */

interface RaInfo {
  router: Endpoint6;
  prefix: V6Addr;
  managed: boolean;
  other: boolean;
  dns?: string;
  pool?: { prefix?: string; len?: number; dns?: string };
}

function dhcpv6Pool(d: Device, name: string) {
  const lines = d.ios?.extraPre ?? [];
  const at = lines.indexOf(`ipv6 dhcp pool ${name}`);
  if (at < 0) return undefined;
  const out: { prefix?: string; len?: number; dns?: string } = {};
  for (let k = at + 1; k < lines.length && lines[k].startsWith(' '); k++) {
    const l = lines[k].trim();
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^address prefix (\S+)\/(\d+)/))) [out.prefix, out.len] = [m[1], Number(m[2])];
    else if ((m = l.match(/^dns-server (\S+)/))) out.dns = normV6(m[1]);
  }
  return out;
}

/** router advertisement a host on `node` would hear */
function raFor(t: Topo, eps: Endpoint6[], node: string): RaInfo | undefined {
  const seg = segOf(t, node);
  for (const e of eps) {
    if (!e.dev.ios || !v6Routing(e.dev) || segOf(t, e.node) !== seg) continue;
    const i = e.dev.ifaces.find((x) => x.name === e.iface)!;
    if (iosLines(i).includes('ipv6 nd ra suppress') || iosLines(i).includes('ipv6 nd ra suppress all')) continue;
    const prefix = e.globals.find((g) => g.len === 64 && !(i.v6 ?? []).includes(g));
    if (!prefix) continue;
    const poolName = iosLines(i).find((l) => l.startsWith('ipv6 dhcp server '))?.split(' ')[3];
    return {
      router: e,
      prefix,
      managed: iosLines(i).includes('ipv6 nd managed-config-flag'),
      other: iosLines(i).includes('ipv6 nd other-config-flag'),
      dns: iosLines(i).find((l) => l.startsWith('ipv6 nd ra dns server '))?.split(' ')[5],
      pool: poolName ? dhcpv6Pool(e.dev, poolName) : undefined,
    };
  }
  return undefined;
}

/** Give auto-configured hosts (and IOS interfaces) their IPv6 addresses. Mutates. */
export function settleV6(p: Project) {
  const t = buildTopo(p);
  const eps = endpoints6(p, t);
  const leased = new Map<string, number>();
  for (const d of p.devices) {
    if (!d.powered) continue;
    if (isHost(d)) {
      if (d.v6Mode !== 'auto' && d.v6Mode !== 'dhcp') continue;
      const i = d.ifaces.find((x) => !x.shutdown && x.media !== 'console');
      if (!i) continue;
      const ra = raFor(t, eps, `${d.id}::${i.name}`);
      if (!ra) {
        i.v6 = [];
        d.gateway6 = '';
        continue;
      }
      d.gateway6 = ra.router.ll;
      if (d.v6Mode === 'dhcp' && ra.managed && ra.pool?.prefix) {
        const base = v6ToBig(v6Prefix(ra.pool.prefix, ra.pool.len ?? 64)) ?? 0n;
        const key = `${ra.router.dev.id}|${ra.router.iface}`;
        const n = (leased.get(key) ?? 0) + 1;
        leased.set(key, n);
        i.v6 = [{ addr: bigToV6(base + BigInt(0x10 + n)), len: 128 }];
      } else i.v6 = [{ addr: slaac(ra.prefix.addr, i.mac), len: 64 }];
      d.dns6 = ra.pool?.dns ?? ra.dns ?? d.dns6 ?? '';
    } else if (d.ios) {
      for (const i of d.ifaces) {
        if (!iosLines(i).includes('ipv6 address autoconfig')) {
          if (i.v6?.length) i.v6 = undefined;
          continue;
        }
        const ra = raFor(t, eps.filter((e) => e.dev.id !== d.id), `${d.id}::${i.name}`);
        i.v6 = ra ? [{ addr: slaac(ra.prefix.addr, i.mac), len: 64 }] : undefined;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  IPv6 routing table                                                 */
/* ------------------------------------------------------------------ */

export interface Route6 {
  code: 'C' | 'L' | 'S';
  prefix: string;
  len: number;
  ad: number;
  via?: string;
  iface?: string;
}

export function rib6(p: Project, t: Topo, d: Device): Route6[] {
  const out: Route6[] = [];
  for (const e of endpoints6(p, t).filter((x) => x.dev.id === d.id)) {
    for (const g of e.globals) {
      out.push({ code: 'C', prefix: v6Prefix(g.addr, g.len), len: g.len, ad: 0, iface: e.iface });
      out.push({ code: 'L', prefix: g.addr, len: 128, ad: 0, iface: e.iface });
    }
  }
  for (const l of [...(d.ios?.extraPost ?? []), ...(d.ios?.extraPre ?? [])]) {
    const m = l.match(/^ipv6 route (\S+) (\S+)(?: (\S+))?(?: (\d+))?$/);
    if (!m) continue;
    const sp = splitPrefix(m[1]);
    if (!sp) continue;
    const viaIsAddr = isV6(m[2]);
    const via = viaIsAddr ? normV6(m[2]) : m[3] && isV6(m[3]) ? normV6(m[3]) : undefined;
    const iface = viaIsAddr ? undefined : m[2];
    out.push({ code: 'S', prefix: sp[0], len: sp[1], ad: m[4] ? Number(m[4]) : 1, via, iface });
  }
  return out;
}

function lookup6(routes: Route6[], dst: string) {
  let best: Route6 | undefined;
  for (const r of routes) if (inV6(dst, r.prefix, r.len) && (!best || r.len > best.len || (r.len === best.len && r.ad < best.ad))) best = r;
  return best;
}

export function showIpv6Route(p: Project, d: Device) {
  const t = buildTopo(p);
  const rs = rib6(p, t, d);
  const out = [
    `IPv6 Routing Table - ${rs.length} entries`,
    'Codes: C - Connected, L - Local, S - Static, R - RIP, B - BGP',
    '       U - Per-user Static route, M - MIPv6',
    '       I1 - ISIS L1, I2 - ISIS L2, IA - ISIS interarea, IS - ISIS summary',
    '       O - OSPF intra, OI - OSPF inter, OE1 - OSPF ext 1, OE2 - OSPF ext 2',
    '       ON1 - OSPF NSSA ext 1, ON2 - OSPF NSSA ext 2',
    '       D - EIGRP, EX - EIGRP external',
  ];
  for (const r of rs) {
    out.push(`${r.code.padEnd(3)}${r.prefix}/${r.len} [${r.ad}/0]`);
    out.push(r.code === 'S' ? `     via ${r.via ?? r.iface}${r.via && r.iface ? `, ${r.iface}` : ''}` : `     via ${r.iface}, ${r.code === 'L' ? 'receive' : 'directly connected'}`);
  }
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/*  ICMPv6 ping                                                        */
/* ------------------------------------------------------------------ */

const owns = (e: Endpoint6, a: string) => e.ll === a || e.globals.some((g) => g.addr === a);

function source6(e: Endpoint6, dst: string) {
  if (isLinkLocal(dst)) return e.ll;
  return e.globals.find((g) => inV6(dst, g.addr, g.len))?.addr ?? e.globals[0]?.addr ?? e.ll;
}

export function ping6(p: Project, srcId: string, rawDst: string): PingResult {
  const dst = normV6(rawDst);
  const t = buildTopo(p);
  const eps = endpoints6(p, t);
  const events: SimEvent[] = [];
  const hops: Hop[] = [];
  const routers: { name: string; ip: string }[] = [];
  const src = p.devices.find((d) => d.id === srcId);
  const fail = (reason: string, unreachFrom?: string): PingResult => ({ ok: false, reason, unreachFrom, hops, events, routers });
  if (!src) return fail('unknown device');
  const mine = eps.filter((e) => e.dev.id === srcId);
  if (!mine.length) return fail('IPv6 is not enabled on this device.');

  const leg = (from: Device, a: string, b: string, reply: boolean): { ok: boolean; at?: Device; reason?: string; unreach?: string } => {
    let cur = from;
    let ttl = 128;
    const own = (d: Device) => eps.filter((e) => e.dev.id === d.id);
    let first = true;
    for (let guard = 0; guard < 30; guard++) {
      if (own(cur).some((e) => owns(e, b))) return { ok: true, at: cur };
      const ce = own(cur);
      let egress: Endpoint6 | undefined;
      let next = b;
      if (isLinkLocal(b)) egress = ce[0];
      else if (cur.ios) {
        if (!first && !v6Routing(cur)) return { ok: false, reason: 'Destination host unreachable', unreach: ce[0]?.globals[0]?.addr ?? ce[0]?.ll };
        const r = lookup6(rib6(p, t, cur), b);
        if (!r) return { ok: false, reason: first ? 'no route' : 'Destination host unreachable', unreach: first ? undefined : ce[0]?.globals[0]?.addr };
        egress = ce.find((e) => e.iface === (r.iface ?? ce.find((x) => x.globals.some((g) => r.via && inV6(r.via, g.addr, g.len)))?.iface ?? (r.via && isLinkLocal(r.via) ? ce[0].iface : undefined)));
        if (r.via) next = r.via;
      } else {
        const onLink = ce.find((e) => e.globals.some((g) => inV6(b, g.addr, g.len)));
        egress = onLink ?? ce[0];
        if (!onLink) {
          if (!cur.gateway6 || !isV6(cur.gateway6)) return { ok: false, reason: 'no default gateway' };
          next = normV6(cur.gateway6);
        }
      }
      if (!egress) return { ok: false, reason: 'no route' };
      if (!first) ttl--;
      const seg = segOf(t, egress.node);
      const target = eps.find((e) => e.dev.id !== cur.id && segOf(t, e.node) === seg && owns(e, next));
      events.push({
        kind: 'NDP',
        at: cur.name,
        to: target?.dev.name,
        info: target ? `Neighbor Solicitation for ${next}, ${target.dev.name} answers` : `Neighbor Solicitation for ${next}, no answer`,
        ok: !!target,
      });
      if (!target) {
        hops.push({ links: [], devs: [cur.id], kind: 'ARP', reply, fail: true, ev: events.length - 1 });
        return { ok: false, reason: 'Request timed out.' };
      }
      const path = l2Path(t, egress.node, target.node);
      hops.push({ links: path?.links ?? [], devs: path?.devs ?? [cur.id, target.dev.id], kind: 'ICMP', reply, ev: events.length });
      const L = ['', '', '', '', '', '', ''];
      L[0] = `Port ${target.iface}`;
      L[1] = `Ethernet II Header ${cur.ifaces.find((i) => i.name === egress!.iface)?.mac} >> ${target.dev.ifaces.find((i) => i.name === target.iface)?.mac}`;
      L[2] = `IPv6 Header Src. IP: ${a}, Dest. IP: ${b}, Hop Limit: ${ttl} · ICMPv6 ${reply ? 'Echo Reply (129)' : 'Echo Request (128)'}`;
      events.push({
        kind: 'ICMP',
        at: cur.name,
        to: target.dev.name,
        info: `ICMPv6 ${reply ? 'Echo Reply' : 'Echo Request'} ${a} → ${b}`,
        ok: true,
        in: { layers: L, steps: [`${target.iface} receives the frame.`, `The packet's destination is ${b}.`] },
      });
      if (!isHost(target.dev) && target.dev.kind !== 'switch') routers.push({ name: target.dev.name, ip: target.globals[0]?.addr ?? target.ll });
      cur = target.dev;
      first = false;
    }
    return { ok: false, reason: 'Hop limit exceeded' };
  };

  const se = mine.find((e) => e.globals.length) ?? mine[0];
  const srcIp = source6(se, dst);
  const there = leg(src, srcIp, dst, false);
  if (!there.ok || !there.at) return { ...fail(there.reason ?? 'failed', there.unreach), srcIp };
  const nFwd = routers.length;
  const back = leg(there.at, dst, srcIp, true);
  events.forEach((e, i) => (e.time = i / 1000));
  return { ok: back.ok, reason: back.ok ? undefined : 'Request timed out.', srcIp, hops, events, routers: routers.slice(0, nFwd) };
}
