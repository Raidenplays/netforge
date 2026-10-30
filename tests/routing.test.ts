// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { exec, newSession } from '../src/engine/ios';
import { ping } from '../src/engine/network';
import { createDevice, templateFor } from '../src/model/catalog';
import type { Device, Project } from '../src/model/types';
import { uid } from '../src/model/types';

/**
 *  PC1 — R1 ==(10.0.12.0/30)== R2 ==(10.0.23.0/30)== R3 — PC3
 *  LANs 192.168.1.0/24 and 192.168.3.0/24, R2 has Loopback0 2.2.2.2
 */
function line() {
  const p: Project = { devices: [], links: [], notes: [] };
  const add = (model: string, name: string) => {
    const d = createDevice(templateFor(model)!, 0, 0, p.devices.map((x) => x.name));
    d.name = name;
    if (d.ios) d.ios.hostname = name;
    p.devices.push(d);
    return d;
  };
  const link = (a: Device, ai: string, b: Device, bi: string) =>
    p.links.push({ id: uid('lnk'), a: { dev: a.id, iface: ai }, b: { dev: b.id, iface: bi }, cable: 'cross' });
  const r1 = add('2911', 'R1');
  const r2 = add('2911', 'R2');
  const r3 = add('2911', 'R3');
  const pc1 = add('PC-PT', 'PC1');
  const pc3 = add('PC-PT', 'PC3');
  link(pc1, 'FastEthernet0', r1, 'GigabitEthernet0/0');
  link(r1, 'GigabitEthernet0/1', r2, 'GigabitEthernet0/1');
  link(r2, 'GigabitEthernet0/2', r3, 'GigabitEthernet0/2');
  link(pc3, 'FastEthernet0', r3, 'GigabitEthernet0/0');
  Object.assign(pc1.ifaces[0], { ip: '192.168.1.10', mask: '255.255.255.0' });
  pc1.gateway = '192.168.1.1';
  Object.assign(pc3.ifaces[0], { ip: '192.168.3.10', mask: '255.255.255.0' });
  pc3.gateway = '192.168.3.1';
  const cfg = (d: Device, lines: string[]) => {
    const s = newSession();
    return ['en', 'conf t', ...lines, 'end'].map((l) => exec(p, d, s, l)).join('');
  };
  const ifc = (n: string, ip: string, mask = '255.255.255.252') => [`int ${n}`, `ip address ${ip} ${mask}`, 'no shut'];
  cfg(r1, [...ifc('g0/0', '192.168.1.1', '255.255.255.0'), ...ifc('g0/1', '10.0.12.1')]);
  cfg(r2, [...ifc('g0/1', '10.0.12.2'), ...ifc('g0/2', '10.0.23.1'), 'int lo0', 'ip address 2.2.2.2 255.255.255.255']);
  cfg(r3, [...ifc('g0/0', '192.168.3.1', '255.255.255.0'), ...ifc('g0/2', '10.0.23.2')]);
  const show = (d: Device, c: string) => exec(p, d, (() => { const s = newSession(); exec(p, d, s, 'en'); return s; })(), c);
  return { p, r1, r2, r3, pc1, pc3, cfg, show };
}

test('without routing, the far LAN is unreachable', () => {
  const { p, pc1 } = line();
  expect(ping(p, pc1.id, '192.168.3.10').ok).toBe(false);
});

