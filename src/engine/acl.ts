/**
 * IPv4 access control lists: parsing and checking ACL entries, and filtering packets with them.
 * Numbered lists live in the config as `access-list N …` lines; named lists as
 * `ip access-list standard|extended NAME` blocks.
 */
import { ipToInt, isIp } from '../model/ip';
import type { Device } from '../model/types';

export type Proto = 'ip' | 'icmp' | 'tcp' | 'udp';

export interface Addr {
  ip: string;
  wild: string;
}

export interface PortMatch {
  op: 'eq' | 'neq' | 'gt' | 'lt' | 'range';
  ports: number[];
}

export interface Ace {
  seq: number;
  action: 'permit' | 'deny';
  proto: Proto;
  src: Addr;
  sport?: PortMatch;
  dst?: Addr;
  dport?: PortMatch;
  icmp?: number;
  established?: boolean;
  /** text as IOS shows it after the sequence number */
  text: string;
}

export interface Acl {
  name: string;
  extended: boolean;
  aces: Ace[];
}

export interface Pkt {
  src: string;
  dst: string;
  proto: 'icmp' | 'tcp' | 'udp';
  sport?: number;
  dport?: number;
  icmpType?: number;
}

const ANY: Addr = { ip: '0.0.0.0', wild: '255.255.255.255' };

const PORTS: Record<string, number> = {
  www: 80, http: 80, ftp: 21, 'ftp-data': 20, telnet: 23, smtp: 25, domain: 53, tftp: 69, pop3: 110, bootps: 67, bootpc: 68, snmp: 161, ntp: 123, https: 443,
  ssh: 22,
};
const PORT_NAMES: Record<string, Record<number, string>> = {
  tcp: { 80: 'www', 21: 'ftp', 20: 'ftp-data', 23: 'telnet', 25: 'smtp', 53: 'domain', 110: 'pop3' },
  udp: { 53: 'domain', 69: 'tftp', 67: 'bootps', 68: 'bootpc', 161: 'snmp', 123: 'ntp' },
};
const ICMP: Record<string, number> = { echo: 8, 'echo-reply': 0, unreachable: 3, 'time-exceeded': 11 };

export const isStandardNumber = (n: number) => (n >= 1 && n <= 99) || (n >= 1300 && n <= 1999);
export const isExtendedNumber = (n: number) => (n >= 100 && n <= 199) || (n >= 2000 && n <= 2699);

/** Parse the words after permit/deny. Returns the entry or the index of the first bad word. */
export function parseAce(words: string[], extended: boolean, seq: number, action: 'permit' | 'deny'): Ace | { errAt: number } {
  let k = 0;
  const addr = (): Addr | null => {
    const w = words[k]?.toLowerCase();
    if (w === 'any') {
      k++;
      return ANY;
    }
    if (w === 'host') {
      if (!isIp(words[k + 1])) return null;
      k += 2;
      return { ip: words[k - 1], wild: '0.0.0.0' };
    }
    if (!isIp(words[k])) return null;
    const ip = words[k++];
    // standard lists allow a bare address (host); extended lists need a wildcard
    if (isIp(words[k])) return { ip, wild: words[k++] };
    if (extended) {
      k--;
      return null;
    }
    return { ip, wild: '0.0.0.0' };
  };
  const port = (): PortMatch | null | undefined => {
    const op = words[k]?.toLowerCase();
    if (!['eq', 'neq', 'gt', 'lt', 'range'].includes(op)) return undefined;
    k++;
    const one = () => {
      const w = words[k]?.toLowerCase();
      const n = /^\d+$/.test(w ?? '') ? Number(w) : PORTS[w ?? ''];
      if (n === undefined || n > 65535) return null;
      k++;
      return n;
    };
    const a = one();
    if (a === null) return null;
    if (op === 'range') {
      const b = one();
      if (b === null) return null;
      return { op: 'range', ports: [a, b] };
    }
    return { op: op as PortMatch['op'], ports: [a] };
  };

  if (!extended) {
    const src = addr();
    if (!src) return { errAt: k };
    if (k < words.length && words[k] !== 'log') return { errAt: k };
    return { seq, action, proto: 'ip', src, text: `${action} ${fmtAddr(src, false)}` };
  }
  const p = words[k]?.toLowerCase();
  if (!['ip', 'icmp', 'tcp', 'udp'].includes(p)) return { errAt: k };
  k++;
  const proto = p as Proto;
  const src = addr();
  if (!src) return { errAt: k };
  const sport = proto === 'tcp' || proto === 'udp' ? port() : undefined;
  if (sport === null) return { errAt: k };
  const dst = addr();
  if (!dst) return { errAt: k };
  const dport = proto === 'tcp' || proto === 'udp' ? port() : undefined;
  if (dport === null) return { errAt: k };
  let icmp: number | undefined;
  let established = false;
  if (proto === 'icmp' && words[k] && ICMP[words[k].toLowerCase()] !== undefined) icmp = ICMP[words[k++].toLowerCase()];
  if (proto === 'tcp' && words[k]?.toLowerCase() === 'established') {
    established = true;
    k++;
  }
  if (words[k] === 'log') k++;
  if (k < words.length) return { errAt: k };
  const fp = (m?: PortMatch) => (m ? ` ${m.op} ${m.ports.map((x) => PORT_NAMES[proto]?.[x] ?? x).join(' ')}` : '');
  const icmpName = icmp !== undefined ? ` ${Object.keys(ICMP).find((n) => ICMP[n] === icmp)}` : '';
  const text = `${action} ${proto} ${fmtAddr(src, true)}${fp(sport)} ${fmtAddr(dst, true)}${fp(dport)}${icmpName}${established ? ' established' : ''}`;
  return { seq, action, proto, src, sport, dst, dport, icmp, established, text };
}

