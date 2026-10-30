import { emptyIos } from '../model/catalog';
import { classfulMask, inNet, intToIp, isIp, isMask, maskToPrefix, network, prefixToMask, randomMac } from '../model/ip';
import type { Device, Iface, IosState, LineCfg, Project, Vlan } from '../model/types';
import { caretError, Grammar, ifaceName, IF_TYPES, type CmdSpec, type ParsedArgs } from './grammar';
import { checkPassword, md5crypt, type7Encode } from './iospw';
import { buildTopo, controlPlane, ifaceStatus, ping } from './network';
import { ospfRouterId, protocolsOf } from './routing';
import { aclAllows, clearAclHits, isExtendedNumber, isStandardNumber, parseAce, showAccessLists, type Ace } from './acl';

/* ================================================================== */
/*  Defaults                                                           */
/* ================================================================== */

export const BANNER_DELIM = '\u0003';
/** how pktconv represents the ^C banner delimiter inside XML text */
const PT_DELIM = '';

export const defaultLines = (d: Device): LineCfg[] =>
  d.kind === 'switch'
    ? [
        { name: 'con 0', cmds: [] },
        { name: 'vty 0 4', cmds: ['login'] },
        { name: 'vty 5 15', cmds: ['login'] },
      ]
    : [
        { name: 'con 0', cmds: [] },
        { name: 'aux 0', cmds: [] },
        { name: 'vty 0 4', cmds: ['login'] },
      ];

export const linesOf = (d: Device, ios: IosState) => (ios.lines ??= defaultLines(d));

export const DEFAULT_VLANS: Vlan[] = [
  { id: 1, name: 'default' },
  { id: 1002, name: 'fddi-default' },
  { id: 1003, name: 'token-ring-default' },
  { id: 1004, name: 'fddinet-default' },
  { id: 1005, name: 'trnet-default' },
];

export const vlansOf = (ios: IosState) => (ios.vlans ??= DEFAULT_VLANS.map((v) => ({ ...v })));

export const vlanName = (id: number) => `VLAN${String(id).padStart(4, '0')}`;

/** Expand "10,20,30-32" to [10,20,30,31,32]. */
export function expandVlans(list: string | undefined): number[] | 'all' {
  if (!list || list === 'all') return 'all';
  if (list === 'none') return [];
  const out: number[] = [];
  for (const part of list.split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let v = a; v <= (b ?? a); v++) out.push(v);
  }
  return out;
}

function compressVlans(ids: number[]): string {
  const s = [...new Set(ids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j - i >= 2 ? `${s[i]}-${s[j]}` : j > i ? `${s[i]},${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return out.join(',');
}

/* ================================================================== */
/*  running-config  <->  structured state                              */
/* ================================================================== */

const pwValue = (ios: IosState, plain: string) => (ios.pwEncrypt ? `7 ${type7Encode(plain)}` : plain);

function parseIfLine(i: Iface, l: string) {
  let m: RegExpMatchArray | null;
  if ((m = l.match(/^ip address (\S+) (\S+)$/))) {
    i.ip = m[1];
    i.mask = m[2];
  } else if (l === 'shutdown') i.shutdown = true;
  else if (l === 'no shutdown') i.shutdown = false;
  else if (l === 'no ip address') {
    i.ip = undefined;
    i.mask = undefined;
  } else if ((m = l.match(/^description (.*)/))) i.description = m[1];
  else if ((m = l.match(/^ip nat (inside|outside)$/))) i.natRole = m[1] as 'inside' | 'outside';
  else if ((m = l.match(/^switchport mode (access|trunk)$/))) i.swMode = m[1] as 'access' | 'trunk';
  else if ((m = l.match(/^switchport access vlan (\d+)$/))) i.accessVlan = Number(m[1]);
  else if ((m = l.match(/^switchport trunk native vlan (\d+)$/))) i.nativeVlan = Number(m[1]);
  else if ((m = l.match(/^switchport trunk allowed vlan (\S+)$/))) i.allowedVlans = m[1];
  else if ((m = l.match(/^encapsulation dot1Q (\d+)/i))) {
    i.dot1q = Number(m[1]);
    if (/native$/.test(l)) (i.extra ??= []).push('encapsulation-native');
  } else (i.extra ??= []).push(l);
}

export function parseRunningConfig(text: string, d: Device) {
  const ios: IosState = emptyIos(d.name);
  const lines = text.split(/\r?\n/);
  type Block = { kind: 'if'; iface: Iface } | { kind: 'pool'; name: string } | { kind: 'line'; cfg: LineCfg } | { kind: 'other'; target: string[] };
  let block: Block | null = null;
  let seenIf = false;
  const parsedLines: LineCfg[] = [];

  const ensureIface = (name: string): Iface => {
    let i = d.ifaces.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!i) {
      i = { name, media: 'virtual', speed: 0, mac: randomMac(), shutdown: false };
      d.ifaces.push(i);
    }
    return i;
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const l = line.trim();

    if (indented && block) {
      if (block.kind === 'if') parseIfLine(block.iface, l);
      else if (block.kind === 'pool') {
        const p = ios.pools.find((x) => x.name === (block as { name: string }).name)!;
        let m: RegExpMatchArray | null;
        if ((m = l.match(/^network (\S+) (\S+)/))) {
          p.network = m[1];
          p.mask = m[2];
        } else if ((m = l.match(/^default-router (\S+)/))) p.router = m[1];
        else if ((m = l.match(/^dns-server (\S+)/))) p.dns = m[1];
      } else if (block.kind === 'line') block.cfg.cmds.push(l);
      else block.target.push(line);
      continue;
    }
    block = null;
    if (l === '!' || l === 'end' || /^version /.test(l) || l.startsWith('Building configuration') || l.startsWith('Current configuration'))
      continue;

    let m: RegExpMatchArray | null;
    if ((m = l.match(/^banner motd (\^C|.)(.*)$/s))) {
      // the text runs to the next delimiter, possibly over several lines
      const delim = m[1];
      let body = m[2];
      while (!body.includes(delim) && n + 1 < lines.length) body += '\n' + lines[++n];
      ios.motd = body.slice(0, body.indexOf(delim) >= 0 ? body.indexOf(delim) : undefined).replace(/^\n/, '').replace(/\n$/, '');
      continue;
    }
    if ((m = l.match(/^hostname (\S+)/))) ios.hostname = m[1];
    else if ((m = l.match(/^enable secret (?:[05] )?(\S+)/))) ios.enableSecret = m[1].startsWith('$1$') ? m[1] : md5crypt(m[1]);
    else if ((m = l.match(/^enable password (.+)/))) ios.enablePassword = m[1].replace(/^0 /, '');
    else if (l === 'service password-encryption') ios.pwEncrypt = true;
    else if ((m = l.match(/^interface (\S+)/))) {
      seenIf = true;
      const i = ensureIface(m[1]);
      i.shutdown = false;
      i.extra = [];
      block = { kind: 'if', iface: i };
    } else if ((m = l.match(/^line (con|aux|vty|console) (.+)/))) {
      const cfg: LineCfg = { name: `${m[1] === 'console' ? 'con' : m[1]} ${m[2]}`, cmds: [] };
      parsedLines.push(cfg);
      block = { kind: 'line', cfg };
    } else if ((m = l.match(/^ip dhcp pool (\S+)/))) {
      ios.pools.push({ name: m[1] });
      block = { kind: 'pool', name: m[1] };
    } else if ((m = l.match(/^ip dhcp excluded-address (\S+)(?: (\S+))?/))) ios.excluded.push({ from: m[1], to: m[2] ?? m[1] });
    else if ((m = l.match(/^ip route (\S+) (\S+) (\S+)(?: (\d+))?/))) {
      const distance = m[4] ? Number(m[4]) : undefined;
      ios.routes.push(isIp(m[3]) ? { network: m[1], mask: m[2], via: m[3], distance } : { network: m[1], mask: m[2], iface: m[3], distance });
    } else if (/^ip nat inside source/.test(l) || /^ip nat pool/.test(l)) ios.natRules.push(l);
    else if ((m = l.match(/^ip default-gateway (\S+)/))) ios.defaultGateway = m[1];
    else if (l === 'ip classless' || /^no service (timestamps|password-encryption)/.test(l)) continue;
    else {
      const target = seenIf ? ios.extraPost : ios.extraPre;
      target.push(l);
      block = { kind: 'other', target };
    }
  }
  if (parsedLines.length) ios.lines = parsedLines;
  const keep = d.ios;
  if (keep?.vlans) ios.vlans = keep.vlans;
  if (keep?.rsaBits) ios.rsaBits = keep.rsaBits;
  if (keep?.startup !== undefined) ios.startup = keep.startup;
  d.ios = ios;
  d.name = d.name || ios.hostname;
}

/**
 * Running-config as a list of lines. A multi-line banner is a single entry (Packet Tracer keeps it in
 * one <LINE>); `delim` is the character shown around it.
 */
export function runningConfigLines(d: Device, delim = '^C'): string[] {
  const s = d.ios ?? emptyIos(d.name);
  const out: string[] = [
    '!',
    `version ${d.kind === 'switch' ? '15.0' : '15.1'}`,
    'no service timestamps log datetime msec',
    'no service timestamps debug datetime msec',
    s.pwEncrypt ? 'service password-encryption' : 'no service password-encryption',
    '!',
    `hostname ${s.hostname}`,
    '!',
  ];
  if (s.enableSecret) out.push(`enable secret 5 ${s.enableSecret.startsWith('$1$') ? s.enableSecret : md5crypt(s.enableSecret)}`);
  if (s.enablePassword) out.push(`enable password ${s.enablePassword}`);
  if (s.enableSecret || s.enablePassword) out.push('!');
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
    if (i.dot1q !== undefined) out.push(` encapsulation dot1Q ${i.dot1q}${i.extra?.includes('encapsulation-native') ? ' native' : ''}`);
    if (i.accessVlan && i.accessVlan !== 1) out.push(` switchport access vlan ${i.accessVlan}`);
    if (i.nativeVlan && i.nativeVlan !== 1) out.push(` switchport trunk native vlan ${i.nativeVlan}`);
    if (i.allowedVlans) out.push(` switchport trunk allowed vlan ${i.allowedVlans}`);
    if (i.swMode) out.push(` switchport mode ${i.swMode}`);
    if (i.ip && i.mask) out.push(` ip address ${i.ip} ${i.mask}`);
    else if ((d.kind === 'router' && !/^\D+\d+\/\d+\/\d+$/.test(i.name)) || i.name.startsWith('Vlan')) out.push(' no ip address');
    if (i.natRole) out.push(` ip nat ${i.natRole}`);
    for (const e of i.extra ?? []) if (e !== 'encapsulation-native') out.push(` ${e}`);
    if (i.shutdown) out.push(' shutdown');
    out.push('!');
  }
  if (s.defaultGateway) out.push(`ip default-gateway ${s.defaultGateway}`, '!');
  if (d.kind === 'router') out.push('ip classless');
  for (const r of s.routes) out.push(`ip route ${r.network} ${r.mask} ${r.via ?? r.iface}${r.distance ? ` ${r.distance}` : ''}`);
  for (const r of s.natRules) out.push(r);
  out.push('!');
  for (const l of s.extraPost) out.push(l);
  if (s.motd !== undefined) out.push(`banner motd ${delim}\n${s.motd}\n${delim}`, '!');
  out.push('!');
  const lines = s.lines ?? defaultLines(d);
  const lastVty = lines.filter((x) => x.name.startsWith('vty')).at(-1);
  for (const l of lines) {
    out.push(`line ${l.name}`);
    for (const c of l.cmds) out.push(` ${c}`);
    if (!l.name.startsWith('vty') || l === lastVty) out.push('!');
  }
  out.push('!', 'end');
  return out;
}

export const runningConfig = (d: Device) => runningConfigLines(d).join('\n');

/** lines for writing into a .pkt (banner delimiter as Packet Tracer stores it) */
export const runningConfigForPkt = (d: Device) => runningConfigLines(d, PT_DELIM);

/** Put the device back to its startup-config (or factory defaults), as a reload does. */
export function loadConfig(d: Device, text: string | undefined) {
  const keep = d.ios;
  d.ifaces = d.ifaces.filter((i) => i.media !== 'virtual' || (d.kind === 'switch' && i.name === 'Vlan1'));
  for (const i of d.ifaces) {
    i.ip = undefined;
    i.mask = undefined;
    i.description = undefined;
    i.natRole = undefined;
    i.extra = undefined;
    i.swMode = undefined;
    i.accessVlan = undefined;
    i.nativeVlan = undefined;
    i.allowedVlans = undefined;
    i.dot1q = undefined;
    if (i.media !== 'wireless') i.shutdown = d.kind === 'router' || i.name === 'Vlan1';
  }
  if (text) parseRunningConfig(text, d);
  else d.ios = emptyIos(d.kind === 'switch' ? 'Switch' : 'Router');
  d.name = d.ios!.hostname;
  d.ios!.vlans = keep?.vlans;
  d.ios!.rsaBits = keep?.rsaBits;
  d.ios!.startup = keep?.startup;
}

/* ================================================================== */
/*  CLI session                                                        */
/* ================================================================== */

export type Mode = 'user' | 'priv' | 'config' | 'if' | 'pool' | 'line' | 'router' | 'vlan' | 'acl';

type Pending =
  | { kind: 'press-return' }
  | { kind: 'login'; tries: number }
  | { kind: 'login-user'; tries: number }
  | { kind: 'login-pass'; tries: number; user: string }
  | { kind: 'enable'; tries: number }
  | { kind: 'confirm'; text: string; action: 'reload' | 'erase' }
  | { kind: 'copy'; text: string; to: 'startup' | 'running' }
  | { kind: 'banner'; delim: string; body: string[] }
  | { kind: 'rsa' };

export interface Session {
  mode: Mode;
  iface?: string[];
  pool?: string;
  /** line block names being configured, e.g. ["vty 0 4"] */
  line?: string[];
  /** router block header, e.g. "router ospf 1" */
  router?: string;
  vlan?: number[];
  /** named ACL being edited, e.g. "ip access-list extended WEB" */
  acl?: string;
  history: string[];
  pending?: Pending;
  /** a Telnet/SSH session into this device (instead of the console) */
  vty?: { ip: string; proto: 'telnet' | 'ssh' };
  /** set when a remote session has ended */
  closed?: boolean;
}

export const newSession = (): Session => ({ mode: 'user', history: [] });

/** A fresh console session; asks for RETURN first when the console has a login or a banner. */
export function startSession(d: Device): Session {
  const s = newSession();
  if (d.ios && (d.ios.motd !== undefined || consoleLogin(d) !== null)) s.pending = { kind: 'press-return' };
  return s;
}

/** true while the terminal should hide what's typed (password prompts) */
export const isSecretInput = (s: Session) =>
  s.pending?.kind === 'login' || s.pending?.kind === 'login-pass' || s.pending?.kind === 'enable';

const isSubIf = (s: Session) => s.mode === 'if' && s.iface?.length === 1 && s.iface[0].includes('.');

export function prompt(d: Device, s: Session) {
  const h = d.ios?.hostname ?? d.name;
  switch (s.pending?.kind) {
    case 'press-return':
      return '';
    case 'login':
    case 'login-pass':
    case 'enable':
      return 'Password: ';
    case 'login-user':
      return 'Username: ';
    case 'confirm':
    case 'copy':
      return s.pending.text;
    case 'banner':
      return '';
    case 'rsa':
      return 'How many bits in the modulus [512]: ';
  }
  switch (s.mode) {
    case 'user':
      return `${h}>`;
    case 'priv':
      return `${h}#`;
    case 'config':
      return `${h}(config)#`;
    case 'if':
      return isSubIf(s) ? `${h}(config-subif)#` : `${h}(config-if${s.iface && s.iface.length > 1 ? '-range' : ''})#`;
    case 'pool':
      return `${h}(dhcp-config)#`;
    case 'line':
      return `${h}(config-line)#`;
    case 'router':
      return `${h}(config-router)#`;
    case 'vlan':
      return `${h}(config-vlan)#`;
    case 'acl':
      return `${h}(config-${s.acl?.includes(' extended ') ? 'ext' : 'std'}-nacl)#`;
  }
}

/* ================================================================== */
/*  Commands                                                           */
/* ================================================================== */

interface Ctx {
  p: Project;
  d: Device;
  s: Session;
  ios: IosState;
  negate: boolean;
  line: string;
}

const INCOMPLETE = '% Incomplete command.\n';
const sw = (d: Device) => d.kind === 'switch';

const DESC: Record<string, string> = {
  enable: 'Turn on privileged commands',
  disable: 'Turn off privileged commands',
  exit: 'Exit from the current mode',
  logout: 'Exit from the EXEC',
  end: 'Exit to privileged mode',
  ping: 'Send echo messages',
  traceroute: 'Trace route to destination',
  show: 'Show running system information',
  configure: 'Enter configuration mode',
  terminal: 'Configure from the terminal',
  copy: 'Copy from one file to another',
  'running-config': 'Current operating configuration',
  'startup-config': 'Contents of startup configuration',
  write: 'Write running configuration to memory',
  memory: 'Write to NV memory',
  erase: 'Erase a filesystem',
  reload: 'Halt and perform a cold restart',
  clear: 'Reset functions',
  clock: 'Manage the system clock',
  debug: 'Debugging functions',
  undebug: 'Disable debugging functions',
  do: 'Run an exec command',
  no: 'Negate a command or set its defaults',
  hostname: 'Set system name',
  secret: 'Assign the privileged level secret',
  password: 'Assign a password',
  service: 'Modify use of network based services',
  'password-encryption': 'Encrypt system passwords',
  banner: 'Define a login banner',
  motd: 'Set Message of the Day banner',
  username: 'Establish user name authentication',
  privilege: 'Set user privilege level',
  ip: 'Global IP configuration subcommands',
  ipv6: 'Global IPv6 configuration commands',
  interface: 'Select an interface to configure',
  range: 'interface range command',
  line: 'Configure a terminal line',
  console: 'Primary terminal line',
  vty: 'Virtual terminal',
  aux: 'Auxiliary line',
  router: 'Enable a routing process',
  vlan: 'VLAN commands',
  name: 'Ascii name of the VLAN',
  route: 'Establish static routes',
  'default-gateway': 'Specify default gateway (if not routing IP)',
  'domain-name': 'Define the default domain name',
  'domain-lookup': 'Enable IP Domain Name System hostname translation',
  'name-server': 'Specify address of name server to use',
  dhcp: 'Configure DHCP server and relay parameters',
  pool: 'Configure DHCP address pools',
  'excluded-address': 'Prevent DHCP from assigning certain addresses',
  nat: 'NAT configuration commands',
  ssh: 'Configure ssh options',
  version: 'Specify protocol version',
  crypto: 'Encryption module',
  key: 'Long term key operations',
  generate: 'Generate new keys',
  rsa: 'Generate RSA keys',
  'unicast-routing': 'Enable unicast routing',
  address: 'Set the IP address of an interface',
  shutdown: 'Shutdown the selected interface',
  description: 'Interface specific description',
  duplex: 'Configure duplex operation',
  speed: 'Configure speed operation',
  switchport: 'Set switching mode characteristics',
  mode: 'Set trunking mode of the interface',
  access: 'Set access mode characteristics of the interface',
  trunk: 'Set trunking characteristics of the interface',
  native: 'Set native VLAN when interface is in trunking mode',
  allowed: 'Set allowed VLAN characteristics when interface is in trunking mode',
  encapsulation: 'Set encapsulation type for an interface',
  dot1Q: 'IEEE 802.1Q Virtual LAN',
  login: 'Enable password checking',
  local: 'Local password checking',
  transport: 'Define transport protocols for line',
  input: 'Define which protocols to use when connecting to the terminal server',
  'exec-timeout': 'Set the EXEC timeout',
  logging: 'Modify message logging facilities',
  synchronous: 'Synchronized message output',
  network: 'Enable routing on an IP network',
  'default-router': 'Default routers',
  'dns-server': 'DNS servers',
  'passive-interface': 'Suppress routing updates on an interface',
  'router-id': 'router-id for this OSPF process',
  'auto-summary': 'Enable automatic network number summarization',
  interfaces: 'Interface status and configuration',
  brief: 'Brief summary of IP status and configuration',
  history: 'Display the session command history',
  arp: 'ARP table',
  'mac-address-table': 'MAC forwarding table',
  'access-list': 'Add an access list entry',
  'spanning-tree': 'Spanning Tree Subsystem',
  cdp: 'Global CDP configuration subcommands',
  ntp: 'Configure NTP',
  'helper-address': 'Specify a destination address for UDP broadcasts',
  'link-local': 'Use link-local address',
  autoconfig: 'Obtain address using autoconfiguration',
  rip: 'Routing Information Protocol (RIP)',
  ospf: 'Open Shortest Path First (OSPF)',
  eigrp: 'Enhanced Interior Gateway Routing Protocol (EIGRP)',
  inside: 'Inside interface for address translation',
  outside: 'Outside interface for address translation',
  security: 'Infra Security CLIs',
};

const G = new Grammar<Ctx>(DESC);

/* ---------- helpers ---------- */

function resolveIfaces(d: Device, spec: string, create: boolean): Iface[] | string {
  const cleaned = spec.replace(/\s*-\s*/g, '-').replace(/\s*,\s*/g, ',');
  const parts = cleaned.split(',').map((x) => x.replace(/\s+/g, ''));
  const out: Iface[] = [];
  let lastPrefix = '';
  for (const part of parts) {
    const m = part.match(/^([a-zA-Z-]*)([\d/.:]+?)(?:-(\d+))?$/);
    if (!m) return '% Invalid interface type and number';
    const word = m[1] || lastPrefix;
    const full = word ? (IF_TYPES.find((t) => t.toLowerCase() === word.toLowerCase()) ?? IF_TYPES.find((t) => t.toLowerCase().startsWith(word.toLowerCase()))) : undefined;
    if (!full) return '% Invalid interface type and number';
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
      if (!i && create) {
        if (/^(Vlan|Loopback|Tunnel)/.test(full)) {
          i = { name: n, media: 'virtual', speed: 0, mac: randomMac(), shutdown: false };
          d.ifaces.push(i);
        } else if (n.includes('.') && d.kind === 'router') {
          const parent = d.ifaces.find((x) => x.name.toLowerCase() === n.split('.')[0].toLowerCase());
          if (parent) {
            i = { name: `${parent.name}.${n.split('.')[1]}`, media: 'virtual', speed: parent.speed, mac: parent.mac, shutdown: false };
            d.ifaces.splice(d.ifaces.indexOf(parent) + 1 + d.ifaces.filter((x) => x.name.startsWith(parent.name + '.')).length, 0, i);
          }
        }
      }
      if (!i) return '% Invalid interface type and number';
      out.push(i);
    }
  }
  return out;
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length));
const short = (n: string) => n.replace('GigabitEthernet', 'Gig').replace('FastEthernet', 'Fa').replace('Ethernet', 'Eth');
const now = () => {
  const t = new Date();
  return `*${t.toUTCString().slice(8, 11)} ${t.getUTCDate()} ${t.toISOString().slice(11, 23)}`;
};

