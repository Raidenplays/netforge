/**
 * Map Packet Tracer XML (decoded by the Rust backend) to a NetForge project and back.
 * Export patches the original XML so everything NetForge doesn't model is preserved.
 */
import { emptyIos, isConsolePort } from '../model/catalog';
import { randomMac } from '../model/ip';
import type { Activity, ActivityVar, CableType, Device, DeviceKind, GradeItem, Iface, Link, Media, Project, ServerServices } from '../model/types';
import { uid } from '../model/types';
import { parseRunningConfig, runningConfigForPkt } from '../engine/ios';
import { defaultServices } from '../engine/services';
import { isV6, normV6 } from '../model/ip6';

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
  AccessPoint: 'ap',
  CellTower: 'cloud',
  CentralOfficeServer: 'cloud',
  DslModem: 'cloud',
  CableModem: 'cloud',
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

/**
 * A .pka (PACKETTRACER5_ACTIVITY) embeds three networks. The last one is the
 * student's working network; the others are the answer and initial networks,
 * which NetForge never shows or modifies.
 */
function workingNet(root: Element): Element {
  if (root.tagName !== 'PACKETTRACER5_ACTIVITY') return root;
  const nets = kids(root, 'PACKETTRACER5');
  return nets[nets.length - 1] ?? root;
}

function readActivity(root: Element): Activity | undefined {
  if (root.tagName !== 'PACKETTRACER5_ACTIVITY') return undefined;
  const pages = kids(kid(kid(root, 'ACTIVITY'), 'INSTRUCTIONS'), 'PAGE').map((p) => p.textContent ?? '');
  const items: GradeItem[] = [];
  const walk = (n: Element, path: string[]) => {
    for (const c of kids(n, 'NODE')) {
      const name = kid(c, 'NAME');
      const p = [...path, name?.textContent ?? ''];
      if (name?.getAttribute('checkType') === '2')
        items.push({
          path: p.slice(1),
          expected: name.getAttribute('nodeValue') ?? '',
          points: Number(txt(c, 'POINTS')) || 1,
          variable: !!name.getAttribute('variableName'),
          variableName: name.getAttribute('variableName') || undefined,
        });
      walk(c, p);
    }
  };
  const comp = kid(root, 'COMPARISONS');
  if (comp) walk(comp, []);
  const titleMatch = pages[0]?.match(/<title>([^<]*)<\/title>/i);
  return { title: titleMatch?.[1]?.trim(), pages, items, completeFeedback: txt(root, 'OVERALL_COMPLETE_FEEDBACK'), variables: readVariables(root) };
}

