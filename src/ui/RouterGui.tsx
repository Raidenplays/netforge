import { useState } from 'react';
import type { Device, HomeRouterState, Radio } from '../model/types';
import { intToIp, isIp, isMask, maskToPrefix, network } from '../model/ip';

type Page = 'basic' | 'wireless' | 'status';

const RADIO_NAMES = ['2.4 GHz', '5 GHz-1', '5 GHz-2'];
const MASKS = ['255.255.255.0', '255.255.255.128', '255.255.255.192', '255.255.255.224', '255.255.255.240', '255.255.255.248', '255.255.255.252', '255.255.0.0'];

const radiosOf = (h: HomeRouterState): Radio[] => {
  const base = h.radios ?? [{ ssid: h.ssid, enabled: true, broadcast: true }];
  return [0, 1, 2].map((k) => ({ ...(base[k] ?? { ssid: 'Default', enabled: true, broadcast: true }), ...(k === 0 ? { ssid: h.ssid } : {}) }));
};

/** four boxes for a dotted address, like the Linksys page */
function Octets({ value, onChange, fixed = 0, disabled }: { value: string; onChange: (v: string) => void; fixed?: number; disabled?: boolean }) {
  const parts = (value || '0.0.0.0').split('.');
  while (parts.length < 4) parts.push('0');
  return (
    <span className="octets">
      {parts.map((p, k) => (
        <span key={k}>
          {k < fixed ? (
            <span className="fixed">{p}</span>
          ) : (
            <input
              className="input"
              value={p}
              disabled={disabled}
              inputMode="numeric"
              maxLength={3}
              onChange={(e) => {
                const next = [...parts];
                next[k] = e.target.value.replace(/\D/g, '');
                onChange(next.join('.'));
              }}
            />
          )}
          {k < 3 && <i>.</i>}
        </span>
      ))}
    </span>
  );
}

