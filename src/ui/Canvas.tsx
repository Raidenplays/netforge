import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { DeviceGlyph, I } from './Icons';
import { buildTopo, ifaceStatus } from '../engine/network';
import { autoPort, cablePorts, canPing, connect, deleteSelection, duplicate, fitView, portUsed, primaryIp, runPing, targetIp, addDevice } from '../actions';
import type { Device } from '../model/types';
import { uid } from '../model/types';

const TILE = 56;

type Pop =
  | { kind: 'ports'; dev: string; sx: number; sy: number }
  | { kind: 'menu'; dev?: string; link?: string; sx: number; sy: number }
  | null;

export function Canvas() {
  const project = useStore((s) => s.project);
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const selected = useStore((s) => s.selected);
  const selectedLink = useStore((s) => s.selectedLink);
  const cableFrom = useStore((s) => s.cableFrom);
  const pduFrom = useStore((s) => s.pduFrom);
  const showPorts = useStore((s) => s.showPorts);
  const flight = useStore((s) => s.flight);
  const placing = useStore((s) => s.placing);
  const speed = useStore((s) => s.speed);
  const set = useStore((s) => s.set);
  const mutate = useStore((s) => s.mutate);

  const wrap = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<Pop>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const drag = useRef<{ id: string; ox: number; oy: number; moved: boolean; snap: typeof project; sx: number; sy: number } | null>(null);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const topo = useMemo(() => buildTopo(project), [project]);
  const byId = useMemo(() => new Map(project.devices.map((d) => [d.id, d])), [project]);

  // fit on first load of a project
  const lastFile = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = `${project.fileName}|${project.devices.length > 0}`;
    if (key !== lastFile.current && wrap.current) {
      lastFile.current = key;
      const r = wrap.current.getBoundingClientRect();
      fitView(r.width, r.height);
    }
  }, [project]);

  const toWorld = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };
  const toScreen = (x: number, y: number) => ({ sx: x * view.k + view.x, sy: y * view.k + view.y });

  /* ---------------- packet animation ---------------- */
  const [t, setT] = useState(0);
  useEffect(() => {
    setT(0);
    if (!flight || !flight.playing) return;
    const hop = flight.hops[flight.step];
    if (!hop) {
      set({ flight: { ...flight, playing: false } });
      return;
    }
    const segs = Math.max(1, hop.devs.length - 1);
    const realtime = useStore.getState().mode === 'realtime';
    const dur = ((realtime ? 260 : 700) * segs) / speed;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const v = Math.max(0, Math.min(1, (now - start) / dur));
      setT(v);
      if (v < 1) raf = requestAnimationFrame(tick);
      else {
        const f = useStore.getState().flight;
        if (!f || f.id !== flight.id) return;
        const next = f.step + 1;
        if (next >= f.hops.length) set({ flight: { ...f, step: f.hops.length, playing: false } });
        else set({ flight: { ...f, step: next } });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight?.id, flight?.step, flight?.playing, speed]);

  const packet = useMemo(() => {
    if (!flight) return null;
    const hop = flight.hops[flight.step];
    if (!hop) return null;
    const pts = hop.devs.map((id) => byId.get(id)).filter(Boolean) as Device[];
    if (pts.length < 2) return { x: pts[0]?.x ?? 0, y: pts[0]?.y ?? 0, fail: true, reply: hop.reply, links: hop.links };
    const segs = pts.length - 1;
    const pos = Math.max(0, Math.min(1, flight.playing ? t : 0)) * segs;
    const i = Math.min(segs - 1, Math.floor(pos));
    const f = pos - i;
    return {
      x: pts[i].x + (pts[i + 1].x - pts[i].x) * f,
      y: pts[i].y + (pts[i + 1].y - pts[i].y) * f,
      fail: !!hop.fail,
      reply: hop.reply,
      links: hop.links,
    };
  }, [flight, t, byId]);

  /* ---------------- interactions ---------------- */

  const onWheel = (e: React.WheelEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.max(0.25, Math.min(3, view.k * Math.exp(-e.deltaY * 0.0015)));
    set({ view: { k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k } });
  };

  const onBgDown = (e: React.PointerEvent) => {
    setPop(null);
    if (e.button === 2) return;
    const w = toWorld(e.clientX, e.clientY);
    if (placing) {
      addDevice(placing, w.x, w.y);
      if (!e.shiftKey) set({ placing: null });
      return;
    }
    if (tool === 'note') {
      const id = uid('note');
      mutate((p) => {
        p.notes.push({ id, x: w.x, y: w.y, text: 'Note' });
      });
      set({ tool: 'select' });
      return;
    }
    if (tool === 'cable' && cableFrom) {
      set({ cableFrom: null });
      return;
    }
    set({ selected: null, selectedLink: null, pduFrom: tool === 'pdu' ? null : pduFrom });
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    setPanning(true);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    if (cableFrom || placing) setCursor(toWorld(e.clientX, e.clientY));
    if (pan.current) {
      set({ view: { ...view, x: pan.current.vx + e.clientX - pan.current.x, y: pan.current.vy + e.clientY - pan.current.y } });
    }
    const d = drag.current;
    if (d) {
      const w = toWorld(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
      d.moved = true;
      mutate(
        (p) => {
          const dev = p.devices.find((x) => x.id === d.id) ?? p.notes.find((x) => x.id === d.id);
          if (dev) {
            dev.x = Math.round((w.x - d.ox) / 2) * 2;
            dev.y = Math.round((w.y - d.oy) / 2) * 2;
          }
        },
        { silent: true },
      );
    }
  };

  const onUp = () => {
    pan.current = null;
    setPanning(false);
    const d = drag.current;
    if (d?.moved) useStore.setState((s) => ({ past: [...s.past, d.snap], future: [] }));
    drag.current = null;
  };

  const onNodeDown = (e: React.PointerEvent, dev: Device) => {
    e.stopPropagation();
    setPop(null);
    if (e.button === 2) return;
    if (tool === 'cable') {
      const { sx, sy } = toScreen(dev.x, dev.y);
      setPop({ kind: 'ports', dev: dev.id, sx: sx + 36, sy: sy - 20 });
      return;
    }
    if (tool === 'pdu') {
      if (!canPing(dev)) return useStore.getState().toast(`${dev.name} can't send pings.`, 'bad');
      if (!pduFrom) return set({ pduFrom: dev.id });
      if (pduFrom === dev.id) return;
      const ip = targetIp(project, pduFrom, dev.id);
      if (!ip) {
        useStore.getState().toast(`${dev.name} has no IP address.`, 'bad');
        return;
      }
      runPing(pduFrom, ip);
      set({ pduFrom: null });
      return;
    }
    set({ selected: dev.id, selectedLink: null });
    const w = toWorld(e.clientX, e.clientY);
    drag.current = { id: dev.id, ox: w.x - dev.x, oy: w.y - dev.y, moved: false, snap: project, sx: e.clientX, sy: e.clientY };
  };

  const pickPort = (devId: string, iface: string | null) => {
    const d = byId.get(devId)!;
    const peer = cableFrom ? byId.get(cableFrom.dev) : undefined;
    const name = iface ?? autoPort(project, d, peer)?.name;
    setPop(null);
    if (!name) return useStore.getState().toast(`${d.name} has no free ports.`, 'bad');
    if (!cableFrom) {
      set({ cableFrom: { dev: devId, iface: name } });
      return;
    }
    connect(cableFrom, { dev: devId, iface: name });
    set({ cableFrom: null });
  };

  const onDrop = (e: React.DragEvent) => {
    const model = e.dataTransfer.getData('text/nf-model');
    if (!model) return;
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    addDevice(model, w.x, w.y);
  };

  const contextMenu = (e: React.MouseEvent, target: { dev?: string; link?: string }) => {
    e.preventDefault();
    e.stopPropagation();
    const r = wrap.current!.getBoundingClientRect();
    if (target.dev) set({ selected: target.dev, selectedLink: null });
    if (target.link) set({ selectedLink: target.link, selected: null });
    setPop({ kind: 'menu', ...target, sx: e.clientX - r.left, sy: e.clientY - r.top });
  };

  /* ---------------- render helpers ---------------- */

  const allLinks = [...project.links.map((l) => ({ l, wifi: false })), ...topo.wireless.map((l) => ({ l, wifi: true }))];
  const activeLinks = new Set(packet?.links ?? []);

  const statusColor = (d: Device, ifaceName: string) => {
    const i = d.ifaces.find((x) => x.name === ifaceName);
    if (!i) return 'var(--text-3)';
    const s = ifaceStatus(project, topo, d, i);
    if (!d.powered) return 'var(--bad)';
    if (i.shutdown) return 'var(--bad)';
    return s.line ? 'var(--good)' : 'var(--bad)';
  };

  const subtitle = (d: Device) => {
    if (d.home) return d.home.lanIp;
    const ip = primaryIp(d);
    return ip ?? '';
  };

  const hint = (() => {
    if (placing) return <>Click to place · <b>Shift</b> to place several · <span className="kbd">Esc</span> to cancel</>;
    if (tool === 'cable')
      return cableFrom ? (
        <>
          From <b>{byId.get(cableFrom.dev)?.name} {cableFrom.iface}</b> — click the device to connect to
        </>
      ) : (
        <>Click a device to start a cable</>
      );
    if (tool === 'pdu')
      return pduFrom ? (
        <>
          Ping from <b>{byId.get(pduFrom)?.name}</b> — click the destination
        </>
      ) : (
        <>Click the device that sends the ping</>
      );
    if (tool === 'note') return <>Click anywhere to drop a note</>;
    return null;
  })();

  const cableDev = cableFrom ? byId.get(cableFrom.dev) : undefined;

  return (
    <div
      ref={wrap}
      className={`canvas-wrap tool-${tool} ${panning ? 'panning' : ''} ${placing ? 'placing' : ''}`}
      onWheel={onWheel}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => setCursor(null)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg className="stage" onPointerDown={onBgDown}>
        <defs>
          <pattern id="grid" width={24 * view.k} height={24 * view.k} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={1} cy={1} r={1} fill="var(--grid)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* notes */}
          {project.notes.map((n) => (
            <foreignObject
              key={n.id}
              x={n.x}
              y={n.y}
              width={180}
              height={90}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).isContentEditable && document.activeElement === e.target) return;
                e.stopPropagation();
                set({ selected: n.id, selectedLink: null });
                const w = toWorld(e.clientX, e.clientY);
                drag.current = { id: n.id, ox: w.x - n.x, oy: w.y - n.y, moved: false, snap: project, sx: e.clientX, sy: e.clientY };
              }}
            >
              <div
                className="note-box"
                contentEditable
                suppressContentEditableWarning
                style={{ outline: selected === n.id ? '2px solid var(--accent)' : undefined }}
                onBlur={(e) => {
                  const text = e.currentTarget.innerText;
                  mutate((p) => {
                    const x = p.notes.find((q) => q.id === n.id);
                    if (x) x.text = text;
                  });
                }}
              >
                {n.text}
              </div>
            </foreignObject>
          ))}

          {/* links */}
          {allLinks.map(({ l, wifi }) => {
            const a = byId.get(l.a.dev);
            const b = byId.get(l.b.dev);
            if (!a || !b) return null;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const off = 38;
            const lab = 62;
            const sel = selectedLink === l.id;
            const showLabels = !wifi && (showPorts || sel || hoverLink === l.id || selected === a.id || selected === b.id);
            return (
              <g
                key={l.id}
                className={`link ${wifi ? 'wifi' : l.cable} ${sel ? 'sel' : ''} ${activeLinks.has(l.id) ? 'active' : ''}`}
                onPointerEnter={() => setHoverLink(l.id)}
                onPointerLeave={() => setHoverLink(null)}
              >
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="wire" />
                {!wifi && (
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className="hit"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setPop(null);
                      set({ selectedLink: l.id, selected: null });
                    }}
                    onContextMenu={(e) => contextMenu(e, { link: l.id })}
                  />
                )}
                {!wifi && len > 2 * off + 10 && (
                  <>
                    <circle className="port-dot" cx={a.x + ux * off} cy={a.y + uy * off} r={4.5} fill={statusColor(a, l.a.iface)} />
                    <circle className="port-dot" cx={b.x - ux * off} cy={b.y - uy * off} r={4.5} fill={statusColor(b, l.b.iface)} />
                  </>
                )}
                {showLabels && (
                  <>
                    <text className="port-label" x={a.x + ux * lab - uy * 10} y={a.y + uy * lab + ux * 10} textAnchor="middle">
                      {short(l.a.iface)}
                    </text>
                    <text className="port-label" x={b.x - ux * lab - uy * 10} y={b.y - uy * lab + ux * 10} textAnchor="middle">
                      {short(l.b.iface)}
                    </text>
                  </>
                )}
              </g>
            );
          })}

          {/* rubber band while cabling */}
          {cableDev && cursor && (
            <line x1={cableDev.x} y1={cableDev.y} x2={cursor.x} y2={cursor.y} stroke="var(--accent-2)" strokeWidth={2} strokeDasharray="6 5" pointerEvents="none" />
          )}

          {/* devices */}
          {project.devices.map((d) => (
            <g
              key={d.id}
              className={`node k-${d.kind} ${selected === d.id ? 'sel' : ''} ${d.powered ? '' : 'off'} ${cableFrom?.dev === d.id || pduFrom === d.id ? 'cable-src' : ''}`}
              transform={`translate(${d.x},${d.y})`}
              onPointerDown={(e) => onNodeDown(e, d)}
              onDoubleClick={() => set({ selected: d.id, inspectorTab: d.ios || ['pc', 'laptop', 'server', 'printer', 'tablet', 'phone'].includes(d.kind) ? 'cli' : 'config' })}
              onContextMenu={(e) => contextMenu(e, { dev: d.id })}
            >
              <rect className="tile" x={-TILE / 2} y={-TILE / 2} width={TILE} height={TILE} rx={15} />
              <rect x={-TILE / 2 + 7} y={-TILE / 2 + 7} width={TILE - 14} height={TILE - 14} rx={11} fill="color-mix(in srgb, var(--tint) 15%, transparent)" />
              <g transform="translate(-14,-14)" style={{ color: 'var(--tint)' }}>
                <DeviceGlyph kind={d.kind} size={28} />
              </g>
              {!d.powered && <circle cx={TILE / 2 - 6} cy={-TILE / 2 + 6} r={5} fill="var(--bad)" stroke="var(--canvas)" strokeWidth={2} />}
              <rect
                className="label-bg"
                x={-Math.max(d.name.length * 3.6, subtitle(d).length * 3.3) - 6}
                y={TILE / 2 + 4}
                width={Math.max(d.name.length * 7.2, subtitle(d).length * 6.6) + 12}
                height={subtitle(d) ? 32 : 18}
                rx={6}
              />
              <text className="label" y={TILE / 2 + 17}>
                {d.name}
              </text>
              <text className="sub" y={TILE / 2 + 31}>
                {subtitle(d)}
              </text>
            </g>
          ))}

          {/* placement ghost */}
          {placing && cursor && (
            <rect x={cursor.x - TILE / 2} y={cursor.y - TILE / 2} width={TILE} height={TILE} rx={15} fill="var(--accent-soft)" stroke="var(--accent)" strokeDasharray="5 4" pointerEvents="none" />
          )}

          {/* packet */}
          {packet && (
            <g className="packet" transform={`translate(${packet.x},${packet.y})`} pointerEvents="none" style={{ color: packet.fail ? 'var(--bad)' : packet.reply ? 'var(--good)' : 'var(--accent)' }}>
              <circle r={13} fill="currentColor" opacity={0.18} />
              <rect x={-9} y={-6.5} width={18} height={13} rx={2.5} fill="currentColor" />
              <path d="M-8 -5 0 1 8 -5" stroke="#fff" strokeWidth={1.5} fill="none" />
              {packet.fail && <path d="M-5 9l10 10M5 9l-10 10" stroke="var(--bad)" strokeWidth={2.4} />}
            </g>
          )}
        </g>
      </svg>

      {!project.devices.length && !placing && (
        <div className="empty">
          <div className="card">
            <I.logo size={44} />
            <h2>Build a network</h2>
            <p>Drag devices in from the library, or open an existing Packet Tracer lab (.pkt). Your file is converted on the fly.</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => window.dispatchEvent(new CustomEvent('nf:open'))}>
                <I.open size={16} /> Open .pkt
              </button>
              <button className="btn outline" onClick={() => window.dispatchEvent(new CustomEvent('nf:sample'))}>
                Try a sample network
              </button>
            </div>
          </div>
        </div>
      )}

      {hint && <div className="hint">{hint}</div>}

      <div className="canvas-hud">
        <button className="btn icon" title="Zoom out" onClick={() => set({ view: { ...view, k: Math.max(0.25, view.k / 1.2) } })}>
          −
        </button>
        <div className="zoom">{Math.round(view.k * 100)}%</div>
        <button className="btn icon" title="Zoom in" onClick={() => set({ view: { ...view, k: Math.min(3, view.k * 1.2) } })}>
          +
        </button>
        <button
          className="btn icon"
          title="Fit to screen (F)"
          onClick={() => {
            const r = wrap.current!.getBoundingClientRect();
            fitView(r.width, r.height);
          }}
        >
          <I.fit size={16} />
        </button>
        <button className={`btn icon ${showPorts ? 'active' : ''}`} title="Show port labels (L)" onClick={() => set({ showPorts: !showPorts })}>
          <I.tag size={16} />
        </button>
      </div>

      {pop?.kind === 'ports' && (
        <PortPicker
          dev={byId.get(pop.dev)!}
          x={pop.sx}
          y={pop.sy}
          onPick={(n) => pickPort(pop.dev, n)}
          used={(n) => portUsed(project, pop.dev, n)}
          status={(n) => statusColor(byId.get(pop.dev)!, n)}
        />
      )}
      {pop?.kind === 'menu' && (
        <div className="popover" style={{ left: pop.sx, top: pop.sy, minWidth: 190 }} onPointerDown={(e) => e.stopPropagation()}>
          {pop.dev && (
            <>
              <button className="menu-item" onClick={() => (set({ inspectorTab: 'cli' }), setPop(null))}>
                <I.terminal size={15} /> Open terminal
              </button>
              <button className="menu-item" onClick={() => (set({ inspectorTab: 'config' }), setPop(null))}>
                <I.tag size={15} /> Configure
              </button>
              {canPing(byId.get(pop.dev)!) && (
                <button className="menu-item" onClick={() => (set({ tool: 'pdu', pduFrom: pop.dev! }), setPop(null))}>
                  <I.envelope size={15} /> Ping from here…
                </button>
              )}
              <button
                className="menu-item"
                onClick={() => {
                  mutate((p) => {
                    const d = p.devices.find((x) => x.id === pop.dev);
                    if (d) d.powered = !d.powered;
                  });
                  setPop(null);
                }}
              >
                <I.power size={15} /> {byId.get(pop.dev)?.powered ? 'Power off' : 'Power on'}
              </button>
              <button className="menu-item" onClick={() => (duplicate(pop.dev!), setPop(null))}>
                <I.copy size={15} /> Duplicate <span className="r">Ctrl D</span>
              </button>
            </>
          )}
          <button className="menu-item danger" onClick={() => (deleteSelection(), setPop(null))}>
            <I.trash size={15} /> Delete {pop.link ? 'cable' : ''} <span className="r">Del</span>
          </button>
        </div>
      )}
    </div>
  );
}

