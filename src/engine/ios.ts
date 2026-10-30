import { emptyIos } from '../model/catalog';
import { classfulMask, inNet, isIp, isMask, maskToPrefix, network, prefixToMask, randomMac, intToIp } from '../model/ip';
import type { Device, Iface, IosState, Project } from '../model/types';
import { buildTopo, ifaceStatus, ping } from './network';

/* ------------------------------------------------------------------ */
/*  running-config  <->  structured state                              */
/* ------------------------------------------------------------------ */

const IF_PREFIXES = [
  'GigabitEthernet',
  'FastEthernet',
  'TenGigabitEthernet',
  'Ethernet',
  'Serial',
  'Vlan',
  'Loopback',
  'Port-channel',
  'Dialer',
  'Cellular',
];

export function parseRunningConfig(text: string, d: Device) {
  const ios: IosState = emptyIos(d.name);
  const lines = text.split(/\r?\n/);
  let block: { kind: 'if' | 'pool' | 'other'; name: string; target?: string[] } | null = null;
  let seenIf = false;

  const ensureIface = (name: string): Iface => {
    let i = d.ifaces.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!i) {
      i = { name, media: 'virtual', speed: 0, mac: randomMac(), shutdown: false };
      d.ifaces.push(i);
    }
    return i;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const l = line.trim();

    if (indented && block) {
      if (block.kind === 'if') {
        const i = ensureIface(block.name);
        let m: RegExpMatchArray | null;
        if ((m = l.match(/^ip address (\S+) (\S+)/))) {
          i.ip = m[1];
          i.mask = m[2];
        } else if (l === 'shutdown') i.shutdown = true;
        else if (l === 'no ip address') {
          i.ip = undefined;
          i.mask = undefined;
        } else if ((m = l.match(/^description (.*)/))) i.description = m[1];
        else if ((m = l.match(/^ip nat (inside|outside)$/))) i.natRole = m[1] as 'inside' | 'outside';
        else if (l === 'ip address dhcp') (i.extra ??= []).push(l);
        else (i.extra ??= []).push(l);
      } else if (block.kind === 'pool') {
        const p = ios.pools.find((x) => x.name === block!.name)!;
        let m: RegExpMatchArray | null;
        if ((m = l.match(/^network (\S+) (\S+)/))) {
          p.network = m[1];
          p.mask = m[2];
        } else if ((m = l.match(/^default-router (\S+)/))) p.router = m[1];
        else if ((m = l.match(/^dns-server (\S+)/))) p.dns = m[1];
      } else block.target?.push(line);
      continue;
    }
    block = null;
    if (l === '!' || l === 'end' || /^version /.test(l) || l.startsWith('Building configuration') || l.startsWith('Current configuration'))
      continue;

    let m: RegExpMatchArray | null;
    if ((m = l.match(/^hostname (\S+)/))) ios.hostname = m[1];
    else if ((m = l.match(/^enable secret (?:\d )?(\S+)/))) ios.enableSecret = m[1];
    else if ((m = l.match(/^interface (\S+)/))) {
      seenIf = true;
      const i = ensureIface(m[1]);
      i.shutdown = false;
      i.extra = [];
      block = { kind: 'if', name: i.name };
    } else if ((m = l.match(/^ip dhcp pool (\S+)/))) {
      ios.pools.push({ name: m[1] });
      block = { kind: 'pool', name: m[1] };
    } else if ((m = l.match(/^ip dhcp excluded-address (\S+)(?: (\S+))?/))) ios.excluded.push({ from: m[1], to: m[2] ?? m[1] });
    else if ((m = l.match(/^ip route (\S+) (\S+) (\S+)/))) {
      ios.routes.push(isIp(m[3]) ? { network: m[1], mask: m[2], via: m[3] } : { network: m[1], mask: m[2], iface: m[3] });
    } else if (/^ip nat inside source/.test(l) || /^ip nat pool/.test(l)) ios.natRules.push(l);
    else if ((m = l.match(/^ip default-gateway (\S+)/))) ios.defaultGateway = m[1];
    else if (l === 'ip classless' || /^no service (timestamps|password-encryption)/.test(l)) continue;
    else {
      const target = seenIf ? ios.extraPost : ios.extraPre;
      target.push(l);
      block = { kind: 'other', name: l, target };
    }
  }
  d.ios = ios;
  d.name = d.name || ios.hostname;
}

