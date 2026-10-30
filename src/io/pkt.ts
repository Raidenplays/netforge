/**
 * Map Packet Tracer XML (decoded by the Rust backend) to a NetForge project and back.
 * Export patches the original XML so everything NetForge doesn't model is preserved.
 */
import { emptyIos } from '../model/catalog';
import { randomMac } from '../model/ip';
import type { CableType, Device, DeviceKind, Iface, Link, Media, Project } from '../model/types';
import { uid } from '../model/types';
import { parseRunningConfig, runningConfig } from '../engine/ios';

const KIND: Record<string, DeviceKind> = {
  Router: 'router',
  Switch: 'switch',
  MultiLayerSwitch: 'switch',
  Pc: 'pc',
  Laptop: 'laptop',
  Server: 'server',
  TabletPC: 'tablet',
  Pda: 'phone',
  SmartPhone: 'phone',
  Printer: 'printer',
  WirelessRouter: 'homerouter',
  WirelessRouterNewGeneration: 'homerouter',
  HomeRouter: 'homerouter',
  Cloud: 'cloud',
};

const SKIP = new Set(['Power Distribution Device']);

const kids = (el: Element | null | undefined, tag: string) =>
  el ? Array.from(el.children).filter((c) => c.tagName === tag) : [];
const kid = (el: Element | null | undefined, tag: string) => kids(el, tag)[0] ?? null;
const txt = (el: Element | null | undefined, path: string) => {
  let cur: Element | null | undefined = el;
  for (const p of path.split('/')) cur = kid(cur, p);
  return cur?.textContent?.trim() ?? '';
};
const setTxt = (el: Element | null | undefined, path: string, value: string) => {
  let cur: Element | null | undefined = el;
  for (const p of path.split('/')) cur = kid(cur, p);
  if (cur) cur.textContent = value;
};

function mediaOf(type: string): [Media, number, string] {
  if (type.includes('Wireless')) return ['wireless', 300, 'Wireless'];
  if (type.includes('Gigabit')) return ['copper', 1000, 'GigabitEthernet'];
  if (type.includes('FastEthernet')) return ['copper', 100, 'FastEthernet'];
  if (type.includes('Fiber')) return ['fiber', 1000, 'GigabitEthernet'];
  if (type.includes('Serial')) return ['serial', 2, 'Serial'];
  if (type.includes('Ethernet')) return ['copper', 10, 'Ethernet'];
  return ['copper', 100, ''];
}

interface RawPort {
  el: Element;
  type: string;
  path: number[];
  index: number;
}

function collectPorts(mod: Element | null, path: number[] = [], out: RawPort[] = []) {
  if (!mod) return out;
  kids(mod, 'PORT').forEach((el, index) => out.push({ el, type: txt(el, 'TYPE'), path, index }));
  kids(mod, 'SLOT').forEach((slot, si) => kids(slot, 'MODULE').forEach((m) => collectPorts(m, [...path, si], out)));
  return out;
}

function configLines(engine: Element, tag: string) {
  return kids(kid(engine, tag), 'LINE').map((l) => l.textContent ?? '');
}

/** Derive interface names the way Packet Tracer shows them. */
function nameIfaces(kind: DeviceKind, ports: RawPort[], cfg: string[]): (string | null)[] {
  if (kind === 'homerouter') {
    let eth = 0;
    let wifi = false;
    return ports.map((p) => {
      if (p.type.startsWith('eCopper')) return eth++ === 0 ? 'Internet' : `Ethernet ${eth - 1}`;
      if (p.type.startsWith('eAccessPoint') && !wifi) {
        wifi = true;
        return 'Wireless';
      }
      return null;
    });
  }
  if (kind === 'router' || kind === 'switch') {
    const cfgNames = cfg.map((l) => l.match(/^interface (\S+)/)?.[1]).filter((n): n is string => !!n && !/^(Vlan|Loopback)/.test(n));
    const phys = ports.filter((p) => p.type && !p.type.includes('Wireless'));
    if (cfgNames.length === phys.length) {
      let k = 0;
      return ports.map((p) => (p.type && !p.type.includes('Wireless') ? cfgNames[k++] : null));
    }
    const counters: Record<string, number> = {};
    return ports.map((p) => {
      const [, , prefix] = mediaOf(p.type);
      if (!prefix) return null;
      if (kind === 'switch') {
        counters[prefix] = (counters[prefix] ?? 0) + 1;
        return `${prefix}0/${counters[prefix]}`;
      }
      return `${prefix}${[...p.path.slice(1), p.index].length ? [0, ...p.path.slice(1), p.index].join('/') : '0'}`;
    });
  }
  const counters: Record<string, number> = {};
  return ports.map((p) => {
    const [, , prefix] = mediaOf(p.type);
    if (!prefix) return null;
    const n = counters[prefix] ?? 0;
    counters[prefix] = n + 1;
    return `${prefix}${n}`;
  });
}