const portKind = (name: string, speed: number) =>
  /^Gigabit/.test(name) ? 'Gigabit' : /^FastEthernet/.test(name) ? 'Fast Eth' : /^Serial/.test(name) ? 'Serial' : speed >= 1000 ? 'Gigabit' : 'Ethernet';

const short = (n: string) =>
  n
    .replace('GigabitEthernet ', 'Gi')
    .replace('GigabitEthernet', 'Gi')
    .replace('FastEthernet', 'Fa')
    .replace('Ethernet ', 'Eth')
    .replace('Serial', 'Se');

function PortPicker({
  dev,
  x,
  y,
  onPick,
  used,
  status,
}: {
  dev: Device;
  x: number;
  y: number;
  onPick: (n: string | null) => void;
  used: (n: string) => boolean;
  status: (n: string) => string;
}) {
  const ports = cablePorts(dev);
  return (
    <div className="popover" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="ph">
        <span>{dev.name}</span>
        <span>{ports.filter((p) => !used(p.name)).length} free</span>
      </div>
      <button className="menu-item" onClick={() => onPick(null)}>
        <I.check size={15} /> Auto-select port
      </button>
      {ports.map((p) => (
        <button key={p.name} className="menu-item" disabled={used(p.name)} onClick={() => onPick(p.name)}>
          <span className="dot" style={{ background: used(p.name) ? status(p.name) : 'var(--border-strong)' }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{p.name}</span>
          <span className="r">{used(p.name) ? 'in use' : portKind(p.name, p.speed)}</span>
        </button>
      ))}
      {!ports.length && <div className="ph">No cable ports — this device is wireless only.</div>}
    </div>
  );
}
