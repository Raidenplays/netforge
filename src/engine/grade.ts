/**
 * Estimate a .pka activity score by checking the assessment items stored in the
 * file against the current network. Only results are reported (item path +
 * pass/fail), never the expected values, the same as Packet Tracer's
 * "Check Results".
 */
import { intToIp, ipToInt, network } from '../model/ip';
import type { ActivityVar, Device, GradeItem, Project } from '../model/types';
import { buildTopo } from './network';
import { deviceXml, portXml, xmlText } from '../io/pkt';
import { linkLocal } from '../model/ip6';

export type Verdict = 'pass' | 'fail' | 'unchecked';

export interface GradeResult {
  item: GradeItem;
  verdict: Verdict;
  /** short label shown in the list */
  label: string;
}

export interface GradeReport {
  results: GradeResult[];
  earned: number;
  checkable: number;
  total: number;
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

function cableBetween(p: Project, a: Device, aPort: string, bName: string) {
  const b = p.devices.find((d) => d.name === bName);
  if (!b) return undefined;
  const same = (x: string, y: string) => norm(x).replace(/\s/g, '') === norm(y).replace(/\s/g, '');
  return p.links.find(
    (l) => (l.a.dev === a.id && same(l.a.iface, aPort) && l.b.dev === b.id) || (l.b.dev === a.id && same(l.b.iface, aPort) && l.a.dev === b.id),
  );
}

function linkBetween(p: Project, a: Device, aPort: string, bName: string, bPort?: string) {
  const b = p.devices.find((d) => d.name === bName);
  if (!b) return false;
  const same = (x: string, y: string) => norm(x).replace(/\s/g, '') === norm(y).replace(/\s/g, '');
  return p.links.some(
    (l) =>
      (l.a.dev === a.id && same(l.a.iface, aPort) && l.b.dev === b.id && (!bPort || same(l.b.iface, bPort))) ||
      (l.b.dev === a.id && same(l.b.iface, aPort) && l.a.dev === b.id && (!bPort || same(l.a.iface, bPort))),
  );
}

/** Value NetForge has for this path, or undefined if NetForge doesn't model it. */
function actual(p: Project, d: Device, rest: string[], raw = false): string | undefined | { link: boolean } {
  const [a, b, c, e] = rest;
  const h = d.home;
  if (rest.length === 1) {
    if (a === 'Device Model') return d.model;
    if (a === 'Power') return d.powered ? '1' : '0';
    if (a === 'Default Gateway') return h ? h.wanGateway : d.ios ? d.ios.defaultGateway : d.gateway;
    if (a === 'DNS Server IP') return h ? h.dns : d.dns;
    if (a === 'Host Name' || a === 'Hostname') return d.ios?.hostname ?? d.name;
    return undefined;
  }
  if (a === 'Ports' && b) {
    const iface = d.ifaces.find((i) => norm(i.name).replace(/\s/g, '') === norm(b).replace(/\s/g, ''));
    if (c === undefined) return iface ? '' : undefined;
    if (c.startsWith('Link to ')) {
      const peer = c.slice('Link to '.length);
      if (e === undefined) return { link: linkBetween(p, d, b, peer) };
      if (e.startsWith('Connects to')) return { link: false }; // resolved by caller with expected port
      if (e === 'Type') {
        // Packet Tracer's cable codes: "0 0" copper straight-through, "0 1" copper crossover, "1" fiber
        const l = cableBetween(p, d, b, peer);
        if (!l) return 'none';
        if (l.cable === 'fiber') return '1';
        if (l.cable === 'straight' || l.cable === 'cross' || l.cable === 'auto') return `0 ${l.cable === 'cross' ? 1 : 0}`;
      }
      return undefined;
    }
    if (!iface) return undefined;
    const wan = h && iface.name === 'Internet';
    // addresses handed out by DHCP depend on lease order; Packet Tracer grades them with variables
    if ((c === 'IP Address' || c === 'Subnet Mask') && (d.dhcpClient || (wan && h!.wanMode === 'dhcp')) && !raw) return undefined;
    if (c === 'IP Address') return wan ? h!.wanIp : (iface.ip ?? '');
    if (c === 'Subnet Mask') return wan ? h!.wanMask : (iface.mask ?? '');
    if (c === 'Port Status' || c === 'Port Up') return iface.shutdown ? '0' : '1';
    if (c === 'IPv6 Auto Config' && !d.ios) return d.v6Mode === 'auto' ? '1' : '0';
    if (c === 'Link Local' && !d.ios) return iface.v6ll ?? linkLocal(iface.mac);
    if (c === 'MTU' || c === 'IP MTU') return '1500';
    // settings NetForge doesn't edit are graded from the saved file, which it keeps unchanged
    const px = portXml(p, d, iface.name);
    const flag = (tag: string) => (xmlText(px, tag) === 'true' ? '1' : '0');
    if (px) {
      if (c === 'ARP Timeout') return xmlText(px, 'TIMEOUT') || undefined;
      if (c === 'Bandwidth') return `autoNegotiate=${xmlText(px, 'AUTONEGOTIATEBANDWIDTH')} bandwidth=${xmlText(px, 'BANDWIDTH')}`;
      if (c === 'Duplex') return `autoNegotiate=${xmlText(px, 'AUTONEGOTIATEDUPLEX')} isFullDuplex=${xmlText(px, 'FULLDUPLEX')}`;
      if (c === 'IPv6 Enable') return flag('IPV6_ENABLED');
      if (c === 'ND Suppressed RA') return flag('ND_SUPPRESSED');
    }
    if (c === 'MAC Address' || c === 'BIA') return iface.mac;
    if (c === 'DHCP client enable') return d.dhcpClient ? '1' : '0';
    if (c === 'SSID') return h?.ssid ?? d.ssid;
    return undefined;
  }
  // radio settings: ["Wireless", "SSID"], ["Wireless 2.4G", "SSID"], ["Port 1", "SSID"]
  if (b === 'SSID' && rest.length === 2) {
    // "Wireless 2.4G", "Wireless 5G-1", "Wireless 5G-2" on home routers
    const k = /5G-?1/i.test(a) ? 1 : /5G-?2/i.test(a) ? 2 : 0;
    if (h) return k === 0 ? h.ssid : h.radios?.[k]?.ssid;
    return d.ssid;
  }
  if (a === 'DHCP Server' && h) {
    if (b === 'DHCP Enable') return h.dhcpEnabled ? '1' : '0';
    if (b === 'Pools' && c?.startsWith('Pool ') && e) {
      const net = network(h.lanIp, h.lanMask);
      switch (e) {
        case 'Default Gateway':
          return h.lanIp;
        case 'Start IP address':
          return intToIp(net + h.startHost);
        case 'Max User':
          return String(h.maxUsers);
        case 'Network Address':
          return intToIp(net);
        case 'Subnet mask':
          return h.lanMask;
        case 'DNS server IP':
          return h.dns ?? '0.0.0.0';
        case 'Name':
          return c.slice(5);
        case 'TFTP Server':
        case 'WLC Address': {
          const pool = deviceXml(p, d)?.getElementsByTagName('POOL')[0] ?? null;
          return xmlText(pool, e === 'TFTP Server' ? 'TFTP_ADDRESS' : 'WLC_ADDRESS') || undefined;
        }
      }
    }
  }
  return undefined;
}

function varOk(v: ActivityVar, value: string) {
  if (v.kind === 'string') return v.values.some((x) => norm(x) === norm(value));
  if (v.kind === 'number') return Number(value) >= v.min && Number(value) <= v.max;
  const n = ipToInt(value);
  const a = ipToInt(v.first);
  const b = ipToInt(v.last);
  return n !== null && a !== null && b !== null && n >= a && n <= b;
}

export function grade(p: Project): GradeReport | null {
  const items = p.activity?.items;
  if (!items?.length) return null;
  buildTopo(p); // keeps parity with simulation state; cheap
  const results: GradeResult[] = [];
  let earned = 0;
  let checkable = 0;
  let total = 0;
  for (const item of items) {
    const [devName, ...rest] = item.path;
    // structural group nodes ("DHCP Server", "Pools", "Pool x") carry no value of their own
    const structural = !item.expected && !rest[rest.length - 1]?.startsWith('Link to ') && rest.length > 0;
    if (structural) continue;
    total += item.points;
    const label = item.path.join(' › ');
    const d = p.devices.find((x) => x.name === devName);
    let verdict: Verdict = 'unchecked';
    const variable = item.variableName ? p.activity?.variables?.[item.variableName] : undefined;
    if (!d) verdict = rest.length ? 'fail' : 'unchecked';
    else if (item.variable && variable) {
      const v = actual(p, d, rest, true);
      if (typeof v === 'string') verdict = varOk(variable, v) ? 'pass' : 'fail';
    } else if (!item.variable) {
      const v = actual(p, d, rest);
      if (v === undefined) verdict = 'unchecked';
      else if (typeof v === 'object') {
        const last = rest[rest.length - 1];
        if (last.startsWith('Connects to')) {
          const peer = rest[2].slice('Link to '.length);
          const port = item.expected.replace(/^Connects to\s*/, '');
          verdict = linkBetween(p, d, rest[1], peer, port) ? 'pass' : 'fail';
        } else verdict = v.link ? 'pass' : 'fail';
      } else verdict = norm(v) === norm(item.expected) ? 'pass' : 'fail';
    }
    if (verdict !== 'unchecked') {
      checkable += item.points;
      if (verdict === 'pass') earned += item.points;
    }
    results.push({ item, verdict, label });
  }
  return { results, earned, checkable, total };
}