/** remembers which addresses each device has already ARPed, for the classic ".!!!!" */
const arpSeen = new Map<string, Set<string>>();

function linkMsg(i: Iface, state: 'up' | 'down' | 'admin', proto: boolean) {
  const link = state === 'admin' ? 'administratively down' : state;
  let out = `\n%LINK-5-CHANGED: Interface ${i.name}, changed state to ${link}\n`;
  if (proto) out += `\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${i.name}, changed state to ${state === 'up' ? 'up' : 'down'}\n`;
  return out;
}

function vlanUp(p: Project, d: Device, vid: number) {
  const t = buildTopo(p);
  return d.ifaces.some((i) => i.media !== 'virtual' && !i.shutdown && (i.swMode === 'trunk' || (i.accessVlan ?? 1) === vid) && ifaceStatus(p, t, d, i).line);
}

/* ---------- show ---------- */

function showIpIntBrief(p: Project, d: Device) {
  const t = buildTopo(p);
  const rows = [pad('Interface', 27) + pad('IP-Address', 16) + pad('OK?', 4) + pad('Method', 7) + pad('Status', 22) + 'Protocol'];
  for (const i of d.ifaces) {
    if (i.media === 'wireless') continue;
    const [admin, line] = ifState(p, t, d, i);
    rows.push(pad(i.name, 27) + pad(i.ip ?? 'unassigned', 16) + pad('YES', 4) + pad(i.ip ? 'manual' : 'unset', 7) + pad(admin, 22) + line);
  }
  return rows.join('\n') + '\n';
}

function ifState(p: Project, t: ReturnType<typeof buildTopo>, d: Device, i: Iface): [string, string] {
  if (i.shutdown) return ['administratively down', 'down'];
  if (i.name.startsWith('Vlan')) {
    const up = vlanUp(p, d, Number(i.name.slice(4)));
    return [up ? 'up' : 'down', up ? 'up' : 'down'];
  }
  if (i.name.includes('.')) {
    const parent = d.ifaces.find((x) => x.name === i.name.split('.')[0]);
    return parent ? ifState(p, t, d, parent) : ['down', 'down'];
  }
  if (i.media === 'virtual') return ['up', 'up'];
  const st = ifaceStatus(p, t, d, i);
  return st.line ? ['up', 'up'] : ['down', 'down'];
}

function v6addrs(i: Iface) {
  return (i.extra ?? []).map((e) => e.match(/^ipv6 address (\S+)(?: (link-local|eui-64))?$/)).filter((m): m is RegExpMatchArray => !!m && m[1] !== 'autoconfig' && m[1] !== 'dhcp');
}

function eui64LinkLocal(mac: string) {
  const h = mac.replace(/[.:-]/g, '').toLowerCase();
  const b = h.match(/../g)!.map((x) => parseInt(x, 16));
  b[0] ^= 2;
  const w = [b[0] << 8 | b[1], b[2] << 8 | 0xff, 0xfe << 8 | b[3], b[4] << 8 | b[5]];
  return 'FE80::' + w.map((x) => x.toString(16).toUpperCase()).join(':');
}

function showIpv6IntBrief(p: Project, d: Device) {
  const t = buildTopo(p);
  const out: string[] = [];
  for (const i of d.ifaces) {
    if (i.media === 'wireless') continue;
    const [admin, line] = ifState(p, t, d, i);
    out.push(pad(i.name, 26) + `[${admin === 'administratively down' ? 'administratively down' : admin}/${line}]`);
    const addrs = v6addrs(i);
    const ll = addrs.find((a) => a[2] === 'link-local')?.[1];
    const enabled = addrs.length || (i.extra ?? []).some((e) => /^ipv6 (enable|address)/.test(e));
    if (!enabled) out.push('    unassigned');
    else {
      out.push(`    ${(ll ?? eui64LinkLocal(i.mac)).toUpperCase()}`);
      for (const a of addrs) if (a[2] !== 'link-local') out.push(`    ${a[1].split('/')[0].toUpperCase()}`);
    }
  }
  return out.join('\n') + '\n';
}