const CABLE_FROM_PT: Record<string, CableType> = {
  eStraightThrough: 'straight',
  eCrossOver: 'cross',
  eFiber: 'fiber',
  eSerialDCE: 'serial',
  eSerialDTE: 'serial',
  eConsole: 'console',
};
const CABLE_TO_PT: Record<CableType, string> = {
  straight: 'eStraightThrough',
  cross: 'eCrossOver',
  fiber: 'eFiber',
  serial: 'eSerialDCE',
  console: 'eConsole',
  auto: 'eStraightThrough',
};

export interface ImportReport {
  project: Project;
  skipped: string[];
  warnings: string[];
}

export function importPkt(xml: string, fileName?: string, filePath?: string): ImportReport {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('The file decoded, but its XML is malformed.');
  const root = doc.documentElement;
  const net = kid(root, 'NETWORK');
  const devEls = kids(kid(net, 'DEVICES'), 'DEVICE');
  const devices: Device[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const byIndex = new Map<number, Device>();
  const byRef = new Map<string, Device>();

  devEls.forEach((el, idx) => {
    const engine = kid(el, 'ENGINE');
    const typeEl = kid(engine, 'TYPE');
    const type = typeEl?.textContent?.trim() ?? '';
    const name = txt(engine, 'NAME');
    if (SKIP.has(type)) {
      skipped.push(name);
      return;
    }
    const kind = KIND[type] ?? 'other';
    const cfg = configLines(engine!, 'RUNNINGCONFIG');
    const ports = collectPorts(kid(engine, 'MODULE'));
    const names = nameIfaces(kind, ports, cfg);
    const ifaces: Iface[] = [];
    ports.forEach((p, k) => {
      const n = names[k];
      if (!n || ifaces.some((i) => i.name === n)) return;
      const [media, speed] = mediaOf(p.type);
      const ip = txt(p.el, 'IP');
      const mask = txt(p.el, 'SUBNET');
      ifaces.push({
        name: n,
        media: kind === 'homerouter' && n === 'Wireless' ? 'wireless' : media,
        speed: Number(txt(p.el, 'BANDWIDTH')) / 1000 || speed,
        mac: txt(p.el, 'MACADDRESS') || randomMac(),
        ip: ip || undefined,
        mask: mask || undefined,
        // PT stores unassociated radios as powered off; association is decided by SSID instead
        shutdown: media === 'wireless' ? false : txt(p.el, 'POWER') === 'false',
      });
    });

    const lg = kid(kid(el, 'WORKSPACE'), 'LOGICAL');
    const d: Device = {
      id: uid('dev'),
      kind,
      model: typeEl?.getAttribute('model') || type,
      name,
      x: Number(txt(lg, 'X')) || 100 + idx * 60,
      y: Number(txt(lg, 'Y')) || 100,
      ifaces,
      powered: txt(engine, 'POWER') !== 'false',
      ptRef: txt(engine, 'SAVE_REF_ID') || undefined,
      ptIndex: idx,
    };

    if (kind === 'router' || kind === 'switch') {
      if (cfg.length) parseRunningConfig(cfg.join('\n'), d);
      else d.ios = emptyIos(name);
      if (kind === 'switch' && !d.ifaces.some((i) => i.name === 'Vlan1'))
        d.ifaces.push({ name: 'Vlan1', media: 'virtual', speed: 0, mac: randomMac(), shutdown: true });
    } else if (kind === 'homerouter') {
      const dhcp = kid(engine, 'DHCP_SERVER');
      const pool = kid(kid(dhcp, 'POOLS'), 'POOL');
      const ssid = engine!.getElementsByTagName('SSID')[0]?.textContent ?? 'Default';
      d.home = {
        lanIp: txt(engine, 'LAN_IP_ADDRESS') || '192.168.0.1',
        lanMask: txt(engine, 'LAN_SUBNET_MASK') || '255.255.255.0',
        dhcpEnabled: txt(dhcp, 'ENABLED') === '1' || txt(dhcp, 'ENABLED') === 'true',
        startHost: Number(txt(engine, 'START_IP')) || 100,
        maxUsers: Number(txt(engine, 'MAX_USERS')) || 50,
        wanMode: txt(engine, 'INTERNET_CONNECTION_TYPE') === '1' ? 'static' : 'dhcp',
        wanIp: txt(engine, 'INTERNET_IP_ADDRESS') || '0.0.0.0',
        wanMask: txt(engine, 'INTERNET_SUBNET_MASK') || '0.0.0.0',
        wanGateway: txt(engine, 'DEFAULT_GATEWAY') || '0.0.0.0',
        ssid,
        leases: kids(kid(pool, 'DHCP_POOL_LEASES'), 'DHCP_POOL_LEASE').map((l) => ({ ip: txt(l, 'IP_ADDRESS'), mac: txt(l, 'MAC_ADDRESS') })),
      };
    } else {
      d.gateway = txt(engine, 'GATEWAY');
      d.dns = txt(engine, 'DNS_CLIENT/SERVER_IP');
      const first = ports.find((p) => p.type);
      d.dhcpClient = first ? txt(first.el, 'PORT_DHCP_ENABLE') === 'true' : false;
      if (ifaces.some((i) => i.media === 'wireless')) d.ssid = txt(engine, 'WIRELESS_CLIENT/WIRELESS_COMMON/SSID') || 'Default';
    }
    if (kind === 'other') warnings.push(`${name} (${type}) is shown but not simulated.`);
    devices.push(d);
    byIndex.set(idx, d);
    if (d.ptRef) byRef.set(d.ptRef, d);
  });

  const links: Link[] = [];
  kids(kid(net, 'LINKS'), 'LINK').forEach((lk, li) => {
    const cable = kid(lk, 'CABLE');
    const from = txt(cable, 'FROM');
    const to = txt(cable, 'TO');
    const ports = kids(cable, 'PORT').map((p) => p.textContent?.trim() ?? '');
    const resolve = (v: string) => (/^\d+$/.test(v) ? byIndex.get(Number(v)) : byRef.get(v));
    const a = resolve(from);
    const b = resolve(to);
    if (!a || !b || ports.length < 2) {
      warnings.push(`Skipped a cable between unknown devices (${from} ↔ ${to}).`);
      return;
    }
    const fix = (d: Device, n: string) => d.ifaces.find((i) => i.name === n)?.name ?? d.ifaces.find((i) => i.name.replace(/\s/g, '') === n.replace(/\s/g, ''))?.name ?? n;
    links.push({
      id: uid('lnk'),
      a: { dev: a.id, iface: fix(a, ports[0]) },
      b: { dev: b.id, iface: fix(b, ports[1]) },
      cable: CABLE_FROM_PT[txt(cable, 'TYPE')] ?? 'straight',
      ptIndex: li,
    });
  });

  return {
    project: { devices, links, notes: [], sourceXml: xml, ptVersion: txt(root, 'VERSION'), fileName, filePath },
    skipped,
    warnings,
  };
}

/* ------------------------------------------------------------------ */

export interface ExportReport {
  xml: string;
  notExported: string[];
}

function setConfig(doc: Document, engine: Element, tag: string, text: string) {
  const el = kid(engine, tag);
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const line of text.split('\n')) {
    el.appendChild(doc.createTextNode('\n'));
    const l = doc.createElement('LINE');
    l.textContent = line;
    el.appendChild(l);
  }
}

