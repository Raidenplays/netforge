import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { DeviceGlyph, I } from './Icons';
import { Terminal } from './Terminal';
import type { Device, Iface, Project } from '../model/types';
import { buildTopo, ifaceStatus, renew } from '../engine/network';
import { runningConfig } from '../engine/ios';
import { classfulMask, isIp, isMask, maskToPrefix } from '../model/ip';
import { isHost, templateFor } from '../model/catalog';

/** Text input that commits on blur / Enter so each edit is one undo step. */
function Commit({
  value,
  onCommit,
  validate,
  placeholder,
  disabled,
  mono = true,
}: {
  value: string;
  onCommit: (v: string) => void;
  validate?: (v: string) => boolean;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const bad = !!v && validate && !validate(v);
  const commit = () => {
    if (v === value) return;
    if (bad) return;
    onCommit(v.trim());
  };
  return (
    <input
      className={`input ${bad ? 'bad' : ''}`}
      style={mono ? undefined : { fontFamily: 'inherit', fontSize: 13 }}
      value={v}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setV(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

const ipOk = (v: string) => isIp(v);
const maskOk = (v: string) => isMask(v);

export function Inspector() {
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.selected);
  const selectedLink = useStore((s) => s.selectedLink);
  const tab = useStore((s) => s.inspectorTab);
  const set = useStore((s) => s.set);
  const mutate = useStore((s) => s.mutate);
  const dev = project.devices.find((d) => d.id === selected);

  if (selectedLink) return <LinkInspector />;
  if (!dev) return <ProjectSummary />;

  const edit = (fn: (d: Device, p: Project) => void) =>
    mutate((p) => {
      const d = p.devices.find((x) => x.id === dev.id);
      if (d) fn(d, p);
    });

  const t = templateFor(dev.model);
  if (tab === 'cli' && !dev.ios && !dev.home && !isHost(dev)) queueMicrotask(() => set({ inspectorTab: 'config' }));
  return (
    <aside className="inspector">
      <div className="insp-head">
        <div className={`ico tinted k-${dev.kind}`}>
          <DeviceGlyph kind={dev.kind} size={22} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Commit
            key={dev.id}
            mono={false}
            value={dev.name}
            onCommit={(v) =>
              edit((d) => {
                d.name = v || d.name;
                if (d.ios) d.ios.hostname = d.name.replace(/\s+/g, '-');
              })
            }
          />
          <div className="model">
            {t?.label ?? dev.model} · {dev.powered ? 'Powered on' : 'Powered off'}
          </div>
        </div>
        <button className={`toggle ${dev.powered ? 'on' : ''}`} title="Power" onClick={() => edit((d) => (d.powered = !d.powered))} />
      </div>
      <div className="tabs">
        {(['overview', 'config', 'cli'] as const).filter((k) => k !== 'cli' || dev.ios || dev.home || isHost(dev)).map((k) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => set({ inspectorTab: k })}>
            {k === 'overview' ? 'Overview' : k === 'config' ? 'Config' : dev.ios ? 'CLI' : dev.home ? 'Status' : 'Desktop'}
          </button>
        ))}
      </div>
      {tab === 'cli' && (dev.ios || isHost(dev)) ? (
        <div className="insp-body flush">
          <Terminal dev={dev} />
        </div>
      ) : (
        <div className="insp-body">
          {tab === 'overview' && <Overview dev={dev} />}
          {(tab === 'config' || (tab === 'cli' && dev.home)) && (dev.home ? <HomeConfig dev={dev} edit={edit} /> : dev.ios ? <IosConfig dev={dev} edit={edit} /> : dev.kind === 'ap' ? <ApConfig dev={dev} edit={edit} /> : dev.kind === 'cloud' || dev.kind === 'other' ? <div className="blank">This device is shown and can be cabled, but NetForge doesn't simulate it yet.</div> : <HostConfig dev={dev} edit={edit} />)}
        </div>
      )}
    </aside>
  );
}

function Overview({ dev }: { dev: Device }) {
  const project = useStore((s) => s.project);
  const topo = useMemo(() => buildTopo(project), [project]);
  const peer = (i: Iface) => {
    for (const l of [...project.links, ...topo.wireless]) {
      const end = l.a.dev === dev.id && l.a.iface === i.name ? l.b : l.b.dev === dev.id && l.b.iface === i.name ? l.a : null;
      if (end) {
        const d = project.devices.find((x) => x.id === end.dev);
        return `${d?.name} · ${end.iface}`;
      }
    }
    return null;
  };
  const ports = dev.ifaces.filter((i) => !(i.media === 'virtual' && !i.ip && i.shutdown));
  return (
    <>
      {dev.note && <div className="section pill">{dev.note}</div>}
      <div className="section">
        <h4>
          Interfaces <span>{ports.length}</span>
        </h4>
        {ports.map((i) => {
          const st = ifaceStatus(project, topo, dev, i);
          const ip = dev.home && i.name === 'Internet' ? dev.home.wanIp : i.ip;
          const mask = dev.home && i.name === 'Internet' ? dev.home.wanMask : i.mask;
          return (
            <div className="iface" key={i.name}>
              <div className="iface-head">
                <span className={`dot ${i.shutdown ? 'admin' : st.line ? 'up' : 'down'}`} />
                <span className="n">{i.name}</span>
                <span className="m">{ip && ip !== '0.0.0.0' ? `${ip}/${maskToPrefix(mask ?? '0.0.0.0')}` : '—'}</span>
              </div>
              {(peer(i) || i.mac) && (
                <div className="iface-body">
                  <dl className="kv" style={{ margin: 0 }}>
                    <dt>Status</dt>
                    <dd>{i.shutdown ? 'administratively down' : st.line ? 'up' : 'down'}</dd>
                    <dt>Connected to</dt>
                    <dd>{peer(i) ?? '—'}</dd>
                    <dt>MAC</dt>
                    <dd>{i.mac}</dd>
                    {i.natRole && (
                      <>
                        <dt>NAT</dt>
                        <dd>ip nat {i.natRole}</dd>
                      </>
                    )}
                  </dl>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {isHost(dev) && (
        <div className="section">
          <h4>IP configuration</h4>
          <dl className="kv">
            <dt>Mode</dt>
            <dd>{dev.dhcpClient ? 'DHCP' : 'Static'}</dd>
            <dt>Gateway</dt>
            <dd>{dev.gateway || '—'}</dd>
            <dt>DNS</dt>
            <dd>{dev.dns || '—'}</dd>
            {dev.ssid !== undefined && (
              <>
                <dt>Wi-Fi network</dt>
                <dd>{dev.ssid}</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {dev.ptRef && (
        <div className="section">
          <h4>Packet Tracer</h4>
          <dl className="kv">
            <dt>Model</dt>
            <dd>{dev.model}</dd>
            <dt>Save ref</dt>
            <dd>{dev.ptRef.replace('save-ref-id:', '')}</dd>
          </dl>
        </div>
      )}
    </>
  );
}

function HostConfig({ dev, edit }: { dev: Device; edit: (fn: (d: Device, p: Project) => void) => void }) {
  const toast = useStore((s) => s.toast);
  const i = dev.ifaces.find((x) => !x.shutdown) ?? dev.ifaces[0];
  if (!i) return <div className="blank">This device has no network interfaces.</div>;
  const setIf = (fn: (x: Iface) => void) => edit((d) => fn(d.ifaces.find((x) => x.name === i.name)!));
  return (
    <>
      <div className="section">
        <h4>{i.name}</h4>
        <div className="radio-row segmented" style={{ display: 'inline-flex' }}>
          <button className={dev.dhcpClient ? 'on' : ''} onClick={() => edit((d) => ((d.dhcpClient = true), (d.ifaces.find((x) => x.name === i.name)!.ip = undefined)))}>
            DHCP
          </button>
          <button className={!dev.dhcpClient ? 'on' : ''} onClick={() => edit((d) => (d.dhcpClient = false))}>
            Static
          </button>
        </div>
        <div className="field">
          <label>IPv4 address</label>
          <Commit
            value={i.ip ?? ''}
            disabled={dev.dhcpClient}
            validate={ipOk}
            placeholder="192.168.1.10"
            onCommit={(v) =>
              setIf((x) => {
                x.ip = v || undefined;
                if (v && !x.mask) x.mask = classfulMask(v);
              })
            }
          />
        </div>
        <div className="field">
          <label>Subnet mask</label>
          <Commit value={i.mask ?? ''} disabled={dev.dhcpClient} validate={maskOk} placeholder="255.255.255.0" onCommit={(v) => setIf((x) => (x.mask = v || undefined))} />
        </div>
        <div className="field">
          <label>Gateway</label>
          <Commit value={dev.gateway ?? ''} disabled={dev.dhcpClient} validate={ipOk} placeholder="192.168.1.1" onCommit={(v) => edit((d) => (d.gateway = v))} />
        </div>
        <div className="field">
          <label>DNS server</label>
          <Commit value={dev.dns ?? ''} disabled={dev.dhcpClient} validate={ipOk} placeholder="8.8.8.8" onCommit={(v) => edit((d) => (d.dns = v))} />
        </div>
        {dev.dhcpClient && (
          <button
            className="btn outline sm"
            onClick={() => {
              let ok = false;
              edit((d, p) => {
                ok = !!renew(p, d.id);
              });
              toast(ok ? 'DHCP lease renewed' : 'DHCP request failed: no server answered', ok ? 'good' : 'bad');
            }}
          >
            <I.reset size={14} /> Renew lease
          </button>
        )}
      </div>
      {dev.dhcpService && (
        <div className="section">
          <h4>
            DHCP service
            <button className={`toggle ${dev.dhcpService.enabled ? 'on' : ''}`} onClick={() => edit((d) => (d.dhcpService!.enabled = !d.dhcpService!.enabled))} />
          </h4>
          {dev.dhcpService.pools.map((pl) => (
            <dl className="kv" key={pl.name} style={{ marginBottom: 10 }}>
              <dt>{pl.name}</dt>
              <dd>
                {pl.network}/{maskToPrefix(pl.mask)}
              </dd>
              <dt>Gateway</dt>
              <dd>{pl.router}</dd>
              <dt>Range</dt>
              <dd>
                {pl.start} · {pl.max} users
              </dd>
              <dt>DNS</dt>
              <dd>{pl.dns}</dd>
            </dl>
          ))}
          {dev.dhcpService.leases.length > 0 && <div className="code" style={{ maxHeight: 120 }}>{dev.dhcpService.leases.map((l) => `${l.ip.padEnd(16)} ${l.mac}`).join('\n')}</div>}
        </div>
      )}
      {dev.ssid !== undefined && (
        <div className="section">
          <h4>Wireless</h4>
          <div className="field">
            <label>SSID</label>
            <Commit mono={false} value={dev.ssid} onCommit={(v) => edit((d) => ((d.ssid = v), (d.ifaces.find((x) => x.media === 'wireless')!.ip = undefined)))} />
          </div>
        </div>
      )}
    </>
  );
}

function ApConfig({ dev, edit }: { dev: Device; edit: (fn: (d: Device, p: Project) => void) => void }) {
  return (
    <div className="section">
      <h4>Wireless</h4>
      <div className="field">
        <label>SSID</label>
        <Commit mono={false} value={dev.ssid ?? 'Default'} onCommit={(v) => edit((d) => (d.ssid = v))} />
      </div>
      <p style={{ color: 'var(--text-3)' }}>The access point bridges Wi-Fi clients with a matching SSID onto Port 0.</p>
    </div>
  );
}

function HomeConfig({ dev, edit }: { dev: Device; edit: (fn: (d: Device, p: Project) => void) => void }) {
  const h = dev.home!;
  const hset = (fn: (x: NonNullable<Device['home']>) => void) => edit((d) => fn(d.home!));
  return (
    <>
      <div className="section">
        <h4>Internet (WAN)</h4>
        <div className="radio-row segmented" style={{ display: 'inline-flex' }}>
          <button className={h.wanMode === 'dhcp' ? 'on' : ''} onClick={() => hset((x) => ((x.wanMode = 'dhcp'), (x.wanIp = '0.0.0.0')))}>
            Automatic (DHCP)
          </button>
          <button className={h.wanMode === 'static' ? 'on' : ''} onClick={() => hset((x) => (x.wanMode = 'static'))}>
            Static IP
          </button>
        </div>
        <div className="field">
          <label>IP address</label>
          <Commit value={h.wanIp} disabled={h.wanMode === 'dhcp'} validate={ipOk} onCommit={(v) => hset((x) => (x.wanIp = v))} />
        </div>
        <div className="field">
          <label>Subnet mask</label>
          <Commit value={h.wanMask} disabled={h.wanMode === 'dhcp'} validate={maskOk} onCommit={(v) => hset((x) => (x.wanMask = v))} />
        </div>
        <div className="field">
          <label>Gateway</label>
          <Commit value={h.wanGateway} disabled={h.wanMode === 'dhcp'} validate={ipOk} onCommit={(v) => hset((x) => (x.wanGateway = v))} />
        </div>
      </div>
      <div className="section">
        <h4>Local network</h4>
        <div className="field">
          <label>Router IP</label>
          <Commit value={h.lanIp} validate={ipOk} onCommit={(v) => hset((x) => ((x.lanIp = v), (x.leases = [])))} />
        </div>
        <div className="field">
          <label>Subnet mask</label>
          <Commit value={h.lanMask} validate={maskOk} onCommit={(v) => hset((x) => ((x.lanMask = v), (x.leases = [])))} />
        </div>
      </div>
      <div className="section">
        <h4>
          DHCP server <button className={`toggle ${h.dhcpEnabled ? 'on' : ''}`} onClick={() => hset((x) => (x.dhcpEnabled = !x.dhcpEnabled))} />
        </h4>
        <div className="field">
          <label>Start (host #)</label>
          <Commit value={String(h.startHost)} validate={(v) => /^\d+$/.test(v) && +v > 0 && +v < 255} onCommit={(v) => hset((x) => ((x.startHost = +v), (x.leases = [])))} />
        </div>
        <div className="field">
          <label>Max users</label>
          <Commit value={String(h.maxUsers)} validate={(v) => /^\d+$/.test(v) && +v > 0 && +v < 254} onCommit={(v) => hset((x) => (x.maxUsers = +v))} />
        </div>
        {h.leases.length > 0 && (
          <div className="code" style={{ maxHeight: 120 }}>
            {h.leases.map((l) => `${l.ip.padEnd(16)} ${l.mac}`).join('\n')}
          </div>
        )}
      </div>
      <div className="section">
        <h4>DNS</h4>
        <div className="field">
          <label>DNS server</label>
          <Commit value={h.dns ?? ''} validate={ipOk} placeholder="handed out to DHCP clients" onCommit={(v) => hset((x) => (x.dns = v || undefined))} />
        </div>
      </div>
      <div className="section">
        <h4>Wireless</h4>
        <div className="field">
          <label>SSID</label>
          <Commit mono={false} value={h.ssid} onCommit={(v) => hset((x) => (x.ssid = v))} />
        </div>
      </div>
    </>
  );
}

function IosConfig({ dev, edit }: { dev: Device; edit: (fn: (d: Device, p: Project) => void) => void }) {
  const toast = useStore((s) => s.toast);
  const [net, setNet] = useState('');
  const [mask, setMask] = useState('');
  const [via, setVia] = useState('');
  const ios = dev.ios!;
  const ifs = dev.ifaces.filter((i) => i.media !== 'wireless');
  return (
    <>
      <div className="section">
        <h4>Global</h4>
        <div className="field">
          <label>Hostname</label>
          <Commit mono={false} value={ios.hostname} onCommit={(v) => edit((d) => ((d.ios!.hostname = v.replace(/\s+/g, '-')), (d.name = v)))} />
        </div>
        {dev.kind === 'switch' && (
          <div className="field">
            <label>Default gateway</label>
            <Commit value={ios.defaultGateway ?? ''} validate={ipOk} onCommit={(v) => edit((d) => (d.ios!.defaultGateway = v || undefined))} />
          </div>
        )}
      </div>
      <div className="section">
        <h4>Interfaces</h4>
        {ifs.map((i) => (
          <IfaceRow key={i.name} i={i} edit={(fn) => edit((d) => fn(d.ifaces.find((x) => x.name === i.name)!))} />
        ))}
      </div>
      {dev.kind === 'router' && (
        <div className="section">
          <h4>Static routes</h4>
          {ios.routes.map((r, k) => (
            <div key={k} className="iface-head" style={{ padding: '4px 0' }}>
              <span className="n">
                {r.network}/{maskToPrefix(r.mask)}
              </span>
              <span className="m">via {r.via ?? r.iface}</span>
              <button className="btn icon sm danger" title="Remove" onClick={() => edit((d) => d.ios!.routes.splice(k, 1))}>
                <I.x size={13} />
              </button>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 5 }}>
            <input className="input" placeholder="network" value={net} onChange={(e) => setNet(e.target.value)} />
            <input className="input" placeholder="mask" value={mask} onChange={(e) => setMask(e.target.value)} />
            <input className="input" placeholder="next hop" value={via} onChange={(e) => setVia(e.target.value)} />
            <button
              className="btn icon outline"
              title="Add route"
              onClick={() => {
                if (!isIp(net) || !isMask(mask) || !isIp(via)) return toast('Route needs a network, mask and next-hop IP.', 'bad');
                edit((d) => d.ios!.routes.push({ network: net, mask, via }));
                setNet('');
                setMask('');
                setVia('');
              }}
            >
              <I.plus size={14} />
            </button>
          </div>
        </div>
      )}
      {ios.pools.length > 0 && (
        <div className="section">
          <h4>DHCP pools</h4>
          {ios.pools.map((p) => (
            <dl className="kv" key={p.name} style={{ marginBottom: 8 }}>
              <dt>{p.name}</dt>
              <dd>
                {p.network}/{p.mask ? maskToPrefix(p.mask) : '?'}
              </dd>
              <dt>Gateway</dt>
              <dd>{p.router ?? '—'}</dd>
            </dl>
          ))}
        </div>
      )}
      <div className="section">
        <h4>
          Running config
          <button
            className="btn sm"
            onClick={() => {
              navigator.clipboard?.writeText(runningConfig(dev)).then(
                () => toast('Copied running-config', 'good'),
                () => toast('Clipboard not available', 'bad'),
              );
            }}
          >
            <I.copy size={13} /> Copy
          </button>
        </h4>
        <div className="code">{runningConfig(dev)}</div>
      </div>
    </>
  );
}

function IfaceRow({ i, edit }: { i: Iface; edit: (fn: (x: Iface) => void) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="iface">
      <div className="iface-head" onClick={() => setOpen(!open)}>
        <span className={`dot ${i.shutdown ? 'admin' : 'up'}`} />
        <span className="n">{i.name}</span>
        <span className="m">{i.ip ? `${i.ip}/${maskToPrefix(i.mask ?? '0.0.0.0')}` : 'no ip'}</span>
        <button
          className={`toggle ${i.shutdown ? '' : 'on'}`}
          title={i.shutdown ? 'no shutdown' : 'shutdown'}
          onClick={(e) => {
            e.stopPropagation();
            edit((x) => (x.shutdown = !x.shutdown));
          }}
        />
      </div>
      {open && (
        <div className="iface-body">
          <div className="field" style={{ marginTop: 8 }}>
            <label>IP address</label>
            <Commit value={i.ip ?? ''} validate={ipOk} onCommit={(v) => edit((x) => ((x.ip = v || undefined), v && !x.mask && (x.mask = classfulMask(v))))} />
          </div>
          <div className="field">
            <label>Subnet mask</label>
            <Commit value={i.mask ?? ''} validate={maskOk} onCommit={(v) => edit((x) => (x.mask = v || undefined))} />
          </div>
          <div className="field">
            <label>Description</label>
            <Commit mono={false} value={i.description ?? ''} onCommit={(v) => edit((x) => (x.description = v || undefined))} />
          </div>
          <div className="field">
            <label>NAT</label>
            <select className="input" value={i.natRole ?? ''} onChange={(e) => edit((x) => (x.natRole = (e.target.value || undefined) as Iface['natRole']))}>
              <option value="">—</option>
              <option value="inside">inside</option>
              <option value="outside">outside</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

function LinkInspector() {
  const project = useStore((s) => s.project);
  const id = useStore((s) => s.selectedLink);
  const mutate = useStore((s) => s.mutate);
  const set = useStore((s) => s.set);
  const l = project.links.find((x) => x.id === id);
  if (!l) return <ProjectSummary />;
  const a = project.devices.find((d) => d.id === l.a.dev);
  const b = project.devices.find((d) => d.id === l.b.dev);
  return (
    <aside className="inspector">
      <div className="insp-head">
        <div className="ico tinted k-other">
          <I.cable size={22} />
        </div>
        <div>
          <div style={{ fontWeight: 620, fontSize: 15 }}>Cable</div>
          <div className="model">
            {a?.name} ↔ {b?.name}
          </div>
        </div>
      </div>
      <div className="insp-body">
        <div className="section">
          <h4>Endpoints</h4>
          <dl className="kv">
            <dt>{a?.name}</dt>
            <dd>{l.a.iface}</dd>
            <dt>{b?.name}</dt>
            <dd>{l.b.iface}</dd>
          </dl>
        </div>
        <div className="section">
          <h4>Cable type</h4>
          <select
            className="input"
            value={l.cable}
            onChange={(e) =>
              mutate((p) => {
                const x = p.links.find((q) => q.id === l.id);
                if (x) x.cable = e.target.value as typeof l.cable;
              })
            }
          >
            <option value="straight">Copper straight-through</option>
            <option value="cross">Copper crossover</option>
            <option value="fiber">Fiber</option>
            <option value="serial">Serial</option>
            <option value="console">Console</option>
          </select>
        </div>
        <button
          className="btn outline danger"
          onClick={() => {
            mutate((p) => {
              p.links = p.links.filter((x) => x.id !== l.id);
            });
            set({ selectedLink: null });
          }}
        >
          <I.trash size={15} /> Remove cable
        </button>
      </div>
    </aside>
  );
}

const KIND_LABEL: Record<string, string> = {
  router: 'Routers',
  switch: 'Switches',
  pc: 'PCs',
  laptop: 'Laptops',
  server: 'Servers',
  tablet: 'Tablets',
  phone: 'Phones',
  printer: 'Printers',
  homerouter: 'Home routers',
  ap: 'Access points',
  cloud: 'Clouds',
  other: 'Other',
};

function ProjectSummary() {
  const project = useStore((s) => s.project);
  const counts = project.devices.reduce<Record<string, number>>((m, d) => ((m[d.kind] = (m[d.kind] ?? 0) + 1), m), {});
  return (
    <aside className="inspector">
      <div className="insp-head">
        <div className="ico tinted k-router">
          <I.logo size={26} />
        </div>
        <div>
          <div style={{ fontWeight: 620, fontSize: 15 }}>{project.fileName ?? 'Untitled network'}</div>
          <div className="model">{project.ptVersion ? `Packet Tracer ${project.ptVersion} file` : 'NetForge project'}</div>
        </div>
      </div>
      <div className="insp-body">
        <div className="section">
          <h4>Topology</h4>
          <dl className="kv">
            <dt>Devices</dt>
            <dd>{project.devices.length}</dd>
            <dt>Cables</dt>
            <dd>{project.links.length}</dd>
            {Object.entries(counts).map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}>
                <dt>{KIND_LABEL[k] ?? k}</dt>
                <dd>{v}</dd>
              </span>
            ))}
          </dl>
        </div>
        <div className="section">
          <h4>Shortcuts</h4>
          <dl className="kv">
            <dt>Select / move</dt>
            <dd>V</dd>
            <dt>Cable</dt>
            <dd>C</dd>
            <dt>Ping (PDU)</dt>
            <dd>P</dd>
            <dt>Note</dt>
            <dd>N</dd>
            <dt>Command palette</dt>
            <dd>Ctrl K</dd>
            <dt>Undo / redo</dt>
            <dd>Ctrl Z / Ctrl Shift Z</dd>
            <dt>Simulation mode</dt>
            <dd>Ctrl M</dd>
          </dl>
        </div>
        <p style={{ color: 'var(--text-3)' }}>Select a device or cable to see its details. Double-click a device to open its terminal.</p>
      </div>
    </aside>
  );
}
