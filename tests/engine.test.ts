// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { produce } from 'immer';
import { expect, test } from 'vitest';
import { importPkt, exportPkt } from '../src/io/pkt';
import { ping, settleDhcp, buildTopo } from '../src/engine/network';
import { exec, newSession, parseRunningConfig, runningConfig } from '../src/engine/ios';
import { hostExec } from '../src/engine/hostcli';
import { uid } from '../src/model/types';
import { sampleProject } from '../src/sample';
import { isHost } from '../src/model/catalog';

test('sample network: double NAT, DHCP, switch SVI', () => {
  const p = sampleProject();
  const by = (n: string) => p.devices.find((d) => d.name === n)!;
  expect(by('Desk-1').ifaces[0].ip).toBe('10.10.10.50');
  expect(by('Tablet').ifaces[0].ip).toMatch(/^192\.168\.0\./);
  expect(ping(p, by('Desk-1').id, '198.51.100.10').ok).toBe(true);
  expect(ping(p, by('Tablet').id, '198.51.100.10').ok).toBe(true);
  expect(ping(p, by('Core-SW').id, '10.10.10.20').ok).toBe(true);
  // ISP has no route back to private space
  expect(ping(p, by('ISP').id, '10.10.10.50').ok).toBe(false);
  const s = newSession();
  const edge = by('Edge');
  exec(p, edge, s, 'en');
  exec(p, edge, s, 'conf t');
  exec(p, edge, s, 'int g0/1');
  exec(p, edge, s, 'shut');
  expect(ping(p, by('Desk-1').id, '10.10.10.1').ok).toBe(false);
  expect(exec(p, edge, s, 'foo')).toContain('% Invalid input');
});

test('round-trips IOS config text', () => {
  const p = sampleProject();
  const edge = p.devices.find((d) => d.name === 'Edge')!;
  const text = runningConfig(edge);
  const copy = JSON.parse(JSON.stringify(edge));
  copy.ifaces.forEach((i: { ip?: string }) => (i.ip = undefined));
  parseRunningConfig(text, copy);
  expect(runningConfig(copy)).toBe(text);
});

// Real Packet Tracer lab (decoded XML). Not committed — point PKT_XML at one of your own labs.
const LAB = process.env.PKT_XML ?? 'samples/a7.xml';
const xml = existsSync(LAB) ? readFileSync(LAB, 'utf8') : '';
const withLab = test.skipIf(!xml);

withLab('imports the assignment', () => {
  const { project, skipped } = importPkt(xml, 'a7.pkt');
  console.log(project.devices.map((d) => `${d.name} [${d.kind}/${d.model}] ${d.ifaces.map((i) => i.name + (i.ip ? '=' + i.ip : '')).join(', ')}`).join('\n'));
  console.log('skipped', skipped);
  const isp = project.devices.find((d) => d.name === 'ISP')!;
  expect(isp.ifaces.find((i) => i.name === 'GigabitEthernet0/0')?.ip).toBe('209.122.122.2');
});

