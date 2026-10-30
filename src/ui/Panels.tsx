import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type Tool } from '../store';
import { DeviceGlyph, I } from './Icons';
import { SimControls, SimPanel } from './Sim';
import { TEMPLATES } from '../model/catalog';

/* ---------------- library ---------------- */

export function Library() {
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const set = useStore((s) => s.set);
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const m = new Map<string, typeof TEMPLATES>();
    for (const t of TEMPLATES) {
      if (q && !`${t.label} ${t.blurb} ${t.model}`.toLowerCase().includes(q.toLowerCase())) continue;
      m.set(t.group, [...(m.get(t.group) ?? []), t]);
    }
    return m;
  }, [q]);

  const tools: [Tool, string, keyof typeof I, string][] = [
    ['select', 'Select', 'cursor', 'V'],
    ['cable', 'Cable', 'cable', 'C'],
    ['pdu', 'Ping', 'envelope', 'P'],
    ['note', 'Note', 'note', 'N'],
  ];

  return (
    <aside className="library">
      <div className="tools">
        {tools.map(([k, label, icon, key]) => {
          const Ico = I[icon];
          return (
            <button
              key={k}
              className={`tool ${tool === k ? 'on' : ''}`}
              title={`${label} (${key})`}
              onClick={() => set({ tool: k, cableFrom: null, pduFrom: null, placing: null })}
            >
              <Ico size={18} />
              {label}
            </button>
          );
        })}
      </div>
      <div className="search">
        <I.search size={15} />
        <input placeholder="Search devices" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="lib-scroll">
        {[...groups.entries()].map(([g, list]) => (
          <div key={g}>
            <div className="group-title">{g}</div>
            {list.map((t) => (
              <div
                key={t.model}
                className={`dev-card k-${t.kind} ${placing === t.model ? 'armed' : ''}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/nf-model', t.model);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => set({ placing: placing === t.model ? null : t.model, tool: 'select', cableFrom: null })}
                title="Drag onto the canvas, or click then click the canvas"
              >
                <div className="ico tinted">
                  <DeviceGlyph kind={t.kind} size={20} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="t">{t.label}</div>
                  <div className="b">{t.blurb}</div>
                </div>
              </div>
            ))}
          </div>
        ))}
        {!groups.size && <div className="blank">No devices match “{q}”.</div>}
      </div>
    </aside>
  );
}

/* ---------------- bottom: activity + simulation ---------------- */

export function BottomPanel() {
  const mode = useStore((s) => s.mode);
  const log = useStore((s) => s.log);
  const open = useStore((s) => s.bottomOpen);
  const set = useStore((s) => s.set);
  const body = useRef<HTMLDivElement>(null);
  const sim = mode === 'simulation';

  useEffect(() => {
    if (!sim) body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [log, sim]);


  return (
    <section className={`bottom ${open ? '' : 'collapsed'} ${sim ? 'simulating' : ''}`}>
      <div className="bottom-head">
        <span className="title">{sim ? 'Simulation' : 'Activity'}</span>
        {sim && <SimControls />}
        <span className="spacer" />
        {!sim && log.length > 0 && (
          <button className="btn sm" onClick={() => set({ log: [] })}>
            Clear
          </button>
        )}
        <button className="btn icon sm" title={open ? 'Collapse' : 'Expand'} onClick={() => set({ bottomOpen: !open })}>
          {open ? '▾' : '▴'}
        </button>
      </div>
      {open && (
        <div className="bottom-body" ref={body}>
          {sim ? (
            <SimPanel />
          ) : log.length ? (
            <table className="events">
              <tbody>
                {log.map((l) => (
                  <tr key={l.id}>
                    <td className="mono" style={{ width: 110, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                      {l.time}
                    </td>
                    <td style={{ width: 24 }}>
                      <span className={`dot ${l.ok ? 'up' : 'down'}`} />
                    </td>
                    <td>{l.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="blank">Pings, cabling and DHCP events show up here.</div>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------- command palette ---------------- */

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function Palette({ commands }: { commands: Command[] }) {
  const set = useStore((s) => s.set);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const list = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  const close = () => set({ palette: false });
  return (
    <div className="overlay" onPointerDown={close}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Type a command or device name…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setHl(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') setHl((h) => Math.min(list.length - 1, h + 1));
            if (e.key === 'ArrowUp') setHl((h) => Math.max(0, h - 1));
            if (e.key === 'Enter' && list[hl]) {
              close();
              list[hl].run();
            }
          }}
        />
        <div className="list">
          {list.map((c, i) => (
            <button
              key={c.id}
              className={`menu-item ${i === hl ? 'hl' : ''}`}
              onMouseEnter={() => setHl(i)}
              onClick={() => {
                close();
                c.run();
              }}
            >
              {c.label}
              {c.hint && <span className="r">{c.hint}</span>}
            </button>
          ))}
          {!list.length && <div className="blank">Nothing matches.</div>}
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.tone === 'good' ? <span className="dot up" /> : t.tone === 'bad' ? <span className="dot down" /> : <span className="dot" />}
          {t.text}
        </div>
      ))}
    </div>
  );
}
