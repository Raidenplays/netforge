/**
 * A small command grammar for the IOS-style CLI.
 *
 * Commands are written as patterns, e.g. `"ip route A.B.C.D A.B.C.D NEXTHOP"`. Lowercase words
 * are keywords (abbreviations allowed, as in IOS); uppercase words are arguments:
 *
 *   WORD        any single token            LINE      the rest of the line (one token or more)
 *   <a-b>       integer in range            A.B.C.D   IPv4 address
 *   IFACE       interface, e.g. g0/0 or "GigabitEthernet 0/0.10"
 *   IFRANGE     interface list/range (rest of the line), e.g. "f0/1 - 4, g0/1"
 *   NEXTHOP     IPv4 address or interface   V6PREFIX  X:X::X/<0-128>      V6ADDR  X:X::X
 *   VLANLIST    e.g. 10,20,30-40            HEX       hex string
 *
 * The parser gives IOS-style errors (caret position, incomplete, ambiguous), context help for
 * `?` and Tab completion from the same tables.
 */

import { normV6 } from '../model/ip6';

export type ArgKind = 'WORD' | 'LINE' | 'RANGE' | 'IPV4' | 'IFACE' | 'IFRANGE' | 'NEXTHOP' | 'V6PREFIX' | 'V6ADDR' | 'VLANLIST';

export interface CmdSpec<C> {
  pattern: string;
  run: (ctx: C, a: ParsedArgs) => string | void;
  /** don't offer this command in ? help or Tab completion */
  hidden?: boolean;
}

export interface ParsedArgs {
  /** argument values in order */
  v: string[];
  /** canonical keyword path (full words) followed by args, for storing in config */
  canonical: string;
  /** the keywords matched (full words) */
  kw: string[];
}

interface ArgNode<C> {
  kind: ArgKind;
  label: string;
  lo?: number;
  hi?: number;
  next: Node<C>;
}

interface Node<C> {
  /** keyed by lowercase keyword */
  kws: Map<string, Node<C>>;
  /** how each keyword is written (e.g. "dot1Q") */
  disp: Map<string, string>;
  args: ArgNode<C>[];
  end?: CmdSpec<C>;
}

const newNode = <C>(): Node<C> => ({ kws: new Map(), disp: new Map(), args: [] });

export const IF_TYPES = [
  'GigabitEthernet',
  'FastEthernet',
  'TenGigabitEthernet',
  'Ethernet',
  'Serial',
  'Vlan',
  'Loopback',
  'Port-channel',
  'Tunnel',
  'Dialer',
  'Cellular',
];

function argKind(tok: string): Omit<ArgNode<unknown>, 'next'> | null {
  const r = tok.match(/^<(\d+)-(\d+)>$/);
  if (r) return { kind: 'RANGE', label: tok, lo: Number(r[1]), hi: Number(r[2]) };
  switch (tok) {
    case 'WORD':
    case 'LINE':
    case 'IFACE':
    case 'IFRANGE':
    case 'NEXTHOP':
    case 'VLANLIST':
      return { kind: tok, label: tok };
    case 'A.B.C.D':
      return { kind: 'IPV4', label: 'A.B.C.D' };
    case 'V6PREFIX':
      return { kind: 'V6PREFIX', label: 'X:X:X:X::X/<0-128>' };
    case 'V6ADDR':
      return { kind: 'V6ADDR', label: 'X:X:X:X::X' };
  }
  return null;
}

