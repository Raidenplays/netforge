import { useEffect, useState } from 'react';
import { useStore, type Flight } from '../store';
import { finishPdu, runPing } from '../actions';
import type { PduLayers, SimEvent } from '../engine/network';
import { I } from './Icons';

const KINDS = ['ICMP', 'ARP', 'NAT', 'DHCP'] as const;

/** Simulation mode: event list, packet inspector and the scenario's PDU list. */
export function SimPanel() {
  const flight = useStore((s) => s.flight);
  const hide = useStore((s) => s.simHide);
  const set = useStore((s) => s.set);
  const finished = !!flight && flight.step >= flight.hops.length;
  const [side, setSide] = useState<'packet' | 'list'>('packet');

  useEffect(() => {
    if (flight && finished) finishPdu(flight.pdu, flight.ok);
  }, [flight?.id, finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const curEv = flight ? (flight.hops[flight.step]?.ev ?? Infinity) : -1;
  // events up to the current hop have happened; the inspector follows the last one unless one is picked
  const lastSeen = flight ? Math.min(flight.events.length - 1, finished ? flight.events.length - 1 : curEv) : -1;
  const sel = flight?.sel ?? lastSeen;
  const ev = flight?.events[sel];

  return (
    <div className="sim">
      <div className="sim-events">
        {flight ? (
          <table className="events">
            <thead>
              <tr>
                <th style={{ width: 30 }}>Vis</th>
                <th style={{ width: 74 }}>Time (s)</th>
                <th style={{ width: 130 }}>Last device</th>
                <th style={{ width: 130 }}>At device</th>
                <th style={{ width: 60 }}>Type</th>
                <th>Info</th>
              </tr>
            </thead>
            <tbody>
              {flight.events.map((e, i) =>
                hide.includes(e.kind) ? null : (
                  <tr
                    key={i}
                    className={`click ${i === sel ? 'picked' : ''} ${i === curEv ? 'now' : i > curEv && !finished ? 'future' : ''}`}
                    ref={i === curEv ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                    onClick={() => (set({ flight: { ...flight, sel: i } }), setSide('packet'))}
                  >
                    <td>{i === curEv && !finished ? <I.eye size={13} /> : null}</td>
                    <td className="mono">{(e.time ?? 0).toFixed(3)}</td>
                    <td>{e.to ? e.at : '--'}</td>
                    <td>{e.to ?? e.at}</td>
                    <td>
                      <span className={`proto ${e.kind}`}>{e.kind}</span>
                    </td>
                    <td className="mono" style={{ color: e.ok ? undefined : 'var(--bad)' }}>
                      {e.info}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        ) : (
          <div className="blank">
            Pick the <b>Ping</b> tool (P), click a source then a destination. Every step waits here so you can play it, step through it and open each packet.
          </div>
        )}
      </div>
      <div className="sim-side">
        {ev && side === 'packet' ? <Inspector ev={ev} flight={flight!} index={sel} onList={() => setSide('list')} /> : <PduList onBack={ev ? () => setSide('packet') : undefined} />}
      </div>
    </div>
  );
}

/** controls shown in the bottom panel header while simulating */
export function SimControls() {
  const flight = useStore((s) => s.flight);
  const speed = useStore((s) => s.speed);
  const hide = useStore((s) => s.simHide);
  const set = useStore((s) => s.set);
  const finished = !!flight && flight.step >= flight.hops.length;
  const go = (f: Partial<Flight>) => flight && set({ flight: { ...flight, sel: null, ...f } });
  return (
    <>
      <button className="btn icon sm" title="Reset" disabled={!flight} onClick={() => go({ step: 0, playing: false })}>
        <I.reset size={15} />
      </button>
      <button className="btn icon sm" title="Back" disabled={!flight || flight.step === 0} onClick={() => go({ step: Math.max(0, flight!.step - 1), playing: false })}>
        <I.back size={15} />
      </button>
      <button className="btn icon sm" title={flight?.playing ? 'Pause' : 'Play'} disabled={!flight || finished} onClick={() => go({ playing: !flight!.playing })}>
        {flight?.playing ? <I.pause size={15} /> : <I.play size={15} />}
      </button>
      <button
        className="btn icon sm"
        title="Step forward"
        disabled={!flight || finished}
        onClick={() => go({ step: Math.min(flight!.hops.length, flight!.step + 1), playing: false })}
      >
        <I.step size={15} />
      </button>
      <div className="speed">
        Speed
        <input type="range" min={0.25} max={3} step={0.25} value={speed} onChange={(e) => set({ speed: +e.target.value })} />
      </div>
      {flight && (
        <span className={`pill ${finished ? (flight.ok ? 'good' : 'bad') : ''}`}>
          {finished ? (flight.ok ? 'Successful' : 'Failed') : `Hop ${Math.min(flight.step + 1, flight.hops.length)} / ${flight.hops.length}`}
        </span>
      )}
      <span className="filters" title="Show or hide event types">
        {KINDS.map((k) => (
          <button
            key={k}
            className={`proto ${k} ${hide.includes(k) ? 'off' : ''}`}
            onClick={() => set({ simHide: hide.includes(k) ? hide.filter((x) => x !== k) : [...hide, k] })}
          >
            {k}
          </button>
        ))}
      </span>
    </>
  );
}

/* ---------------- packet inspector ---------------- */

const LAYER_NAMES = ['Physical', 'Data link', 'Network', 'Transport', 'Session', 'Presentation', 'Application'];

function Inspector({ ev, flight, index, onList }: { ev: SimEvent; flight: Flight; index: number; onList: () => void }) {
  const set = useStore((s) => s.set);
  const [tab, setTab] = useState<'osi' | 'in' | 'out'>('osi');
  const pick = (i: number) => set({ flight: { ...flight, sel: Math.max(0, Math.min(flight.events.length - 1, i)) } });
  return (
    <div className="pdu">
      <div className="pdu-head">
        <span className={`proto ${ev.kind}`}>{ev.kind}</span>
        <b>At {ev.to ?? ev.at}</b>
        {ev.to && ev.at !== '--' && <span className="dim">from {ev.at}</span>}
        <span className="spacer" />
        <button className="btn icon sm" title="Previous event" onClick={() => pick(index - 1)}>
          ‹
        </button>
        <button className="btn icon sm" title="Next event" onClick={() => pick(index + 1)}>
          ›
        </button>
        <button className="btn sm" onClick={onList} title="Pings in this scenario">
          PDU list
        </button>
      </div>
      <div className="tabs">
        <button className={tab === 'osi' ? 'on' : ''} onClick={() => setTab('osi')}>
          OSI model
        </button>
        <button className={tab === 'in' ? 'on' : ''} onClick={() => setTab('in')} disabled={!ev.in}>
          Inbound PDU
        </button>
        <button className={tab === 'out' ? 'on' : ''} onClick={() => setTab('out')} disabled={!ev.out}>
          Outbound PDU
        </button>
      </div>
      <div className="pdu-body">
        {tab === 'osi' ? <Osi ev={ev} /> : <Details ev={ev} side={tab} />}
      </div>
    </div>
  );
}

function Osi({ ev }: { ev: SimEvent }) {
  const col = (title: string, side?: PduLayers, other?: PduLayers) => (
    <div className="osi-col">
      <div className="osi-title">{title}</div>
      {[6, 5, 4, 3, 2, 1, 0].map((k) => {
        const text = side?.layers[k] ?? '';
        const changed = !!text && !!other?.layers[k] && other.layers[k] !== text;
        return (
          <div key={k} className={`osi-layer ${text ? 'used' : ''} ${changed ? 'changed' : ''}`} title={LAYER_NAMES[k]}>
            <span className="n">L{k + 1}</span>
            <span>{text || LAYER_NAMES[k]}</span>
          </div>
        );
      })}
    </div>
  );
  return (
    <>
      <div className="osi">
        {col('In layers', ev.in, ev.out)}
        {col('Out layers', ev.out, ev.in)}
      </div>
      <ol className="osi-steps">
        {[...(ev.in?.steps ?? []), ...(ev.out?.steps ?? [])].map((s, i) => (
          <li key={i}>{s}</li>
        ))}
        {!ev.in && !ev.out && <li>{ev.info}</li>}
      </ol>
    </>
  );
}

function Details({ ev, side }: { ev: SimEvent; side: 'in' | 'out' }) {
  const f = ev.fields ?? {};
  const L = (side === 'in' ? ev.in : ev.out)?.layers ?? [];
  const mac = L[1]?.match(/([0-9A-F.]{14}) >> ([0-9A-F.]{14})/i);
  const ip = L[2]?.match(/Src\. IP: ([^,\s]+), Dest\. IP: ([^,\s]+)(?:, TTL: (\d+))?/);
  const rows: [string, [string, string][]][] = [];
  if (L[0]) rows.push(['Layer 1', [['Port', L[0].replace(/^Port\(?s?\)?:? ?/, '')]]]);
  if (mac)
    rows.push([
      L[1].startsWith('Dot1q') ? 'Ethernet 802.1Q' : 'Ethernet II',
      [
        ['Destination MAC', mac[2]],
        ['Source MAC', mac[1]],
        ...(L[1].startsWith('Dot1q') && f.vlan ? ([['VLAN', String(f.vlan)]] as [string, string][]) : []),
        ['Type', ev.kind === 'ARP' ? '0x0806 (ARP)' : '0x0800 (IPv4)'],
      ],
    ]);
  if (ev.kind === 'ARP' && f.arp)
    rows.push([
      'ARP',
      [
        ['Hardware type', '1 (Ethernet)'],
        ['Protocol type', '0x0800'],
        ['Opcode', f.arp.op === 'request' ? '1 (request)' : '2 (reply)'],
        ['Sender MAC', f.arp.senderMac],
        ['Sender IP', f.arp.senderIp],
        ['Target MAC', f.arp.op === 'request' ? '0000.0000.0000' : f.arp.targetMac],
        ['Target IP', f.arp.targetIp],
      ],
    ]);
  if (ip)
    rows.push([
      'IPv4',
      [
        ['Version', '4'],
        ['Header length', '20 bytes'],
        ['TTL', ip[3] ?? String(f.ttl ?? '')],
        ['Protocol', '1 (ICMP)'],
        ['Source IP', ip[1]],
        ['Destination IP', ip[2]],
      ],
    ]);
  const icmp = L[2]?.match(/ICMP Message Type: (\d+)/)?.[1];
  if (icmp)
    rows.push([
      'ICMP',
      [
        ['Type', `${icmp} (${icmp === '8' ? 'Echo Request' : 'Echo Reply'})`],
        ['Code', '0'],
        ['Identifier', '0x0001'],
        ['Data', '32 bytes'],
      ],
    ]);
  if (f.nat) rows.push(['NAT', [[f.nat.side === 'source' ? 'Inside local → global' : 'Inside global → local', `${f.nat.from} → ${f.nat.to}`]]]);
  if (!rows.length) return <div className="blank">No {side === 'in' ? 'inbound' : 'outbound'} PDU at this step.</div>;
  return (
    <div className="pdu-fields">
      {rows.map(([title, fields]) => (
        <section key={title}>
          <h5>{title}</h5>
          <dl>
            {fields.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="mono">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/* ---------------- scenario PDU list ---------------- */

function PduList({ onBack }: { onBack?: () => void }) {
  const pdus = useStore((s) => s.pdus);
  return (
    <div className="pdu">
      <div className="pdu-head">
        <b>PDU list</b>
        <span className="dim">{pdus.length} in this scenario</span>
        <span className="spacer" />
        {onBack && (
          <button className="btn sm" onClick={onBack}>
            Packet inspector
          </button>
        )}
      </div>
      {pdus.length ? <PduTable /> : <div className="blank">Pings you send in simulation mode are listed here, so you can fire them again or delete them.</div>}
    </div>
  );
}

function PduTable() {
  const pdus = useStore((s) => s.pdus);
  const flight = useStore((s) => s.flight);
  const set = useStore((s) => s.set);
  return (
    <table className="events pdus">
      <thead>
        <tr>
          <th style={{ width: 34 }}>Fire</th>
          <th>Status</th>
          <th>Source</th>
          <th>Destination</th>
          <th>Type</th>
          <th style={{ width: 28 }}>#</th>
          <th style={{ width: 28 }} />
        </tr>
      </thead>
      <tbody>
        {pdus.map((x) => (
          <tr key={x.id} className={flight?.pdu === x.id ? 'now' : ''}>
            <td>
              <button className="fire" style={{ background: x.color }} title="Fire again" onClick={() => runPing(x.srcId, x.dst)} />
            </td>
            <td className={x.status === 'Failed' ? 'bad' : x.status === 'Successful' ? 'good' : ''}>{x.status}</td>
            <td>{x.srcName}</td>
            <td>{x.dstName}</td>
            <td>
              <span className="proto ICMP">ICMP</span>
            </td>
            <td className="mono">{x.num}</td>
            <td>
              <button
                className="btn icon sm"
                title="Delete"
                onClick={() => set({ pdus: pdus.filter((y) => y.id !== x.id), flight: flight?.pdu === x.id ? null : flight })}
              >
                <I.trash size={13} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
