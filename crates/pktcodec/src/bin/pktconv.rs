//! pktconv: convert between Packet Tracer .pkt/.pka and XML.
//!   pktconv decode lab.pkt lab.xml
//!   pktconv encode lab.xml lab.pkt
fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 4 || !(a[1] == "decode" || a[1] == "encode") {
        eprintln!("usage: pktconv <decode|encode> <input> <output>");
        std::process::exit(2);
    }
    let input = std::fs::read(&a[2]).unwrap_or_else(|e| {
        eprintln!("{}: {e}", a[2]);
        std::process::exit(1)
    });
    let out = if a[1] == "decode" {
        pktcodec::decode(&input).unwrap_or_else(|e| {
            eprintln!("{e}");
            std::process::exit(1)
        })
    } else {
        pktcodec::encode(&input)
    };
    std::fs::write(&a[3], out).expect("write output");
}