/** VARIABLE_MANAGER: variables point at pools of allowed values */
function readVariables(root: Element): Record<string, ActivityVar> {
  const vm = kid(root, 'VARIABLE_MANAGER');
  const out: Record<string, ActivityVar> = {};
  if (!vm) return out;
  const pools = new Map<string, ActivityVar>();
  for (const sp of kids(kid(vm, 'STRING_POOLS'), 'STRING_POOL'))
    pools.set(txt(sp, 'NAME'), { kind: 'string', values: kids(sp, 'VALUES').flatMap((v) => (v.textContent ?? '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) });
  for (const ip of kids(kid(vm, 'IP_POOLS'), 'IP_POOL')) pools.set(txt(ip, 'NAME'), { kind: 'ip', first: txt(ip, 'FIRST_IP'), last: txt(ip, 'LAST_IP') });
  for (const np of kids(kid(vm, 'NUMBER_POOLS'), 'NUMBER_POOL'))
    pools.set(txt(np, 'NAME'), { kind: 'number', min: Number(txt(np, 'MIN') || txt(np, 'MIN_VALUE')), max: Number(txt(np, 'MAX') || txt(np, 'MAX_VALUE')) });
  for (const v of Array.from(kid(vm, 'VARIABLES_POOLS')?.children ?? [])) {
    const pool = pools.get(txt(v, 'POOL_NAME'));
    if (pool) out[txt(v, 'NAME')] = pool;
  }
  return out;
}

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

const on = (v: string) => v === '1' || v === 'true';

/** a Server-PT's HTTP pages and DNS records */
function readServices(engine: Element, name: string): ServerServices {
  const svc = defaultServices(name);
  const http = kid(engine, 'HTTP_SERVER');
  if (http) svc.http = on(txt(http, 'ENABLED'));
  const pages: Record<string, string> = {};
  for (const fc of Array.from(engine.getElementsByTagName('FILE_CONTENT')))
    if (fc.getAttribute('class') === 'CHttpPage') pages[txt(fc.parentElement, 'NAME')] = txt(fc, 'TEXT');
  if (Object.keys(pages).length) svc.pages = pages;
  const dns = kid(engine, 'DNS_SERVER');
  if (dns) {
    svc.dns = on(txt(dns, 'ENABLED'));
    svc.records = kids(kid(dns, 'NAMESERVER-DATABASE'), 'RESOURCE-RECORD').filter((r) => ['A-REC', 'CNAME', 'NS'].includes(txt(r, 'TYPE'))).map((r) => {
      const type = txt(r, 'TYPE');
      return type === 'A-REC'
        ? { name: txt(r, 'NAME'), type: 'A' as const, value: txt(r, 'IPADDRESS') }
        : { name: txt(r, 'NAME'), type: type === 'NS' ? ('NS' as const) : ('CNAME' as const), value: txt(r, 'SERVER-NAME') || txt(r, 'HOSTNAME') };
    });
  }
  return svc;
}

function writeServices(doc: Document, engine: Element, svc: ServerServices) {
  const http = kid(engine, 'HTTP_SERVER');
  if (http) setTxt(http, 'ENABLED', svc.http ? '1' : '0');
  for (const fc of Array.from(engine.getElementsByTagName('FILE_CONTENT'))) {
    if (fc.getAttribute('class') !== 'CHttpPage') continue;
    const page = svc.pages[txt(fc.parentElement, 'NAME')];
    if (page !== undefined) setTxt(fc, 'TEXT', page);
  }
  const dns = kid(engine, 'DNS_SERVER');
  if (!dns) return;
  setTxt(dns, 'ENABLED', svc.dns ? '1' : '0');
  const db = kid(dns, 'NAMESERVER-DATABASE');
  if (!db) return;
  // records NetForge doesn't model (e.g. AAAA) are kept
  for (const r of kids(db, 'RESOURCE-RECORD')) if (['A-REC', 'CNAME', 'NS'].includes(txt(r, 'TYPE'))) db.removeChild(r);
  const mk = (tag: string, text: string) => {
    const e = doc.createElement(tag);
    e.textContent = text;
    return e;
  };
  for (const r of svc.records) {
    const rr = doc.createElement('RESOURCE-RECORD');
    rr.append(mk('TYPE', r.type === 'A' ? 'A-REC' : r.type === 'NS' ? 'NS' : 'CNAME'), mk('NAME', r.name), mk('TTL', '86400'));
    rr.append(mk(r.type === 'A' ? 'IPADDRESS' : r.type === 'NS' ? 'SERVER-NAME' : 'HOSTNAME', r.value));
    db.appendChild(rr);
  }
}

/** the VLANS element of the device's flash:vlan.dat, if it has one */
function vlanDat(engine: Element): Element | null {
  for (const fc of Array.from(engine.getElementsByTagName('FILE_CONTENT')))
    if (fc.getAttribute('class') === 'CVlanDatFileContent') return kid(fc, 'VLANS');
  return null;
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
      if (p.type.startsWith('eCopper')) return eth++ === 0 ? 'Internet' : `${p.type.includes('Gigabit') ? 'GigabitEthernet' : 'Ethernet'} ${eth - 1}`;
      if (p.type.startsWith('eAccessPoint') && !wifi) {
        wifi = true;
        return 'Wireless';
      }
      return null;
    });
  }
  if (kind === 'ap') return ports.map((p, k) => (p.type ? `Port ${k}` : null));
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
  eMultiMode: 'fiber',
  eSingleMode: 'fiber',
  eSerial: 'serial',
};
const CABLE_TO_PT: Record<CableType, string> = {
  straight: 'eStraightThrough',
  cross: 'eCrossOver',
  fiber: 'eMultiMode',
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
  const work = workingNet(root);
  const net = kid(work, 'NETWORK');
  if (!net) throw new Error('No network found in this file.');
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
        media: (kind === 'homerouter' && n === 'Wireless') || (kind === 'ap' && p.type.includes('Wireless')) ? 'wireless' : media,
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
      const vdat = vlanDat(engine!);
      if (vdat) d.ios!.vlans = Array.from(vdat.getElementsByTagName('VLAN')).map((v) => ({ id: Number(v.getAttribute('number')), name: v.getAttribute('name') ?? '' }));
      const startup = configLines(engine!, 'STARTUPCONFIG');
      if (startup.length) d.ios!.startup = startup.join('\n');
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
        dns: txt(engine, 'DNS_CLIENT/SERVER_IP') || txt(pool, 'DNS_SERVER') || undefined,
        leases: kids(kid(pool, 'DHCP_POOL_LEASES'), 'DHCP_POOL_LEASE').map((l) => ({ ip: txt(l, 'IP_ADDRESS'), mac: txt(l, 'MAC_ADDRESS') })),
      };
    } else if (kind === 'ap') {
      d.ssid = engine!.getElementsByTagName('SSID')[0]?.textContent ?? 'Default';
    } else if (kind === 'cloud' || kind === 'other') {
      // shown and cable-able, not simulated
    } else {
      d.gateway = txt(engine, 'GATEWAY');
      d.dns = txt(engine, 'DNS_CLIENT/SERVER_IP');
      const first = ports.find((p) => p.type);
      d.dhcpClient = first ? txt(first.el, 'PORT_DHCP_ENABLE') === 'true' : false;
      const svc = kid(kid(kid(kid(engine, 'DHCP_SERVERS'), 'ASSOCIATED_PORTS'), 'ASSOCIATED_PORT'), 'DHCP_SERVER') ?? (kind === 'server' ? kid(engine, 'DHCP_SERVER') : null);
      if (svc && kind === 'server') {
        d.dhcpService = {
          enabled: txt(svc, 'ENABLED') === '1' || txt(svc, 'ENABLED') === 'true',
          pools: kids(kid(svc, 'POOLS'), 'POOL').map((pl) => ({
            name: txt(pl, 'NAME'),
            network: txt(pl, 'NETWORK'),
            mask: txt(pl, 'MASK'),
            router: txt(pl, 'DEFAULT_ROUTER'),
            start: txt(pl, 'START_IP'),
            max: Number(txt(pl, 'MAX_USERS')) || 50,
            dns: txt(pl, 'DNS_SERVER'),
          })),
          leases: [],
        };
      }
      if (ifaces.some((i) => i.media === 'wireless')) d.ssid = txt(engine, 'WIRELESS_CLIENT/WIRELESS_COMMON/SSID') || 'Default';
      if (kind === 'server') d.services = readServices(engine!, name);
      // IPv6 on the host's first port
      if (first) {
        const v6 = kids(kid(first.el, 'IPV6_ADDRESSES'), 'IPV6_ADDRESS').filter((x) => txt(x, 'TYPE') === '0');
        const host = ifaces.find((x) => x.media !== 'wireless') ?? ifaces[0];
        if (host && v6.length) host.v6 = v6.map((x) => ({ addr: normV6(txt(x, 'ADDRESS')), len: Number(txt(x, 'PREFIX')) || 64 }));
        const ll = txt(first.el, 'IPV6_LINK_LOCAL');
        if (host && ll && isV6(ll)) host.v6ll = normV6(ll);
        d.v6Mode = txt(first.el, 'IPV6_PORT_DHCP_ENABLED') === 'true' ? 'dhcp' : txt(first.el, 'IPV6_ADDRESS_AUTOCONFIG') === 'true' ? 'auto' : 'static';
        const gw6 = txt(first.el, 'IPV6_PORT_GATEWAY');
        if (gw6 && isV6(gw6)) d.gateway6 = normV6(gw6);
        const dns6 = txt(first.el, 'IPV6_PORT_DNS');
        if (dns6 && isV6(dns6)) d.dns6 = normV6(dns6);
      }
    }
    if (kind === 'other' || kind === 'cloud') warnings.push(`${name} (${type}) is shown but not simulated.`);
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
    const fix = (d: Device, n: string) => {
      if (isConsolePort(n)) return n;
      const hit = d.ifaces.find((i) => i.name === n) ?? d.ifaces.find((i) => i.name.replace(/\s/g, '') === n.replace(/\s/g, ''));
      if (hit) return hit.name;
      // port naming we don't derive yet: trust the name on the cable
      const [media, speed] = mediaOf(n.replace(/\d.*$/, ''));
      d.ifaces.push({ name: n, media: /serial/i.test(n) ? 'serial' : media === 'wireless' ? 'copper' : media, speed, mac: randomMac(), shutdown: false });
      return n;
    };
    links.push({
      id: uid('lnk'),
      a: { dev: a.id, iface: fix(a, ports[0]) },
      b: { dev: b.id, iface: fix(b, ports[1]) },
      cable: CABLE_FROM_PT[txt(cable, 'TYPE')] ?? (txt(lk, 'TYPE') === 'eFiber' ? 'fiber' : txt(lk, 'TYPE') === 'eSerial' ? 'serial' : 'straight'),
      ptIndex: li,
    });
  });

  return {
    project: { devices, links, notes: [], sourceXml: xml, ptVersion: txt(work, 'VERSION') || txt(root, 'VERSION'), fileName, filePath, activity: readActivity(root) },
    skipped,
    warnings,
  };
}