function showIpRoute(p: Project, d: Device, only?: string) {
  if (d.kind === 'switch' && !d.ios?.extraPost.includes('ip routing')) {
    return d.ios?.defaultGateway ? `Default gateway is ${d.ios.defaultGateway}\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty\n` : 'Default gateway is not set\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty\n';
  }
  const t = buildTopo(p);
  const rib = (controlPlane(t).ribs.get(d.id) ?? []).filter((r) => !only || r.code.startsWith(only));
  const lines = only
    ? []
    : [
        'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
        '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
        '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
        '       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP',
        '       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area',
        '       * - candidate default, U - per-user static route, o - ODR',
        '       P - periodic downloaded static route',
        '',
      ];
  const def = rib.find((r) => r.network === '0.0.0.0' && r.mask === '0.0.0.0');
  if (!only) lines.push(def ? `Gateway of last resort is ${def.via ?? '0.0.0.0'} to network 0.0.0.0` : 'Gateway of last resort is not set', '');
  const ip = (s: string) => ipToNum(s);
  // group by classful major network, like IOS
  const groups = new Map<string, typeof rib>();
  for (const r of [...rib].sort((a, b) => ip(a.network) - ip(b.network) || maskToPrefix(a.mask) - maskToPrefix(b.mask) || (a.code === 'L' ? 1 : -1))) {
    const major = r.network === '0.0.0.0' ? '0.0.0.0' : intToIp(network(r.network, classfulMask(r.network)));
    (groups.get(major) ?? groups.set(major, []).get(major)!).push(r);
  }
  const fmt = (r: (typeof rib)[number], indent: boolean) => {
    const code = r.code.padEnd(indent ? 8 : 5);
    const dest = `${r.network}/${maskToPrefix(r.mask)}`;
    if (r.code === 'C' || r.code === 'L') return `${code}${dest} is directly connected, ${r.iface}`;
    if (!r.via) return `${code}${dest} is directly connected, ${r.iface}`;
    const tail = r.code.startsWith('S') ? '' : `, 00:00:${String(10 + (ip(r.via) % 40)).padStart(2, '0')}, ${r.iface}`;
    return `${code}${dest} [${r.ad}/${r.metric}] via ${r.via}${tail}`;
  };
  for (const [major, rs] of groups) {
    const cm = classfulMask(major);
    const subnets = rs.filter((r) => r.mask !== cm || r.network !== major);
    if (major !== '0.0.0.0' && subnets.length && !(rs.length === 1 && rs[0].mask === cm)) {
      const masks = new Set(rs.map((r) => r.mask));
      lines.push(
        masks.size > 1
          ? `     ${major}/${maskToPrefix(cm)} is variably subnetted, ${rs.length} subnets, ${masks.size} masks`
          : `     ${major}/${maskToPrefix(cm)} is subnetted, ${rs.length} subnets`,
      );
      // routes with several equal-cost next hops print the extra ones on their own lines
      let last = '';
      for (const r of rs) {
        const k = r.network + r.mask + r.code;
        lines.push(k === last && r.via ? `${' '.repeat(8 + `${r.network}/${maskToPrefix(r.mask)}`.length)} [${r.ad}/${r.metric}] via ${r.via}, 00:00:12, ${r.iface}` : fmt(r, true));
        last = k;
      }
    } else for (const r of rs) lines.push(fmt(r, false));
  }
  return lines.join('\n') + '\n';
}

const ipToNum = (s: string) => s.split('.').reduce((n, o) => n * 256 + Number(o), 0);

function showIpProtocols(p: Project, d: Device) {
  const pr = protocolsOf(d);
  const t = buildTopo(p);
  const cp = controlPlane(t);
  const out: string[] = [];
  const nbrs = (proto: 'ospf' | 'eigrp' | 'rip') =>
    cp.adj.filter((a) => a.proto === proto && (a.a.id === d.id || a.b.id === d.id)).map((a) => (a.a.id === d.id ? a.bIp : a.aIp));
  for (const o of pr.ospf) {
    out.push(`Routing Protocol is "ospf ${o.pid}"`, '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set');
    out.push(`  Router ID ${ospfRouterId(d, o)}`, `  Number of areas in this router is ${new Set(o.networks.map((n) => n.area)).size}. ${new Set(o.networks.map((n) => n.area)).size} normal 0 stub 0 nssa`, '  Maximum path: 4', '  Routing for Networks:');
    for (const n of o.networks) out.push(`    ${n.ip} ${n.wild} area ${n.area}`);
    if (o.passive.size) out.push(o.passiveDefault ? '  Passive Interface(s): (default)' : `  Passive Interface(s):`, ...[...o.passive].map((x) => `    ${d.ifaces.find((i) => i.name.toLowerCase() === x)?.name ?? x}`));
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    for (const ip of nbrs('ospf')) out.push(`    ${ip.padEnd(16)}110           00:00:12`);
    out.push('  Distance: (default is 110)', '');
  }
  for (const e of pr.eigrp) {
    out.push(`Routing Protocol is "eigrp  ${e.as} "`, '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set', '  Default networks flagged in outgoing updates', '  Default networks accepted from incoming updates', '  EIGRP metric weight K1=1, K2=0, K3=1, K4=0, K5=0', '  EIGRP maximum hopcount 100', '  EIGRP maximum metric variance 1', `  Automatic network summarization is ${e.autoSummary ? '' : 'not '}in effect`, '  Maximum path: 4', '  Routing for Networks:');
    for (const n of e.networks) out.push(`     ${n.ip}${n.wild ? ` ${n.wild}` : ''}`);
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    for (const ip of nbrs('eigrp')) out.push(`    ${ip.padEnd(16)}90            00:00:12`);
    out.push('  Distance: internal 90 external 170', '');
  }
  if (pr.rip) {
    const r = pr.rip;
    out.push('Routing Protocol is "rip"', 'Sending updates every 30 seconds, next due in 12 seconds', 'Invalid after 180 seconds, hold down 180, flushed after 240', '  Outgoing update filter list for all interfaces is not set', '  Incoming update filter list for all interfaces is not set', '  Redistributing: rip', `  Default version control: send version ${r.version}, receive ${r.version === 2 ? '2' : 'any version'}`);
    out.push(`  Automatic network summarization is ${r.autoSummary ? '' : 'not '}in effect`, '  Maximum path: 4', '  Routing for Networks:', ...r.networks.map((n) => `	${n}`));
    if (r.passive.size) out.push('  Passive Interface(s):', ...[...r.passive].map((x) => `	${d.ifaces.find((i) => i.name.toLowerCase() === x)?.name ?? x}`));
    out.push('  Routing Information Sources:', '	Gateway         Distance      Last Update');
    for (const ip of nbrs('rip')) out.push(`	${ip.padEnd(16)}120           00:00:12`);
    out.push('  Distance: (default is 120)', '');
  }
  return out.length ? out.join('\n') + '\n' : '';
}

/** OSPF neighbours as `show ip ospf neighbor` lists them (DR/BDR elected per multi-access link) */
function ospfNeighbors(p: Project, d: Device) {
  const t = buildTopo(p);
  const cp = controlPlane(t);
  const mine = cp.adj.filter((a) => a.proto === 'ospf' && (a.a.id === d.id || a.b.id === d.id));
  const rows = ['', 'Neighbor ID     Pri   State           Dead Time   Address         Interface'];
  for (const a of mine) {
    const peer = a.a.id === d.id ? a.b : a.a;
    const myIf = a.a.id === d.id ? a.aIf : a.bIf;
    const peerIp = a.a.id === d.id ? a.bIp : a.aIp;
    const iface = d.ifaces.find((i) => i.name === myIf);
    let role = '-';
    if (iface?.media !== 'serial') {
      // everyone on this link, ranked by router ID (all priorities default to 1)
      const onLink = cp.adj.filter((x) => x.proto === 'ospf' && ((x.a.id === d.id && x.aIf === myIf) || (x.b.id === d.id && x.bIf === myIf)));
      const ids = [d, ...onLink.map((x) => (x.a.id === d.id ? x.b : x.a))].map((x) => ({ id: x.id, rid: ospfRouterId(x, protocolsOf(x).ospf[0]) }));
      ids.sort((x, y) => ipToNum(y.rid) - ipToNum(x.rid));
      role = ids[0].id === peer.id ? 'DR' : ids[1]?.id === peer.id ? 'BDR' : 'DROTHER';
    }
    rows.push(`${pad(ospfRouterId(peer, protocolsOf(peer).ospf[0]), 16)}${pad('1', 6)}${pad(`FULL/${role === '-' ? '  -' : role}`, 16)}${pad('00:00:3' + (ipToNum(peerIp) % 10), 12)}${pad(peerIp, 16)}${myIf}`);
  }
  return rows.join('\n') + '\n';
}

function eigrpNeighbors(p: Project, d: Device) {
  const t = buildTopo(p);
  const cp = controlPlane(t);
  const pr = protocolsOf(d).eigrp[0];
  const mine = cp.adj.filter((a) => a.proto === 'eigrp' && (a.a.id === d.id || a.b.id === d.id));
  const rows = [`IP-EIGRP neighbors for process ${pr?.as ?? 1}`, 'H   Address         Interface      Hold Uptime    SRTT   RTO   Q   Seq', '                                   (sec)          (ms)        Cnt  Num'];
  mine.forEach((a, k) => {
    const peerIp = a.a.id === d.id ? a.bIp : a.aIp;
    const myIf = a.a.id === d.id ? a.aIf : a.bIf;
    rows.push(`${pad(String(k), 4)}${pad(peerIp, 16)}${pad(short(myIf), 15)}${pad('14', 5)}00:01:2${k}   40     1000  0   ${10 + k}`);
  });
  return rows.join('\n') + '\n';
}

function showVlanBrief(d: Device) {
  const ios = d.ios!;
  const rows = ['', 'VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------'];
  for (const v of vlansOf(ios).slice().sort((a, b) => a.id - b.id)) {
    const ports = d.ifaces
      .filter((i) => i.media !== 'virtual' && i.media !== 'wireless' && i.swMode !== 'trunk' && (i.accessVlan ?? 1) === v.id)
      .map((i) => short(i.name));
    const status = v.id >= 1002 ? 'act/unsup' : 'active';
    const head = `${pad(String(v.id), 5)}${pad(v.name, 33)}${pad(status, 10)}`;
    if (!ports.length) rows.push(head.trimEnd());
    for (let k = 0; k < ports.length; k += 4) rows.push((k === 0 ? head : ' '.repeat(48)) + ports.slice(k, k + 4).join(', '));
  }
  return rows.join('\n') + '\n';
}

function showIntTrunk(p: Project, d: Device) {
  const t = buildTopo(p);
  const trunks = d.ifaces.filter((i) => i.swMode === 'trunk' && !i.shutdown && ifaceStatus(p, t, d, i).line);
  if (!trunks.length) return '';
  const out = ['Port        Mode         Encapsulation  Status        Native vlan'];
  for (const i of trunks) out.push(`${pad(short(i.name), 12)}${pad('on', 13)}${pad('802.1q', 15)}${pad('trunking', 14)}${i.nativeVlan ?? 1}`);
  out.push('', 'Port        Vlans allowed on trunk');
  for (const i of trunks) out.push(`${pad(short(i.name), 12)}${i.allowedVlans ?? '1-1005'}`);
  out.push('', 'Port        Vlans allowed and active in management domain');
  const ids = vlansOf(d.ios!).map((v) => v.id);
  for (const i of trunks) {
    const allowed = expandVlans(i.allowedVlans);
    out.push(`${pad(short(i.name), 12)}${compressVlans(ids.filter((v) => allowed === 'all' || allowed.includes(v)))}`);
  }
  return out.join('\n') + '\n';
}

function showInterfaces(p: Project, d: Device, only?: Iface) {
  const t = buildTopo(p);
  return d.ifaces
    .filter((i) => i.media !== 'wireless' && (!only || i === only))
    .map((i) => {
      const [admin, line] = ifState(p, t, d, i);
      const hw = i.media === 'virtual' ? (i.name.startsWith('Vlan') ? 'CPU Interface' : i.name.startsWith('Loopback') ? 'Loopback' : 'Virtual') : i.speed >= 1000 ? 'CN Gigabit Ethernet' : 'Lance';
      return (
        `${i.name} is ${admin}, line protocol is ${line}\n  Hardware is ${hw}, address is ${i.mac} (bia ${i.mac})\n` +
        (i.description ? `  Description: ${i.description}\n` : '') +
        (i.ip ? `  Internet address is ${i.ip}/${maskToPrefix(i.mask!)}\n` : '') +
        `  MTU 1500 bytes, BW ${(i.speed || 100) * 1000} Kbit, DLY ${i.speed >= 1000 ? 10 : 100} usec,\n     reliability 255/255, txload 1/255, rxload 1/255\n`
      );
    })
    .join('');
}

function iosPing(p: Project, d: Device, target: string) {
  if (!isIp(target)) return `% Unrecognized host or address, or protocol not running.\n\n`;
  const r = ping(p, d.id, target, { count: true });
  const seen = arpSeen.get(d.id) ?? arpSeen.set(d.id, new Set()).get(d.id)!;
  const cold = r.ok && !seen.has(target);
  if (r.ok) seen.add(target);
  const marks = r.ok ? (cold ? '.!!!!' : '!!!!!') : r.unreachFrom ? 'U.U.U' : '.....';
  const ok = r.ok ? (cold ? 4 : 5) : 0;
  return (
    `Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:\n${marks}\n` +
    `Success rate is ${ok * 20} percent (${ok}/5)${ok ? `, round-trip min/avg/max = 0/${r.hops.length}/${r.hops.length * 2} ms` : ''}\n\n`
  );
}

function iosTrace(p: Project, d: Device, target: string) {
  if (!isIp(target)) return `% Unrecognized host or address, or protocol not running.\n\n`;
  const r = ping(p, d.id, target);
  const out = [`Type escape sequence to abort.`, `Tracing the route to ${target}`, ''];
  let n = 1;
  for (const h of r.routers) out.push(`  ${n++}   ${h.ip}\t0 msec\t0 msec\t1 msec`);
  if (r.ok) out.push(`  ${n}   ${target}\t1 msec\t0 msec\t0 msec`);
  else for (let k = 0; k < 3; k++) out.push(`  ${n++}   *     *     *`);
  return out.join('\n') + '\n';
}

/* ---------- block helpers for router config kept in extraPost ---------- */

function blockLines(list: string[], header: string) {
  const at = list.indexOf(header);
  if (at < 0) return null;
  let end = at + 1;
  while (end < list.length && list[end].startsWith(' ')) end++;
  return { at, end };
}