function fmtAddr(a: Addr, extended: boolean) {
  if (a.wild === '255.255.255.255') return 'any';
  if (a.wild === '0.0.0.0') return extended ? `host ${a.ip}` : `host ${a.ip}`;
  return `${a.ip} ${a.wild}`;
}

/** Every ACL on a device, from its stored config lines. */
export function aclsOf(d: Device): Map<string, Acl> {
  const out = new Map<string, Acl>();
  const lines = d.ios?.extraPost ?? [];
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^access-list (\d+) (permit|deny) (.*)$/))) {
      const n = Number(m[1]);
      const acl = out.get(m[1]) ?? out.set(m[1], { name: m[1], extended: isExtendedNumber(n), aces: [] }).get(m[1])!;
      const ace = parseAce(m[3].split(/\s+/), acl.extended, (acl.aces.length + 1) * 10, m[2] as 'permit' | 'deny');
      if (!('errAt' in ace)) acl.aces.push(ace);
    } else if ((m = l.match(/^ip access-list (standard|extended) (\S+)$/))) {
      const acl: Acl = { name: m[2], extended: m[1] === 'extended', aces: [] };
      out.set(m[2], acl);
      for (let j = k + 1; j < lines.length && lines[j].startsWith(' '); j++) {
        const e = lines[j].trim().match(/^(\d+) (permit|deny) (.*)$/);
        if (!e) continue;
        const ace = parseAce(e[3].split(/\s+/), acl.extended, Number(e[1]), e[2] as 'permit' | 'deny');
        if (!('errAt' in ace)) acl.aces.push(ace);
      }
    }
  }
  return out;
}

const match = (ip: string, a: Addr) => {
  const x = ipToInt(ip);
  const n = ipToInt(a.ip);
  const w = ipToInt(a.wild);
  if (x === null || n === null || w === null) return false;
  return ((x ^ n) & ~w) >>> 0 === 0;
};

const portOk = (m: PortMatch | undefined, p: number | undefined) => {
  if (!m) return true;
  if (p === undefined) return false;
  switch (m.op) {
    case 'eq':
      return p === m.ports[0];
    case 'neq':
      return p !== m.ports[0];
    case 'gt':
      return p > m.ports[0];
    case 'lt':
      return p < m.ports[0];
    case 'range':
      return p >= m.ports[0] && p <= m.ports[1];
  }
};

/** hit counters for `show access-lists`, per device and list */
const hits = new Map<string, Map<number, number>>();
export const aclHits = (devId: string, acl: string) => hits.get(`${devId}|${acl}`) ?? new Map<number, number>();
export const clearAclHits = (devId: string) => {
  for (const k of [...hits.keys()]) if (k.startsWith(devId + '|')) hits.delete(k);
};

/** First matching entry decides; nothing matching means the implicit deny. */
export function aclAllows(d: Device, name: string, pkt: Pkt, count = false): { ok: boolean; ace?: Ace } {
  const acl = aclsOf(d).get(name);
  if (!acl) return { ok: true }; // an undefined ACL permits everything, like IOS
  for (const ace of acl.aces) {
    if (!match(pkt.src, ace.src)) continue;
    if (acl.extended) {
      if (!match(pkt.dst, ace.dst!)) continue;
      if (ace.proto !== 'ip' && ace.proto !== pkt.proto) continue;
      if (ace.proto !== 'ip' && (!portOk(ace.sport, pkt.sport) || !portOk(ace.dport, pkt.dport))) continue;
      if (ace.icmp !== undefined && pkt.icmpType !== ace.icmp) continue;
      if (ace.established && pkt.sport === undefined) continue;
      if (ace.established && !(pkt.sport !== undefined && pkt.sport < 1024 && (pkt.dport ?? 0) >= 1024)) continue;
    }
    if (count) {
      const k = `${d.id}|${name}`;
      const m = hits.get(k) ?? hits.set(k, new Map()).get(k)!;
      m.set(ace.seq, (m.get(ace.seq) ?? 0) + 1);
    }
    return { ok: ace.action === 'permit', ace };
  }
  return { ok: false };
}

/** the ACL applied to an interface in a direction (`ip access-group X in|out`) */
export function accessGroup(d: Device, iface: string, dir: 'in' | 'out'): string | undefined {
  const i = d.ifaces.find((x) => x.name === iface);
  return i?.extra?.map((e) => e.match(/^ip access-group (\S+) (in|out)$/)).find((m) => m && m[2] === dir)?.[1];
}

export function showAccessLists(d: Device, only?: string): string {
  const out: string[] = [];
  for (const acl of aclsOf(d).values()) {
    if (only && acl.name !== only) continue;
    const kind = acl.extended ? 'Extended' : 'Standard';
    out.push(/^\d+$/.test(acl.name) ? `${kind} IP access list ${acl.name}` : `${kind} IP access list ${acl.name}`);
    const h = aclHits(d.id, acl.name);
    for (const a of acl.aces) out.push(`    ${a.seq} ${a.text}${h.get(a.seq) ? ` (${h.get(a.seq)} match(es))` : ''}`);
  }
  return out.length ? out.join('\n') + '\n' : '';
}
