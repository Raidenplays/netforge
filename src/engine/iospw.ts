/**
 * IOS password encodings.
 * - Type 7 (`service password-encryption`): the well-known reversible Vigenère-style scheme.
 * - Type 5 (`enable secret`, `username … secret`): MD5-crypt ($1$). Packet Tracer always uses the
 *   salt "mERr", so the same secret produces the same hash as in a real .pkt file.
 */

const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';
const TYPE7_SEED = 8;

export function type7Encode(plain: string, seed = TYPE7_SEED): string {
  let out = String(seed).padStart(2, '0');
  for (let i = 0; i < plain.length; i++) {
    const x = plain.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length);
    out += x.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function type7Decode(enc: string): string | null {
  if (!/^\d{2}([0-9A-Fa-f]{2})*$/.test(enc)) return null;
  const seed = Number(enc.slice(0, 2));
  let out = '';
  for (let i = 2, k = 0; i < enc.length; i += 2, k++) {
    out += String.fromCharCode(parseInt(enc.slice(i, i + 2), 16) ^ XLAT.charCodeAt((seed + k) % XLAT.length));
  }
  return out;
}

/* ---------------------------- MD5 ---------------------------- */

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => dv.getUint32(off + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return out;
}

/* ------------------------- MD5-crypt ------------------------- */

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const PT_SALT = 'mERr';

export function md5crypt(password: string, salt = PT_SALT): string {
  const pw = enc(password);
  const sl = enc(salt.slice(0, 8));
  const magic = enc('$1$');
  const alt = md5(cat(pw, sl, pw));
  const parts: Uint8Array[] = [pw, magic, sl];
  for (let n = pw.length; n > 0; n -= 16) parts.push(alt.slice(0, Math.min(16, n)));
  for (let n = pw.length; n; n >>= 1) parts.push(n & 1 ? new Uint8Array([0]) : pw.slice(0, 1));
  let fin = md5(cat(...parts));
  for (let i = 0; i < 1000; i++) {
    const p: Uint8Array[] = [];
    p.push(i & 1 ? pw : fin);
    if (i % 3) p.push(sl);
    if (i % 7) p.push(pw);
    p.push(i & 1 ? fin : pw);
    fin = md5(cat(...p));
  }
  let out = '';
  const to64 = (v: number, n: number) => {
    for (; n > 0; n--, v >>= 6) out += ITOA64[v & 0x3f];
  };
  to64((fin[0] << 16) | (fin[6] << 8) | fin[12], 4);
  to64((fin[1] << 16) | (fin[7] << 8) | fin[13], 4);
  to64((fin[2] << 16) | (fin[8] << 8) | fin[14], 4);
  to64((fin[3] << 16) | (fin[9] << 8) | fin[15], 4);
  to64((fin[4] << 16) | (fin[10] << 8) | fin[5], 4);
  to64(fin[11], 2);
  return `$1$${salt}$${out}`;
}

/** Check a typed password against a stored IOS password value ("cisco", "7 0822…", "5 $1$…", "$1$…"). */
export function checkPassword(stored: string | undefined, typed: string): boolean {
  if (stored === undefined) return false;
  let s = stored.trim();
  let type = '0';
  const m = s.match(/^([057]) (\S+)$/);
  if (m) [, type, s] = m;
  if (s.startsWith('$1$')) type = '5';
  if (type === '5') {
    const salt = s.split('$')[2] ?? PT_SALT;
    return md5crypt(typed, salt) === s;
  }
  if (type === '7') return type7Decode(s) === typed;
  return s === typed;
}