/* ------------------------------------------------------------------ */

export interface ExportReport {
  xml: string;
  notExported: string[];
}

function setConfig(doc: Document, engine: Element, tag: string, lines: string[]) {
  const el = kid(engine, tag);
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const line of lines) {
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
  const work = workingNet(root);
  const net = kid(work, 'NETWORK');
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
      if (k === ports.findIndex((x) => x.type) && (d.v6Mode || d.gateway6 !== undefined)) {
        setTxt(rp.el, 'IPV6_ADDRESS_AUTOCONFIG', String(d.v6Mode === 'auto'));
        setTxt(rp.el, 'IPV6_PORT_DHCP_ENABLED', String(d.v6Mode === 'dhcp'));
        setTxt(rp.el, 'IPV6_PORT_GATEWAY', d.gateway6 ?? '');
        setTxt(rp.el, 'IPV6_PORT_DNS', d.dns6 ?? '');
        const list = kid(rp.el, 'IPV6_ADDRESSES');
        if (list && d.v6Mode === 'static') {
          for (const x of kids(list, 'IPV6_ADDRESS')) list.removeChild(x);
          for (const a of i.v6 ?? []) {
            const e = doc.createElement('IPV6_ADDRESS');
            for (const [tag, v] of [['ADDRESS', a.addr], ['PREFIX', String(a.len)], ['TYPE', '0']]) {
              const c = doc.createElement(tag);
              c.textContent = v;
              e.appendChild(c);
            }
            list.appendChild(e);
          }
        }
      }
    });

    if (d.ios) {
      const cfg = runningConfigForPkt(d);
      setConfig(doc, engine, 'RUNNINGCONFIG', cfg);
      // keep a saved startup-config as it was; otherwise save the running one, as before
      setConfig(doc, engine, 'STARTUPCONFIG', d.ios.startup !== undefined ? d.ios.startup.split('\n') : cfg);
      const vdat = vlanDat(engine);
      if (vdat && d.ios.vlans) {
        const rspan = new Map(Array.from(vdat.getElementsByTagName('VLAN')).map((v) => [v.getAttribute('number'), v.getAttribute('rspan') ?? '0']));
        while (vdat.firstChild) vdat.removeChild(vdat.firstChild);
        for (const v of d.ios.vlans) {
          vdat.appendChild(doc.createTextNode('\n'));
          const e = doc.createElement('VLAN');
          e.setAttribute('rspan', rspan.get(String(v.id)) ?? '0');
          e.setAttribute('number', String(v.id));
          e.setAttribute('name', v.name);
          vdat.appendChild(e);
        }
        setTxt(vdat.parentElement, 'VLAN_COUNT', String(d.ios.vlans.length));
      }
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
      if (h.dns) {
        setTxt(engine, 'DNS_CLIENT/SERVER_IP', h.dns);
        setTxt(kid(kid(kid(engine, 'DHCP_SERVER'), 'POOLS'), 'POOL'), 'DNS_SERVER', h.dns);
      }
      const ssid = engine.getElementsByTagName('SSID')[0];
      if (ssid) ssid.textContent = h.ssid;
    } else if (d.kind === 'ap') {
      const ssid = engine.getElementsByTagName('SSID')[0];
      if (ssid && d.ssid !== undefined) ssid.textContent = d.ssid;
    } else if (d.kind === 'cloud' || d.kind === 'other') {
      // untouched
    } else {
      setTxt(engine, 'GATEWAY', d.gateway ?? '');
      if (d.dhcpService) {
        const svc = kid(kid(kid(kid(engine, 'DHCP_SERVERS'), 'ASSOCIATED_PORTS'), 'ASSOCIATED_PORT'), 'DHCP_SERVER') ?? kid(engine, 'DHCP_SERVER');
        setTxt(svc, 'ENABLED', d.dhcpService.enabled ? '1' : '0');
      }
      setTxt(engine, 'DNS_CLIENT/SERVER_IP', d.dns ?? '');
      if (d.services) writeServices(doc, engine, d.services);
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
    for (const pdu of Array.from(work.getElementsByTagName('PDU'))) {
      const s = txt(pdu, 'SOURCE');
      const dst = kid(pdu, 'DESTINATION')?.getAttribute('device') ?? '';
      if (removedRefs.has(s) || removedRefs.has(dst)) pdu.parentElement?.removeChild(pdu);
    }
  }

  return { xml: new XMLSerializer().serializeToString(doc), notExported };
}

