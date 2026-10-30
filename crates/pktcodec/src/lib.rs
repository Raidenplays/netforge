//! Reader/writer for Cisco Packet Tracer `.pkt` / `.pka` files.
//!
//! Written for interoperability, from the publicly documented format
//! (see https://github.com/mircodz/pka2xml, BSD-2-Clause). No Cisco code
//! is used. Container layout (PT 5.0+):
//!
//! 1. byte-reverse + XOR obfuscation:   b[i] = a[len-1-i] ^ (len - i*len)
//! 2. Twofish in EAX mode, key = 0x89 x16, nonce = 0x10 x16, 16-byte tag at end
//! 3. XOR obfuscation:                  b[i] = a[i] ^ (len - i)
//! 4. 4-byte big-endian uncompressed size, then a zlib stream of XML
//!
//! Files from PT < 5 skip steps 1–2.

use cipher::{BlockEncrypt, KeyInit, generic_array::GenericArray};
use flate2::{Compression, read::ZlibDecoder, write::ZlibEncoder};
use std::io::{Read, Write};
use twofish::Twofish;

const KEY: [u8; 16] = [137; 16];
const NONCE: [u8; 16] = [16; 16];

#[derive(Debug)]
pub enum PktError {
    Decrypt,
    Decompress(String),
    Utf8,
}

impl std::fmt::Display for PktError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PktError::Decrypt => write!(f, "not a Packet Tracer file, or an unsupported version"),
            PktError::Decompress(e) => write!(f, "corrupt payload: {e}"),
            PktError::Utf8 => write!(f, "payload is not valid UTF-8 XML"),
        }
    }
}
impl std::error::Error for PktError {}

fn xor_tail(buf: &mut [u8]) {
    let n = buf.len();
    for (i, b) in buf.iter_mut().enumerate() {
        *b ^= (n - i) as u8;
    }
}

fn uncompress(data: &[u8]) -> Result<Vec<u8>, PktError> {
    if data.len() < 4 {
        return Err(PktError::Decompress("too short".into()));
    }
    let size = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let mut out = Vec::with_capacity(size);
    ZlibDecoder::new(&data[4..])
        .read_to_end(&mut out)
        .map_err(|e| PktError::Decompress(e.to_string()))?;
    Ok(out)
}

fn compress(data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data).unwrap();
    out.extend(enc.finish().unwrap());
    out
}

// ---- Twofish-128 in EAX mode (CTR + OMAC), per Bellare/Rogaway/Wagner ----

struct Eax {
    tf: Twofish,
    k1: [u8; 16],
    k2: [u8; 16],
}

fn dbl(b: &[u8; 16]) -> [u8; 16] {
    let mut o = [0u8; 16];
    let carry = b[0] >> 7;
    for i in 0..16 {
        o[i] = (b[i] << 1) | if i < 15 { b[i + 1] >> 7 } else { 0 };
    }
    if carry == 1 {
        o[15] ^= 0x87;
    }
    o
}

