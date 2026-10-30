import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import type { Device, DnsRecord, Project } from '../model/types';
import { wirelessLinks } from '../engine/network';
import { httpGet } from '../engine/services';
import { isIp } from '../model/ip';
import { Terminal } from './Terminal';
import { I } from './Icons';

type App = 'ip' | 'cmd' | 'term' | 'ssh' | 'web' | 'wifi' | 'services';

const S = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const APPS: { id: App; label: string; tint: string; icon: ReactNode; when?: (d: Device) => boolean }[] = [
  {
    id: 'ip',
    label: 'IP Configuration',
    tint: '#5b9dff',
    icon: (
      <S>
        <rect x="3" y="5" width="18" height="12" rx="2" />
        <path d="M7 9h2M7 13h6M13 9h4" />
        <path d="M9 21h6" />
      </S>
    ),
  },
  {
    id: 'cmd',
    label: 'Command Prompt',
    tint: '#8b95a7',
    icon: (
      <S>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 10 3 2-3 2M12 15h5" />
      </S>
    ),
  },
  {
    id: 'term',
    label: 'Terminal',
    tint: '#34d399',
    icon: (
      <S>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="m7 9 2.5 2L7 13" />
        <path d="M12 21v-4M8 21h8" />
      </S>
    ),
    when: (d) => d.kind === 'pc' || d.kind === 'laptop',
  },
  {
    id: 'ssh',
    label: 'Telnet / SSH Client',
    tint: '#fbbf24',
    icon: (
      <S>
        <rect x="3" y="4" width="14" height="11" rx="2" />
        <path d="m6 8 2 1.5L6 11" />
        <rect x="14" y="13" width="7" height="7" rx="1.5" />
        <path d="M15.5 13v-1.5a2 2 0 0 1 4 0V13" />
      </S>
    ),
  },
  {
    id: 'web',
    label: 'Web Browser',
    tint: '#22d3ee',
    icon: (
      <S>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" />
      </S>
    ),
  },
  {
    id: 'wifi',
    label: 'PC Wireless',
    tint: '#c084fc',
    icon: (
      <S>
        <path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" />
        <circle cx="12" cy="19" r="1" />
      </S>
    ),
    when: (d) => d.ifaces.some((i) => i.media === 'wireless'),
  },
  {
    id: 'services',
    label: 'Services',
    tint: '#fb923c',
    icon: (
      <S>
        <rect x="4" y="3" width="16" height="7" rx="1.5" />
        <rect x="4" y="14" width="16" height="7" rx="1.5" />
        <path d="M8 6.5h.01M8 17.5h.01" />
      </S>
    ),
    when: (d) => !!d.services,
  },
];

