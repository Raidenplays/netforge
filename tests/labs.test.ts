// @vitest-environment jsdom
// Runs against real Packet Tracer activities if they're present in samples/
// (decoded with `pktconv text lab.pka lab.xml`). Coursework isn't committed.
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { importPkt, exportPkt } from '../src/io/pkt';
import { ping, settleDhcp } from '../src/engine/network';
import { grade } from '../src/engine/grade';

const lab = (f: string) => {
  const path = `samples/${f}`;
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};
const A5 = lab('Net_-_Assignment_5_MyHomeNetwork.xml');
const A6 = lab('NET_-_Assignment_6_Connect_the_Physical_Layer1.xml');
const DHCP = lab('11_2_3_Packet_Tracer_Configure_DHCP_on_a_Wireless_Router.xml');

const load = (xml: string) => {
  const p = importPkt(xml, 'lab.pka').project;
  for (const d of p.devices) for (const i of d.ifaces) if (d.dhcpClient && i.ip?.startsWith('169.254')) i.ip = undefined;
  settleDhcp(p);
  const by = (n: string) => p.devices.find((d) => d.name === n)!;
  return { p, by };
};

test.skipIf(!A6)('Assignment 6: relay DHCP, serial interface routes, AP Wi-Fi, grading', () => {
  const { p, by } = load(A6);
  expect(p.devices.length).toBe(22);
  expect(p.links.length).toBe(19);
  expect(by('PC1').ifaces[0].ip).toMatch(/^172\.29\.1\./); // via helper-address on East Vlan1
  expect(by('PC4').ifaces[0].ip).toMatch(/^172\.30\.1\./);
  expect(by('Laptop').ifaces[0].ip).not.toBe(by('TabletPC').ifaces[0].ip); // same MAC in the file
  expect(ping(p, by('PC1').id, '209.165.200.225').ok).toBe(true);
  expect(ping(p, by('Laptop').id, '172.31.1.10').ok).toBe(true);
  const g = grade(p)!;
  expect(g.earned).toBe(g.checkable);
  // removing a graded cable is caught
  const cut = { ...p, links: p.links.slice(1) };
  expect(grade(cut)!.earned).toBeLessThan(g.checkable);
});

test.skipIf(!A5)('Assignment 5: home network', () => {
  const { p, by } = load(A5);
  expect(by('MyHomeRouter').home!.ssid).toBeTruthy();
  expect(ping(p, by('PC0').id, '172.16.144.1').ok).toBe(true);
  expect(ping(p, by('MyTablet').id, '172.16.144.1').ok).toBe(true);
  const g = grade(p)!;
  expect(g.earned).toBe(g.checkable);
});

test.skipIf(!DHCP)('11.2.3 DHCP on a wireless router: grading + export keeps answer networks', () => {
  const { p, by } = load(DHCP);
  expect(by('PC0').ifaces[0].ip).toMatch(/^192\.168\.5\./);
  const g = grade(p)!;
  expect(g.earned).toBe(g.checkable);
  // wrong max users is caught
  const h = by('DHCP Enabled Router').home!;
  h.maxUsers = 10;
  expect(grade(p)!.earned).toBeLessThan(g.checkable);
  h.maxUsers = 75;
  const xml = exportPkt(p).xml;
  expect((xml.match(/<PACKETTRACER5>/g) ?? []).length).toBe(3);
  expect(xml).toContain('<COMPARISONS>');
  const again = importPkt(xml, 'x.pka').project;
  expect(again.devices.length).toBe(p.devices.length);
});