impl Eax {
    fn new() -> Self {
        let tf = Twofish::new_from_slice(&KEY).expect("128-bit key");
        let mut l = [0u8; 16];
        let mut e = Self { tf, k1: [0; 16], k2: [0; 16] };
        e.enc(&mut l);
        e.k1 = dbl(&l);
        e.k2 = dbl(&e.k1);
        e
    }
    fn enc(&self, b: &mut [u8; 16]) {
        self.tf.encrypt_block(GenericArray::from_mut_slice(b));
    }
    /// OMAC^t(data) = CMAC([0;15] || t || data)
    fn omac(&self, t: u8, data: &[u8]) -> [u8; 16] {
        let mut msg = vec![0u8; 16];
        msg[15] = t;
        msg.extend_from_slice(data);
        let full = msg.len() % 16 == 0;
        let blocks = msg.len().div_ceil(16);
        let mut x = [0u8; 16];
        for bi in 0..blocks {
            let chunk = &msg[bi * 16..((bi + 1) * 16).min(msg.len())];
            let mut blk = [0u8; 16];
            blk[..chunk.len()].copy_from_slice(chunk);
            if bi == blocks - 1 {
                if full {
                    for i in 0..16 { blk[i] ^= self.k1[i]; }
                } else {
                    blk[chunk.len()] = 0x80;
                    for i in 0..16 { blk[i] ^= self.k2[i]; }
                }
            }
            for i in 0..16 { x[i] ^= blk[i]; }
            self.enc(&mut x);
        }
        x
    }
    fn ctr(&self, iv: &[u8; 16], data: &mut [u8]) {
        let mut ctr = u128::from_be_bytes(*iv);
        for chunk in data.chunks_mut(16) {
            let mut ks = ctr.to_be_bytes();
            self.enc(&mut ks);
            for (b, k) in chunk.iter_mut().zip(ks) { *b ^= k; }
            ctr = ctr.wrapping_add(1);
        }
    }
    fn seal(&self, plain: &[u8]) -> Vec<u8> {
        let n = self.omac(0, &NONCE);
        let h = self.omac(1, &[]);
        let mut c = plain.to_vec();
        self.ctr(&n, &mut c);
        let cm = self.omac(2, &c);
        c.extend((0..16).map(|i| n[i] ^ h[i] ^ cm[i]));
        c
    }
    fn open(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        if sealed.len() < 16 { return None; }
        let (c, tag) = sealed.split_at(sealed.len() - 16);
        let n = self.omac(0, &NONCE);
        let h = self.omac(1, &[]);
        let cm = self.omac(2, c);
        let ok = (0..16).fold(0u8, |a, i| a | (tag[i] ^ n[i] ^ h[i] ^ cm[i])) == 0;
        if !ok { return None; }
        let mut p = c.to_vec();
        self.ctr(&n, &mut p);
        Some(p)
    }
}

/// Decode a `.pkt`/`.pka` file into its XML bytes.
pub fn decode(input: &[u8]) -> Result<Vec<u8>, PktError> {
    let n = input.len() as u64;
    let stage1: Vec<u8> = (0..input.len())
        .map(|i| input[input.len() - 1 - i] ^ (n.wrapping_sub((i as u64).wrapping_mul(n)) as u8))
        .collect();

    match Eax::new().open(&stage1) {
        Some(mut plain) => {
            xor_tail(&mut plain);
            uncompress(&plain)
        }
        None => {
            // Pre-5.0 files: XOR + zlib only.
            let mut old = input.to_vec();
            xor_tail(&mut old);
            uncompress(&old).map_err(|_| PktError::Decrypt)
        }
    }
}

/// Decode straight to a UTF-8 string.
pub fn decode_to_string(input: &[u8]) -> Result<String, PktError> {
    String::from_utf8(decode(input)?).map_err(|_| PktError::Utf8)
}

/// Encode XML into a `.pkt` file that Packet Tracer 5.0+ can open.
pub fn encode(xml: &[u8]) -> Vec<u8> {
    let mut stage3 = compress(xml);
    xor_tail(&mut stage3);
    let sealed = Eax::new().seal(&stage3);
    let n = sealed.len() as u64;
    let mut out = vec![0u8; sealed.len()];
    // inverse of stage 1: out[len-1-i] = sealed[i] ^ k(i)
    for i in 0..sealed.len() {
        out[sealed.len() - 1 - i] = sealed[i] ^ (n.wrapping_sub((i as u64).wrapping_mul(n)) as u8);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let xml = b"<PACKETTRACER5><VERSION>8.2.2</VERSION></PACKETTRACER5>";
        let enc = encode(xml);
        assert_eq!(decode(&enc).unwrap(), xml);
    }

    #[test]
    fn sample_file() {
        let path = std::env::var("PKT_SAMPLE").unwrap_or_else(|_| "../../samples/a7.pkt".into());
        if let Ok(bytes) = std::fs::read(&path) {
            let xml = decode_to_string(&bytes).expect("decode sample");
            assert!(xml.contains("PACKETTRACER"));
            // re-encoding must give back the same XML
            assert_eq!(decode(&encode(xml.as_bytes())).unwrap(), xml.as_bytes());
        }
    }
}