export function runningConfig(d: Device): string {
  const s = d.ios ?? emptyIos(d.name);
  const out: string[] = ['!', 'version 15.1', 'no service timestamps log datetime msec', 'no service timestamps debug datetime msec', 'no service password-encryption', '!', `hostname ${s.hostname}`, '!'];
  if (s.enableSecret) out.push(`enable secret 5 ${s.enableSecret}`, '!');
  for (const x of s.excluded) out.push(`ip dhcp excluded-address ${x.from}${x.to && x.to !== x.from ? ' ' + x.to : ''}`);
  if (s.excluded.length) out.push('!');
  for (const p of s.pools) {
    out.push(`ip dhcp pool ${p.name}`);
    if (p.network) out.push(` network ${p.network} ${p.mask}`);
    if (p.router) out.push(` default-router ${p.router}`);
    if (p.dns) out.push(` dns-server ${p.dns}`);
    out.push('!');
  }
  for (const l of s.extraPre) out.push(l);
  if (s.extraPre.length) out.push('!');
  for (const i of d.ifaces) {
    if (i.media === 'wireless') continue;
    out.push(`interface ${i.name}`);
    if (i.description) out.push(` description ${i.description}`);
    if (i.ip && i.mask) out.push(` ip address ${i.ip} ${i.mask}`);
    else if (d.kind === 'router' || i.name.startsWith('Vlan')) out.push(' no ip address');
    if (i.natRole) out.push(` ip nat ${i.natRole}`);
    for (const e of i.extra ?? []) out.push(` ${e}`);
    if (i.shutdown) out.push(' shutdown');
    out.push('!');
  }
  if (s.defaultGateway) out.push(`ip default-gateway ${s.defaultGateway}`, '!');
  if (d.kind === 'router') out.push('ip classless');
  for (const r of s.routes) out.push(`ip route ${r.network} ${r.mask} ${r.via ?? r.iface}`);
  for (const r of s.natRules) out.push(r);
  out.push('!');
  for (const l of s.extraPost) out.push(l);
  out.push('!', 'end');
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/*  CLI                                                                */
/* ------------------------------------------------------------------ */

export type Mode = 'user' | 'priv' | 'config' | 'if' | 'pool' | 'line' | 'router';

export interface Session {
  mode: Mode;
  iface?: string[];
  pool?: string;
  history: string[];
}

export const newSession = (): Session => ({ mode: 'user', history: [] });

export function prompt(d: Device, s: Session) {
  const h = d.ios?.hostname ?? d.name;
  switch (s.mode) {
    case 'user':
      return `${h}>`;
    case 'priv':
      return `${h}#`;
    case 'config':
      return `${h}(config)#`;
    case 'if':
      return `${h}(config-if${s.iface && s.iface.length > 1 ? '-range' : ''})#`;
    case 'pool':
      return `${h}(dhcp-config)#`;
    case 'line':
      return `${h}(config-line)#`;
    case 'router':
      return `${h}(config-router)#`;
  }
}

const KW: Record<Mode, string[]> = {
  user: ['enable', 'exit', 'logout', 'ping', 'show', 'traceroute', 'disable'],
  priv: ['configure', 'copy', 'disable', 'enable', 'exit', 'logout', 'ping', 'reload', 'show', 'traceroute', 'write', 'clear'],
  config: ['access-list', 'banner', 'do', 'enable', 'end', 'exit', 'hostname', 'interface', 'ip', 'line', 'no', 'router', 'service', 'spanning-tree', 'vlan', 'username'],
  if: ['description', 'do', 'duplex', 'end', 'exit', 'interface', 'ip', 'no', 'shutdown', 'speed', 'switchport', 'channel-group', 'spanning-tree'],
  pool: ['default-router', 'dns-server', 'do', 'domain-name', 'end', 'exit', 'network', 'no', 'lease'],
  line: ['do', 'end', 'exit', 'login', 'password', 'transport', 'exec-timeout', 'logging', 'no'],
  router: ['do', 'end', 'exit', 'network', 'no', 'version', 'passive-interface', 'default-information', 'router-id', 'auto-summary'],
};

export const keywords = (m: Mode) => KW[m];

function pick(word: string, opts: string[]): string | null | 'ambig' {
  const w = word.toLowerCase();
  if (opts.includes(w)) return w;
  const hits = opts.filter((o) => o.startsWith(w));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return 'ambig';
  return null;
}

const invalid = (line: string, tok = 0) => {
  const words = line.trim().split(/\s+/);
  const pos = line.indexOf(words[tok] ?? '') + 0;
  return `${' '.repeat(Math.max(0, pos))}^\n% Invalid input detected at '^' marker.\n`;
};

function resolveIfaces(d: Device, spec: string, create: boolean): Iface[] | string {
  const cleaned = spec.replace(/\s+/g, '');
  // ranges: fa0/1-24 or g0/1-2,fa0/3
  const parts = cleaned.split(',');
  const out: Iface[] = [];
  let lastPrefix = '';
  for (const part of parts) {
    const m = part.match(/^([a-zA-Z-]*)([\d/.]+?)(?:-(\d+))?$/);
    if (!m) return '% Invalid interface type and number';
    const word = m[1] || lastPrefix;
    const full = IF_PREFIXES.find((p) => p.toLowerCase().startsWith(word.toLowerCase()));
    if (!full || !word) return '% Invalid interface type and number';
    lastPrefix = full;
    const nums = m[2];
    const names: string[] = [];
    if (m[3]) {
      const base = nums.slice(0, nums.lastIndexOf('/') + 1);
      const from = Number(nums.slice(nums.lastIndexOf('/') + 1));
      for (let k = from; k <= Number(m[3]); k++) names.push(`${full}${base}${k}`);
    } else names.push(`${full}${nums}`);
    for (const n of names) {
      let i = d.ifaces.find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (!i && create && /^(Vlan|Loopback)/.test(full)) {
        i = { name: n, media: 'virtual', speed: 0, mac: randomMac(), shutdown: full === 'Vlan' };
        d.ifaces.push(i);
      }
      if (!i) return '% Invalid interface type and number';
      out.push(i);
    }
  }
  return out;
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length));

