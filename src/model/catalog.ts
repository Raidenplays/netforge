import { randomMac } from './ip';
import type { Device, DeviceKind, Iface, IosState, Media } from './types';
import { uid } from './types';

export interface Template {
  model: string;
  kind: DeviceKind;
  label: string;
  group: 'Network' | 'End devices' | 'Wireless' | 'Other';
  blurb: string;
  ports: [string, Media, number][];
}

const range = (prefix: string, from: number, to: number, media: Media, speed: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => [`${prefix}${from + i}`, media, speed] as [string, Media, number]);

export const TEMPLATES: Template[] = [
  {
    model: '1941',
    kind: 'router',
    label: 'Router 1941',
    group: 'Network',
    blurb: 'ISR G2 · 2× Gigabit',
    ports: [
      ['GigabitEthernet0/0', 'copper', 1000],
      ['GigabitEthernet0/1', 'copper', 1000],
    ],
  },
  {
    model: 'ISR4331',
    kind: 'router',
    label: 'Router 4331',
    group: 'Network',
    blurb: 'ISR 4000 · 3× Gigabit',
    ports: range('GigabitEthernet0/0/', 0, 2, 'copper', 1000),
  },
  {
    model: '2911',
    kind: 'router',
    label: 'Router 2911',
    group: 'Network',
    blurb: 'ISR G2 · 3× Gigabit',
    ports: range('GigabitEthernet0/', 0, 2, 'copper', 1000),
  },
  {
    model: '2960-24TT',
    kind: 'switch',
    label: 'Switch 2960',
    group: 'Network',
    blurb: '24× Fast Ethernet · 2× Gigabit',
    ports: [...range('FastEthernet0/', 1, 24, 'copper', 100), ...range('GigabitEthernet0/', 1, 2, 'copper', 1000)],
  },
  {
    model: '3650-24PS',
    kind: 'switch',
    label: 'Switch 3650',
    group: 'Network',
    blurb: '24× Gigabit · multilayer',
    ports: range('GigabitEthernet1/0/', 1, 24, 'copper', 1000),
  },
  {
    model: 'PC-PT',
    kind: 'pc',
    label: 'PC',
    group: 'End devices',
    blurb: 'Desktop · 1× Fast Ethernet',
    ports: [['FastEthernet0', 'copper', 100]],
  },
  {
    model: 'Laptop-PT',
    kind: 'laptop',
    label: 'Laptop',
    group: 'End devices',
    blurb: 'Laptop · 1× Fast Ethernet',
    ports: [['FastEthernet0', 'copper', 100]],
  },
  {
    model: 'Server-PT',
    kind: 'server',
    label: 'Server',
    group: 'End devices',
    blurb: 'Server · 1× Fast Ethernet',
    ports: [['FastEthernet0', 'copper', 100]],
  },
  {
    model: 'Printer-PT',
    kind: 'printer',
    label: 'Printer',
    group: 'End devices',
    blurb: 'Network printer',
    ports: [['FastEthernet0', 'copper', 100]],
  },
  {
    model: 'TabletPC-PT',
    kind: 'tablet',
    label: 'Tablet',
    group: 'Wireless',
    blurb: 'Wi-Fi client',
    ports: [['Wireless0', 'wireless', 300]],
  },
  {
    model: 'SMARTPHONE-PT',
    kind: 'phone',
    label: 'Smartphone',
    group: 'Wireless',
    blurb: 'Wi-Fi client',
    ports: [['Wireless0', 'wireless', 300]],
  },
  {
    model: 'Laptop-PT-W',
    kind: 'laptop',
    label: 'Wi-Fi laptop',
    group: 'Wireless',
    blurb: 'Laptop with wireless card',
    ports: [['Wireless0', 'wireless', 300]],
  },
  {
    model: 'AccessPoint-PT',
    kind: 'ap',
    label: 'Access point',
    group: 'Wireless',
    blurb: 'Bridges Wi-Fi onto a wired LAN',
    ports: [
      ['Port 0', 'copper', 100],
      ['Port 1', 'wireless', 300],
    ],
  },
  {
    model: 'HomeRouter-PT-AC',
    kind: 'homerouter',
    label: 'Home router',
    group: 'Wireless',
    blurb: 'Wi-Fi AC · 4 LAN · NAT · DHCP',
    ports: [
      ['Internet', 'copper', 1000],
      ['GigabitEthernet 1', 'copper', 1000],
      ['GigabitEthernet 2', 'copper', 1000],
      ['GigabitEthernet 3', 'copper', 1000],
      ['GigabitEthernet 4', 'copper', 1000],
      ['Wireless', 'wireless', 867],
    ],
  },
];

export const templateFor = (model: string) => TEMPLATES.find((t) => t.model === model);

export const emptyIos = (hostname: string): IosState => ({
  hostname,
  routes: [],
  pools: [],
  excluded: [],
  leases: [],
  natRules: [],
  extraPre: [],
  extraPost: [],
});

const counters: Record<string, number> = {};

export function nextName(base: string, existing: string[]) {
  let n = counters[base] ?? 0;
  while (existing.includes(`${base}${n}`)) n++;
  counters[base] = n + 1;
  return `${base}${n}`;
}

export function createDevice(t: Template, x: number, y: number, existingNames: string[]): Device {
  const base =
    t.kind === 'router' ? 'Router' : t.kind === 'switch' ? 'Switch' : t.kind === 'homerouter' ? 'Home Router' : t.label.replace(/\s+/g, '');
  const name = nextName(base, existingNames);
  const ifaces: Iface[] = t.ports.map(([n, media, speed]) => ({
    name: n,
    media,
    speed,
    mac: randomMac(),
    // routers ship with interfaces administratively down, like real IOS
    shutdown: t.kind === 'router',
  }));
  const d: Device = { id: uid('dev'), kind: t.kind, model: t.model, name, x, y, ifaces, powered: true };
  if (t.kind === 'router' || t.kind === 'switch') d.ios = emptyIos(name);
  if (t.kind === 'switch') ifaces.push({ name: 'Vlan1', media: 'virtual', speed: 0, mac: randomMac(), shutdown: true });
  if (t.kind === 'ap') d.ssid = 'Default';
  if (t.kind === 'homerouter')
    d.home = {
      lanIp: '192.168.0.1',
      lanMask: '255.255.255.0',
      dhcpEnabled: true,
      startHost: 100,
      maxUsers: 50,
      wanMode: 'dhcp',
      wanIp: '0.0.0.0',
      wanMask: '0.0.0.0',
      wanGateway: '0.0.0.0',
      ssid: 'Default',
      leases: [],
    };
  if (['pc', 'laptop', 'server', 'printer', 'tablet', 'phone'].includes(t.kind)) {
    d.dhcpClient = false;
    d.gateway = '';
    d.dns = '';
    if (t.ports.some((p) => p[1] === 'wireless')) d.ssid = 'Default';
  }
  return d;
}

export const isHost = (d: Device) => ['pc', 'laptop', 'server', 'printer', 'tablet', 'phone'].includes(d.kind);
export const isIos = (d: Device) => !!d.ios;