test('OSPF: adjacencies, routes with costs, neighbor table, passive interfaces', () => {
  const { p, r1, r2, r3, pc1, cfg, show } = line();
  cfg(r1, ['router ospf 1', 'network 192.168.1.0 0.0.0.255 area 0', 'network 10.0.12.0 0.0.0.3 area 0']);
  const msg = cfg(r2, ['router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'network 2.2.2.2 0.0.0.0 area 0']);
  expect(msg).toContain('%OSPF-5-ADJCHG: Process 1, Nbr 192.168.1.1 on GigabitEthernet0/1 from LOADING to FULL, Loading Done');
  cfg(r3, ['router ospf 1', 'router-id 3.3.3.3', 'network 192.168.3.0 0.0.0.255 area 0', 'network 10.0.23.0 0.0.0.3 area 0', 'passive-interface g0/0']);
  expect(ping(p, pc1.id, '192.168.3.10').ok).toBe(true);
  const rt = show(r1, 'show ip route');
  expect(rt).toContain('O    192.168.3.0/24 [110/3] via 10.0.12.2, ');
  expect(rt).toContain('O       2.2.2.2/32 [110/2] via 10.0.12.2');
  expect(rt).toContain('10.0.0.0/8 is variably subnetted');
  expect(show(r2, 'show ip ospf neighbor')).toMatch(/3\.3\.3\.3\s+1\s+FULL\/DR\s+\S+\s+10\.0\.23\.2\s+GigabitEthernet0\/2/);
  expect(show(r1, 'show ip protocols')).toContain('Routing Protocol is "ospf 1"');
  // the router ID comes from the loopback
  expect(show(r2, 'show ip ospf')).toContain('with ID 2.2.2.2');
  // a passive link interface drops the adjacency
  expect(cfg(r3, ['router ospf 1', 'passive-interface g0/2'])).toContain('from FULL to DOWN');
  expect(ping(p, pc1.id, '192.168.3.10').ok).toBe(false);
});

test('EIGRP: same AS only, composite metrics', () => {
  const { p, r1, r2, r3, pc1, cfg, show } = line();
  cfg(r1, ['router eigrp 10', 'network 192.168.1.0', 'network 10.0.12.0 0.0.0.3', 'no auto-summary']);
  cfg(r2, ['router eigrp 10', 'network 10.0.0.0', 'no auto-summary']);
  cfg(r3, ['router eigrp 20', 'network 192.168.3.0', 'network 10.0.0.0', 'no auto-summary']);
  expect(ping(p, pc1.id, '192.168.3.10').ok).toBe(false); // AS mismatch
  const up = cfg(r3, ['no router eigrp 20', 'router eigrp 10', 'network 192.168.3.0', 'network 10.0.0.0', 'no auto-summary']);
  expect(up).toContain('%DUAL-5-NBRCHANGE: IP-EIGRP 10: Neighbor 10.0.23.1 (GigabitEthernet0/2) is up: new adjacency');
  expect(ping(p, pc1.id, '192.168.3.10').ok).toBe(true);
  // 3 gigabit hops: 256 * (10^7/10^6 + 30us/10) = 3328
  expect(show(r1, 'show ip route')).toContain('D    192.168.3.0/24 [90/3328] via 10.0.12.2');
  expect(show(r1, 'show ip eigrp neighbors')).toContain('10.0.12.2');
});

test('RIP v2: hop counts and classful summarisation', () => {
  const { p, r1, r2, r3, pc1, cfg, show } = line();
  for (const r of [r1, r2, r3]) cfg(r, ['router rip', 'version 2', 'no auto-summary', 'network 10.0.0.0', 'network 192.168.1.0', 'network 192.168.3.0']);
  expect(ping(p, pc1.id, '192.168.3.10').ok).toBe(true);
  expect(show(r1, 'show ip route')).toContain('R    192.168.3.0/24 [120/2] via 10.0.12.2');
  expect(show(r1, 'show running-config')).toContain('router rip\n version 2\n no auto-summary\n network 10.0.0.0');
  expect(show(r2, 'show ip protocols')).toContain('Routing Protocol is "rip"');
});

test('administrative distance: OSPF beats RIP, a floating static route takes over when OSPF goes away', () => {
  const { p, r1, r2, r3, pc1, cfg, show } = line();
  for (const r of [r1, r2, r3]) {
    cfg(r, ['router rip', 'version 2', 'network 10.0.0.0', 'network 192.168.1.0', 'network 192.168.3.0']);
    cfg(r, ['router ospf 1', 'network 0.0.0.0 255.255.255.255 area 0']);
  }
  expect(show(r1, 'show ip route')).toMatch(/O\s+192\.168\.3\.0\/24 \[110\//);
  expect(show(r1, 'show ip route')).not.toMatch(/R\s+192\.168\.3\.0/);
  cfg(r1, ['ip route 192.168.3.0 255.255.255.0 10.0.12.2 130']);
  expect(show(r1, 'show ip route')).not.toMatch(/S\s+192\.168\.3\.0/);
  for (const r of [r1, r2, r3]) cfg(r, ['no router ospf 1', 'no router rip']);
  expect(show(r1, 'show ip route')).toContain('S    192.168.3.0/24 [130/0] via 10.0.12.2');
  expect(show(r1, 'show running-config')).toContain('ip route 192.168.3.0 255.255.255.0 10.0.12.2 130');
  void pc1;
  void p;
});

test('default route origination', () => {
  const { p, r1, r3, pc1, cfg, show } = line();
  const r2 = p.devices.find((d) => d.name === 'R2')!;
  cfg(r3, ['ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/0', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'network 192.168.3.0 0.0.0.255 area 0', 'default-information originate']);
  cfg(r2, ['router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0']);
  cfg(r1, ['router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'network 192.168.1.0 0.0.0.255 area 0']);
  const rt = show(r1, 'show ip route');
  expect(rt).toContain('Gateway of last resort is 10.0.12.2 to network 0.0.0.0');
  expect(rt).toContain('O*E2 0.0.0.0/0 [110/1] via 10.0.12.2');
  expect(ping(p, pc1.id, '192.168.3.10').ok).toBe(true);
});
