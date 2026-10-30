//! pktconv: convert between Packet Tracer .pkt/.pka and XML.
//!   pktconv decode lab.pkt lab.xml
//!   pktconv encode lab.xml lab.pkt
//!   pktconv text   lab.pka lab.xml   (XML-safe: raw bytes mapped to U+F700+n, as NetForge sees it)
fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 4 || !["decode", "encode", "text"].contains(&a[1].as_str()) {
        eprintln!("usage: pktconv <decode|encode|text> <input> <output>");
        std::process::exit(2);
    }
    let input = std::fs::read(&a[2]).unwrap_or_else(|e| {
        eprintln!("{}: {e}", a[2]);
        std::process::exit(1)
    });
    let out = if a[1] == "text" {
        pktcodec::decode_to_string(&input)
            .unwrap_or_else(|e| {
                eprintln!("{e}");
                std::process::exit(1)
            })
            .into_bytes()
    } else if a[1] == "decode" {
        pktcodec::decode(&input).unwrap_or_else(|e| {
            eprintln!("{e}");
            std::process::exit(1)
        })
    } else {
        // accepts both raw XML and XML-safe text
        match std::str::from_utf8(&input) {
            Ok(t) => pktcodec::encode_str(t),
            Err(_) => pktcodec::encode(&input),
        }
    };
    std::fs::write(&a[3], out).expect("write output");
}
