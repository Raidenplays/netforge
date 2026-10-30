import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { Device } from '../model/types';
import { complete, exec, help, isSecretInput, newSession, openRemote, prompt, startSession, type Session } from '../engine/ios';
import { HOST_CMDS, hostExec, hostPrompt } from '../engine/hostcli';
import { resolve } from '../engine/services';

interface Buf {
  lines: { t: string; c?: 'cmd' | 'sys' | 'err' }[];
  session: Session;
  hist: string[];
  /** Telnet/SSH session opened from a host prompt */
  remote?: { dev: string; session: Session };
}

const buffers = new Map<string, Buf>();

function bufFor(d: Device, key: string, intro?: string): Buf {
  let b = buffers.get(key);
  if (!b) {
    b = { lines: [], session: d.ios ? startSession(d) : newSession(), hist: [] };
    if (intro !== undefined) b.lines.push({ t: intro, c: 'sys' });
    else if (d.ios)
      b.lines.push({
        t: `${d.model} emulated by NetForge\nIOS-style CLI · abbreviations (conf t, int g0/0, sh ip int br), Tab completion and ? help work\n\nPress RETURN to get started!\n\n`,
        c: 'sys',
      });
    else b.lines.push({ t: `Cisco Packet Tracer PC Command Line 1.0 (NetForge)\nType help for a list of commands.\n\n`, c: 'sys' });
    buffers.set(key, b);
  }
  return b;
}

export const QUICK_IOS = ['enable', 'configure terminal', 'show ip interface brief', 'show running-config', 'show ip route', 'end'];
export const QUICK_HOST = ['ipconfig', 'ipconfig /all', 'ipconfig /renew', 'ping '];

const isErr = (res: string) => /^% |\n% /.test(res) && !res.includes('%SYS') && !res.includes('%LINK');

/**
 * A terminal on `dev`: the IOS CLI for routers and switches, the command prompt for hosts.
 * `bufKey` keeps separate scrollback (e.g. a PC's console session to a router); `autorun` runs once.
 */
export function Terminal({ dev, bufKey, intro, autorun, quick = true }: { dev: Device; bufKey?: string; intro?: string; autorun?: string; quick?: boolean }) {
  const mutate = useStore((s) => s.mutate);
  const project = useStore((s) => s.project);
  const [, force] = useState(0);
  const [input, setInput] = useState('');
  const [hi, setHi] = useState<number | null>(null);
  const out = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const key = bufKey ?? dev.id;
  const b = bufFor(dev, key, intro);
  const remoteDev = b.remote ? project.devices.find((d) => d.id === b.remote!.dev) : undefined;
  if (b.remote && !remoteDev) b.remote = undefined;
  // which device and session the next line goes to
  const tDev = remoteDev ?? dev;
  const tSess = b.remote?.session ?? b.session;
  const ios = !!tDev.ios;
  const pr = ios ? prompt(tDev, tSess) : hostPrompt();

  useEffect(() => {
    out.current?.scrollTo({ top: out.current.scrollHeight });
  });
  useEffect(() => {
    inp.current?.focus();
    setInput('');
    setHi(null);
  }, [key]);

  const secret = ios && isSecretInput(tSess);

  const run = (line: string) => {
    // password prompts don't echo what was typed
    b.lines.push({ t: pr + (secret ? '' : line) + '\n', c: 'cmd' });
    if (line.trim() && !secret && !(ios && tSess.pending)) b.hist.push(line);
    let res = '';
    const w = line.trim().split(/\s+/);
    const verb = w[0]?.toLowerCase();
    if (!ios && (verb === 'telnet' || verb === 'ssh')) {
      // open a remote CLI from the host prompt
      let user: string | undefined;
      let target = w[1];
      if (verb === 'ssh') {
        const l = w.indexOf('-l');
        user = l > 0 ? w[l + 1] : undefined;
        target = w.filter((x, k) => k > 0 && x !== '-l' && w[k - 1] !== '-l').pop() ?? '';
        if (!user || !target) res = 'Usage: ssh -l <username> <ip or name>\n';
      } else if (!target) res = 'Usage: telnet <ip or name>\n';
      if (!res) {
        const look = resolve(project, dev, target);
        const ip = look.ok ? look.ip : target;
        const r = openRemote(project, dev, ip, verb, user);
        res = r.out;
        if (r.dev && r.session) b.remote = { dev: r.dev.id, session: r.session };
      }
    } else
      mutate((p) => {
        const d = p.devices.find((x) => x.id === tDev.id);
        if (!d) return;
        res = ios ? exec(p, d, tSess, line) : hostExec(p, d, line);
      });
    if (b.remote?.session.closed) b.remote = undefined;
    if (res === '\f') b.lines = [];
    else if (res) b.lines.push({ t: res, c: isErr(res) ? 'err' : undefined });
    if (b.lines.length > 600) b.lines = b.lines.slice(-400);
    setInput('');
    setHi(null);
    force((n) => n + 1);
  };

  const ran = useRef(false);
  useEffect(() => {
    if (autorun && !ran.current) {
      ran.current = true;
      run(autorun);
    }
  }, [autorun]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (ios) setInput(complete(tSess, input));
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
    } else if (e.key === '?' && ios && !tSess.pending) {
      // IOS help: show what can come next, then give the line back
      e.preventDefault();
      b.lines.push({ t: pr + input + '?\n', c: 'cmd' });
      const res = help(tDev, tSess, input);
      if (res) b.lines.push({ t: res, c: res.includes('% ') ? 'err' : undefined });
      force((n) => n + 1);
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
          type={secret ? 'password' : 'text'}
          value={input}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          aria-label="Terminal input"
        />
      </div>
      {quick && (
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
      )}
    </div>
  );
}