export function exportPkt(p: Project): ExportReport {
  if (!p.sourceXml) throw new Error('Only projects opened from a .pkt file can be saved back as .pkt.');
  const doc = new DOMParser().parseFromString(p.sourceXml, 'application/xml');
  const root = doc.documentElement;
  const net = kid(root, 'NETWORK');
  const devList = kid(net, 'DEVICES')!;
  const devEls = kids(devList, 'DEVICE');
  const notExported: string[] = [];
  const keep = new Set<number>();

  for (const d of p.devices) {
    if (d.ptIndex === undefined || !devEls[d.ptIndex]) {
      notExported.push(d.name);
      continue;
    }
    keep.add(d.ptIndex);
    const el = devEls[d.ptIndex];
    const engine = kid(el, 'ENGINE')!;
    setTxt(engine, 'NAME', d.name);
    setTxt(engine, 'SYS_NAME', d.name);
    const lg = kid(kid(el, 'WORKSPACE'), 'LOGICAL');
    setTxt(lg, 'X', String(Math.round(d.x * 2) / 2));
    setTxt(lg, 'Y', String(Math.round(d.y * 2) / 2));

    const ports = collectPorts(kid(engine, 'MODULE'));
    const names = nameIfaces(d.kind, ports, configLines(engine, 'RUNNINGCONFIG'));
    ports.forEach((rp, k) => {
      const i = d.ifaces.find((x) => x.name === names[k]);
      if (!i) return;
      if (d.kind !== 'homerouter') {
        setTxt(rp.el, 'IP', i.ip ?? '');
        setTxt(rp.el, 'SUBNET', i.mask ?? '');
      }
      setTxt(rp.el, 'POWER', String(!i.shutdown));
      if (d.dhcpClient !== undefined && k === ports.findIndex((x) => x.type)) setTxt(rp.el, 'PORT_DHCP_ENABLE', String(!!d.dhcpClient));
    });

    if (d.ios) {
      const cfg = runningConfig(d);
      setConfig(doc, engine, 'RUNNINGCONFIG', cfg);
      setConfig(doc, engine, 'STARTUPCONFIG', cfg);
    } else if (d.home) {
      const h = d.home;
      setTxt(engine, 'LAN_IP_ADDRESS', h.lanIp);
      setTxt(engine, 'LAN_SUBNET_MASK', h.lanMask);
      setTxt(engine, 'START_IP', String(h.startHost));
      setTxt(engine, 'MAX_USERS', String(h.maxUsers));
      setTxt(engine, 'INTERNET_CONNECTION_TYPE', h.wanMode === 'static' ? '1' : '0');
      if (h.wanMode === 'static') {
        setTxt(engine, 'INTERNET_IP_ADDRESS', h.wanIp);
        setTxt(engine, 'INTERNET_SUBNET_MASK', h.wanMask);
        setTxt(engine, 'DEFAULT_GATEWAY', h.wanGateway);
      }
      setTxt(kid(engine, 'DHCP_SERVER'), 'ENABLED', h.dhcpEnabled ? '1' : '0');
      const ssid = engine.getElementsByTagName('SSID')[0];
      if (ssid) ssid.textContent = h.ssid;
    } else {
      setTxt(engine, 'GATEWAY', d.gateway ?? '');
      setTxt(engine, 'DNS_CLIENT/SERVER_IP', d.dns ?? '');
      if (d.ssid !== undefined) setTxt(engine, 'WIRELESS_CLIENT/WIRELESS_COMMON/SSID', d.ssid);
    }
  }

  // devices deleted in NetForge
  const removedRefs = new Set<string>();
  const removedIdx = new Set<number>();
  devEls.forEach((el, idx) => {
    const engine = kid(el, 'ENGINE');
    const type = txt(engine, 'TYPE');
    if (keep.has(idx) || SKIP.has(type)) return;
    removedIdx.add(idx);
    const ref = txt(engine, 'SAVE_REF_ID');
    if (ref) removedRefs.add(ref);
    devList.removeChild(el);
  });

  // cables: keep original elements that still exist, append new ones
  const linksEl = kid(net, 'LINKS')!;
  const orig = kids(linksEl, 'LINK');
  const keepLinks = new Set(p.links.filter((l) => l.ptIndex !== undefined).map((l) => l.ptIndex!));
  orig.forEach((el, i) => {
    if (!keepLinks.has(i)) linksEl.removeChild(el);
  });
  const devById = new Map(p.devices.map((d) => [d.id, d]));
  const usesIndex = orig.some((el) => /^\d+$/.test(txt(kid(el, 'CABLE'), 'FROM')));
  // index references must account for removed devices
  const newIndex = (d: Device) => d.ptIndex! - [...removedIdx].filter((r) => r < d.ptIndex!).length;
  for (const l of p.links) {
    if (l.ptIndex !== undefined) continue;
    const a = devById.get(l.a.dev);
    const b = devById.get(l.b.dev);
    if (!a || !b || a.ptIndex === undefined || b.ptIndex === undefined) continue;
    const ref = (d: Device) => (usesIndex || !d.ptRef ? String(newIndex(d)) : d.ptRef);
    const mk = (tag: string, text?: string) => {
      const e = doc.createElement(tag);
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const link = mk('LINK');
    link.appendChild(mk('TYPE', l.cable === 'fiber' ? 'eFiber' : l.cable === 'serial' ? 'eSerial' : 'eCopper'));
    const cable = mk('CABLE');
    cable.append(
      mk('LENGTH', '1'),
      mk('FUNCTIONAL', 'true'),
      mk('FROM', ref(a)),
      mk('PORT', l.a.iface),
      mk('TO', ref(b)),
      mk('PORT', l.b.iface),
      mk('FROM_DEVICE_MEM_ADDR', ''),
      mk('TO_DEVICE_MEM_ADDR', ''),
      mk('FROM_PORT_MEM_ADDR', ''),
      mk('TO_PORT_MEM_ADDR', ''),
      mk('GEO_VIEW_COLOR', '#6ba72e'),
      mk('IS_MANAGED_IN_RACK_VIEW', 'false'),
      mk('TYPE', CABLE_TO_PT[l.cable]),
    );
    link.appendChild(cable);
    linksEl.appendChild(link);
  }

  // drop scenario PDUs that point at deleted devices
  if (removedRefs.size) {
    for (const pdu of Array.from(root.getElementsByTagName('PDU'))) {
      const s = txt(pdu, 'SOURCE');
      const dst = kid(pdu, 'DESTINATION')?.getAttribute('device') ?? '';
      if (removedRefs.has(s) || removedRefs.has(dst)) pdu.parentElement?.removeChild(pdu);
    }
  }

  return { xml: new XMLSerializer().serializeToString(doc), notExported };
}