/** A host's Desktop: a launcher of apps, each opening inside the panel. */
export function Desktop({ dev, ipConfig }: { dev: Device; ipConfig: ReactNode }) {
  const [app, setApp] = useState<App | null>(null);
  const apps = APPS.filter((a) => !a.when || a.when(dev));
  const cur = apps.find((a) => a.id === app);
  if (!cur)
    return (
      <div className="desktop">
        <div className="dapps">
          {apps.map((a) => (
            <button key={a.id} className="dapp" onClick={() => setApp(a.id)}>
              <span className="tile" style={{ ['--t' as string]: a.tint }}>
                {a.icon}
              </span>
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <div className="desktop open">
      <div className="app-bar">
        <button className="btn icon sm" title="All apps" onClick={() => setApp(null)}>
          <I.apps size={15} />
        </button>
        <span className="tile sm" style={{ ['--t' as string]: cur.tint }}>
          {cur.icon}
        </span>
        <b>{cur.label}</b>
      </div>
      <div className="app-body">
        {app === 'ip' && <div className="insp-body">{ipConfig}</div>}
        {app === 'cmd' && <Terminal dev={dev} />}
        {app === 'term' && <ConsoleApp dev={dev} />}
        {app === 'ssh' && <SshApp dev={dev} />}
        {app === 'web' && <Browser dev={dev} />}
        {app === 'wifi' && <Wireless dev={dev} />}
        {app === 'services' && <Services dev={dev} />}
      </div>
    </div>
  );
}

/* ---------------- Terminal (console cable) ---------------- */

function consolePeer(p: Project, dev: Device) {
  const l = p.links.find((x) => x.cable === 'console' && (x.a.dev === dev.id || x.b.dev === dev.id));
  if (!l) return undefined;
  const other = l.a.dev === dev.id ? l.b.dev : l.a.dev;
  return p.devices.find((d) => d.id === other);
}

function ConsoleApp({ dev }: { dev: Device }) {
  const project = useStore((s) => s.project);
  const peer = consolePeer(project, dev);
  if (!peer?.ios)
    return (
      <div className="blank">
        No console connection. Use the <b>Cable</b> tool to connect this {dev.kind === 'laptop' ? 'laptop' : 'PC'}'s <b>RS 232</b> port to a router or switch's <b>Console</b> port.
      </div>
    );
  if (!peer.powered) return <div className="blank">{peer.name} is powered off.</div>;
  return (
    <>
      <div className="app-note">
        Bits per second 9600 · Data bits 8 · Parity None · Stop bits 1 · Flow control None — connected to <b>{peer.name}</b>
      </div>
      <Terminal dev={peer} bufKey={`${dev.id}>console>${peer.id}`} intro={`\nPress RETURN to get started!\n\n`} />
    </>
  );
}

/* ---------------- Telnet / SSH client ---------------- */

function SshApp({ dev }: { dev: Device }) {
  const [proto, setProto] = useState<'ssh' | 'telnet'>('ssh');
  const [user, setUser] = useState('');
  const [host, setHost] = useState('');
  const [run, setRun] = useState<{ n: number; cmd: string } | null>(null);
  const connect = () => {
    if (!host.trim()) return;
    setRun({ n: Date.now(), cmd: proto === 'ssh' ? `ssh -l ${user.trim() || 'admin'} ${host.trim()}` : `telnet ${host.trim()}` });
  };
  return (
    <>
      <div className="app-form">
        <div className="segmented">
          <button className={proto === 'ssh' ? 'on' : ''} onClick={() => setProto('ssh')}>
            SSH
          </button>
          <button className={proto === 'telnet' ? 'on' : ''} onClick={() => setProto('telnet')}>
            Telnet
          </button>
        </div>
        {proto === 'ssh' && <input className="input" placeholder="Username" value={user} onChange={(e) => setUser(e.target.value)} style={{ width: 120 }} />}
        <input className="input" placeholder="Host name or IP" value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && connect()} style={{ flex: 1 }} />
        <button className="btn primary sm" onClick={connect} disabled={!host.trim()}>
          Connect
        </button>
      </div>
      {run ? (
        <Terminal key={run.n} dev={dev} bufKey={`${dev.id}>ssh>${run.n}`} intro="" autorun={run.cmd} quick={false} />
      ) : (
        <div className="blank">Connect to a router or switch's VTY lines. SSH needs a username, a domain name and RSA keys on the device.</div>
      )}
    </>
  );
}

/* ---------------- Web browser ---------------- */

function Browser({ dev }: { dev: Device }) {
  const project = useStore((s) => s.project);
  const [url, setUrl] = useState('http://');
  const [page, setPage] = useState<{ url: string; html: string; status: string } | null>(null);
  const [back, setBack] = useState<string[]>([]);
  const frame = useRef<HTMLIFrameElement>(null);

  const go = (target: string, push = true) => {
    const r = httpGet(project, dev, target);
    if (push && page) setBack([...back, page.url]);
    setPage(r);
    setUrl(r.url);
  };

  // follow links inside the page without leaving the app
  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc || !page) return;
    doc.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      const href = a?.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(href)) go(href);
      else {
        const m = page.url.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
        const origin = m?.[1] ?? page.url;
        const dir = (m?.[2] ?? '/').replace(/[^/]*$/, '');
        go(href.startsWith('/') ? origin + href : `${origin}${dir}${href}`);
      }
    });
  };

  return (
    <>
      <div className="app-form">
        <button className="btn icon sm" title="Back" disabled={!back.length} onClick={() => (go(back[back.length - 1], false), setBack(back.slice(0, -1)))}>
          ‹
        </button>
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go(url)} style={{ flex: 1 }} spellCheck={false} />
        <button className="btn primary sm" onClick={() => go(url)}>
          Go
        </button>
        <button className="btn sm" onClick={() => page && go(page.url, false)} disabled={!page}>
          Reload
        </button>
      </div>
      {page ? (
        <>
          <iframe ref={frame} className="web" title="Web page" sandbox="allow-same-origin" srcDoc={page.html} onLoad={onLoad} />
          <div className="app-note">{page.status}</div>
        </>
      ) : (
        <div className="blank">Type a URL such as http://192.168.1.10 or a name your DNS server knows, then Go.</div>
      )}
    </>
  );
}

