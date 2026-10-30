import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { Device } from '../model/types';
import { complete, exec, newSession, prompt, type Session } from '../engine/ios';
import { HOST_CMDS, hostExec, hostPrompt } from '../engine/hostcli';

interface Buf {
  lines: { t: string; c?: 'cmd' | 'sys' | 'err' }[];
  session: Session;
  hist: string[];
}

const buffers = new Map<string, Buf>();

function bufFor(d: Device): Buf {
  let b = buffers.get(d.id);
  if (!b) {
    b = { lines: [], session: newSession(), hist: [] };
    if (d.ios)
      b.lines.push({
        t: `${d.model} emulated by NetForge\nIOS-style CLI · abbreviations (conf t, int g0/0, sh ip int br), Tab completion and ? help work\n\nPress RETURN to get started!\n\n`,
        c: 'sys',
      });
    else b.lines.push({ t: `Command Prompt — ${d.name}\nType help for a list of commands.\n\n`, c: 'sys' });
    buffers.set(d.id, b);
  }
  return b;
}

export const QUICK_IOS = ['enable', 'configure terminal', 'show ip interface brief', 'show running-config', 'show ip route', 'end'];
export const QUICK_HOST = ['ipconfig', 'ipconfig /all', 'ipconfig /renew', 'ping '];

export function Terminal({ dev }: { dev: Device }) {
  const mutate = useStore((s) => s.mutate);
  const [, force] = useState(0);
  const [input, setInput] = useState('');
  const [hi, setHi] = useState<number | null>(null);
  const out = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const b = bufFor(dev);
  const ios = !!dev.ios;
  const pr = ios ? prompt(dev, b.session) : hostPrompt();

  useEffect(() => {
    out.current?.scrollTo({ top: out.current.scrollHeight });
  });
  useEffect(() => {
    inp.current?.focus();
    setInput('');
    setHi(null);
  }, [dev.id]);

  const run = (line: string) => {
    b.lines.push({ t: pr + line + '\n', c: 'cmd' });
    if (line.trim()) b.hist.push(line);
    let res = '';
    mutate((p) => {
      const d = p.devices.find((x) => x.id === dev.id);
      if (!d) return;
      res = ios ? exec(p, d, b.session, line) : hostExec(p, d, line);
    });
    if (res === '\f') b.lines = [];
    else if (res) b.lines.push({ t: res, c: res.includes('% Invalid') || res.includes('% Incomplete') || res.includes('% Ambiguous') ? 'err' : undefined });
    if (b.lines.length > 600) b.lines = b.lines.slice(-400);
    setInput('');
    setHi(null);
    force((n) => n + 1);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') run(input);
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const n = hi === null ? b.hist.length - 1 : Math.max(0, hi - 1);
      if (b.hist[n] !== undefined) {
        setHi(n);
        setInput(b.hist[n]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hi === null) return;
      const n = hi + 1;
      if (n >= b.hist.length) {
        setHi(null);
        setInput('');
      } else {
        setHi(n);
        setInput(b.hist[n]);
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (ios) setInput(complete(b.session, input));
      else {
        const hits = HOST_CMDS.filter((c) => c.startsWith(input.toLowerCase()));
        if (hits.length === 1) setInput(hits[0] + ' ');
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      b.lines = [];
      force((n) => n + 1);
    } else if (e.key === 'z' && e.ctrlKey && ios) {
      e.preventDefault();
      run('end');
    } else if (e.key === '?' && ios) {
      e.preventDefault();
      run(input + '?');
    }
  };

  return (
    <div className="term" onClick={() => window.getSelection()?.toString() || inp.current?.focus()}>
      <div className="term-out" ref={out}>
        {b.lines.map((l, i) => (
          <span key={i} className={l.c}>
            {l.t}
          </span>
        ))}
      </div>
      <div className="term-line">
        <span>{pr}</span>
        <input
          ref={inp}
          value={input}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          aria-label="Terminal input"
        />
      </div>
      <div className="term-bar">
        {(ios ? QUICK_IOS : QUICK_HOST).map((c) => (
          <button
            key={c}
            onClick={(e) => {
              e.stopPropagation();
              if (c.endsWith(' ')) {
                setInput(c);
                inp.current?.focus();
              } else run(c);
            }}
          >
            {c.trim()}
          </button>
        ))}
      </div>
    </div>
  );
}