function showIpIntBrief(p: Project, d: Device) {
  const t = buildTopo(p);
  const rows = [pad('Interface', 27) + pad('IP-Address', 16) + pad('OK?', 4) + pad('Method', 7) + pad('Status', 22) + 'Protocol'];
  for (const i of d.ifaces) {
    if (i.media === 'wireless') continue;
    const st = ifaceStatus(p, t, d, i);
    const status = i.shutdown ? 'administratively down' : st.line ? 'up' : 'down';
    rows.push(pad(i.name, 27) + pad(i.ip ?? 'unassigned', 16) + pad('YES', 4) + pad(i.ip ? 'manual' : 'unset', 7) + pad(status, 22) + (st.line && !i.shutdown ? 'up' : 'down'));
  }
  return rows.join('\n') + '\n';
}

function showIpRoute(p: Project, d: Device) {
  const t = buildTopo(p);
  const lines = [
    'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
    '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
    '       * - candidate default, U - per-user static route, o - ODR',
    '',
  ];
  const def = d.ios?.routes.find((r) => r.network === '0.0.0.0' && r.mask === '0.0.0.0');
  lines.push(def ? `Gateway of last resort is ${def.via ?? '0.0.0.0'} to network 0.0.0.0` : 'Gateway of last resort is not set', '');
  const eps = t.endpoints.filter((e) => e.dev.id === d.id);
  for (const e of eps) {
    const pre = maskToPrefix(e.mask);
    lines.push(`C    ${intToIp(network(e.ip, e.mask))}/${pre} is directly connected, ${e.iface}`);
    lines.push(`L    ${e.ip}/32 is directly connected, ${e.iface}`);
  }
  for (const r of d.ios?.routes ?? []) {
    const pre = maskToPrefix(r.mask);
    const star = pre === 0 ? '*' : ' ';
    lines.push(`S${star}   ${r.network}/${pre} ${r.via ? `[1/0] via ${r.via}` : `is directly connected, ${r.iface}`}`);
  }
  return lines.join('\n') + '\n';
}

function iosPing(p: Project, d: Device, target: string) {
  if (!isIp(target)) return `% Unrecognized host or address, or protocol not running.\n`;
  const r = ping(p, d.id, target);
  const marks = r.ok ? '!!!!!' : '.....';
  return (
    `Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:\n${marks}\n` +
    (r.ok
      ? `Success rate is 100 percent (5/5), round-trip min/avg/max = 0/${r.hops.length}/${r.hops.length * 2} ms\n`
      : `Success rate is 0 percent (0/5)\n`)
  );
}

