// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { exec, newSession, openRemote, runningConfig } from '../src/engine/ios';
import { hostExec } from '../src/engine/hostcli';
import { ping } from '../src/engine/network';
import { httpGet } from '../src/engine/services';
import { createDevice, templateFor } from '../src/model/catalog';
import type { Device, Project } from '../src/model/types';
import { uid } from '../src/model/types';

/** two PCs on 192.168.10.0/24 and 192.168.20.0/24, a web server on 10.0.0.0/24, one router */
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
  const r = add('2911', 'R1');
  const pcA = add('PC-PT', 'PC-A');
  const pcB = add('PC-PT', 'PC-B');
  const srv = add('Server-PT', 'Web');
  link(pcA, 'FastEthernet0', r, 'GigabitEthernet0/0');
  link(pcB, 'FastEthernet0', r, 'GigabitEthernet0/1');
  link(srv, 'FastEthernet0', r, 'GigabitEthernet0/2');
  const host = (d: Device, ip: string, gw: string) => {
    Object.assign(d.ifaces[0], { ip, mask: '255.255.255.0' });
    d.gateway = gw;
  };
  host(pcA, '192.168.10.10', '192.168.10.1');
  host(pcB, '192.168.20.10', '192.168.20.1');
  host(srv, '10.0.0.10', '10.0.0.1');
  const s = newSession();
  const run = (...lines: string[]) => lines.map((l) => exec(p, r, s, l)).join('');
  run('en', 'conf t');
  for (const [n, ip] of [['g0/0', '192.168.10.1'], ['g0/1', '192.168.20.1'], ['g0/2', '10.0.0.1']]) run(`int ${n}`, `ip address ${ip} 255.255.255.0`, 'no shut');
  run('exit');
  return { p, r, pcA, pcB, srv, run };
}

test('standard ACL close to the destination: only one LAN reaches the server', () => {
  const { p, pcA, pcB, run } = lab();
  expect(ping(p, pcB.id, '10.0.0.10').ok).toBe(true);
  run('access-list 10 permit 192.168.10.0 0.0.0.255', 'int g0/2', 'ip access-group 10 out', 'exit');
  expect(hostExec(p, pcA, 'ping 10.0.0.10')).toContain('Reply from 10.0.0.10');
  const r = ping(p, pcB.id, '10.0.0.10');
  expect(r.ok).toBe(false);
  // like PT, the router answers with an unreachable from the interface the PC talks to
  expect(hostExec(p, pcB, 'ping 10.0.0.10')).toContain('Reply from 192.168.20.1: Destination host unreachable.');
  expect(run('do show access-lists')).toMatch(/Standard IP access list 10\n {4}10 permit 192\.168\.10\.0 0\.0\.0\.255 \(\d+ match\(es\)\)/);
});

test('extended named ACL: web allowed, ping blocked; host bits are cleaned up', () => {
  const { p, r, pcA, srv, run } = lab();
  run('ip access-list extended WEB-ONLY', 'permit tcp 192.168.10.5 0.0.0.255 host 10.0.0.10 eq 80', 'deny icmp any any', '30 permit ip any any', 'exit');
  run('int g0/0', 'ip access-group WEB-ONLY in', 'exit');
  const cfg = runningConfig(r);
  expect(cfg).toContain('ip access-list extended WEB-ONLY\n 10 permit tcp 192.168.10.0 0.0.0.255 host 10.0.0.10 eq www\n 20 deny icmp any any\n 30 permit ip any any');
  expect(cfg).toContain(' ip access-group WEB-ONLY in');
  expect(httpGet(p, pcA, 'http://10.0.0.10').ok).toBe(true);
  expect(ping(p, pcA.id, '10.0.0.10').ok).toBe(false);
  void srv;
  // deleting one entry by number lets ping through
  run('ip access-list extended WEB-ONLY', 'no 20', 'exit');
  expect(ping(p, pcA.id, '10.0.0.10').ok).toBe(true);
});

test('ACL syntax errors put the caret on the bad word', () => {
  const { run } = lab();
  expect(run('access-list 101 permit tcp any hots 10.0.0.10')).toContain("% Invalid input detected at '^' marker.");
  expect(run('access-list 10 permit tcp any')).toContain('% Invalid input');
  expect(run('access-list 50 deny host 192.168.20.10')).toBe('');
  expect(run('do show access-lists 50')).toContain('10 deny host 192.168.20.10');
});

test('access-class limits who can telnet in', () => {
  const { p, r, pcA, pcB, run } = lab();
  run('line vty 0 4', 'password cisco', 'login', 'access-class 5 in', 'exit', 'access-list 5 permit host 192.168.10.10');
  expect(openRemote(p, pcA, '192.168.10.1', 'telnet').session).toBeTruthy();
  expect(openRemote(p, pcB, '192.168.20.1', 'telnet').out).toContain('% Connection refused by remote host');
  void r;
});
