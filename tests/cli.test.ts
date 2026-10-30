// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { complete, exec, help, newSession, parseRunningConfig, prompt, runningConfig, startSession, type Session } from '../src/engine/ios';
import { md5crypt, type7Decode, type7Encode } from '../src/engine/iospw';
import { ping } from '../src/engine/network';
import { createDevice, templateFor } from '../src/model/catalog';
import type { Device, Project } from '../src/model/types';
import { uid } from '../src/model/types';

function net() {
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
  return { p, add, link };
}

/** run lines, return the output of the last one */
const run = (p: Project, d: Device, s: Session, ...lines: string[]) => lines.map((l) => exec(p, d, s, l)).at(-1)!;

test('password encodings match Packet Tracer', () => {
  expect(md5crypt('cisco')).toBe('$1$mERr$hx5rVt7rPNoS4wqbXKX7m0');
  expect(md5crypt('class')).toBe('$1$mERr$9cTjUIEqNGurQiFU.ZeCi1');
  expect(md5crypt('a much longer password than sixteen')).toBe('$1$mERr$T2StrOZ0vVxnrIJayhi4L/');
  expect(type7Encode('cisco')).toBe('0822455D0A16');
  expect(type7Decode(type7Encode('S3cret!'))).toBe('S3cret!');
});

test('basic device settings: secrets, line passwords, encryption, banner', () => {
  const { p, add } = net();
  const r = add('2911', 'Router');
  const s = newSession();
  run(p, r, s, 'en', 'conf t', 'hostname R1', 'enable secret class', 'line con 0', 'password cisco', 'login', 'exit');
  run(p, r, s, 'line vty 0 4', 'pass cisco', 'login', 'transport input ssh', 'exit');
  run(p, r, s, 'banner motd #Authorized access only!#');
  let cfg = runningConfig(r);
  expect(cfg).toContain('hostname R1');
  expect(cfg).toContain('enable secret 5 $1$mERr$9cTjUIEqNGurQiFU.ZeCi1');
  expect(cfg).toContain('line con 0\n password cisco\n login\n!');
  expect(cfg).toContain('line vty 0 4\n password cisco\n login\n transport input ssh\n!');
  expect(cfg).toContain('banner motd ^C\nAuthorized access only!\n^C');
  expect(cfg).toContain('no service password-encryption');
  run(p, r, s, 'service password-encryption');
  cfg = runningConfig(r);
  expect(cfg).toContain('service password-encryption');
  expect(cfg).toContain(' password 7 0822455D0A16');
  expect(cfg).not.toContain(' password cisco');
  // parse it back
  const copy: Device = JSON.parse(JSON.stringify(r));
  parseRunningConfig(cfg, copy);
  expect(runningConfig(copy)).toBe(cfg);
});

test('enable secret and console login prompt for passwords', () => {
  const { p, add } = net();
  const r = add('1941', 'R1');
  const s = newSession();
  run(p, r, s, 'enable', 'configure terminal', 'enable secret class', 'line console 0', 'password cisco', 'login', 'end', 'disable');
  expect(prompt(r, s)).toBe('R1>');
  exec(p, r, s, 'enable');
  expect(prompt(r, s)).toBe('Password: ');
  exec(p, r, s, 'wrong');
  exec(p, r, s, 'wrong');
  expect(exec(p, r, s, 'wrong')).toContain('% Bad secrets');
  expect(prompt(r, s)).toBe('R1>');
  run(p, r, s, 'enable', 'class');
  expect(prompt(r, s)).toBe('R1#');
  // logging out and back in asks for the console password
  expect(exec(p, r, s, 'exit')).toContain('Press RETURN to get started');
  expect(exec(p, r, s, '')).toContain('User Access Verification');
  expect(prompt(r, s)).toBe('Password: ');
  exec(p, r, s, 'cisco');
  expect(prompt(r, s)).toBe('R1>');
  // a new console session starts at the login too
  const s2 = startSession(r);
  expect(exec(p, r, s2, '')).toContain('User Access Verification');
});

test('login local uses the username database', () => {
  const { p, add } = net();
  const r = add('1941', 'R1');
  const s = newSession();
  run(p, r, s, 'en', 'conf t', 'username admin secret Adm1nP@55', 'line con 0', 'login local', 'end');
  expect(runningConfig(r)).toContain(`username admin secret 5 ${md5crypt('Adm1nP@55')}`);
  exec(p, r, s, 'exit');
  exec(p, r, s, '');
  expect(prompt(r, s)).toBe('Username: ');
  exec(p, r, s, 'admin');
  expect(exec(p, r, s, 'nope')).toContain('% Login invalid');
  run(p, r, s, 'admin', 'Adm1nP@55');
  expect(prompt(r, s)).toBe('R1>');
});