function iosTrace(p: Project, d: Device, target: string) {
  if (!isIp(target)) return `% Unrecognized host or address, or protocol not running.\n`;
  const r = ping(p, d.id, target);
  const out = [`Type escape sequence to abort.`, `Tracing the route to ${target}`, ''];
  let n = 1;
  for (const h of r.routers) out.push(`  ${n++}   ${h.ip}\t0 msec\t0 msec\t1 msec`);
  if (r.ok) out.push(`  ${n}   ${target}\t1 msec\t0 msec\t0 msec`);
  else for (let k = 0; k < 3; k++) out.push(`  ${n++}   *     *     *`);
  return out.join('\n') + '\n';
}

function linkMsg(i: Iface, up: boolean) {
  return up
    ? `\n%LINK-5-CHANGED: Interface ${i.name}, changed state to up\n\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${i.name}, changed state to up\n`
    : `\n%LINK-5-CHANGED: Interface ${i.name}, changed state to administratively down\n\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${i.name}, changed state to down\n`;
}

const SHOW_TREE: Record<string, any> = {
  'running-config': {},
  'startup-config': {},
  ip: { interface: { brief: {} }, route: {}, dhcp: { binding: {}, pool: {} }, nat: { translations: {} } },
  interfaces: {},
  version: {},
  vlan: { brief: {} },
  history: {},
  clock: {},
};

function doShow(p: Project, d: Device, s: Session, words: string[], line: string): string {
  let node = SHOW_TREE;
  const path: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const opts = Object.keys(node);
    if (!opts.length) break;
    const w = pick(words[k], opts);
    if (w === 'ambig') return `% Ambiguous command: "${line.trim()}"\n`;
    if (!w) return invalid(line, k + 1);
    path.push(w);
    node = node[w];
  }
  const cmd = path.join(' ');
  switch (cmd) {
    case 'running-config':
    case 'startup-config': {
      const c = runningConfig(d);
      return `Building configuration...\n\nCurrent configuration : ${c.length} bytes\n${c}\n`;
    }
    case 'ip interface brief':
    case 'ip interface':
      return showIpIntBrief(p, d);
    case 'ip route':
      return showIpRoute(p, d);
    case 'ip dhcp binding': {
      const rows = ['IP address       Client-ID/              Lease expiration        Type', '                 Hardware address'];
      for (const l of d.ios?.leases ?? []) rows.push(`${pad(l.ip, 17)}${pad(l.mac, 24)}--                      Automatic`);
      return rows.join('\n') + '\n';
    }
    case 'ip dhcp pool': {
      return (d.ios?.pools ?? [])
        .map((pl) => `Pool ${pl.name} :\n Network: ${pl.network ?? '-'} ${pl.mask ?? ''}\n Default router: ${pl.router ?? '-'}\n DNS: ${pl.dns ?? '-'}\n`)
        .join('\n');
    }
    case 'ip nat translations':
      return 'Pro  Inside global     Inside local       Outside local      Outside global\n';
    case 'version':
      return `Cisco IOS Software, ${d.model} Software, Version 15.1(4)M4 (NetForge emulation)\n\n${d.ios?.hostname} uptime is 1 hours, 2 minutes\n`;
    case 'interfaces': {
      const t = buildTopo(p);
      return d.ifaces
        .filter((i) => i.media !== 'wireless')
        .map((i) => {
          const st = ifaceStatus(p, t, d, i);
          return `${i.name} is ${i.shutdown ? 'administratively down' : st.line ? 'up' : 'down'}, line protocol is ${st.line && !i.shutdown ? 'up' : 'down'}\n  Hardware is ${i.media}, address is ${i.mac}\n${i.ip ? `  Internet address is ${i.ip}/${maskToPrefix(i.mask!)}\n` : ''}  MTU 1500 bytes, BW ${i.speed * 1000} Kbit\n`;
        })
        .join('');
    }
    case 'vlan brief':
    case 'vlan': {
      if (d.kind !== 'switch') return invalid(line, 1);
      const ports = d.ifaces.filter((i) => i.media !== 'virtual').map((i) => i.name.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gig'));
      const rows = ['VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------'];
      for (let k = 0; k < ports.length; k += 4) rows.push(`${k === 0 ? '1    default                          active    ' : ' '.repeat(48)}${ports.slice(k, k + 4).join(', ')}`);
      return rows.join('\n') + '\n';
    }
    case 'history':
      return s.history.map((h) => `  ${h}`).join('\n') + '\n';
    case 'clock':
      return `*${new Date().toUTCString()}\n`;
    default:
      return `% Incomplete command.\n`;
  }
}