const isIpv4 = (s: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((o) => Number(o) <= 255);
const isV6 = (s: string) => /^[0-9a-fA-F:]+$/.test(s) && s.includes(':') && (s.match(/::/g)?.length ?? 0) <= 1;

/** Does `tok` (and maybe the following token) satisfy the argument? Returns tokens consumed. */
function matchArg(a: Omit<ArgNode<unknown>, 'next'>, toks: string[], k: number): number {
  const t = toks[k];
  switch (a.kind) {
    case 'WORD':
      return 1;
    case 'LINE':
    case 'IFRANGE':
      return toks.length - k;
    case 'RANGE': {
      if (!/^\d+$/.test(t)) return 0;
      const n = Number(t);
      return n >= a.lo! && n <= a.hi! ? 1 : 0;
    }
    case 'IPV4':
      return isIpv4(t) ? 1 : 0;
    case 'NEXTHOP':
      if (isIpv4(t)) return 1;
      return matchIface(toks, k);
    case 'IFACE':
      return matchIface(toks, k);
    case 'V6PREFIX': {
      const [addr, len] = t.split('/');
      return len !== undefined && isV6(addr) && /^\d+$/.test(len) && Number(len) <= 128 ? 1 : 0;
    }
    case 'V6ADDR':
      return isV6(t) ? 1 : 0;
    case 'VLANLIST':
      return /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(t) ? 1 : 0;
  }
}

function ifType(word: string): string | undefined {
  if (!word) return undefined;
  const w = word.toLowerCase();
  return IF_TYPES.find((t) => t.toLowerCase() === w) ?? IF_TYPES.find((t) => t.toLowerCase().startsWith(w));
}

/** "g0/0", "gig 0/0", "GigabitEthernet0/0.10", "vlan 1" → tokens consumed (0 = no match) */
function matchIface(toks: string[], k: number): number {
  const t = toks[k];
  const m = t.match(/^([a-zA-Z-]+)([\d/.:]+)$/);
  if (m && ifType(m[1])) return 1;
  if (/^[a-zA-Z-]+$/.test(t) && ifType(t) && /^[\d/.:]+$/.test(toks[k + 1] ?? '')) return 2;
  return 0;
}

/** Normalise an interface reference to its full name, e.g. "g 0/0" → "GigabitEthernet0/0". */
export function ifaceName(ref: string): string | null {
  const s = ref.replace(/\s+/g, '');
  const m = s.match(/^([a-zA-Z-]+)([\d/.:]+)$/);
  if (!m) return null;
  const t = ifType(m[1]);
  return t ? t + m[2] : null;
}

export class Grammar<C> {
  private roots = new Map<string, Node<C>>();
  private desc: Record<string, string>;

  constructor(desc: Record<string, string>) {
    this.desc = desc;
  }

  add(mode: string, specs: CmdSpec<C>[]) {
    let root = this.roots.get(mode);
    if (!root) this.roots.set(mode, (root = newNode()));
    for (const spec of specs) {
      let n = root;
      for (const tok of spec.pattern.split(' ')) {
        const a = argKind(tok);
        if (a) {
          let an = n.args.find((x) => x.label === a.label && x.kind === a.kind);
          if (!an) n.args.push((an = { ...a, next: newNode() }));
          n = an.next;
        } else {
          const key = tok.toLowerCase();
          let kn = n.kws.get(key);
          if (!kn) {
            n.kws.set(key, (kn = newNode()));
            n.disp.set(key, tok);
          }
          n = kn;
        }
      }
      n.end = spec;
    }
  }

  /** first keywords of a mode (used for falling back from sub-modes to global config) */
  hasFirst(mode: string, word: string) {
    const root = this.roots.get(mode);
    if (!root) return false;
    const w = word.toLowerCase();
    return [...root.kws.keys()].some((k) => k.startsWith(w));
  }

  private kwMatches(n: Node<C>, tok: string, includeHidden = true) {
    const w = tok.toLowerCase();
    const keys = [...n.kws.keys()];
    if (keys.includes(w)) return [w];
    return keys.filter((k) => k.startsWith(w) && (includeHidden || !this.isHidden(n.kws.get(k)!)));
  }

  private isHidden(n: Node<C>): boolean {
    if (n.end && !n.end.hidden) return false;
    for (const c of n.kws.values()) if (!this.isHidden(c)) return false;
    for (const a of n.args) if (!this.isHidden(a.next)) return false;
    return !!n.end || (n.kws.size === 0 && n.args.length === 0);
  }

  parse(
    mode: string,
    toks: string[],
  ):
    | { ok: true; spec: CmdSpec<C>; args: ParsedArgs }
    | { ok: false; err: 'invalid' | 'incomplete' | 'ambiguous'; at: number; node?: Node<C> } {
    let n = this.roots.get(mode);
    if (!n) return { ok: false, err: 'invalid', at: 0 };
    const v: string[] = [];
    const kw: string[] = [];
    const canon: string[] = [];
    let k = 0;
    while (k < toks.length) {
      const hits = this.kwMatches(n, toks[k]);
      if (hits.length === 1) {
        const word = n.disp.get(hits[0]) ?? hits[0];
        kw.push(word);
        canon.push(word);
        n = n.kws.get(hits[0])!;
        k++;
        continue;
      }
      let took = 0;
      let next: Node<C> | undefined;
      for (const a of n.args) {
        took = matchArg(a, toks, k);
        if (took) {
          next = a.next;
          break;
        }
      }
      if (took && next) {
        let val = toks.slice(k, k + took).join(' ');
        const kind = n.args.find((x) => x.next === next)?.kind;
        if (kind === 'V6ADDR') val = normV6(val);
        if (kind === 'V6PREFIX') val = `${normV6(val.split('/')[0])}/${val.split('/')[1]}`;
        v.push(val);
        canon.push(val);
        n = next;
        k += took;
        continue;
      }
      if (hits.length > 1) return { ok: false, err: 'ambiguous', at: k };
      return { ok: false, err: 'invalid', at: k };
    }
    if (!n.end) return { ok: false, err: 'incomplete', at: k, node: n };
    return { ok: true, spec: n.end, args: { v, kw, canonical: canon.join(' ') } };
  }

  /** IOS `?` help. `line` is what was typed before the `?`. */
  help(mode: string, line: string): string | { err: 'invalid' | 'ambiguous'; at: number } {
    const partial = !/\s$/.test(line) && line.length > 0;
    const toks = line.trim() ? line.trim().split(/\s+/) : [];
    const walk = partial ? toks.slice(0, -1) : toks;
    let n = this.roots.get(mode);
    if (!n) return '';
    for (let k = 0; k < walk.length; ) {
      const hits = this.kwMatches(n, walk[k]);
      if (hits.length === 1) {
        n = n.kws.get(hits[0])!;
        k++;
        continue;
      }
      let took = 0;
      let next: Node<C> | undefined;
      for (const a of n.args) {
        took = matchArg(a, walk, k);
        if (took) {
          next = a.next;
          break;
        }
      }
      if (!took || !next) return { err: hits.length > 1 ? 'ambiguous' : 'invalid', at: k };
      if (took > 1 && k + took > walk.length) took = walk.length - k;
      n = next;
      k += took;
    }
    if (partial) {
      const w = toks[toks.length - 1].toLowerCase();
      const words = [...n.kws.keys()].filter((x) => x.startsWith(w) && !this.isHidden(n!.kws.get(x)!)).map((x) => n!.disp.get(x) ?? x).sort();
      return words.length ? words.join('  ') + '\n' : '% Unrecognized command\n';
    }
    const rows: [string, string][] = [];
    for (const k of [...n.kws.keys()].sort()) if (!this.isHidden(n.kws.get(k)!)) rows.push([n.disp.get(k) ?? k, this.desc[n.disp.get(k) ?? k] ?? '']);
    for (const a of n.args) rows.push([a.label, ARG_HELP[a.kind] ?? '']);
    if (n.end && !n.end.hidden) rows.push(['<cr>', '']);
    const w = Math.max(0, ...rows.map((r) => r[0].length)) + 2;
    return rows.map(([k, d]) => `  ${d ? k.padEnd(w) + d : k}`).join('\n') + '\n';
  }

  /** Tab completion of the last word (keywords and interface types). */
  complete(mode: string, line: string): string {
    if (!line || /\s$/.test(line)) return line;
    const toks = line.split(/\s+/);
    const last = toks[toks.length - 1];
    const root = this.roots.get(mode);
    if (!root) return line;
    let n: Node<C> = root;
    for (let k = 0; k < toks.length - 1; ) {
      const hits = this.kwMatches(n, toks[k]);
      if (hits.length === 1) {
        n = n.kws.get(hits[0])!;
        k++;
        continue;
      }
      const a: ArgNode<C> | undefined = n.args.find((x) => matchArg(x, toks, k));
      if (!a) return line;
      k += Math.min(matchArg(a, toks, k), toks.length - 1 - k);
      n = a.next;
    }
    const hits = this.kwMatches(n, last, false);
    let word: string | undefined;
    if (hits.length === 1) word = n.disp.get(hits[0]) ?? hits[0];
    else if (n.args.some((a) => a.kind === 'IFACE' || a.kind === 'IFRANGE' || a.kind === 'NEXTHOP') && /^[a-zA-Z-]+$/.test(last)) word = ifType(last);
    if (!word) return line;
    return line.slice(0, line.length - last.length) + word + (hits.length === 1 ? ' ' : '');
  }
}

const ARG_HELP: Partial<Record<ArgKind, string>> = {
  WORD: 'Name or value',
  LINE: 'Text',
  IPV4: 'IP address or mask',
  IFACE: 'Interface name',
  IFRANGE: 'Interface list',
  NEXTHOP: 'Forwarding IP address or interface',
  V6PREFIX: 'IPv6 prefix',
  V6ADDR: 'IPv6 address',
  VLANLIST: 'VLAN IDs, e.g. 10,20,30-40',
};

/** Render an IOS "% Invalid input" error with the caret under token `at`. */
export function caretError(promptLen: number, line: string, at: number) {
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let i = 0;
  let col = line.length;
  while ((m = re.exec(line))) {
    if (i++ === at) {
      col = m.index;
      break;
    }
  }
  return `${' '.repeat(promptLen + col)}^\n% Invalid input detected at '^' marker.\n`;
}
