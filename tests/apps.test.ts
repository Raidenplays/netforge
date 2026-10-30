// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { exec, newSession, openRemote, prompt, type Session } from '../src/engine/ios';
import { hostExec } from '../src/engine/hostcli';
import { ping } from '../src/engine/network';
import { httpGet, resolve } from '../src/engine/services';
import { createDevice, templateFor } from '../src/model/catalog';
import type { Device, Project } from '../src/model/types';
import { uid } from '../src/model/types';

/** PC — R1 — Server, with R1 set up for SSH and telnet */
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
  const pc = add('PC-PT', 'PC');
  const r = add('1941', 'R1');
  const srv = add('Server-PT', 'Web');
  link(pc, 'FastEthernet0', r, 'GigabitEthernet0/0');
  link(srv, 'FastEthernet0', r, 'GigabitEthernet0/1');
  Object.assign(pc.ifaces[0], { ip: '192.168.1.10', mask: '255.255.255.0' });
  pc.gateway = '192.168.1.1';
  pc.dns = '10.0.0.10';
  Object.assign(srv.ifaces[0], { ip: '10.0.0.10', mask: '255.255.255.0' });
  srv.gateway = '10.0.0.1';
  const s = newSession();
  for (const l of [
    'en', 'conf t', 'hostname R1', 'ip domain-name lab.local', 'username admin secret cisco123', 'enable secret class',
    'int g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shut', 'int g0/1', 'ip address 10.0.0.1 255.255.255.0', 'no shut', 'exit',
    'line vty 0 4', 'login local', 'transport input ssh telnet', 'end',
  ])
    exec(p, r, s, l);
  return { p, pc, r, srv };
}

const type = (p: Project, d: Device, s: Session, ...lines: string[]) => lines.map((l) => exec(p, d, s, l)).at(-1)!;

test('SSH needs RSA keys, then logs in with the local user database', () => {
  const { p, pc, r } = lab();
  expect(openRemote(p, pc, '192.168.1.1', 'ssh', 'admin').out).toContain('% Connection refused by remote host');
  exec(p, r, (() => { const s = newSession(); exec(p, r, s, 'en'); exec(p, r, s, 'class'); exec(p, r, s, 'conf t'); return s; })(), 'crypto key generate rsa general-keys modulus 1024');
  const bad = openRemote(p, pc, '192.168.1.1', 'ssh', 'admin');
  expect(prompt(bad.dev!, bad.session!)).toBe('Password: ');
  expect(exec(p, bad.dev!, bad.session!, 'nope')).toContain('closed by foreign host');
  const ok = openRemote(p, pc, '192.168.1.1', 'ssh', 'admin');
  exec(p, ok.dev!, ok.session!, 'cisco123');
  expect(prompt(ok.dev!, ok.session!)).toBe('R1>');
  type(p, ok.dev!, ok.session!, 'enable', 'class');
  expect(prompt(ok.dev!, ok.session!)).toBe('R1#');
  expect(exec(p, ok.dev!, ok.session!, 'exit')).toContain('[Connection to 192.168.1.1 closed by foreign host]');
  expect(ok.session!.closed).toBe(true);
});

test('telnet follows transport input and the vty login', () => {
  const { p, pc, r } = lab();
  const t = openRemote(p, pc, '192.168.1.1', 'telnet');
  expect(t.out).toContain('Trying 192.168.1.1 ...Open');
  expect(prompt(t.dev!, t.session!)).toBe('Username: ');
  const s = newSession();
  type(p, r, s, 'en', 'class', 'conf t', 'line vty 0 4', 'transport input ssh', 'end');
  expect(openRemote(p, pc, '192.168.1.1', 'telnet').out).toContain('% Connection refused by remote host');
  expect(openRemote(p, pc, '10.9.9.9', 'telnet').out).toContain('% Connection timed out');
});

test('web browser and nslookup through a DNS server', () => {
  const { p, pc, srv } = lab();
  let r = httpGet(p, pc, '10.0.0.10');
  expect(r.ok).toBe(true);
  expect(r.html).toContain('served by');
  expect(httpGet(p, pc, 'http://10.0.0.10/helloworld.html').html).toContain('Hello, world!');
  expect(httpGet(p, pc, 'http://10.0.0.10/missing.html').status).toBe('404 Not Found');
  // names need a DNS record
  expect(httpGet(p, pc, 'www.lab.local').status).toBe('Host Name Unresolved');
  srv.services!.dns = true;
  srv.services!.records.push({ name: 'www.lab.local', type: 'A', value: '10.0.0.10' }, { name: 'web', type: 'CNAME', value: 'www.lab.local' });
  expect(resolve(p, pc, 'web')).toMatchObject({ ok: true, ip: '10.0.0.10' });
  r = httpGet(p, pc, 'www.lab.local');
  expect(r.ok).toBe(true);
  expect(hostExec(p, pc, 'nslookup www.lab.local')).toContain('Address:  10.0.0.10');
  expect(hostExec(p, pc, 'ping www.lab.local')).toContain('Pinging www.lab.local [10.0.0.10]');
  srv.services!.http = false;
  expect(httpGet(p, pc, 'www.lab.local').status).toBe('Connection refused');
});

test('simulation events carry packet details for the inspector', () => {
  const { p, pc } = lab();
  const r = ping(p, pc.id, '10.0.0.10');
  expect(r.ok).toBe(true);
  const first = r.events[0];
  expect(first.at).toBe('--');
  expect(first.out?.layers[2]).toContain('Src. IP: 192.168.1.10, Dest. IP: 10.0.0.10, TTL: 128');
  const arp = r.events.find((e) => e.kind === 'ARP')!;
  expect(arp.fields?.dstMac).toBe('FFFF.FFFF.FFFF');
  expect(arp.fields?.arp?.targetIp).toBe('192.168.1.1');
  // the router's arrival event: in at TTL 128, out at TTL 127 with new MACs
  const atR1 = r.events.find((e) => e.to === 'R1' && e.kind === 'ICMP')!;
  expect(atR1.in?.layers[2]).toContain('TTL: 128');
  expect(atR1.out?.layers[2]).toContain('TTL: 127');
  expect(atR1.in?.layers[1]).not.toBe(atR1.out?.layers[1]);
  expect(r.events.map((e) => e.time)).toEqual(r.events.map((_, i) => i / 1000));
  // the reply comes back without a second ARP (both sides learned each other)
  expect(r.events.filter((e) => e.kind === 'ARP').length).toBe(2);
});
