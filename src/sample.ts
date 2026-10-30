import { createDevice, templateFor } from './model/catalog';
import type { Project } from './model/types';
import { uid } from './model/types';
import { exec, newSession } from './engine/ios';
import { settleDhcp } from './engine/network';

/** Small office network: router with DHCP + NAT to an ISP, a switch, PCs, a server and Wi-Fi. */
export function sampleProject(): Project {
  const p: Project = { devices: [], links: [], notes: [], fileName: 'Sample office.netforge' };
  const add = (model: string, x: number, y: number, name: string) => {
    const d = createDevice(templateFor(model)!, x, y, p.devices.map((d) => d.name));
    d.name = name;
    if (d.ios) d.ios.hostname = name;
    p.devices.push(d);
    return d;
  };
  const isp = add('1941', 420, 80, 'ISP');
  const web = add('Server-PT', 720, 80, 'Web-Server');
  const edge = add('2911', 420, 250, 'Edge');
  const sw = add('2960-24TT', 420, 410, 'Core-SW');
  const pc1 = add('PC-PT', 240, 560, 'Desk-1');
  const pc2 = add('Laptop-PT', 420, 580, 'Desk-2');
  const srv = add('Server-PT', 600, 560, 'Files');
  const home = add('HomeRouter-PT-AC', 150, 330, 'Guest-WiFi');
  const tab = add('TabletPC-PT', 40, 470, 'Tablet');

  const link = (a: typeof isp, ai: string, b: typeof isp, bi: string, cable: 'straight' | 'cross' = 'straight') =>
    p.links.push({ id: uid('lnk'), a: { dev: a.id, iface: ai }, b: { dev: b.id, iface: bi }, cable });
  link(isp, 'GigabitEthernet0/1', web, 'FastEthernet0');
  link(isp, 'GigabitEthernet0/0', edge, 'GigabitEthernet0/0', 'cross');
  link(edge, 'GigabitEthernet0/1', sw, 'GigabitEthernet0/1');
  link(sw, 'FastEthernet0/1', pc1, 'FastEthernet0');
  link(sw, 'FastEthernet0/2', pc2, 'FastEthernet0');
  link(sw, 'FastEthernet0/3', srv, 'FastEthernet0');
  link(edge, 'GigabitEthernet0/2', home, 'Internet', 'straight');

  const run = (d: typeof isp, cmds: string[]) => {
    const s = newSession();
    for (const c of cmds) exec(p, d, s, c);
  };
  run(isp, ['en', 'conf t', 'int g0/0', 'ip add 203.0.113.1 255.255.255.252', 'no shut', 'int g0/1', 'ip add 198.51.100.1 255.255.255.0', 'no shut', 'end']);
  run(edge, [
    'en',
    'conf t',
    'int g0/0',
    'ip add 203.0.113.2 255.255.255.252',
    'ip nat outside',
    'no shut',
    'int g0/1',
    'ip add 10.10.10.1 255.255.255.0',
    'ip nat inside',
    'no shut',
    'int g0/2',
    'ip add 10.20.20.1 255.255.255.0',
    'ip nat inside',
    'no shut',
    'exit',
    'ip dhcp excluded-address 10.10.10.1 10.10.10.49',
    'ip dhcp pool OFFICE',
    'network 10.10.10.0 255.255.255.0',
    'default-router 10.10.10.1',
    'dns-server 198.51.100.10',
    'exit',
    'ip dhcp pool GUEST',
    'network 10.20.20.0 255.255.255.0',
    'default-router 10.20.20.1',
    'exit',
    'access-list 1 permit 10.0.0.0 0.255.255.255',
    'ip nat inside source list 1 interface g0/0 overload',
    'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
    'end',
  ]);
  run(sw, ['en', 'conf t', 'int vlan 1', 'ip add 10.10.10.2 255.255.255.0', 'no shut', 'exit', 'ip default-gateway 10.10.10.1', 'end']);

  web.ifaces[0].ip = '198.51.100.10';
  web.ifaces[0].mask = '255.255.255.0';
  web.gateway = '198.51.100.1';
  srv.ifaces[0].ip = '10.10.10.20';
  srv.ifaces[0].mask = '255.255.255.0';
  srv.gateway = '10.10.10.1';
  for (const d of [pc1, pc2, tab]) d.dhcpClient = true;
  home.home!.ssid = 'Guest';
  tab.ssid = 'Guest';

  p.notes.push({ id: uid('note'), x: 620, y: 230, text: 'Try: Ping tool → Desk-1 → Web-Server.\nSwitch to Simulation to step through NAT.' });
  settleDhcp(p);
  return p;
}