/* ------------------------------------------------------------------ */
/*  Reading saved values NetForge doesn't model (for activity grading)  */
/* ------------------------------------------------------------------ */

let cachedXml = '';
let cachedDevs: Element[] = [];

/** the saved <DEVICE> element of a device in the working network */
export function deviceXml(p: Project, d: Device): Element | null {
  if (!p.sourceXml || d.ptIndex === undefined) return null;
  if (cachedXml !== p.sourceXml) {
    const doc = new DOMParser().parseFromString(p.sourceXml, 'application/xml');
    cachedDevs = kids(kid(kid(workingNet(doc.documentElement), 'NETWORK'), 'DEVICES'), 'DEVICE');
    cachedXml = p.sourceXml;
  }
  return cachedDevs[d.ptIndex] ?? null;
}

/** the saved <PORT> element for one of a device's interfaces */
export function portXml(p: Project, d: Device, iface: string): Element | null {
  const el = deviceXml(p, d);
  if (!el) return null;
  const engine = kid(el, 'ENGINE')!;
  const ports = collectPorts(kid(engine, 'MODULE'));
  const names = nameIfaces(d.kind, ports, configLines(engine, 'RUNNINGCONFIG'));
  const k = names.findIndex((n) => n === iface);
  return k >= 0 ? ports[k].el : null;
}

export const xmlText = (el: Element | null, tag: string) => (el ? txt(el, tag) : '');