withLab('full lab: DHCP + NAT + ping to web server', () => {
  let { project } = importPkt(xml, 'a7.pkt');
  const by = (n: string) => project.devices.find((d) => d.name === n)!;
  project = produce(project, (p) => {
    const f = (n: string) => p.devices.find((d) => d.name === n)!;
    const isp = f('ISP'), hr = f('Wireless Router0'), web = f('WEB Server'), pc = f('Gaming PC'), lap = f('My Laptop'), tab = f('Home Tablet');
    // configure home router like the assignment
    hr.home!.ssid = 'HomeNetwork'; hr.home!.lanIp = '192.168.0.1'; hr.home!.lanMask = '255.255.255.0'; hr.home!.dhcpEnabled = true; hr.home!.startHost = 100; hr.home!.maxUsers = 50;
    hr.home!.wanMode = 'static'; hr.home!.wanIp = '209.122.122.1'; hr.home!.wanMask = '255.255.255.252'; hr.home!.wanGateway = '209.122.122.2';
    const w = web.ifaces[0]; w.ip = '209.209.100.100'; w.mask = '255.255.255.0'; web.gateway = '209.209.100.101';
    pc.dhcpClient = true; lap.dhcpClient = true; tab.dhcpClient = true;
    // cable whatever isn't cabled yet (the file may be a finished copy)
    const used = (d: string, i: string) => p.links.some((l) => (l.a.dev === d && l.a.iface === i) || (l.b.dev === d && l.b.iface === i));
    const cable = (a: string, ai: string, b: string, bi: string) => !used(a, ai) && !used(b, bi) && p.links.push({ id: uid(), a: { dev: a, iface: ai }, b: { dev: b, iface: bi }, cable: 'straight' });
    cable(isp.id, 'GigabitEthernet0/0', hr.id, 'Internet');
    cable(isp.id, 'GigabitEthernet0/1', web.id, 'FastEthernet0');
    cable(pc.id, 'FastEthernet0', hr.id, 'GigabitEthernet 1');
    cable(lap.id, 'FastEthernet0', hr.id, 'GigabitEthernet 2');
    console.log('dhcp', settleDhcp(p));
  });
  const pc = by('Gaming PC');
  console.log('PC', pc.ifaces[0].ip, pc.gateway, 'tablet', by('Home Tablet').ifaces.map(i=>i.name+'='+i.ip), 'laptopW', by('Home Laptop').ifaces.map(i=>i.name+'='+i.ip));
  const r = ping(project, pc.id, '209.209.100.100');
  console.log(r.ok, r.reason, r.events.map((e) => `${e.kind} ${e.at}: ${e.info}`).join('\n'));
  expect(r.ok).toBe(true);
  const t = ping(project, by('Home Tablet').id, '209.209.100.100');
  console.log('tablet', t.ok, t.reason);
  expect(t.ok).toBe(true);
  // ISP cannot reach a private address
  expect(ping(project, by('ISP').id, pc.ifaces[0].ip!).ok).toBe(false);
  // host CLI
  const out = produce(project, (p) => { console.log(hostExec(p, p.devices.find(d=>d.name==='Gaming PC')!, 'tracert 209.209.100.100')); });
  // export round-trip
  const ex = exportPkt(project);
  const again = importPkt(ex.xml, 'x.pkt').project;
  expect(again.links.length).toBe(project.links.length);
  expect(again.devices.find(d=>d.name==='WEB Server')!.ifaces[0].ip).toBe('209.209.100.100');
});

withLab('a finished Assignment 7 works exactly as saved', () => {
  const { project } = importPkt(xml, 'a7.pkt');
  if (project.links.length < 4) return; // only meaningful for a completed copy
  const p = produce(project, (d) => void settleDhcp(d));
  const by = (n: string) => p.devices.find((d) => d.name === n)!;
  // every host that has an address (by DHCP or set by hand) reaches the web server
  for (const d of p.devices.filter((x) => isHost(x) && x.name !== 'WEB Server' && x.ifaces.some((i) => i.ip && !i.ip.startsWith('169.254'))))
    expect(ping(p, by(d.name).id, '209.209.100.100').ok, d.name).toBe(true);
});

withLab('IOS CLI: DHCP pool on a router', () => {
  let { project } = importPkt(xml, 'a7.pkt');
  const s = newSession();
  project = produce(project, (p) => {
    const isp = p.devices.find((d) => d.name === 'ISP')!;
    const lines = ['en', 'conf t', 'hostname EDGE', 'int g0/1', 'ip address 10.0.0.1 255.255.255.0', 'no shut', 'exit',
      'ip dhcp excluded-address 10.0.0.1 10.0.0.9', 'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1', 'dns-server 8.8.8.8', 'end', 'sh ip int br'];
    for (const l of lines) { const o = exec(p, isp, s, l); if (o.trim()) console.log(`> ${l}\n${o}`); }
    const pc = p.devices.find((d) => d.name === 'Gaming PC')!;
    pc.dhcpClient = true; pc.ifaces[0].ip = undefined;
    p.links.push({ id: uid(), a: { dev: isp.id, iface: 'GigabitEthernet0/1' }, b: { dev: pc.id, iface: 'FastEthernet0' }, cable: 'straight' });
    settleDhcp(p);
    console.log('pc got', pc.ifaces[0].ip, pc.gateway);
    console.log(exec(p, isp, s, 'ping ' + pc.ifaces[0].ip));
    console.log(runningConfig(isp).split('\n').slice(0, 30).join('\n'));
  });
  expect(project.devices.find(d=>d.name==='Gaming PC')!.ifaces[0].ip).toBe('10.0.0.10');
});