/**
 * Execute one CLI line against a device. Mutates `d` and `s` (use an immer draft).
 * Returns the text to print.
 */
export function exec(p: Project, d: Device, s: Session, line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('!')) return '';
  s.history.push(trimmed);
  const ios = (d.ios ??= emptyIos(d.name));

  if (trimmed.endsWith('?')) {
    return KW[s.mode].map((k) => `  ${k}`).join('\n') + '\n';
  }

  let words = trimmed.split(/\s+/);
  let negate = false;

  // "do" from config modes
  if (s.mode !== 'user' && s.mode !== 'priv' && pick(words[0], ['do']) === 'do' && words[0].toLowerCase() === 'do') {
    const inner: Session = { ...s, mode: 'priv' };
    return exec(p, d, inner, words.slice(1).join(' '));
  }

  if (s.mode !== 'user' && s.mode !== 'priv' && words[0].toLowerCase() === 'no') {
    negate = true;
    words = words.slice(1);
    if (!words.length) return '% Incomplete command.\n';
  }

  const cmd = pick(words[0], KW[s.mode]);
  if (cmd === 'ambig') return `% Ambiguous command: "${trimmed}"\n`;
  if (!cmd) {
    // interface-mode commands typed in config mode fall back like IOS does
    if (s.mode === 'if' || s.mode === 'pool' || s.mode === 'line' || s.mode === 'router') {
      const up = pick(words[0], KW.config);
      if (up && up !== 'ambig') {
        const ss: Session = { ...s, mode: 'config' };
        const out = exec(p, d, ss, (negate ? 'no ' : '') + words.join(' '));
        Object.assign(s, ss);
        return out;
      }
    }
    return invalid(trimmed, negate ? 1 : 0);
  }
  const args = words.slice(1);

  // universal navigation
  if (cmd === 'end') {
    s.mode = 'priv';
    return '\n%SYS-5-CONFIG_I: Configured from console by console\n';
  }
  if (cmd === 'exit' || cmd === 'logout') {
    if (s.mode === 'if' || s.mode === 'pool' || s.mode === 'line' || s.mode === 'router') s.mode = 'config';
    else if (s.mode === 'config') {
      s.mode = 'priv';
      return '\n%SYS-5-CONFIG_I: Configured from console by console\n';
    } else s.mode = 'user';
    return '';
  }

  switch (s.mode) {
    case 'user':
    case 'priv': {
      if (cmd === 'enable') {
        s.mode = 'priv';
        return '';
      }
      if (cmd === 'disable') {
        s.mode = 'user';
        return '';
      }
      if (cmd === 'show') {
        if (!args.length) return '% Incomplete command.\n';
        return doShow(p, d, s, args, trimmed);
      }
      if (cmd === 'ping') return args[0] ? iosPing(p, d, args[0]) : '% Incomplete command.\n';
      if (cmd === 'traceroute') return args[0] ? iosTrace(p, d, args[0]) : '% Incomplete command.\n';
      if (s.mode === 'user') return invalid(trimmed);
      if (cmd === 'configure') {
        if (args[0] && pick(args[0], ['terminal']) !== 'terminal') return invalid(trimmed, 1);
        s.mode = 'config';
        return 'Enter configuration commands, one per line.  End with CNTL/Z.\n';
      }
      if (cmd === 'copy') {
        const a = args.map((x) => pick(x, ['running-config', 'startup-config']));
        if (a[0] === 'running-config' && a[1] === 'startup-config') return 'Destination filename [startup-config]? \nBuilding configuration...\n[OK]\n';
        return invalid(trimmed, 1);
      }
      if (cmd === 'write') return 'Building configuration...\n[OK]\n';
      if (cmd === 'reload') return 'Proceed with reload? [confirm]\n%SYS-5-RELOAD: Reload requested (simulated: configuration kept)\n';
      if (cmd === 'clear') return '';
      return invalid(trimmed);
    }

    case 'config': {
      if (cmd === 'hostname') {
        if (!args[0]) return '% Incomplete command.\n';
        ios.hostname = args[0];
        d.name = args[0];
        return '';
      }
      if (cmd === 'interface') {
        let spec = args.join(' ');
        const isRange = args[0] && pick(args[0], ['range']) === 'range';
        if (isRange) spec = args.slice(1).join(' ');
        if (!spec) return '% Incomplete command.\n';
        const r = resolveIfaces(d, spec, true);
        if (typeof r === 'string') return r + '\n';
        s.mode = 'if';
        s.iface = r.map((i) => i.name);
        return '';
      }
      if (cmd === 'enable') {
        const sub = args[0] && pick(args[0], ['secret', 'password']);
        if (!sub || sub === 'ambig' || !args[1]) return '% Incomplete command.\n';
        ios.enableSecret = negate ? undefined : args[args.length - 1];
        return '';
      }
      if (cmd === 'ip') {
        const sub = args[0] && pick(args[0], ['route', 'dhcp', 'nat', 'default-gateway', 'domain-name', 'routing', 'name-server', 'cef', 'classless']);
        if (!sub || sub === 'ambig') return invalid(trimmed, 1);
        if (sub === 'route') {
          const [, net, mask, via] = args;
          if (!isIp(net) || !isMask(mask) || !via) return '% Incomplete command.\n';
          if (negate) {
            ios.routes = ios.routes.filter((r) => !(r.network === net && r.mask === mask && (r.via === via || r.iface === via)));
            return '';
          }
          if (isIp(via)) ios.routes.push({ network: intToIp(network(net, mask)), mask, via });
          else {
            const r = resolveIfaces(d, via, false);
            if (typeof r === 'string') return r + '\n';
            ios.routes.push({ network: intToIp(network(net, mask)), mask, iface: r[0].name });
          }
          return '';
        }
        if (sub === 'dhcp') {
          const what = args[1] && pick(args[1], ['pool', 'excluded-address']);
          if (what === 'pool') {
            if (!args[2]) return '% Incomplete command.\n';
            if (negate) {
              ios.pools = ios.pools.filter((x) => x.name !== args[2]);
              return '';
            }
            if (!ios.pools.some((x) => x.name === args[2])) ios.pools.push({ name: args[2] });
            s.mode = 'pool';
            s.pool = args[2];
            return '';
          }
          if (what === 'excluded-address') {
            if (!isIp(args[2])) return '% Incomplete command.\n';
            if (negate) ios.excluded = ios.excluded.filter((x) => x.from !== args[2]);
            else ios.excluded.push({ from: args[2], to: isIp(args[3]) ? args[3] : args[2] });
            return '';
          }
          return invalid(trimmed, 2);
        }
        if (sub === 'nat') {
          const rest = `ip nat ${args.slice(1).join(' ')}`;
          if (negate) ios.natRules = ios.natRules.filter((r) => r !== rest);
          else ios.natRules.push(rest);
          return '';
        }
        if (sub === 'default-gateway') {
          ios.defaultGateway = negate ? undefined : args[1];
          return '';
        }
        // accept other "ip" globals verbatim
        const l = `${negate ? 'no ' : ''}ip ${args.join(' ')}`;
        ios.extraPost.push(l);
        return '';
      }
      if (cmd === 'line') {
        s.mode = 'line';
        if (!negate) ios.extraPost.push(`line ${args.join(' ')}`);
        return '';
      }
      if (cmd === 'router') {
        s.mode = 'router';
        ios.extraPost.push(`router ${args.join(' ')}`);
        return '';
      }
      if (cmd === 'banner') {
        ios.extraPre = ios.extraPre.filter((l) => !l.startsWith('banner'));
        if (!negate) ios.extraPre.push(`banner ${args.join(' ')}`);
        return '';
      }
      // everything else is accepted and stored
      ios.extraPost.push(`${negate ? 'no ' : ''}${cmd} ${args.join(' ')}`.trim());
      return '';
    }

    case 'if': {
      const ifs = (s.iface ?? []).map((n) => d.ifaces.find((i) => i.name === n)!).filter(Boolean);
      if (cmd === 'interface') {
        const r = resolveIfaces(d, args.join(' '), true);
        if (typeof r === 'string') return r + '\n';
        s.iface = r.map((i) => i.name);
        return '';
      }
      if (cmd === 'shutdown') {
        let out = '';
        for (const i of ifs) {
          const was = i.shutdown;
          i.shutdown = !negate;
          if (was !== i.shutdown) out += linkMsg(i, !i.shutdown);
        }
        return out;
      }
      if (cmd === 'description') {
        for (const i of ifs) i.description = negate ? undefined : args.join(' ');
        return '';
      }
      if (cmd === 'ip') {
        const sub = args[0] && pick(args[0], ['address', 'nat', 'helper-address', 'access-group', 'ospf']);
        if (sub === 'address') {
          if (negate) {
            for (const i of ifs) {
              i.ip = undefined;
              i.mask = undefined;
            }
            return '';
          }
          if (args[1] === 'dhcp') {
            for (const i of ifs) (i.extra ??= []).push('ip address dhcp');
            return '';
          }
          let [, ip, mask] = args;
          if (ip?.includes('/')) {
            const [a, pre] = ip.split('/');
            ip = a;
            mask = prefixToMask(Number(pre));
          }
          if (!isIp(ip)) return invalid(trimmed, 2);
          if (!mask) mask = d.kind === 'router' ? '' : classfulMask(ip);
          if (!isMask(mask)) return '% Incomplete command.\n';
          if (ifs.length !== 1) return '% IP addresses may not be configured on a range.\n';
          const clash = d.ifaces.find((o) => o !== ifs[0] && o.ip && o.mask && inNet(ip, o.ip, o.mask) && !o.shutdown);
          if (clash) return `% ${intToIp(network(ip, mask))} overlaps with ${clash.name}\n`;
          if (ip === intToIp(network(ip, mask)) && maskToPrefix(mask) < 31)
            return 'Bad mask /' + maskToPrefix(mask) + ' for address ' + ip + '\n';
          ifs[0].ip = ip;
          ifs[0].mask = mask;
          return '';
        }
        if (sub === 'nat') {
          const role = args[1] && pick(args[1], ['inside', 'outside']);
          if (!role || role === 'ambig') return '% Incomplete command.\n';
          for (const i of ifs) i.natRole = negate ? undefined : (role as 'inside' | 'outside');
          return '';
        }
        if (sub && sub !== 'ambig') {
          for (const i of ifs) (i.extra ??= []).push(`${negate ? 'no ' : ''}ip ${args.join(' ')}`);
          return '';
        }
        return invalid(trimmed, 1);
      }
      // switchport, duplex, speed, etc. stored as-is
      for (const i of ifs) {
        const l = `${negate ? 'no ' : ''}${cmd} ${args.join(' ')}`.trim();
        i.extra = (i.extra ?? []).filter((e) => !e.startsWith(`${cmd} `) || cmd === 'switchport');
        i.extra.push(l);
      }
      return '';
    }

    case 'pool': {
      const pool = ios.pools.find((x) => x.name === s.pool);
      if (!pool) return '';
      if (cmd === 'network') {
        let [ip, mask] = args;
        if (ip?.includes('/')) {
          const [a, pre] = ip.split('/');
          ip = a;
          mask = prefixToMask(Number(pre));
        }
        if (!isIp(ip)) return '% Incomplete command.\n';
        pool.network = ip;
        pool.mask = isMask(mask) ? mask : classfulMask(ip);
        return '';
      }
      if (cmd === 'default-router') {
        pool.router = negate ? undefined : args[0];
        return '';
      }
      if (cmd === 'dns-server') {
        pool.dns = negate ? undefined : args[0];
        return '';
      }
      return '';
    }

    case 'line':
    case 'router': {
      ios.extraPost.push(` ${negate ? 'no ' : ''}${cmd} ${args.join(' ')}`.trimEnd());
      return '';
    }
  }
  return invalid(trimmed);
}

/** first-word tab completion */
export function complete(s: Session, line: string): string {
  const words = line.split(/\s+/);
  if (words.length !== 1 || !words[0]) return line;
  const hits = KW[s.mode].filter((k) => k.startsWith(words[0].toLowerCase()));
  return hits.length === 1 ? hits[0] + ' ' : line;
}
