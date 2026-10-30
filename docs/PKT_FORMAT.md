# Packet Tracer file format (`.pkt` / `.pka`)

Notes from implementing `crates/pktcodec`, based on the public research in
[pka2xml](https://github.com/mircodz/pka2xml) and verified against real Packet Tracer 8.2 files.

## Container (Packet Tracer 5.0+)

Decoding a file of length `L`:

1. **Reverse + XOR**: `b[i] = a[L - 1 - i] ^ (L - i·L) mod 256`
2. **Twofish-128 in EAX mode**: key `0x89 × 16`, nonce `0x10 × 16`, no associated data.
   The last 16 bytes are the EAX tag, so a correct decode is authenticated.
3. **XOR**: `c[i] = b[i] ^ (N - i) mod 256`, where `N` is the plaintext length
4. **qCompress**: 4-byte big-endian uncompressed length, then a zlib stream of XML

Encoding runs the same steps backwards. Files from before 5.0 skip steps 1–2.

Rust's `eax` crate only accepts the cipher's default key size (256-bit for Twofish), so the codec
implements EAX (CTR + OMAC/CMAC) directly on top of `twofish` with a 128-bit key.

Some files carry raw binary inside attributes (for example `ACTIVITY/@VALUE`), which is neither
valid UTF-8 nor valid XML. `decode_to_string` maps every such byte to U+F700 + byte (and back in
`encode_str`), so the text is always parseable and round-trips byte-for-byte.

## Activities (`.pka`)

The root is `PACKETTRACER5_ACTIVITY` holding three `PACKETTRACER5` networks. The **last** is the
student's working network; the first two are the answer and initial networks. Also present:

- `ACTIVITY/INSTRUCTIONS/PAGE*`: instruction pages as HTML (often Word-exported, Windows-1252)
- `COMPARISONS`: a tree of `NODE` elements (`NAME` with `checkType`, `nodeValue`, `variableName`;
  `POINTS`). `checkType="2"` marks a graded item; `nodeValue` is the expected value unless
  `variableName` is set, in which case it's computed from `VARIABLE_MANAGER`.
- `OVERALL_COMPLETE_FEEDBACK` / `OVERALL_INCOMPLETE_FEEDBACK`: feedback HTML

## XML layout (the parts NetForge uses)

```
PACKETTRACER5
├─ VERSION                         8.2.1.0118
└─ NETWORK
   ├─ DEVICES / DEVICE*
   │  ├─ ENGINE
   │  │  ├─ TYPE @model            Router (1941), Switch, Pc, Laptop, Server, TabletPC,
   │  │  │                          WirelessRouterNewGeneration (HomeRouter-PT-AC) …
   │  │  ├─ NAME, POWER, SAVE_REF_ID  "save-ref-id:<u64>" — stable device id
   │  │  ├─ MODULE / SLOT* / MODULE* / PORT*
   │  │  │     PORT: TYPE (eCopperFastEthernet, eCopperGigabitEthernet, eHostWirelessN …),
   │  │  │           MACADDRESS, IP, SUBNET, POWER, PORT_DHCP_ENABLE, BANDWIDTH (kbps)
   │  │  ├─ GATEWAY, DNS_CLIENT/SERVER_IP            hosts
   │  │  ├─ WIRELESS_CLIENT/WIRELESS_COMMON/SSID     Wi-Fi clients
   │  │  ├─ RUNNINGCONFIG / LINE*, STARTUPCONFIG / LINE*   IOS devices, one LINE per config line
   │  │  │     (a multi-line `banner motd` is one LINE; its ^C delimiters are 0x03 bytes)
   │  │  ├─ FILE_MANAGER/…/FILE[NAME=vlan.dat]/FILE_CONTENT[@class=CVlanDatFileContent]
   │  │  │     VLAN_COUNT, VLANS / VLAN @number @name @rspan     switch VLAN database
   │  │  └─ LAN_IP_ADDRESS, LAN_SUBNET_MASK, START_IP, MAX_USERS,
   │  │     INTERNET_CONNECTION_TYPE, INTERNET_IP_ADDRESS, DHCP_SERVER/ENABLED,
   │  │     WIRELESS_SERVERS/…/SSID                   home routers
   │  └─ WORKSPACE / LOGICAL / X, Y   canvas position
   └─ LINKS / LINK*
      └─ CABLE: FROM, PORT, TO, PORT, TYPE (eStraightThrough, eCrossOver, eFiber …)
             FROM/TO are a device index (older files) or a save-ref-id
```

### Interface names

Names aren't stored on ports. Packet Tracer derives them:

- **IOS devices**: the order of `interface …` lines in the running-config matches the physical
  port order. NetForge uses that first, then falls back to type + slot path.
- **Hosts**: `FastEthernet0`, `GigabitEthernet0`, `Wireless0`, counting per type.
- **Home routers**: `Internet`, `Ethernet 1`–`Ethernet 4`, `Wireless`.

### Quirks

- Unassociated Wi-Fi radios are saved with `POWER=false`. Association really depends on SSID,
  so NetForge treats the radio as on and matches SSIDs.
- Physical-view-only devices such as *Power Distribution Device* are skipped on import and left
  untouched on export.

## Passwords in configs

Packet Tracer writes `enable secret` and `username … secret` as MD5-crypt (`$1$`) with the fixed salt
`mERr`, so a given secret always produces the same line (`cisco` → `$1$mERr$hx5rVt7rPNoS4wqbXKX7m0`).
With `service password-encryption`, line and user passwords use the standard reversible type 7 encoding
(`cisco` → `0822455D0A16`). NetForge produces the same values, so configs typed in NetForge match
the ones Packet Tracer saves and grades.

## Compatibility

`pktcodec` and the importer were run over all 299 sample networks bundled with Packet Tracer 9.0.1
(versions 5.2 to 9.0.1) and the 88 device templates: every file decodes, imports, exports and
re-imports with the same devices and cables.