/** The home router's web configuration page (Setup, Wireless, Status). Changes apply on Save Settings. */
export function RouterGui({ dev, onSave, onClose }: { dev: Device; onSave: (h: HomeRouterState) => void; onClose: () => void }) {
  const [page, setPage] = useState<Page>('basic');
  const [draft, setDraft] = useState<HomeRouterState>(() => JSON.parse(JSON.stringify({ ...dev.home!, radios: radiosOf(dev.home!) })));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (fn: (h: HomeRouterState) => void) => {
    setDraft((d) => {
      const n: HomeRouterState = JSON.parse(JSON.stringify(d));
      fn(n);
      return n;
    });
    setMsg(null);
  };
  const h = draft;
  const net = isIp(h.lanIp) && isMask(h.lanMask) ? network(h.lanIp, h.lanMask) : 0;
  const prefix = intToIp(net).split('.').slice(0, 3).join('.');
  const first = net + h.startHost;
  const last = first + h.maxUsers - 1;

  const save = () => {
    const bad = (label: string, v: string, check: (x: string) => boolean) => (!check(v) ? `${label} is not valid.` : '');
    const err =
      (h.wanMode === 'static'
        ? bad('Internet IP Address', h.wanIp, isIp) || bad('Subnet Mask', h.wanMask, isMask) || bad('Default Gateway', h.wanGateway, isIp)
        : '') ||
      bad('Router IP Address', h.lanIp, isIp) ||
      (h.startHost < 1 || h.startHost > 254 ? 'Start IP Address is not valid.' : '') ||
      (h.maxUsers < 1 || last > net + 2 ** (32 - maskToPrefix(h.lanMask)) - 2 ? 'Maximum number of Users is too large for this network.' : '');
    if (err) return setMsg({ ok: false, text: err });
    const radios = h.radios!;
    onSave({ ...h, ssid: radios[0].ssid, radios, leases: h.lanIp !== dev.home!.lanIp || h.lanMask !== dev.home!.lanMask || h.startHost !== dev.home!.startHost ? [] : h.leases });
    setMsg({ ok: true, text: 'Settings are successful.' });
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal router-gui" role="dialog" aria-label={`${dev.name} configuration`}>
        <div className="rg-head">
          <div>
            <b>{dev.name}</b>
            <span>Wireless-AC router · {dev.model}</span>
          </div>
          <nav>
            {(['basic', 'wireless', 'status'] as const).map((p) => (
              <button key={p} className={page === p ? 'on' : ''} onClick={() => setPage(p)}>
                {p === 'basic' ? 'Setup' : p === 'wireless' ? 'Wireless' : 'Status'}
              </button>
            ))}
          </nav>
          <button className="btn icon sm" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="rg-sub">{page === 'basic' ? 'Basic Setup' : page === 'wireless' ? 'Basic Wireless Settings' : 'Router · Local Network · Wireless'}</div>

        <div className="rg-body">
          {page === 'basic' && (
            <>
              <section>
                <h5>Internet Setup</h5>
                <div className="rg-row">
                  <label>Internet Connection type</label>
                  <select className="input" value={h.wanMode} onChange={(e) => set((x) => (x.wanMode = e.target.value as 'dhcp' | 'static'))}>
                    <option value="dhcp">Automatic Configuration - DHCP</option>
                    <option value="static">Static IP</option>
                  </select>
                </div>
                {h.wanMode === 'static' && (
                  <>
                    <div className="rg-row">
                      <label>Internet IP Address</label>
                      <Octets value={h.wanIp} onChange={(v) => set((x) => (x.wanIp = v))} />
                    </div>
                    <div className="rg-row">
                      <label>Subnet Mask</label>
                      <Octets value={h.wanMask} onChange={(v) => set((x) => (x.wanMask = v))} />
                    </div>
                    <div className="rg-row">
                      <label>Default Gateway</label>
                      <Octets value={h.wanGateway} onChange={(v) => set((x) => (x.wanGateway = v))} />
                    </div>
                    <div className="rg-row">
                      <label>DNS 1</label>
                      <Octets value={h.wanDns ?? '0.0.0.0'} onChange={(v) => set((x) => (x.wanDns = v))} />
                    </div>
                  </>
                )}
              </section>
              <section>
                <h5>Network Setup</h5>
                <div className="rg-row">
                  <label>Router IP Address</label>
                  <Octets value={h.lanIp} onChange={(v) => set((x) => (x.lanIp = v))} />
                </div>
                <div className="rg-row">
                  <label>Subnet Mask</label>
                  <select className="input" value={h.lanMask} onChange={(e) => set((x) => (x.lanMask = e.target.value))}>
                    {(MASKS.includes(h.lanMask) ? MASKS : [h.lanMask, ...MASKS]).map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div className="rg-row">
                  <label>DHCP Server</label>
                  <span className="rg-radio">
                    <label>
                      <input type="radio" checked={h.dhcpEnabled} onChange={() => set((x) => (x.dhcpEnabled = true))} /> Enabled
                    </label>
                    <label>
                      <input type="radio" checked={!h.dhcpEnabled} onChange={() => set((x) => (x.dhcpEnabled = false))} /> Disabled
                    </label>
                  </span>
                </div>
                <div className="rg-row">
                  <label>Start IP Address</label>
                  <span className="octets">
                    <span className="fixed">{prefix}.</span>
                    <input className="input" value={String(h.startHost)} disabled={!h.dhcpEnabled} onChange={(e) => set((x) => (x.startHost = Number(e.target.value.replace(/\D/g, '')) || 0))} />
                  </span>
                </div>
                <div className="rg-row">
                  <label>Maximum number of Users</label>
                  <input className="input" style={{ width: 70 }} value={String(h.maxUsers)} disabled={!h.dhcpEnabled} onChange={(e) => set((x) => (x.maxUsers = Number(e.target.value.replace(/\D/g, '')) || 0))} />
                </div>
                <div className="rg-row">
                  <label>IP Address Range</label>
                  <span className="mono">
                    {intToIp(first)} – {intToIp(last)}
                  </span>
                </div>
                <div className="rg-row">
                  <label>Static DNS 1</label>
                  <Octets value={h.dns ?? '0.0.0.0'} disabled={!h.dhcpEnabled} onChange={(v) => set((x) => (x.dns = v))} />
                </div>
              </section>
            </>
          )}

          {page === 'wireless' &&
            h.radios!.map((r, k) => (
              <section key={k}>
                <h5>{RADIO_NAMES[k]}</h5>
                <div className="rg-row">
                  <label>Network Mode</label>
                  <select className="input" value={r.enabled ? 'mixed' : 'off'} onChange={(e) => set((x) => (x.radios![k].enabled = e.target.value !== 'off'))}>
                    <option value="mixed">Mixed</option>
                    <option value="off">Disabled</option>
                  </select>
                </div>
                <div className="rg-row">
                  <label>Network Name (SSID)</label>
                  <input className="input" value={r.ssid} disabled={!r.enabled} onChange={(e) => set((x) => (x.radios![k].ssid = e.target.value))} />
                </div>
                <div className="rg-row">
                  <label>Channel</label>
                  <span className="dim">Auto</span>
                </div>
                <div className="rg-row">
                  <label>SSID Broadcast</label>
                  <span className="rg-radio">
                    <label>
                      <input type="radio" disabled={!r.enabled} checked={r.broadcast} onChange={() => set((x) => (x.radios![k].broadcast = true))} /> Enabled
                    </label>
                    <label>
                      <input type="radio" disabled={!r.enabled} checked={!r.broadcast} onChange={() => set((x) => (x.radios![k].broadcast = false))} /> Disabled
                    </label>
                  </span>
                </div>
              </section>
            ))}

          {page === 'status' && (
            <>
              <section>
                <h5>Internet</h5>
                <dl className="kv">
                  <dt>Connection type</dt>
                  <dd>{dev.home!.wanMode === 'static' ? 'Static IP' : 'Automatic Configuration - DHCP'}</dd>
                  <dt>IP address</dt>
                  <dd>{dev.home!.wanIp}</dd>
                  <dt>Subnet mask</dt>
                  <dd>{dev.home!.wanMask}</dd>
                  <dt>Default gateway</dt>
                  <dd>{dev.home!.wanGateway}</dd>
                  <dt>DNS</dt>
                  <dd>{dev.home!.wanDns ?? dev.home!.dns ?? '0.0.0.0'}</dd>
                </dl>
              </section>
              <section>
                <h5>Local Network</h5>
                <dl className="kv">
                  <dt>Router IP</dt>
                  <dd>
                    {dev.home!.lanIp} / {dev.home!.lanMask}
                  </dd>
                  <dt>DHCP server</dt>
                  <dd>{dev.home!.dhcpEnabled ? 'Enabled' : 'Disabled'}</dd>
                </dl>
                <table className="events" style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>IP address</th>
                      <th>MAC address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dev.home!.leases.map((l) => (
                      <tr key={l.ip}>
                        <td>DHCP client</td>
                        <td className="mono">{l.ip}</td>
                        <td className="mono">{l.mac}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section>
                <h5>Wireless</h5>
                <dl className="kv">
                  {radiosOf(dev.home!).map((r, k) => (
                    <span key={k} style={{ display: 'contents' }}>
                      <dt>{RADIO_NAMES[k]}</dt>
                      <dd>{r.enabled ? `${r.ssid}${r.broadcast ? '' : ' (hidden)'}` : 'Disabled'}</dd>
                    </span>
                  ))}
                </dl>
              </section>
            </>
          )}
        </div>

        {page !== 'status' && (
          <div className="rg-foot">
            {msg && <span className={msg.ok ? 'good' : 'bad'}>{msg.text}</span>}
            <span className="spacer" />
            <button className="btn sm" onClick={() => (setDraft(JSON.parse(JSON.stringify({ ...dev.home!, radios: radiosOf(dev.home!) }))), setMsg(null))}>
              Cancel Changes
            </button>
            <button className="btn primary sm" onClick={save}>
              Save Settings
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