/* ---------------- PC Wireless ---------------- */

function Wireless({ dev }: { dev: Device }) {
  const project = useStore((s) => s.project);
  const mutate = useStore((s) => s.mutate);
  const nets = useMemo(() => {
    const out = new Map<string, { ssid: string; signal: number; ap: string }>();
    const bands = ['2.4 GHz', '5 GHz-1', '5 GHz-2'];
    for (const ap of project.devices) {
      if (!ap.powered || (ap.kind !== 'homerouter' && ap.kind !== 'ap')) continue;
      // each enabled radio that broadcasts its name shows up as a network
      const offered =
        ap.kind === 'ap'
          ? [{ ssid: ap.ssid ?? 'Default', band: '' }]
          : (ap.home?.radios ?? [{ ssid: ap.home!.ssid, enabled: true, broadcast: true }])
              .map((r, k) => ({ ...r, ssid: k === 0 ? ap.home!.ssid : r.ssid, band: bands[k] }))
              .filter((r) => r.enabled && r.broadcast);
      const dist = Math.hypot(ap.x - dev.x, ap.y - dev.y);
      const signal = Math.max(0, Math.round(100 - (dist / 520) * 100));
      if (signal <= 0) continue;
      for (const o of offered) {
        const cur = out.get(o.ssid);
        const label = o.band ? `${ap.name} · ${o.band}` : ap.name;
        if (!cur) out.set(o.ssid, { ssid: o.ssid, signal, ap: label });
        else if (cur.signal < signal) out.set(o.ssid, { ...cur, signal, ap: label });
        else if (cur.ap.startsWith(ap.name) && o.band) cur.ap += `, ${o.band}`;
      }
    }
    return [...out.values()].sort((a, b) => b.signal - a.signal);
  }, [project, dev.x, dev.y]);
  const link = useMemo(() => wirelessLinks(project).find((l) => l.a.dev === dev.id), [project, dev.id]);
  const [hidden, setHidden] = useState('');
  const w = dev.ifaces.find((i) => i.media === 'wireless');
  return (
    <div className="insp-body">
      <div className="section">
        <h4>Link information</h4>
        <dl className="kv">
          <dt>Status</dt>
          <dd>{link ? `Connected to ${dev.ssid}` : 'Not associated'}</dd>
          <dt>IP address</dt>
          <dd>{w?.ip ?? 'none'}</dd>
          <dt>MAC address</dt>
          <dd>{w?.mac}</dd>
        </dl>
      </div>
      <div className="section">
        <h4>Networks in range</h4>
        {nets.length ? (
          <div className="nets">
            {nets.map((n) => (
              <div key={n.ssid} className={`net ${dev.ssid === n.ssid && link ? 'on' : ''}`}>
                <div className="bars" title={`${n.signal}%`}>
                  {[25, 50, 75, 100].map((t) => (
                    <i key={t} className={n.signal >= t - 24 ? 'lit' : ''} style={{ height: t / 10 + 3 }} />
                  ))}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{n.ssid}</b>
                  <div className="dim">
                    {n.ap} · {n.signal}%
                  </div>
                </div>
                <button
                  className="btn sm"
                  disabled={dev.ssid === n.ssid && !!link}
                  onClick={() =>
                    mutate((p) => {
                      const d = p.devices.find((x) => x.id === dev.id)!;
                      d.ssid = n.ssid;
                      const wi = d.ifaces.find((i) => i.media === 'wireless');
                      if (wi && d.dhcpClient) wi.ip = undefined;
                    })
                  }
                >
                  {dev.ssid === n.ssid && link ? 'Connected' : 'Connect'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="blank">No wireless networks in range. Move closer to an access point or wireless router.</div>
        )}
      </div>
      <div className="section">
        <h4>Hidden network</h4>
        <div className="app-form" style={{ padding: 0, border: 0 }}>
          <input className="input" placeholder="Network name (SSID)" value={hidden} onChange={(e) => setHidden(e.target.value)} style={{ flex: 1 }} />
          <button
            className="btn sm"
            disabled={!hidden.trim()}
            onClick={() =>
              mutate((p) => {
                const d = p.devices.find((x) => x.id === dev.id)!;
                d.ssid = hidden.trim();
                const wi = d.ifaces.find((i) => i.media === 'wireless');
                if (wi && d.dhcpClient) wi.ip = undefined;
              })
            }
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Server services ---------------- */

function Services({ dev }: { dev: Device }) {
  const mutate = useStore((s) => s.mutate);
  const svc = dev.services!;
  const [file, setFile] = useState(Object.keys(svc.pages)[0] ?? 'index.html');
  const [rec, setRec] = useState<DnsRecord>({ name: '', type: 'A', value: '' });
  const [newFile, setNewFile] = useState('');
  const edit = (fn: (s: NonNullable<Device['services']>) => void) =>
    mutate((p) => {
      const d = p.devices.find((x) => x.id === dev.id);
      if (d?.services) fn(d.services);
    });
  return (
    <div className="insp-body">
      <div className="section">
        <h4>
          HTTP
          <button className={`toggle ${svc.http ? 'on' : ''}`} onClick={() => edit((s) => (s.http = !s.http))} />
        </h4>
        <div className="app-form" style={{ padding: 0, border: 0 }}>
          <select className="input" value={file} onChange={(e) => setFile(e.target.value)} style={{ flex: 1 }}>
            {Object.keys(svc.pages).map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <input className="input" placeholder="new-page.html" value={newFile} onChange={(e) => setNewFile(e.target.value)} style={{ width: 130 }} />
          <button
            className="btn sm"
            disabled={!/^[\w.-]+$/.test(newFile)}
            onClick={() => {
              const name = newFile;
              edit((s) => void (s.pages[name] = s.pages[name] ?? '<html>\n</html>'));
              setFile(name);
              setNewFile('');
            }}
          >
            Add file
          </button>
        </div>
        <textarea
          className="input code-edit"
          key={file}
          defaultValue={svc.pages[file] ?? ''}
          spellCheck={false}
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== svc.pages[file]) edit((s) => (s.pages[file] = v));
          }}
        />
      </div>
      <div className="section">
        <h4>
          DNS
          <button className={`toggle ${svc.dns ? 'on' : ''}`} onClick={() => edit((s) => (s.dns = !s.dns))} />
        </h4>
        <div className="app-form" style={{ padding: 0, border: 0 }}>
          <input className="input" placeholder="Name" value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} style={{ flex: 1 }} />
          <select className="input" value={rec.type} onChange={(e) => setRec({ ...rec, type: e.target.value as DnsRecord['type'] })} style={{ width: 84 }}>
            <option value="A">A</option>
            <option value="CNAME">CNAME</option>
            <option value="NS">NS</option>
          </select>
          <input className="input" placeholder={rec.type === 'A' ? 'Address' : 'Host name'} value={rec.value} onChange={(e) => setRec({ ...rec, value: e.target.value })} style={{ flex: 1 }} />
          <button
            className="btn sm"
            disabled={!rec.name || !rec.value || (rec.type === 'A' && !isIp(rec.value))}
            onClick={() => (edit((s) => void s.records.push({ ...rec, name: rec.name.trim(), value: rec.value.trim() })), setRec({ name: '', type: 'A', value: '' }))}
          >
            Add
          </button>
        </div>
        <table className="events">
          <tbody>
            {svc.records.map((r, k) => (
              <tr key={k}>
                <td>{r.name}</td>
                <td>
                  <span className="proto DHCP">{r.type}</span>
                </td>
                <td className="mono">{r.value}</td>
                <td style={{ width: 28 }}>
                  <button className="btn icon sm" title="Remove" onClick={() => edit((s) => void s.records.splice(k, 1))}>
                    <I.trash size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!svc.records.length && <div className="dim" style={{ marginTop: 6 }}>No records yet.</div>}
      </div>
    </div>
  );
}