function blockEdit(list: string[], header: string, cmd: string, negate: boolean) {
  let b = blockLines(list, header);
  if (!b) {
    list.push(header);
    b = { at: list.length - 1, end: list.length };
  }
  const body = list.slice(b.at + 1, b.end);
  const line = ` ${cmd}`;
  const without = body.filter((l) => l !== line);
  const next = negate ? without : [...without, line];
  list.splice(b.at + 1, b.end - b.at - 1, ...next);
}

/* ---------- line config ---------- */

function lineSet(ctx: Ctx, edit: (cmds: string[]) => string[]) {
  const all = linesOf(ctx.d, ctx.ios);
  for (const name of ctx.s.line ?? []) {
    const l = all.find((x) => x.name === name);
    if (l) l.cmds = edit(l.cmds);
  }
}

const replaceCmd = (prefix: RegExp, value?: string) => (cmds: string[]) => {
  const rest = cmds.filter((c) => !prefix.test(c));
  if (value === undefined) return rest;
  // IOS keeps password before login, transport after
  const order = ['exec-timeout', 'privilege', 'logging', 'password', 'login', 'transport'];
  const out = [...rest, value];
  const rank = (c: string) => {
    const k = order.findIndex((o) => c.startsWith(o));
    return k < 0 ? order.length : k;
  };
  return out.sort((a, b) => rank(a) - rank(b));
};

/* ---------- registration ---------- */

const cmd = (fn: (c: Ctx, a: ParsedArgs) => string | void) => fn;
const store = (where: 'pre' | 'post') =>
  cmd((c, a) => {
    const line = a.canonical;
    const list = where === 'pre' ? c.ios.extraPre : c.ios.extraPost;
    const head = line.split(' ').slice(0, 2).join(' ');
    if (c.negate) {
      // drop the matching line (or every line of that command family)
      const exact = list.indexOf(line);
      if (exact >= 0) list.splice(exact, 1);
      else for (let k = list.length - 1; k >= 0; k--) if (list[k].startsWith(head)) list.splice(k, 1);
      return;
    }
    const neg = list.indexOf(`no ${line}`);
    if (neg >= 0) list.splice(neg, 1);
    if (!list.includes(line)) list.push(line);
  });

const ifStore = cmd((c, a) => {
  for (const i of curIfaces(c)) {
    const line = a.canonical;
    const fam = line.split(' ').slice(0, line.startsWith('ipv6 address') || line.startsWith('ip helper') ? 99 : 2).join(' ');
    i.extra = (i.extra ?? []).filter((e) => (c.negate ? !e.startsWith(fam) && e !== line : !e.startsWith(fam + ' ') && e !== fam));
    if (!c.negate) i.extra.push(line);
  }
});

const curIfaces = (c: Ctx) => (c.s.iface ?? []).map((n) => c.d.ifaces.find((i) => i.name === n)!).filter(Boolean);

const showCmds = (priv: boolean): CmdSpec<Ctx>[] => {
  const S = (pattern: string, run: CmdSpec<Ctx>['run'], hidden = false): CmdSpec<Ctx> => ({ pattern: `show ${pattern}`, run, hidden });
  const list: CmdSpec<Ctx>[] = [
    S('ip interface brief', (c) => showIpIntBrief(c.p, c.d)),
    S('ip interface', (c) => showIpIntBrief(c.p, c.d), true),
    S('ip route', (c) => showIpRoute(c.p, c.d)),
    S('ip route static', (c) => showIpRoute(c.p, c.d, 'S')),
    S('ip route connected', (c) => showIpRoute(c.p, c.d, 'C')),
    S('ip route ospf', (c) => showIpRoute(c.p, c.d, 'O')),
    S('ip route rip', (c) => showIpRoute(c.p, c.d, 'R')),
    S('ip route eigrp', (c) => showIpRoute(c.p, c.d, 'D')),
    S('ip protocols', (c) => showIpProtocols(c.p, c.d)),
    S('ip ospf neighbor', (c) => ospfNeighbors(c.p, c.d)),
    S('ip ospf', (c) => {
      const o = protocolsOf(c.d).ospf[0];
      return o ? ` Routing Process "ospf ${o.pid}" with ID ${ospfRouterId(c.d, o)}\n Supports only single TOS(TOS0) routes\n Supports opaque LSA\n SPF schedule delay 5 secs, Hold time between two SPFs 10 secs\n Number of areas in this router is ${new Set(o.networks.map((n) => n.area)).size}. ${new Set(o.networks.map((n) => n.area)).size} normal 0 stub 0 nssa\n Reference bandwidth unit is ${o.refBw} mbps\n` : '';
    }),
    S('ip eigrp neighbors', (c) => eigrpNeighbors(c.p, c.d)),
    S('ip dhcp binding', (c) => {
      const rows = ['IP address       Client-ID/              Lease expiration        Type', '                 Hardware address'];
      for (const l of c.ios.leases) rows.push(`${pad(l.ip, 17)}${pad(l.mac, 24)}--                      Automatic`);
      return rows.join('\n') + '\n';
    }),
    S('ip dhcp pool', (c) =>
      c.ios.pools.map((pl) => `\nPool ${pl.name} :\n Utilization mark (high/low)    : 100 / 0\n Subnet size (first/next)       : 0 / 0 \n Total addresses                : ${pl.mask ? 2 ** (32 - maskToPrefix(pl.mask)) - 2 : 0}\n Leased addresses               : ${c.ios.leases.length}\n Excluded addresses             : ${c.ios.excluded.length}\n Pending event                  : none\n`).join('') || '\n',
    ),
    S('ip nat translations', () => 'Pro  Inside global     Inside local       Outside local      Outside global\n'),
    S('ip ssh', (c) => (c.ios.rsaBits ? `SSH Enabled - version ${c.ios.extraPre.includes('ip ssh version 2') || c.ios.extraPost.includes('ip ssh version 2') ? '2.0' : '1.99'}\nAuthentication timeout: 120 secs; Authentication retries: 3\n` : '%SSH has not been enabled\n')),
    S('ipv6 interface brief', (c) => showIpv6IntBrief(c.p, c.d)),
    S('interfaces', (c) => showInterfaces(c.p, c.d)),
    S('interfaces IFACE', (c, a) => {
      const n = ifaceName(a.v[0]);
      const i = c.d.ifaces.find((x) => x.name.toLowerCase() === n?.toLowerCase());
      return i ? showInterfaces(c.p, c.d, i) : '% Invalid interface type and number\n';
    }),
    S('version', (c) => `Cisco IOS Software emulated by NetForge, ${c.d.model}\n\n${c.ios.hostname} uptime is 1 hours, 2 minutes\nSystem image file is "flash:"\n\n${c.d.model} processor with 512K bytes of memory.\n${c.d.ifaces.filter((i) => i.media !== 'virtual').length} network interface(s)\nConfiguration register is 0x2102\n`),
    S('history', (c) => c.s.history.map((h) => `  ${h}`).join('\n') + '\n'),
    S('clock', () => `${now()} UTC ${new Date().toUTCString().slice(0, 3)} ${new Date().toUTCString().slice(8, 16)}\n`),
    S('arp', (c) => {
      const rows = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
      for (const i of c.d.ifaces) if (i.ip) rows.push(`Internet  ${pad(i.ip, 17)}-          ${pad(i.mac, 16)}ARPA   ${i.name}`);
      return rows.join('\n') + '\n';
    }),
    S('users', () => '    Line       User       Host(s)              Idle       Location\n*  0 con 0                idle                 00:00:00 \n'),
    S('flash:', (c) => `System flash directory:\nFile  Length   Name/status\n  1  33591768 ${c.d.model.toLowerCase()}.bin\n[33591768 bytes used, 30424616 available, 64016384 total]\n`),
    S('protocols', (c) => `Global values:\n  Internet Protocol routing is ${c.d.kind === 'router' ? 'enabled' : 'disabled'}\n` + c.d.ifaces.filter((i) => i.media !== 'wireless').map((i) => `${i.name} is ${i.shutdown ? 'administratively down' : 'up'}, line protocol is ${i.shutdown ? 'down' : 'up'}\n${i.ip ? `  Internet address is ${i.ip}/${maskToPrefix(i.mask!)}\n` : ''}`).join('')),
    S('access-lists', (c) => showAccessLists(c.d)),
    S('access-lists WORD', (c, a) => showAccessLists(c.d, a.v[0])),
    S('ip access-lists', (c) => showAccessLists(c.d)),
    S('vlan brief', (c) => (sw(c.d) ? showVlanBrief(c.d) : caretError(prompt(c.d, c.s).length, c.line, 1))),
    S('vlan', (c) => (sw(c.d) ? showVlanBrief(c.d) : caretError(prompt(c.d, c.s).length, c.line, 1))),
    S('interfaces trunk', (c) => (sw(c.d) ? showIntTrunk(c.p, c.d) : caretError(prompt(c.d, c.s).length, c.line, 2))),
    S('mac address-table', () => '          Mac Address Table\n-------------------------------------------\n\nVlan    Mac Address       Type        Ports\n----    -----------       --------    -----\n\n'),
    S('cdp neighbors', () => 'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge\n                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone\nDevice ID    Local Intrfce   Holdtme    Capability   Platform    Port ID\n'),
  ];
  if (priv) {
    list.push(
      S('running-config', (c) => {
        const cfg = runningConfig(c.d);
        return `Building configuration...\n\nCurrent configuration : ${cfg.length} bytes\n${cfg}\n\n`;
      }),
      S('startup-config', (c) => (c.ios.startup ? `Using ${c.ios.startup.length} bytes\n${c.ios.startup}\n\n` : 'startup-config is not present\n')),
      S('running-config interface IFACE', (c, a) => {
        const n = ifaceName(a.v[0])?.toLowerCase();
        const lines = runningConfigLines(c.d);
        const at = lines.findIndex((l) => l.toLowerCase() === `interface ${n}`);
        if (at < 0) return '% Invalid interface type and number\n';
        let end = at + 1;
        while (lines[end]?.startsWith(' ')) end++;
        return `Building configuration...\n\nCurrent configuration : 0 bytes\n!\n${lines.slice(at, end).join('\n')}\nend\n\n`;
      }),
    );
  }
  return list;
};

const swOnly = (c: Ctx) => (sw(c.d) ? null : caretError(prompt(c.d, c.s).length, c.line, 0));

function execCommon(user: boolean): CmdSpec<Ctx>[] {
  return [
    {
      pattern: 'enable',
      run: (c) => {
        if (c.s.mode === 'priv') return;
      if (c.s.vty && !c.ios.enableSecret && !c.ios.enablePassword) return '% No password set.\n';
      if (c.ios.enableSecret || c.ios.enablePassword) {
          c.s.pending = { kind: 'enable', tries: 0 };
          return '';
        }
        c.s.mode = 'priv';
      },
    },
    { pattern: 'disable', run: (c) => void (c.s.mode = 'user') },
    { pattern: 'exit', run: (c) => logout(c) },
    { pattern: 'logout', run: (c) => logout(c) },
    { pattern: 'ping A.B.C.D', run: (c, a) => iosPing(c.p, c.d, a.v[0]) },
    { pattern: 'ping WORD', run: (_c, a) => `Translating "${a.v[0]}"...domain server (255.255.255.255)\n% Unrecognized host or address, or protocol not running.\n\n` },
    { pattern: 'ping ip A.B.C.D', run: (c, a) => iosPing(c.p, c.d, a.v[0]), hidden: true },
    { pattern: 'traceroute A.B.C.D', run: (c, a) => iosTrace(c.p, c.d, a.v[0]) },
    { pattern: 'traceroute WORD', run: (_c, a) => `Translating "${a.v[0]}"...domain server (255.255.255.255)\n% Unrecognized host or address, or protocol not running.\n\n` },
    { pattern: 'terminal LINE', run: () => '' },
    ...showCmds(!user),
  ];
}

function logout(c: Ctx) {
  if (c.s.vty) {
    c.s.closed = true;
    return `\n[Connection to ${c.s.vty.ip} closed by foreign host]\n`;
  }
  c.s.mode = 'user';
  c.s.pending = { kind: 'press-return' };
  return `\n\n\n\n${c.ios.hostname} con0 is now available\n\n\n\n\n\nPress RETURN to get started.\n`;
}