test('IOS-style errors, help and completion', () => {
  const { p, add } = net();
  const r = add('2911', 'R1');
  const s = newSession();
  expect(exec(p, r, s, 'configure terminal')).toContain('% Invalid input'); // user mode
  exec(p, r, s, 'en');
  // caret sits under the bad word: "R1#" is 3 chars, "show " is 5
  expect(exec(p, r, s, 'show ipp route')).toBe(`${' '.repeat(8)}^\n% Invalid input detected at '^' marker.\n`);
  expect(exec(p, r, s, 'show ip')).toBe('% Incomplete command.\n');
  expect(exec(p, r, s, 'c')).toContain('% Ambiguous command: "c"');
  expect(help(r, s, 'co')).toBe('configure  copy\n');
  expect(help(r, s, 'show ip interface ')).toContain('brief');
  expect(help(r, s, 'show ip interface brief ')).toContain('<cr>');
  expect(complete(s, 'sh')).toBe('show ');
  expect(complete(s, 'show ip int')).toBe('show ip interface ');
  exec(p, r, s, 'conf t');
  expect(complete(s, 'int g')).toBe('int GigabitEthernet');
  expect(complete(s, 'do sh')).toBe('do show ');
  expect(exec(p, r, s, 'hostnmae R2')).toContain('% Invalid input');
  expect(help(r, s, '')).toContain('  no ');
  // abbreviations are stored in full
  run(p, r, s, 'int g0/0', 'ip add 10.0.0.1 255.255.255.0', 'no shut', 'desc uplink to ISP');
  const cfg = runningConfig(r);
  expect(cfg).toContain('interface GigabitEthernet0/0\n description uplink to ISP\n ip address 10.0.0.1 255.255.255.0\n');
  // an interface-mode prompt falls back to global commands
  exec(p, r, s, 'hostname R9');
  expect(prompt(r, s)).toBe('R9(config)#');
  expect(exec(p, r, s, 'ip route 10.1.0.0 255.255.0.0 10.0.0.2')).toBe('');
  expect(exec(p, r, s, 'ip route 10.1.0.1 255.255.0.0 10.0.0.2')).toContain('Inconsistent address and mask');
});

test('SSH setup: domain name, RSA keys, ssh version', () => {
  const { p, add } = net();
  const r = add('1941', 'Router');
  const s = newSession();
  run(p, r, s, 'en', 'conf t');
  expect(exec(p, r, s, 'crypto key generate rsa')).toContain('hostname other than Router');
  exec(p, r, s, 'hostname R1');
  expect(exec(p, r, s, 'crypto key generate rsa')).toContain('% Please define a domain-name first.');
  exec(p, r, s, 'ip domain-name netacad.pka');
  expect(exec(p, r, s, 'crypto key generate rsa')).toContain('The name for the keys will be: R1.netacad.pka');
  expect(prompt(r, s)).toBe('How many bits in the modulus [512]: ');
  expect(exec(p, r, s, '1024')).toContain('SSH 1.99 has been enabled');
  exec(p, r, s, 'ip ssh version 2');
  expect(exec(p, r, s, 'do show ip ssh')).toContain('SSH Enabled - version 2.0');
  expect(runningConfig(r)).toContain('ip domain-name netacad.pka');
});

test('startup-config: copy run start, reload restores it', () => {
  const { p, add } = net();
  const r = add('1941', 'R1');
  const s = newSession();
  run(p, r, s, 'en');
  expect(exec(p, r, s, 'show startup-config')).toBe('startup-config is not present\n');
  run(p, r, s, 'conf t', 'hostname Saved', 'end', 'copy running-config startup-config');
  expect(prompt(r, s)).toBe('Destination filename [startup-config]? ');
  expect(exec(p, r, s, '')).toContain('[OK]');
  run(p, r, s, 'conf t', 'hostname NotSaved', 'end');
  exec(p, r, s, 'reload');
  expect(prompt(r, s)).toBe('Proceed with reload? [confirm]');
  exec(p, r, s, '');
  exec(p, r, s, '');
  expect(prompt(r, s)).toBe('Saved>');
});

