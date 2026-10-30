// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { exec, newSession } from '../src/engine/ios';
import { hostExec } from '../src/engine/hostcli';
import { ping, settleDhcp } from '../src/engine/network';
import { importPkt } from '../src/io/pkt';
import { bigToV6, eui64, linkLocal, normV6, slaac, v6ToBig } from '../src/model/ip6';
import { createDevice, templateFor } from '../src/model/catalog';
import type { Device, Project } from '../src/model/types';
import { uid } from '../src/model/types';

test('address helpers', () => {
  expect(normV6('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:DB8::1');
  expect(normV6('fe80::1')).toBe('FE80::1');
  expect(bigToV6(v6ToBig('2001:db8:acad:a::')!)).toBe('2001:DB8:ACAD:A::');
  // Packet Tracer's SLAAC address for MAC 00D0.FF10.A663 (from the ipv6_slaac sample)
  expect(slaac('2001:DB8:ACAD:A::', '00D0.FF10.A663')).toBe('2001:DB8:ACAD:A:2D0:FFFF:FE10:A663');
  expect(linkLocal('00D0.FF10.A663')).toBe('FE80::2D0:FFFF:FE10:A663');
  expect(eui64('0000.0000.0001') > 0n).toBe(true);
});

/** PC1 — R1 — R2 — PC2 over IPv6 only */
function lab() {
  const p: Project = { devices: [], links: [], notes: [] };
  const add = (model: string, name: string) => {
    const d = createDevice(templateFor(model)!, 0, 0, p.devices.map((x) => x.name));
    d.name = name;
    if (d.ios) d.ios.hostname = name;
    p.devices.push(d);
    return d;
  };
  const link = (a: Device, ai: string, b: Device, bi: string) =>
    p.links.push({ id: uid('lnk'), a: { dev: a.id, iface: ai }, b: { dev: b.id, iface: bi }, cable: 'straight' });
  const r1 = add('1941', 'R1');
  const r2 = add('1941', 'R2');
  const pc1 = add('PC-PT', 'PC1');
  const pc2 = add('PC-PT', 'PC2');
  link(pc1, 'FastEthernet0', r1, 'GigabitEthernet0/0');
  link(r1, 'GigabitEthernet0/1', r2, 'GigabitEthernet0/1');
  link(pc2, 'FastEthernet0', r2, 'GigabitEthernet0/0');
  const cfg = (d: Device, lines: string[]) => {
    const s = newSession();
    return ['en', 'conf t', ...lines, 'end'].map((l) => exec(p, d, s, l)).join('');
  };
  return { p, r1, r2, pc1, pc2, cfg };
}

test('static addressing, link-local gateways and static routes', () => {
  const { p, r1, r2, pc1, pc2, cfg } = lab();
  cfg(r1, ['ipv6 unicast-routing', 'int g0/0', 'ipv6 address 2001:db8:acad:1::1/64', 'ipv6 address fe80::1 link-local', 'no shut', 'int g0/1', 'ipv6 address 2001:db8:acad:12::1/64', 'no shut', 'exit', 'ipv6 route 2001:db8:acad:2::/64 2001:db8:acad:12::2']);
  cfg(r2, ['ipv6 unicast-routing', 'int g0/0', 'ipv6 address 2001:db8:acad:2::1/64', 'ipv6 address fe80::1 link-local', 'no shut', 'int g0/1', 'ipv6 address 2001:db8:acad:12::2/64', 'no shut', 'exit', 'ipv6 route ::/0 2001:db8:acad:12::1']);
  pc1.v6Mode = 'static';
  pc1.ifaces[0].v6 = [{ addr: '2001:DB8:ACAD:1::10', len: 64 }];
  pc1.gateway6 = 'FE80::1';
  pc2.v6Mode = 'static';
  pc2.ifaces[0].v6 = [{ addr: '2001:DB8:ACAD:2::10', len: 64 }];
  pc2.gateway6 = 'FE80::1';
  expect(ping(p, pc1.id, '2001:DB8:ACAD:2::10').ok).toBe(true);
  expect(hostExec(p, pc1, 'ping 2001:db8:acad:2::10')).toContain('Reply from 2001:DB8:ACAD:2::10');
  const s = newSession();
  exec(p, r1, s, 'en');
  expect(exec(p, r1, s, 'show running-config')).toContain(' ipv6 address 2001:DB8:ACAD:1::1/64\n ipv6 address FE80::1 link-local');
  expect(exec(p, r1, s, 'show ipv6 route')).toContain('S  2001:DB8:ACAD:2::/64 [1/0]\n     via 2001:DB8:ACAD:12::2');
  expect(exec(p, r1, s, 'show ipv6 interface brief')).toContain('GigabitEthernet0/0        [up/up]\n    FE80::1\n    2001:DB8:ACAD:1::1');
  expect(exec(p, r1, s, 'ping 2001:db8:acad:2::10')).toContain('!!!!!');
  // without ipv6 unicast-routing a router doesn't forward
  cfg(r2, ['no ipv6 unicast-routing']);
  expect(ping(p, pc1.id, '2001:DB8:ACAD:2::10').ok).toBe(false);
});

test('SLAAC and stateless DHCPv6 give a PC its address, gateway and DNS', () => {
  const { p, r1, pc1, cfg } = lab();
  cfg(r1, ['ipv6 unicast-routing', 'ipv6 dhcp pool STATELESS', 'dns-server 2001:db8:acad:1::53', 'domain-name lab.local', 'exit', 'int g0/0', 'ipv6 address 2001:db8:acad:1::1/64', 'ipv6 address fe80::1 link-local', 'ipv6 nd other-config-flag', 'ipv6 dhcp server STATELESS', 'no shut']);
  pc1.v6Mode = 'auto';
  settleDhcp(p);
  expect(pc1.ifaces[0].v6?.[0].addr).toBe(slaac('2001:DB8:ACAD:1::', pc1.ifaces[0].mac));
  expect(pc1.gateway6).toBe('FE80::1');
  expect(pc1.dns6).toBe('2001:DB8:ACAD:1::53');
  expect(hostExec(p, pc1, 'ipconfig')).toContain(`IPv6 Address....................: ${pc1.ifaces[0].v6![0].addr}`);
  expect(ping(p, pc1.id, '2001:DB8:ACAD:1::1').ok).toBe(true);
  const s = newSession();
  exec(p, r1, s, 'en');
  expect(exec(p, r1, s, 'show running-config')).toContain('ipv6 dhcp pool STATELESS\n dns-server 2001:DB8:ACAD:1::53\n domain-name lab.local');
});

test('stateful DHCPv6 hands out addresses from the pool', () => {
  const { p, r1, pc1, cfg } = lab();
  cfg(r1, ['ipv6 unicast-routing', 'ipv6 dhcp pool STATEFUL', 'address prefix 2001:db8:acad:1::/64', 'dns-server 2001:db8:acad:1::53', 'exit', 'int g0/0', 'ipv6 address 2001:db8:acad:1::1/64', 'ipv6 nd managed-config-flag', 'ipv6 dhcp server STATEFUL', 'no shut']);
  pc1.v6Mode = 'dhcp';
  settleDhcp(p);
  expect(pc1.ifaces[0].v6?.[0].addr.startsWith('2001:DB8:ACAD:1::')).toBe(true);
  expect(ping(p, pc1.id, '2001:DB8:ACAD:1::1').ok).toBe(true);
});

const SAMPLE = '/home/claude/work/corpus/01_Networking_IPv6_ipv6_slaac.pkt.xml';
test.skipIf(!existsSync(SAMPLE))("Packet Tracer's SLAAC sample: the PC ends up with the same address PT gave it", () => {
  const xml = readFileSync(SAMPLE, 'utf8');
  const p = importPkt(xml, 'slaac.pkt').project;
  const pc = p.devices.find((d) => d.kind === 'pc')!;
  expect(pc.v6Mode).toBe('auto');
  settleDhcp(p);
  expect(pc.ifaces[0].v6?.[0].addr).toBe('2001:DB8:ACAD:A:2D0:FFFF:FE10:A663');
  expect(ping(p, pc.id, '2001:DB8:ACAD:A::1').ok).toBe(true);
});