G.add('user', execCommon(true));
G.add('priv', [
  ...execCommon(false),
  { pattern: 'configure terminal', run: (c) => ((c.s.mode = 'config'), 'Enter configuration commands, one per line.  End with CNTL/Z.\n') },
  { pattern: 'configure', run: (c) => ((c.s.mode = 'config'), 'Enter configuration commands, one per line.  End with CNTL/Z.\n'), hidden: true },
  {
    pattern: 'copy running-config startup-config',
    run: (c) => void (c.s.pending = { kind: 'copy', text: 'Destination filename [startup-config]? ', to: 'startup' }),
  },
  {
    pattern: 'copy startup-config running-config',
    run: (c) => void (c.s.pending = { kind: 'copy', text: 'Destination filename [running-config]? ', to: 'running' }),
  },
  { pattern: 'write memory', run: (c) => saveStartup(c) },
  { pattern: 'write', run: (c) => saveStartup(c) },
  { pattern: 'erase startup-config', run: (c) => void (c.s.pending = { kind: 'confirm', text: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', action: 'erase' }) },
  { pattern: 'write erase', run: (c) => void (c.s.pending = { kind: 'confirm', text: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', action: 'erase' }), hidden: true },
  { pattern: 'reload', run: (c) => void (c.s.pending = { kind: 'confirm', text: 'Proceed with reload? [confirm]', action: 'reload' }) },
  { pattern: 'clear access-list counters', run: (c) => void clearAclHits(c.d.id) },
  { pattern: 'clear LINE', run: () => '' },
  { pattern: 'clock set LINE', run: () => '' },
  { pattern: 'debug LINE', run: () => '' },
  { pattern: 'undebug LINE', run: () => '' },
  { pattern: 'delete LINE', run: () => '' },
]);

function saveStartup(c: Ctx) {
  c.ios.startup = runningConfig(c.d);
  return 'Building configuration...\n[OK]\n';
}

/* ---------------- global config ---------------- */

const cfgCommon: CmdSpec<Ctx>[] = [
  { pattern: 'end', run: (c) => ((c.s.mode = 'priv'), `\n%SYS-5-CONFIG_I: Configured from console by console\n`) },
  { pattern: 'exit', run: (c) => exitMode(c) },
  { pattern: 'do LINE', run: () => '' },
  { pattern: 'no', run: () => INCOMPLETE },
];

function exitMode(c: Ctx) {
  if (c.s.mode === 'config') {
    c.s.mode = 'priv';
    return `\n%SYS-5-CONFIG_I: Configured from console by console\n`;
  }
  c.s.mode = 'config';
  c.s.iface = c.s.pool = c.s.line = c.s.router = c.s.vlan = c.s.acl = undefined;
}

const setEnable = (kind: 'secret' | 'password', type?: string) =>
  cmd((c, a) => {
    if (c.negate) {
      if (kind === 'secret') c.ios.enableSecret = undefined;
      else c.ios.enablePassword = undefined;
      return;
    }
    const v = a.v[0];
    if (!v) return INCOMPLETE;
    if (kind === 'secret') c.ios.enableSecret = type === '5' ? v : md5crypt(v);
    else c.ios.enablePassword = type === '7' ? `7 ${v}` : pwValue(c.ios, v);
  });

function setUser(c: Ctx, a: ParsedArgs) {
  const [name, ...rest] = a.v;
  c.ios.extraPre = c.ios.extraPre.filter((l) => !l.startsWith(`username ${name} `));
  if (c.negate) return;
  const priv = a.kw.includes('privilege') ? ` privilege ${rest.shift()}` : '';
  const pw = rest[rest.length - 1];
  const line = a.kw.includes('secret') ? `username ${name}${priv} secret 5 ${md5crypt(pw)}` : `username ${name}${priv} password ${c.ios.pwEncrypt ? `7 ${type7Encode(pw)}` : `0 ${pw}`}`;
  // usernames sit with the other global lines, before interfaces
  c.ios.extraPre.push(line);
}

function enterIface(c: Ctx, a: ParsedArgs, range: boolean) {
  const spec = a.v[0];
  if (!range && !ifaceName(spec)) return '% Invalid interface type and number\n';
  const r = resolveIfaces(c.d, spec, !range);
  if (typeof r === 'string') return r + '\n';
  if (c.negate) {
    // only virtual interfaces can be removed
    for (const i of r) if (i.media === 'virtual') c.d.ifaces.splice(c.d.ifaces.indexOf(i), 1);
    return;
  }
  c.s.mode = 'if';
  c.s.iface = r.map((i) => i.name);
  c.s.pool = c.s.line = c.s.router = c.s.vlan = c.s.acl = undefined;
}

function enterLine(c: Ctx, kind: 'con' | 'aux' | 'vty', from: number, to?: number) {
  const all = linesOf(c.d, c.ios);
  const max = c.d.kind === 'switch' ? 15 : 4;
  if (kind === 'vty' && (from > max || (to ?? from) > max)) return caretError(prompt(c.d, c.s).length, c.line, 2);
  if (kind === 'aux' && c.d.kind === 'switch') return caretError(prompt(c.d, c.s).length, c.line, 1);
  const names: string[] = [];
  if (kind !== 'vty') names.push(`${kind} 0`);
  else {
    // map onto the existing vty blocks the range touches (like IOS's "line vty 0 15" on a switch)
    for (const l of all.filter((x) => x.name.startsWith('vty'))) {
      const [, a, b] = l.name.split(' ').map(Number);
      if ((to ?? from) >= a && from <= (b ?? a)) names.push(l.name);
    }
    if (!names.length) {
      const n = to !== undefined ? `vty ${from} ${to}` : `vty ${from}`;
      all.push({ name: n, cmds: [] });
      names.push(n);
    }
  }
  c.s.mode = 'line';
  c.s.line = names;
}

function enterRouter(c: Ctx, header: string) {
  if (c.negate) {
    const b = blockLines(c.ios.extraPost, header);
    if (b) c.ios.extraPost.splice(b.at, b.end - b.at);
    return;
  }
  if (!blockLines(c.ios.extraPost, header)) c.ios.extraPost.push(header);
  c.s.mode = 'router';
  c.s.router = header;
}

function vlanCmd(c: Ctx, a: ParsedArgs) {
  const err = swOnly(c);
  if (err) return err;
  const ids = expandVlans(a.v[0]);
  if (ids === 'all') return INCOMPLETE;
  if (ids.some((v) => v < 1 || v > 4094)) return '% Command rejected.  Bad vlan range.  Supported vlan range is 1 to 4094.\n';
  const vl = vlansOf(c.ios);
  if (c.negate) {
    if (ids.some((v) => v === 1 || v >= 1002)) return '%Default VLAN 1 may not be deleted.\n';
    c.ios.vlans = vl.filter((v) => !ids.includes(v.id));
    return;
  }
  for (const id of ids) if (!vl.some((v) => v.id === id)) vl.push({ id, name: vlanName(id) });
  c.s.mode = 'vlan';
  c.s.vlan = ids;
}

function crypto(c: Ctx, bits?: number) {
  if (c.negate) return;
  if (/^(Router|Switch)$/.test(c.ios.hostname)) return `% Please define a hostname other than ${c.ios.hostname}.\n`;
  const dom = [...c.ios.extraPre, ...c.ios.extraPost].find((l) => l.startsWith('ip domain-name '))?.slice(15);
  if (!dom) return '% Please define a domain-name first.\n';
  const head = `The name for the keys will be: ${c.ios.hostname}.${dom}\n`;
  if (bits === undefined) {
    c.s.pending = { kind: 'rsa' };
    return (
      head +
      'Choose the size of the key modulus in the range of 360 to 4096 for your\n  General Purpose Keys. Choosing a key modulus greater than 512 may take\n  a few minutes.\n\n'
    );
  }
  return head + rsaDone(c.ios, bits);
}

function rsaDone(ios: IosState, bits: number) {
  const had = !!ios.rsaBits;
  ios.rsaBits = bits;
  return `% Generating ${bits} bit RSA keys, keys will be non-exportable...[OK]\n${had ? '' : `${now()}: %SSH-5-ENABLED: SSH 1.99 has been enabled\n`}`;
}

const cfgGlobal: CmdSpec<Ctx>[] = [
  ...cfgCommon,
  {
    pattern: 'hostname WORD',
    run: (c, a) => {
      if (c.negate) a.v[0] = c.d.kind === 'switch' ? 'Switch' : 'Router';
      c.ios.hostname = a.v[0];
      c.d.name = a.v[0];
    },
  },
  { pattern: 'hostname', run: (c) => (c.negate ? void ((c.ios.hostname = c.d.kind === 'switch' ? 'Switch' : 'Router'), (c.d.name = c.ios.hostname)) : INCOMPLETE), hidden: true },
  { pattern: 'enable secret WORD', run: setEnable('secret') },
  { pattern: 'enable secret 0 WORD', run: setEnable('secret', '0'), hidden: true },
  { pattern: 'enable secret 5 WORD', run: setEnable('secret', '5'), hidden: true },
  { pattern: 'enable secret', run: setEnable('secret'), hidden: true },
  { pattern: 'enable password WORD', run: setEnable('password') },
  { pattern: 'enable password 0 WORD', run: setEnable('password', '0'), hidden: true },
  { pattern: 'enable password 7 WORD', run: setEnable('password', '7'), hidden: true },
  { pattern: 'enable password', run: setEnable('password'), hidden: true },
  {
    pattern: 'service password-encryption',
    run: (c) => {
      c.ios.pwEncrypt = !c.negate;
      if (c.negate) return;
      // IOS encrypts everything already in the config right away
      if (c.ios.enablePassword && !c.ios.enablePassword.startsWith('7 ')) c.ios.enablePassword = `7 ${type7Encode(c.ios.enablePassword)}`;
      for (const l of linesOf(c.d, c.ios)) l.cmds = l.cmds.map((x) => x.replace(/^password (?!7 )(?:0 )?(.+)$/, (_, pw) => `password 7 ${type7Encode(pw)}`));
      c.ios.extraPre = c.ios.extraPre.map((x) => x.replace(/^(username \S+(?: privilege \d+)?) password 0 (.+)$/, (_, h, pw) => `${h} password 7 ${type7Encode(pw)}`));
    },
  },
  { pattern: 'service LINE', run: () => '' },
  {
    pattern: 'banner motd LINE',
    run: (c) => {
      if (c.negate) {
        c.ios.motd = undefined;
        return;
      }
      const raw = c.line.replace(/^\s*(no\s+)?\S+\s+\S+\s+/, '');
      const delim = raw[0];
      const rest = raw.slice(1);
      const close = rest.indexOf(delim);
      if (close >= 0) {
        c.ios.motd = rest.slice(0, close);
        return;
      }
      c.s.pending = { kind: 'banner', delim, body: rest ? [rest] : [] };
      return `Enter TEXT message.  End with the character '${delim}'.\n`;
    },
  },
  { pattern: 'banner motd', run: (c) => (c.negate ? void (c.ios.motd = undefined) : INCOMPLETE), hidden: true },
  { pattern: 'username WORD password WORD', run: setUser },
  { pattern: 'username WORD password 0 WORD', run: setUser, hidden: true },
  { pattern: 'username WORD secret WORD', run: setUser },
  { pattern: 'username WORD privilege <0-15> password WORD', run: setUser },
  { pattern: 'username WORD privilege <0-15> secret WORD', run: setUser },
  { pattern: 'username WORD', run: (c, a) => (c.negate ? setUser(c, a) : INCOMPLETE), hidden: true },
  { pattern: 'interface IFACE', run: (c, a) => enterIface(c, a, false) },
  { pattern: 'interface range IFRANGE', run: (c, a) => enterIface(c, a, true) },
  { pattern: 'line console <0-0>', run: (c) => enterLine(c, 'con', 0) },
  { pattern: 'line aux <0-0>', run: (c) => enterLine(c, 'aux', 0) },
  { pattern: 'line vty <0-15>', run: (c, a) => enterLine(c, 'vty', Number(a.v[0])) },
  { pattern: 'line vty <0-15> <0-15>', run: (c, a) => enterLine(c, 'vty', Number(a.v[0]), Number(a.v[1])) },
  { pattern: 'router rip', run: (c) => enterRouter(c, 'router rip') },
  { pattern: 'router ospf <1-65535>', run: (c, a) => enterRouter(c, `router ospf ${a.v[0]}`) },
  { pattern: 'router eigrp <1-65535>', run: (c, a) => enterRouter(c, `router eigrp ${a.v[0]}`) },
  { pattern: 'ipv6 router rip WORD', run: (c, a) => enterRouter(c, `ipv6 router rip ${a.v[0]}`) },
  { pattern: 'ipv6 router ospf <1-65535>', run: (c, a) => enterRouter(c, `ipv6 router ospf ${a.v[0]}`) },
  { pattern: 'vlan VLANLIST', run: vlanCmd },
  {
    pattern: 'ip route A.B.C.D A.B.C.D NEXTHOP',
    run: (c, a) => staticRoute(c, a),
  },
  {
    pattern: 'ip route A.B.C.D A.B.C.D NEXTHOP <1-255>',
    run: (c, a) => staticRoute(c, a),
  },
  {
    pattern: 'ip default-gateway A.B.C.D',
    run: (c, a) => void (c.ios.defaultGateway = c.negate ? undefined : a.v[0]),
  },
  { pattern: 'ip default-gateway', run: (c) => (c.negate ? void (c.ios.defaultGateway = undefined) : INCOMPLETE), hidden: true },
  {
    pattern: 'ip dhcp pool WORD',
    run: (c, a) => {
      if (c.negate) {
        c.ios.pools = c.ios.pools.filter((x) => x.name !== a.v[0]);
        return;
      }
      if (!c.ios.pools.some((x) => x.name === a.v[0])) c.ios.pools.push({ name: a.v[0] });
      c.s.mode = 'pool';
      c.s.pool = a.v[0];
    },
  },
  { pattern: 'ip dhcp excluded-address A.B.C.D', run: (c, a) => excl(c, a.v[0], a.v[0]) },
  { pattern: 'ip dhcp excluded-address A.B.C.D A.B.C.D', run: (c, a) => excl(c, a.v[0], a.v[1]) },
  { pattern: 'ip dhcp LINE', run: store('post'), hidden: true },
  {
    pattern: 'ip nat LINE',
    run: (c, a) => {
      const rest = a.canonical;
      if (c.negate) c.ios.natRules = c.ios.natRules.filter((r) => r !== rest);
      else if (!c.ios.natRules.includes(rest)) c.ios.natRules.push(rest);
    },
  },
  { pattern: 'ip domain-name WORD', run: (c, a) => replaceGlobal(c, 'ip domain-name', a.canonical) },
  { pattern: 'ip domain-lookup', run: (c) => replaceGlobal(c, 'ip domain-lookup', c.negate ? 'no ip domain-lookup' : undefined, true) },
  { pattern: 'ip name-server LINE', run: store('pre') },
  { pattern: 'ip ssh version <1-2>', run: (c, a) => replaceGlobal(c, 'ip ssh version', c.negate ? undefined : a.canonical) },
  { pattern: 'ip ssh LINE', run: store('post') },
  { pattern: 'ip routing', run: (c) => replaceGlobal(c, 'ip routing', c.negate ? undefined : 'ip routing') },
  { pattern: 'ip cef', run: store('pre') },
  { pattern: 'ip classless', run: () => '' },
  { pattern: 'ip access-list standard WORD', run: (c, a) => namedAcl(c, 'standard', a.v[0]) },
  { pattern: 'ip access-list extended WORD', run: (c, a) => namedAcl(c, 'extended', a.v[0]) },
  { pattern: 'ip http LINE', run: store('post') },
  { pattern: 'ip host LINE', run: store('pre') },
  { pattern: 'ip scp LINE', run: store('post') },
  { pattern: 'ip flow-export LINE', run: store('post') },
  { pattern: 'ipv6 unicast-routing', run: store('pre') },
  { pattern: 'ipv6 route LINE', run: store('post') },
  { pattern: 'ipv6 cef', run: store('pre') },
  { pattern: 'ipv6 dhcp LINE', run: store('pre') },
  { pattern: 'ipv6 LINE', run: store('post'), hidden: true },
  { pattern: 'crypto key generate rsa', run: (c) => crypto(c) },
  { pattern: 'crypto key generate rsa general-keys modulus <360-4096>', run: (c, a) => crypto(c, Number(a.v[0])) },
  { pattern: 'crypto key generate rsa modulus <360-4096>', run: (c, a) => crypto(c, Number(a.v[0])), hidden: true },
  { pattern: 'crypto key zeroize rsa', run: (c) => ((c.ios.rsaBits = undefined), '% All keys will be removed.\n') },
  { pattern: 'crypto LINE', run: store('post'), hidden: true },
  { pattern: 'security passwords min-length <0-16>', run: store('pre') },
  { pattern: 'login block-for LINE', run: store('pre') },
  { pattern: 'login LINE', run: store('pre'), hidden: true },
  { pattern: 'access-list <1-2699> permit LINE', run: (c, a) => numberedAce(c, a, 'permit') },
  { pattern: 'access-list <1-2699> deny LINE', run: (c, a) => numberedAce(c, a, 'deny') },
  { pattern: 'access-list <1-2699> remark LINE', run: (c, a) => void (!c.negate && c.ios.extraPost.push(`access-list ${a.v[0]} remark ${a.v[1]}`)) },
  {
    pattern: 'access-list <1-2699>',
    hidden: true,
    run: (c, a) => (c.negate ? void (c.ios.extraPost = c.ios.extraPost.filter((l) => !l.startsWith(`access-list ${a.v[0]} `))) : INCOMPLETE),
  },
  { pattern: 'spanning-tree LINE', run: store('pre') },
  { pattern: 'cdp run', run: (c) => replaceGlobal(c, 'cdp run', c.negate ? 'no cdp run' : undefined) },
  { pattern: 'lldp run', run: store('post') },
  { pattern: 'ntp LINE', run: store('post') },
  { pattern: 'logging LINE', run: store('post') },
  { pattern: 'snmp-server LINE', run: store('post') },
  { pattern: 'clock timezone LINE', run: store('pre') },
  { pattern: 'aaa LINE', run: store('pre') },
  { pattern: 'license LINE', run: store('pre') },
  { pattern: 'vtp LINE', run: store('pre') },
  { pattern: 'mac address-table LINE', run: store('post') },
  { pattern: 'errdisable LINE', run: store('post') },
  { pattern: 'default LINE', run: () => '' },
];

function staticRoute(c: Ctx, a: ParsedArgs) {
  const [net, mask, via, dist] = a.v;
  if (!isMask(mask)) return '%Inconsistent address and mask\n';
  const nw = intToIp(network(net, mask));
  if (nw !== net) return '%Inconsistent address and mask\n';
  const viaIp = isIp(via);
  const ifn = viaIp ? undefined : ifaceName(via);
  if (!viaIp && !c.d.ifaces.some((i) => i.name.toLowerCase() === ifn?.toLowerCase())) return '% Invalid interface type and number\n';
  const iface = c.d.ifaces.find((i) => i.name.toLowerCase() === ifn?.toLowerCase())?.name;
  c.ios.routes = c.ios.routes.filter((r) => !(r.network === nw && r.mask === mask && (r.via === via || r.iface === iface)));
  if (c.negate) return;
  const distance = dist ? Number(dist) : undefined;
  c.ios.routes.push(viaIp ? { network: nw, mask, via, distance } : { network: nw, mask, iface, distance });
}

/** canonical text of an entry, as IOS stores it in the running-config */
function aceConfig(ace: Ace, extended: boolean) {
  if (extended) return ace.text;
  const a = ace.src;
  return `${ace.action} ${a.wild === '255.255.255.255' ? 'any' : a.wild === '0.0.0.0' ? `host ${a.ip}` : `${a.ip} ${a.wild}`}`;
}

/** zero the host bits under the wildcard, as IOS does when it stores an entry */
function normalizeWords(words: string[]) {
  return words.map((w, k) => (isIp(w) && isIp(words[k + 1]) && words[k - 1] !== 'host' ? intToIp((ipToNum(w) & ~ipToNum(words[k + 1])) >>> 0) : w));
}

function numberedAce(c: Ctx, a: ParsedArgs, action: 'permit' | 'deny') {
  const n = Number(a.v[0]);
  const extended = isExtendedNumber(n);
  if (!extended && !isStandardNumber(n)) return caretError(prompt(c.d, c.s).length, c.line, 1);
  const words = normalizeWords(a.v[1].split(/\s+/));
  const ace = parseAce(words, extended, 0, action);
  if ('errAt' in ace) return caretError(prompt(c.d, c.s).length, c.line, ace.errAt + 3 + (c.negate ? 1 : 0));
  const line = `access-list ${n} ${aceConfig(ace, extended)}`;
  if (c.negate) {
    // "no access-list N ..." removes the whole list, like IOS
    c.ios.extraPost = c.ios.extraPost.filter((l) => !l.startsWith(`access-list ${n} `));
    return;
  }
  if (!c.ios.extraPost.includes(line)) {
    // keep a list's lines together
    const last = c.ios.extraPost.map((l, k) => (l.startsWith(`access-list ${n} `) ? k : -1)).filter((k) => k >= 0).pop();
    if (last === undefined) c.ios.extraPost.push(line);
    else c.ios.extraPost.splice(last + 1, 0, line);
  }
}

function namedAcl(c: Ctx, kind: 'standard' | 'extended', name: string) {
  const header = `ip access-list ${kind} ${name}`;
  if (c.negate) {
    const b = blockLines(c.ios.extraPost, header);
    if (b) c.ios.extraPost.splice(b.at, b.end - b.at);
    return;
  }
  if (!blockLines(c.ios.extraPost, header)) c.ios.extraPost.push(header);
  c.s.mode = 'acl';
  c.s.acl = header;
}

function namedAce(c: Ctx, a: ParsedArgs, action: 'permit' | 'deny', seqArg?: string) {
  if (!c.s.acl) return;
  const extended = c.s.acl.includes(' extended ');
  const words = normalizeWords(a.v[a.v.length - 1].split(/\s+/));
  const ace = parseAce(words, extended, 0, action);
  if ('errAt' in ace) return caretError(prompt(c.d, c.s).length, c.line, ace.errAt + (seqArg ? 2 : 1));
  const b = blockLines(c.ios.extraPost, c.s.acl)!;
  const body = c.ios.extraPost.slice(b.at + 1, b.end);
  const seqs = body.map((l) => Number(l.trim().split(' ')[0])).filter((x) => !Number.isNaN(x));
  const seq = seqArg ? Number(seqArg) : (Math.max(0, ...seqs) + 10);
  if (seqs.includes(seq)) return '% Duplicate sequence number\n';
  const text = aceConfig(ace, extended);
  if (body.some((l) => l.trim().replace(/^\d+ /, '') === text)) return '% Duplicate access-list entry\n';
  const next = [...body, ` ${seq} ${text}`].sort((x, y) => Number(x.trim().split(' ')[0]) - Number(y.trim().split(' ')[0]));
  c.ios.extraPost.splice(b.at + 1, b.end - b.at - 1, ...next);
}

function accessGroupCmd(c: Ctx, name: string, dir: 'in' | 'out') {
  for (const i of curIfaces(c)) {
    i.extra = (i.extra ?? []).filter((e) => !(e.startsWith('ip access-group ') && e.endsWith(` ${dir}`)));
    if (!c.negate) i.extra.push(`ip access-group ${name} ${dir}`);
  }
}

function excl(c: Ctx, from: string, to: string) {
  if (c.negate) c.ios.excluded = c.ios.excluded.filter((x) => x.from !== from);
  else if (!c.ios.excluded.some((x) => x.from === from && x.to === to)) c.ios.excluded.push({ from, to });
}

/** keep one line for a global setting (`value` undefined removes it) */
function replaceGlobal(c: Ctx, family: string, value?: string, pre = true) {
  const strip = (l: string[]) => l.filter((x) => !x.startsWith(family) && !x.startsWith(`no ${family}`));
  c.ios.extraPre = strip(c.ios.extraPre);
  c.ios.extraPost = strip(c.ios.extraPost);
  if (c.negate && !value?.startsWith('no ')) return;
  if (value) (pre ? c.ios.extraPre : c.ios.extraPost).push(value);
}

G.add('config', cfgGlobal);

/* ---------------- interface ---------------- */

function setIp(c: Ctx, a: ParsedArgs) {
  const ifs = curIfaces(c);
  if (c.negate) {
    for (const i of ifs) {
      i.ip = undefined;
      i.mask = undefined;
      i.extra = i.extra?.filter((e) => e !== 'ip address dhcp');
    }
    return;
  }
  const [ip, mask] = a.v;
  if (ifs.length !== 1) return '% IP addresses may not be configured on a range.\n';
  const i = ifs[0];
  if (c.d.kind === 'switch' && i.media !== 'virtual' && !c.ios.extraPost.includes('ip routing')) return caretError(prompt(c.d, c.s).length, c.line, 0);
  if (!isMask(mask)) return `Bad mask 0x${(network(mask, '255.255.255.255') >>> 0).toString(16).toUpperCase()} for address ${ip}\n`;
  if (ip === intToIp(network(ip, mask)) && maskToPrefix(mask) < 31) return `Bad mask /${maskToPrefix(mask)} for address ${ip}\n`;
  const clash = c.d.ifaces.find((o) => o !== i && o.ip && o.mask && (inNet(ip, o.ip, o.mask) || inNet(o.ip, ip, mask)));
  if (clash) return `% ${intToIp(network(ip, mask))} overlaps with ${clash.name}\n`;
  i.ip = ip;
  i.mask = mask;
  i.extra = i.extra?.filter((e) => e !== 'ip address dhcp');
}

function shut(c: Ctx) {
  let out = '';
  for (const i of curIfaces(c)) {
    const was = i.shutdown;
    i.shutdown = !c.negate;
    if (was === i.shutdown) continue;
    if (i.shutdown) out += linkMsg(i, 'admin', !i.name.startsWith('Vlan') || vlanUp(c.p, c.d, Number(i.name.slice(4))));
    else if (i.name.startsWith('Vlan')) {
      const up = vlanUp(c.p, c.d, Number(i.name.slice(4)));
      out += linkMsg(i, 'up', up);
    } else if (i.media === 'virtual') out += linkMsg(i, 'up', true);
    else {
      const t2 = buildTopo(c.p);
      const up = ifaceStatus(c.p, t2, c.d, i).line;
      out += linkMsg(i, up ? 'up' : 'down', up);
    }
  }
  return out;
}

function swport(c: Ctx, fn: (i: Iface) => string | void) {
  const err = swOnly(c);
  if (err) return err;
  let out = '';
  for (const i of curIfaces(c)) {
    if (i.media === 'virtual') return caretError(prompt(c.d, c.s).length, c.line, 0);
    out += fn(i) ?? '';
  }
  return out;
}

function ensureVlan(c: Ctx, id: number) {
  const vl = vlansOf(c.ios);
  if (vl.some((v) => v.id === id)) return '';
  vl.push({ id, name: vlanName(id) });
  return `% Access VLAN does not exist. Creating vlan ${id}\n`;
}

const rtOnly = (c: Ctx) => (c.d.kind === 'switch' ? caretError(prompt(c.d, c.s).length, c.line, 0) : null);

const cfgIf: CmdSpec<Ctx>[] = [
  ...cfgCommon,
  { pattern: 'interface IFACE', run: (c, a) => enterIface(c, a, false) },
  { pattern: 'interface range IFRANGE', run: (c, a) => enterIface(c, a, true) },
  { pattern: 'shutdown', run: shut },
  { pattern: 'description LINE', run: (c, a) => void curIfaces(c).forEach((i) => (i.description = c.negate ? undefined : a.v[0])) },
  { pattern: 'description', run: (c) => (c.negate ? void curIfaces(c).forEach((i) => (i.description = undefined)) : INCOMPLETE), hidden: true },
  { pattern: 'ip address A.B.C.D A.B.C.D', run: setIp },
  { pattern: 'ip address A.B.C.D A.B.C.D secondary', run: ifStore },
  {
    pattern: 'ip address dhcp',
    run: (c) => {
      for (const i of curIfaces(c)) {
        i.extra = (i.extra ?? []).filter((e) => e !== 'ip address dhcp');
        if (!c.negate) {
          i.ip = i.mask = undefined;
          i.extra.push('ip address dhcp');
        }
      }
    },
  },
  { pattern: 'ip address', run: (c, a) => (c.negate ? setIp(c, a) : INCOMPLETE), hidden: true },
  { pattern: 'ip nat inside', run: (c) => void curIfaces(c).forEach((i) => (i.natRole = c.negate ? undefined : 'inside')) },
  { pattern: 'ip nat outside', run: (c) => void curIfaces(c).forEach((i) => (i.natRole = c.negate ? undefined : 'outside')) },
  { pattern: 'ip helper-address A.B.C.D', run: ifStore },
  { pattern: 'ip access-group WORD in', run: (c, a) => accessGroupCmd(c, a.v[0], 'in') },
  { pattern: 'ip access-group WORD out', run: (c, a) => accessGroupCmd(c, a.v[0], 'out') },
  { pattern: 'ip ospf LINE', run: ifStore },
  { pattern: 'ip summary-address LINE', run: ifStore },
  { pattern: 'ip dhcp LINE', run: ifStore },
  { pattern: 'ip mtu <68-1500>', run: ifStore },
  { pattern: 'ip proxy-arp', run: ifStore },
  { pattern: 'ipv6 address V6PREFIX', run: ifStore },
  { pattern: 'ipv6 address V6PREFIX eui-64', run: ifStore },
  { pattern: 'ipv6 address V6ADDR link-local', run: ifStore },
  { pattern: 'ipv6 address autoconfig', run: ifStore },
  { pattern: 'ipv6 address dhcp', run: ifStore },
  { pattern: 'ipv6 enable', run: ifStore },
  { pattern: 'ipv6 LINE', run: ifStore, hidden: true },
  { pattern: 'duplex auto', run: ifStore },
  { pattern: 'duplex full', run: ifStore },
  { pattern: 'duplex half', run: ifStore },
  { pattern: 'speed auto', run: ifStore },
  { pattern: 'speed 10', run: ifStore },
  { pattern: 'speed 100', run: ifStore },
  { pattern: 'speed 1000', run: ifStore },
  { pattern: 'mdix auto', run: ifStore },
  { pattern: 'bandwidth <1-10000000>', run: ifStore },
  { pattern: 'delay <1-16777215>', run: ifStore },
  { pattern: 'clock rate <300-4000000>', run: (c, a) => rtOnly(c) ?? ifStore(c, a) },
  { pattern: 'encapsulation dot1Q <1-4094>', run: (c, a) => rtOnly(c) ?? dot1q(c, Number(a.v[0]), false) },
  { pattern: 'encapsulation dot1Q <1-4094> native', run: (c, a) => rtOnly(c) ?? dot1q(c, Number(a.v[0]), true) },
  { pattern: 'encapsulation ppp', run: (c, a) => rtOnly(c) ?? ifStore(c, a) },
  { pattern: 'encapsulation hdlc', run: (c, a) => rtOnly(c) ?? ifStore(c, a) },
  { pattern: 'ppp LINE', run: ifStore },
  { pattern: 'keepalive LINE', run: ifStore },
  { pattern: 'tunnel LINE', run: ifStore },
  { pattern: 'standby LINE', run: ifStore },
  { pattern: 'cdp enable', run: ifStore },
  { pattern: 'channel-group LINE', run: ifStore },
  { pattern: 'spanning-tree LINE', run: ifStore },
  { pattern: 'storm-control LINE', run: ifStore },
  {
    pattern: 'switchport mode access',
    run: (c) => swport(c, (i) => void (i.swMode = c.negate ? undefined : 'access')),
  },
  {
    pattern: 'switchport mode trunk',
    run: (c) =>
      swport(c, (i) => {
        const was = i.swMode;
        i.swMode = c.negate ? undefined : 'trunk';
        if (was === i.swMode || c.negate) return;
        const t = buildTopo(c.p);
        if (!ifaceStatus(c.p, t, c.d, i).line) return;
        return `\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${i.name}, changed state to down\n\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${i.name}, changed state to up\n`;
      }),
  },
  { pattern: 'switchport mode dynamic auto', run: (c) => swport(c, (i) => void (i.swMode = undefined)) },
  { pattern: 'switchport mode dynamic desirable', run: (c) => swport(c, (i) => void (i.swMode = undefined)) },
  {
    pattern: 'switchport access vlan <1-4094>',
    run: (c, a) => {
      const id = Number(a.v[0]);
      const msg = c.negate ? '' : ensureVlan(c, id);
      return swport(c, (i) => void (i.accessVlan = c.negate ? undefined : id)) + msg;
    },
  },
  { pattern: 'switchport trunk native vlan <1-4094>', run: (c, a) => swport(c, (i) => void (i.nativeVlan = c.negate ? undefined : Number(a.v[0]))) },
  { pattern: 'switchport trunk allowed vlan VLANLIST', run: (c, a) => swport(c, (i) => void (i.allowedVlans = c.negate ? undefined : a.v[0])) },
  { pattern: 'switchport trunk allowed vlan all', run: (c) => swport(c, (i) => void (i.allowedVlans = undefined)) },
  { pattern: 'switchport trunk allowed vlan none', run: (c) => swport(c, (i) => void (i.allowedVlans = 'none')) },
  {
    pattern: 'switchport trunk allowed vlan add VLANLIST',
    run: (c, a) =>
      swport(c, (i) => {
        const cur = expandVlans(i.allowedVlans);
        if (cur === 'all') return;
        i.allowedVlans = compressVlans([...cur, ...(expandVlans(a.v[0]) as number[])]);
      }),
  },
  {
    pattern: 'switchport trunk allowed vlan remove VLANLIST',
    run: (c, a) =>
      swport(c, (i) => {
        const cur = expandVlans(i.allowedVlans);
        const rm = expandVlans(a.v[0]) as number[];
        const base = cur === 'all' ? Array.from({ length: 4094 }, (_, k) => k + 1) : cur;
        i.allowedVlans = compressVlans(base.filter((v) => !rm.includes(v)));
      }),
  },
  { pattern: 'switchport trunk encapsulation dot1q', run: (c) => swOnly(c) ?? '' },
  { pattern: 'switchport nonegotiate', run: (c, a) => swOnly(c) ?? ifStore(c, a) },
  { pattern: 'switchport port-security', run: (c, a) => swOnly(c) ?? ifStore(c, a) },
  { pattern: 'switchport port-security LINE', run: (c, a) => swOnly(c) ?? ifStore(c, a) },
  { pattern: 'switchport voice vlan <1-4094>', run: (c, a) => swOnly(c) ?? ifStore(c, a) },
  { pattern: 'switchport', run: (c, a) => swOnly(c) ?? ifStore(c, a), hidden: true },
];

function dot1q(c: Ctx, id: number, native: boolean) {
  for (const i of curIfaces(c)) {
    if (c.negate) {
      i.dot1q = undefined;
      continue;
    }
    i.dot1q = id;
    i.extra = (i.extra ?? []).filter((e) => e !== 'encapsulation-native');
    if (native) i.extra.push('encapsulation-native');
  }
}

G.add('if', cfgIf);

/* ---------------- line ---------------- */

const cfgLine: CmdSpec<Ctx>[] = [
  ...cfgCommon,
  { pattern: 'password WORD', run: (c, a) => lineSet(c, replaceCmd(/^password /, c.negate ? undefined : `password ${pwValue(c.ios, a.v[0])}`)) },
  { pattern: 'password 0 WORD', run: (c, a) => lineSet(c, replaceCmd(/^password /, c.negate ? undefined : `password ${pwValue(c.ios, a.v[0])}`)), hidden: true },
  { pattern: 'password 7 WORD', run: (c, a) => lineSet(c, replaceCmd(/^password /, c.negate ? undefined : `password 7 ${a.v[0]}`)), hidden: true },
  { pattern: 'password', run: (c) => (c.negate ? lineSet(c, replaceCmd(/^password /)) : INCOMPLETE), hidden: true },
  { pattern: 'login', run: (c) => lineSet(c, replaceCmd(/^login/, c.negate ? undefined : 'login')) },
  { pattern: 'login local', run: (c) => lineSet(c, replaceCmd(/^login/, c.negate ? undefined : 'login local')) },
  { pattern: 'login authentication WORD', run: (c, a) => lineSet(c, replaceCmd(/^login/, c.negate ? undefined : a.canonical)) },
  { pattern: 'transport input LINE', run: (c, a) => lineSet(c, replaceCmd(/^transport input/, c.negate ? undefined : a.canonical)) },
  { pattern: 'transport output LINE', run: (c, a) => lineSet(c, replaceCmd(/^transport output/, c.negate ? undefined : a.canonical)) },
  { pattern: 'exec-timeout <0-35791>', run: (c, a) => lineSet(c, replaceCmd(/^exec-timeout/, c.negate ? undefined : `exec-timeout ${a.v[0]} 0`)) },
  { pattern: 'exec-timeout <0-35791> <0-2147483>', run: (c, a) => lineSet(c, replaceCmd(/^exec-timeout/, c.negate ? undefined : a.canonical)) },
  { pattern: 'logging synchronous', run: (c) => lineSet(c, replaceCmd(/^logging synchronous/, c.negate ? undefined : 'logging synchronous')) },
  { pattern: 'privilege level <0-15>', run: (c, a) => lineSet(c, replaceCmd(/^privilege/, c.negate ? undefined : a.canonical)) },
  { pattern: 'access-class LINE', run: (c, a) => lineSet(c, replaceCmd(/^access-class/, c.negate ? undefined : a.canonical)) },
  { pattern: 'history size <0-256>', run: () => '' },
];
G.add('line', cfgLine);

/* ---------------- router ---------------- */

const rtr = cmd((c, a) => {
  if (c.s.router) blockEdit(c.ios.extraPost, c.s.router, a.canonical, c.negate);
});

/** RIP and classful EIGRP network statements are stored as the major network, like IOS */
const rtrNetwork = cmd((c, a) => {
  if (!c.s.router) return;
  const ip = a.v[0];
  const classful = c.s.router === 'router rip' || (c.s.router.startsWith('router eigrp') && a.v.length === 1);
  rtr(c, { ...a, canonical: classful ? `network ${intToIp(network(ip, classfulMask(ip)))}` : a.canonical });
});

function passive(c: Ctx, iface: string) {
  if (!c.s.router) return;
  const b = blockLines(c.ios.extraPost, c.s.router);
  const byDefault = !!b && c.ios.extraPost.slice(b.at + 1, b.end).includes(' passive-interface default');
  // under "passive-interface default", IOS records the exceptions as "no passive-interface X"
  if (byDefault) blockEdit(c.ios.extraPost, c.s.router, `no passive-interface ${iface}`, !c.negate);
  else blockEdit(c.ios.extraPost, c.s.router, `passive-interface ${iface}`, c.negate);
}
G.add('router', [
  ...cfgCommon,
  { pattern: 'network A.B.C.D', run: rtrNetwork },
  { pattern: 'network A.B.C.D A.B.C.D', run: rtrNetwork },
  { pattern: 'network A.B.C.D A.B.C.D area <0-4294967295>', run: rtr },
  { pattern: 'version <1-2>', run: rtr },
  {
    pattern: 'auto-summary',
    run: (c) => {
      if (!c.s.router) return;
      blockEdit(c.ios.extraPost, c.s.router, 'auto-summary', true);
      blockEdit(c.ios.extraPost, c.s.router, 'no auto-summary', true);
      blockEdit(c.ios.extraPost, c.s.router, c.negate ? 'no auto-summary' : 'auto-summary', false);
    },
  },
  { pattern: 'passive-interface IFACE', run: (c, a) => passive(c, ifaceName(a.v[0]) ?? a.v[0]) },
  {
    pattern: 'passive-interface default',
    run: (c) => {
      if (!c.s.router) return;
      const b = blockLines(c.ios.extraPost, c.s.router)!;
      // switching modes drops the per-interface lines
      const body = c.ios.extraPost.slice(b.at + 1, b.end).filter((l) => !/^ (no )?passive-interface /.test(l));
      c.ios.extraPost.splice(b.at + 1, b.end - b.at - 1, ...body);
      if (!c.negate) blockEdit(c.ios.extraPost, c.s.router, 'passive-interface default', false);
    },
  },
  { pattern: 'auto-cost reference-bandwidth <1-4294967>', run: rtr },
  { pattern: 'router-id A.B.C.D', run: rtr },
  { pattern: 'default-information originate', run: rtr },
  { pattern: 'redistribute LINE', run: rtr },
  { pattern: 'area LINE', run: rtr },
  { pattern: 'eigrp router-id A.B.C.D', run: rtr },
  { pattern: 'maximum-paths <1-16>', run: rtr },
  { pattern: 'distance LINE', run: rtr },
  { pattern: 'timers LINE', run: rtr },
]);

/* ---------------- named access lists ---------------- */

G.add('acl', [
  ...cfgCommon,
  { pattern: 'permit LINE', run: (c, a) => namedAce(c, a, 'permit') },
  { pattern: 'deny LINE', run: (c, a) => namedAce(c, a, 'deny') },
  { pattern: '<1-2147483647> permit LINE', run: (c, a) => namedAce(c, a, 'permit', a.v[0]) },
  { pattern: '<1-2147483647> deny LINE', run: (c, a) => namedAce(c, a, 'deny', a.v[0]) },
  {
    pattern: '<1-2147483647>',
    hidden: true,
    run: (c, a) => {
      if (!c.negate || !c.s.acl) return INCOMPLETE;
      const b = blockLines(c.ios.extraPost, c.s.acl)!;
      const body = c.ios.extraPost.slice(b.at + 1, b.end).filter((l) => l.trim().split(' ')[0] !== a.v[0]);
      c.ios.extraPost.splice(b.at + 1, b.end - b.at - 1, ...body);
    },
  },
  { pattern: 'remark LINE', run: () => '' },
]);

/* ---------------- dhcp pool ---------------- */

const poolOf = (c: Ctx) => c.ios.pools.find((x) => x.name === c.s.pool);
G.add('pool', [
  ...cfgCommon,
  {
    pattern: 'network A.B.C.D A.B.C.D',
    run: (c, a) => {
      const pl = poolOf(c);
      if (!pl) return;
      if (c.negate) pl.network = pl.mask = undefined;
      else [pl.network, pl.mask] = a.v;
    },
  },
  {
    pattern: 'network A.B.C.D',
    run: (c, a) => {
      const pl = poolOf(c);
      if (!pl) return;
      const [ip, pre] = a.v[0].split('/');
      pl.network = ip;
      pl.mask = pre ? prefixToMask(Number(pre)) : classfulMask(ip);
    },
  },
  { pattern: 'default-router A.B.C.D', run: (c, a) => void (poolOf(c) && (poolOf(c)!.router = c.negate ? undefined : a.v[0])) },
  { pattern: 'dns-server A.B.C.D', run: (c, a) => void (poolOf(c) && (poolOf(c)!.dns = c.negate ? undefined : a.v[0])) },
  { pattern: 'domain-name WORD', run: () => '' },
  { pattern: 'lease LINE', run: () => '' },
  { pattern: 'option LINE', run: () => '' },
]);

/* ---------------- vlan ---------------- */

G.add('vlan', [
  ...cfgCommon,
  {
    pattern: 'name WORD',
    run: (c, a) => {
      for (const v of vlansOf(c.ios)) if (c.s.vlan?.includes(v.id)) v.name = c.negate ? vlanName(v.id) : a.v[0];
    },
  },
  { pattern: 'vlan VLANLIST', run: vlanCmd },
]);

/* ================================================================== */
/*  exec                                                               */
/* ================================================================== */

const CONFIG_MODES: Mode[] = ['config', 'if', 'pool', 'line', 'router', 'vlan', 'acl'];

function consoleLogin(d: Device, which: 'con' | 'vty' = 'con') {
  const con = d.ios ? linesOf(d, d.ios).find((l) => (which === 'con' ? l.name === 'con 0' : l.name.startsWith('vty'))) : undefined;
  const login = con?.cmds.find((c) => c.startsWith('login'));
  if (!login) return null;
  if (login === 'login local') return 'local';
  const pw = con!.cmds.find((c) => c.startsWith('password '))?.slice(9);
  return pw === undefined ? 'nopass' : pw;
}

function motd(d: Device) {
  return d.ios?.motd !== undefined ? `${d.ios.motd}\n\n` : '';
}

function loginPrompt(d: Device, s: Session): string {
  const how = consoleLogin(d);
  if (how === null) return '';
  if (how === 'nopass') return '\nPassword required, but none set\n\n';
  s.pending = how === 'local' ? { kind: 'login-user', tries: 0 } : { kind: 'login', tries: 0 };
  return '\n\nUser Access Verification\n\n';
}

function usersOf(d: Device) {
  const out = new Map<string, string>();
  for (const l of d.ios?.extraPre ?? []) {
    const m = l.match(/^username (\S+)(?: privilege \d+)? (password|secret) (.+)$/);
    if (m) out.set(m[1], m[3]);
  }
  return out;
}

/** Answer an interactive prompt (password, confirm, …). */
function answer(p: Project, d: Device, s: Session, line: string): string {
  const pend = s.pending!;
  const ios = (d.ios ??= emptyIos(d.name));
  switch (pend.kind) {
    case 'press-return': {
      s.pending = undefined;
      const head = motd(d);
      const login = loginPrompt(d, s);
      if (s.pending || login) return head + login;
      return head + (line.trim() ? exec(p, d, s, line) : '');
    }
    case 'login': {
      const pw = consoleLogin(d, s.vty ? 'vty' : 'con');
      if (typeof pw === 'string' && checkPassword(pw, line)) {
        s.pending = undefined;
        return '';
      }
      if (++pend.tries >= 3) {
        if (s.vty) {
          s.closed = true;
          return `% Bad passwords\n\n[Connection to ${s.vty.ip} closed by foreign host]\n`;
        }
        s.pending = { kind: 'press-return' };
        return '% Bad passwords\n\n';
      }
      return '';
    }
    case 'login-user':
      s.pending = { kind: 'login-pass', tries: pend.tries, user: line.trim() };
      return '';
    case 'login-pass': {
      const stored = usersOf(d).get(pend.user);
      if (stored !== undefined && checkPassword(stored, line)) {
        s.pending = undefined;
        return '';
      }
      const tries = pend.tries + 1;
      if (s.vty && (tries >= 3 || s.vty.proto === 'ssh')) {
        s.closed = true;
        return `% Login invalid\n\n[Connection to ${s.vty.ip} closed by foreign host]\n`;
      }
      s.pending = tries >= 3 ? { kind: 'press-return' } : { kind: 'login-user', tries };
      return '% Login invalid\n\n';
    }
    case 'enable': {
      const good = ios.enableSecret ? checkPassword(ios.enableSecret, line) : checkPassword(ios.enablePassword, line);
      if (good) {
        s.pending = undefined;
        s.mode = 'priv';
        return '';
      }
      if (++pend.tries >= 3) {
        s.pending = undefined;
        return '% Bad secrets\n\n';
      }
      return '';
    }
    case 'confirm': {
      s.pending = undefined;
      if (/^n/i.test(line.trim())) return '';
      if (pend.action === 'erase') {
        ios.startup = undefined;
        return '[OK]\nErase of nvram: complete\n%SYS-7-NV_BLOCK_INIT: Initialized the geometry of nvram\n';
      }
      loadConfig(d, ios.startup);
      arpSeen.delete(d.id);
      s.mode = 'user';
      s.pending = { kind: 'press-return' };
      return `%SYS-5-RELOAD: Reload requested by console. Reload Reason: Reload Command.\n\n${d.model} restarted (NetForge)\n\n${ios.startup ? '' : '\n         --- System Configuration Dialog ---\n\nContinue with configuration dialog? [yes/no]: no\n'}\nPress RETURN to get started!\n`;
    }
    case 'copy': {
      s.pending = undefined;
      if (pend.to === 'startup') {
        ios.startup = runningConfig(d);
        return 'Building configuration...\n[OK]\n';
      }
      if (ios.startup) parseRunningConfig(ios.startup, d);
      return `${ios.startup?.length ?? 0} bytes copied in 0.416 secs\n${now()}: %SYS-5-CONFIG_I: Configured from console by console\n`;
    }
    case 'banner': {
      const at = line.indexOf(pend.delim);
      if (at < 0) {
        pend.body.push(line);
        return '';
      }
      pend.body.push(line.slice(0, at));
      ios.motd = pend.body.join('\n').replace(/^\n+|\n+$/g, '');
      s.pending = undefined;
      return '';
    }
    case 'rsa': {
      s.pending = undefined;
      const n = line.trim() ? Number(line.trim()) : 512;
      if (!Number.isInteger(n) || n < 360 || n > 4096) return '% Key modulus size must be between 360 and 4096 bits\n';
      return rsaDone(ios, n);
    }
  }
}

/**
 * Execute one CLI line against a device. Mutates `d` and `s` (use an immer draft).
 * Returns the text to print.
 */
export function exec(p: Project, d: Device, s: Session, line: string): string {
  const ios = (d.ios ??= emptyIos(d.name));
  if (s.pending) return answer(p, d, s, line);
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('!')) return '';
  s.history.push(trimmed);
  if (trimmed.endsWith('?')) return help(d, s, line.replace(/\?$/, ''));

  let words = trimmed.split(/\s+/);
  let negate = false;
  const pl = prompt(d, s).length;
  const lead = line.length - line.trimStart().length;

  if (CONFIG_MODES.includes(s.mode)) {
    const w0 = words[0].toLowerCase();
    if (w0 === 'do' && words.length > 1) {
      const inner: Session = { ...s, mode: 'priv', pending: undefined };
      const out = exec(p, d, inner, words.slice(1).join(' '));
      if (inner.pending) s.pending = inner.pending;
      return out;
    }
    if (w0 === 'no') {
      negate = true;
      words = words.slice(1);
      if (!words.length) return INCOMPLETE;
    }
  }

  const ctx: Ctx = { p, d, s, ios, negate, line };
  const r = G.parse(s.mode, words);
  if (!r.ok) {
    // sub-mode commands that belong to global config drop back to it, like IOS
    if (r.at === 0 && r.err === 'invalid' && s.mode !== 'config' && CONFIG_MODES.includes(s.mode) && G.hasFirst('config', words[0])) {
      const g = G.parse('config', words);
      if (g.ok) {
        s.mode = 'config';
        s.iface = s.pool = s.line = s.router = s.vlan = s.acl = undefined;
        return g.spec.run(ctx, g.args) ?? '';
      }
    }
    if (r.err === 'incomplete') return INCOMPLETE;
    if (r.err === 'ambiguous') return `% Ambiguous command: "${trimmed}"\n`;
    return caretError(pl + lead, line.trimStart() === line ? line : line.trimStart(), r.at + (negate ? 1 : 0));
  }
  const watch = d.ios?.extraPost.some((l) => l.startsWith('router ')) ? adjKeys(p, d) : null;
  const out = r.spec.run(ctx, r.args) ?? '';
  return watch ? out + adjChanges(p, d, watch) : out;
}

/** this device's routing adjacencies, keyed so changes can be reported */
function adjKeys(p: Project, d: Device) {
  const cp = controlPlane(buildTopo(p));
  const out = new Map<string, string[]>();
  for (const a of cp.adj) {
    if (a.proto === 'rip' || (a.a.id !== d.id && a.b.id !== d.id)) continue;
    const meFirst = a.a.id === d.id;
    const peer = meFirst ? a.b : a.a;
    const myIf = meFirst ? a.aIf : a.bIf;
    const peerIp = meFirst ? a.bIp : a.aIp;
    if (a.proto === 'ospf') {
      const o = protocolsOf(d).ospf[0];
      const rid = ospfRouterId(peer, protocolsOf(peer).ospf[0]);
      out.set(`ospf|${peer.id}|${myIf}`, [
        `%OSPF-5-ADJCHG: Process ${o?.pid ?? 1}, Nbr ${rid} on ${myIf} from LOADING to FULL, Loading Done`,
        `%OSPF-5-ADJCHG: Process ${o?.pid ?? 1}, Nbr ${rid} on ${myIf} from FULL to DOWN, Neighbor Down: Interface down or detached`,
      ]);
    } else
      out.set(`eigrp|${peer.id}|${myIf}`, [
        `%DUAL-5-NBRCHANGE: IP-EIGRP ${a.as}: Neighbor ${peerIp} (${myIf}) is up: new adjacency`,
        `%DUAL-5-NBRCHANGE: IP-EIGRP ${a.as}: Neighbor ${peerIp} (${myIf}) is down: interface down`,
      ]);
  }
  return out;
}

function adjChanges(p: Project, d: Device, before: Map<string, string[]>) {
  const after = adjKeys(p, d);
  let out = '';
  for (const [k, [up]] of after) if (!before.has(k)) out += `\n${now()}: ${up}\n`;
  for (const [k, [, down]] of before) if (!after.has(k)) out += `\n${now()}: ${down}\n`;
  return out;
}

/** `?` help for what's been typed so far */
export function help(d: Device, s: Session, typed: string): string {
  if (s.pending) return '';
  let t = typed.replace(/^\s+/, '');
  let mode = s.mode;
  const first = t.split(/\s+/)[0]?.toLowerCase();
  if (CONFIG_MODES.includes(mode) && first === 'do' && /\s/.test(t)) {
    mode = 'priv';
    t = t.replace(/^\S+\s+/, '');
  } else if (CONFIG_MODES.includes(mode) && first === 'no' && /\s/.test(t)) t = t.replace(/^\S+\s+/, '');
  const out = G.help(mode, t);
  if (typeof out === 'string') return out;
  if (out.err === 'ambiguous') return `% Ambiguous command: "${typed.trim()}"\n`;
  return caretError(prompt(d, s).length, typed, out.at);
}

/** Tab completion (keywords and interface names) */
export function complete(s: Session, line: string): string {
  if (s.pending) return line;
  const m = line.match(/^(\s*(?:do|no)\s+)(.*)$/i);
  if (m && CONFIG_MODES.includes(s.mode)) {
    const mode = /^\s*do/i.test(m[1]) ? 'priv' : s.mode;
    return m[1] + G.complete(mode, m[2]);
  }
  return G.complete(s.mode, line);
}

/** first words available in a mode (for UI hints) */
export const keywords = (m: Mode) =>
  G.help(m, '')
    .toString()
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((w) => w && w !== '<cr>');

/* ================================================================== */
/*  Telnet / SSH into a device                                         */
/* ================================================================== */

export interface Remote {
  dev?: Device;
  session?: Session;
  out: string;
}

/** Open a Telnet or SSH session from `client` to `ip`, checking reachability and the VTY lines. */
export function openRemote(p: Project, client: Device, ip: string, proto: 'telnet' | 'ssh', user?: string): Remote {
  const head = proto === 'telnet' ? `Trying ${ip} ...` : '';
  const fail = (msg: string) => ({ out: `${head ? head + '\n' : ''}${msg}\n` });
  if (!isIp(ip)) return fail(`% Unknown command or computer name, or unable to find computer address`);
  if (!ping(p, client.id, ip, { l4: { proto: 'tcp', sport: 1025, dport: proto === 'ssh' ? 22 : 23 }, count: true }).ok) return fail('% Connection timed out; remote host not responding');
  const d = p.devices.find((x) => x.ifaces.some((i) => i.ip === ip && !i.shutdown));
  if (!d?.ios || !d.powered) return fail('% Connection refused by remote host');
  const ios = d.ios;
  const vty = linesOf(d, ios).find((l) => l.name.startsWith('vty'));
  const transport = vty?.cmds.find((c) => c.startsWith('transport input'))?.slice(16).split(/\s+/) ?? ['all'];
  const allowed = transport.includes('all') || transport.includes(proto);
  if (!allowed || transport.includes('none')) return fail('% Connection refused by remote host');
  if (proto === 'ssh' && !ios.rsaBits) return fail('% Connection refused by remote host');
  // access-class on the VTY lines filters who may connect
  const cls = vty?.cmds.find((c) => /^access-class \S+ in$/.test(c))?.split(' ')[1];
  const from = client.ifaces.find((i) => i.ip && !i.shutdown)?.ip ?? '0.0.0.0';
  if (cls && !aclAllows(d, cls, { src: from, dst: ip, proto: 'tcp', dport: proto === 'ssh' ? 22 : 23 }, true).ok) return fail('% Connection refused by remote host');
  const s: Session = { mode: 'user', history: [], vty: { ip, proto } };
  const how = consoleLogin(d, 'vty');
  let out = head ? `${head}Open\n` : '';
  if (proto === 'ssh') {
    // SSH always authenticates a user: the local database with "login local", otherwise the line password
    if (how === 'local' || how === null) s.pending = { kind: 'login-pass', tries: 2, user: user ?? '' };
    else if (how === 'nopass') return fail('% Connection refused by remote host');
    else s.pending = { kind: 'login', tries: 2 };
    return { dev: d, session: s, out };
  }
  out += motd(d);
  if (how === 'nopass') return { out: out + '\n\nPassword required, but none set\n\n[Connection to ' + ip + ' closed by foreign host]\n' };
  if (how === 'local') s.pending = { kind: 'login-user', tries: 0 };
  else if (how !== null) s.pending = { kind: 'login', tries: 0 };
  if (s.pending) out += '\n\nUser Access Verification\n\n';
  return { dev: d, session: s, out };
}