test('VLANs, trunks and router-on-a-stick', () => {
  const { p, add, link } = net();
  const r = add('1941', 'R1');
  const s1 = add('2960-24TT', 'S1');
  const s2 = add('2960-24TT', 'S2');
  const pcA = add('PC-PT', 'PC-A'); // VLAN 10 on S1
  const pcB = add('PC-PT', 'PC-B'); // VLAN 10 on S2
  const pcC = add('PC-PT', 'PC-C'); // VLAN 20 on S2
  link(s1, 'FastEthernet0/1', pcA, 'FastEthernet0');
  link(s2, 'FastEthernet0/1', pcB, 'FastEthernet0');
  link(s2, 'FastEthernet0/2', pcC, 'FastEthernet0');
  link(s1, 'GigabitEthernet0/1', s2, 'GigabitEthernet0/1');
  link(s1, 'GigabitEthernet0/2', r, 'GigabitEthernet0/0');
  const host = (d: Device, ip: string, gw: string) => {
    d.ifaces[0].ip = ip;
    d.ifaces[0].mask = '255.255.255.0';
    d.gateway = gw;
  };
  host(pcA, '192.168.10.11', '192.168.10.1');
  host(pcB, '192.168.10.12', '192.168.10.1');
  host(pcC, '192.168.20.13', '192.168.20.1');

  for (const sw of [s1, s2]) {
    const s = newSession();
    run(p, sw, s, 'en', 'conf t', 'vlan 10', 'name Students', 'vlan 20', 'name Faculty', 'exit');
    run(p, sw, s, 'int f0/1', 'sw mo acc', 'sw acc vlan 10');
  }
  run(p, s2, newSession(), 'en', 'conf t', 'int fa0/2', 'switchport mode access', 'switchport access vlan 20');
  // only S1 configures the trunk; S2's port negotiates (dynamic auto)
  const s = newSession();
  run(p, s1, s, 'en', 'conf t', 'int g0/1', 'switchport mode trunk', 'int g0/2', 'switchport mode trunk', 'end');
  expect(exec(p, s1, s, 'show vlan brief')).toMatch(/10\s+Students\s+active\s+Fa0\/1/);
  expect(exec(p, s1, s, 'show interfaces trunk')).toContain('Gig0/1');

  // same VLAN across the trunk: yes; different VLANs without a router: no
  expect(ping(p, pcA.id, '192.168.10.12').ok).toBe(true);
  expect(ping(p, pcA.id, '192.168.20.13').ok).toBe(false);

  // router-on-a-stick
  const rs = newSession();
  run(p, r, rs, 'en', 'conf t', 'int g0/0.10', 'encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0');
  expect(prompt(r, rs)).toBe('R1(config-subif)#');
  run(p, r, rs, 'int g0/0.20', 'encapsulation dot1Q 20', 'ip address 192.168.20.1 255.255.255.0', 'int g0/0', 'no shutdown', 'end');
  expect(ping(p, pcA.id, '192.168.20.13').ok).toBe(true);
  expect(runningConfig(r)).toContain('interface GigabitEthernet0/0.10\n encapsulation dot1Q 10\n ip address 192.168.10.1 255.255.255.0\n!');

  // pruning VLAN 20 off the S1–S2 trunk cuts PC-C off
  run(p, s1, s, 'conf t', 'int g0/1', 'switchport trunk allowed vlan 1,10', 'end');
  expect(ping(p, pcA.id, '192.168.20.13').ok).toBe(false);
  expect(ping(p, pcA.id, '192.168.10.12').ok).toBe(true);

  // config round-trip keeps the switchport settings
  const cfg = runningConfig(s1);
  expect(cfg).toContain('interface FastEthernet0/1\n switchport access vlan 10\n switchport mode access\n!');
  expect(cfg).toContain('interface GigabitEthernet0/1\n switchport trunk allowed vlan 1,10\n switchport mode trunk\n!');
});

test('access VLAN that does not exist yet is created, like IOS', () => {
  const { p, add } = net();
  const sw = add('2960-24TT', 'S1');
  const s = newSession();
  expect(run(p, sw, s, 'en', 'conf t', 'int f0/5', 'switchport access vlan 99')).toContain('% Access VLAN does not exist. Creating vlan 99');
  expect(exec(p, sw, s, 'do show vlan brief')).toMatch(/99\s+VLAN0099\s+active\s+Fa0\/5/);
});

test('first ping from a router loses one packet to ARP', () => {
  const { p, add, link } = net();
  const r = add('1941', 'R1');
  const pc = add('PC-PT', 'PC');
  link(r, 'GigabitEthernet0/0', pc, 'FastEthernet0');
  pc.ifaces[0].ip = '10.0.0.10';
  pc.ifaces[0].mask = '255.255.255.0';
  const s = newSession();
  run(p, r, s, 'en', 'conf t', 'int g0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end');
  expect(exec(p, r, s, 'ping 10.0.0.10')).toContain('.!!!!\nSuccess rate is 80 percent (4/5)');
  expect(exec(p, r, s, 'ping 10.0.0.10')).toContain('!!!!!\nSuccess rate is 100 percent (5/5)');
});
