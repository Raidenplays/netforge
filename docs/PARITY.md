# Packet Tracer parity checklist

The goal is for NetForge to do everything Cisco Packet Tracer does. This list tracks how far
along that is. ✅ done · 🟡 partly done · ❌ not started.

## Files

| Feature | Status | Notes |
| --- | --- | --- |
| Open `.pkt` / `.pka` (PT 5.0 to 9.0.1) | ✅ | Every sample network bundled with PT 9.0.1 opens |
| Save back to `.pkt` | 🟡 | Edits to existing devices and cables; devices added in NetForge aren't written yet |
| Activities: instructions, Check Results | 🟡 | Many assessment items graded; variable-based items and cable codes not yet |
| Activity timer, locked interfaces, dynamic feedback | ❌ | |
| `.pkz` (bundled files), `.pksz` | ❌ | |

## Workspace

| Feature | Status | Notes |
| --- | --- | --- |
| Logical workspace: place, move, cable, notes | ✅ | |
| Physical workspace (cities, buildings, racks, distance) | ❌ | |
| Clusters, shapes, drawing tools | ❌ | Notes only |
| Device modules (add/remove HWIC, NM cards) and the Physical tab | ❌ | |
| Power on/off | ✅ | |
| Cable types: straight, cross, fiber, serial, console | ✅ | Coaxial, phone and USB cables ❌ |
| Wireless association by SSID and range | 🟡 | No WPA/WPA2 keys yet |

## Realtime and simulation

| Feature | Status | Notes |
| --- | --- | --- |
| Realtime mode | ✅ | |
| Simulation mode: play, pause, step forward and back, speed | ✅ | |
| Event list (time, last device, at device, type) | ✅ | |
| Event filters | ✅ | ICMP, ARP, NAT, DHCP |
| PDU information: OSI model (in/out layers), inbound/outbound PDU details | ✅ | Ethernet, 802.1Q, ARP, IPv4, ICMP, NAT |
| Scenario PDU list: fire again, delete, status | ✅ | |
| Several scenarios, periodic PDUs, complex PDUs | ❌ | |
| Challenge Me quizzes | ❌ | |
| Events for DHCP, DNS, HTTP, STP, CDP, routing protocols | ❌ | |

## End devices (Desktop apps)

| App | Status | Notes |
| --- | --- | --- |
| IP Configuration | ✅ | IPv4, DHCP; IPv6 ❌ |
| Command Prompt | 🟡 | ipconfig, ping (names too), tracert, nslookup, arp, telnet, ssh |
| Terminal (console cable) | ✅ | |
| Telnet / SSH Client | ✅ | Checks VTY transport, login, local users, RSA keys |
| Web Browser | ✅ | HTTP over DNS names, links between pages; HTTPS ❌ |
| PC Wireless | 🟡 | Network list, signal, connect; profiles and security ❌ |
| Email, FTP/TFTP, Text Editor, Firewall, IPv6 Firewall, VPN, PPPoE, Dial-up, Traffic Generator, MIB Browser, Bluetooth, IoT apps, Programming | ❌ | |

## Server services

| Service | Status | Notes |
| --- | --- | --- |
| DHCP | ✅ | |
| HTTP (pages editable) | ✅ | |
| DNS (A, CNAME, NS) | ✅ | |
| HTTPS, TFTP, FTP, Email, AAA, NTP, Syslog, IoT, VM management | ❌ | |

## IOS

| Feature | Status | Notes |
| --- | --- | --- |
| CLI: modes, abbreviations, `?`, Tab, IOS errors | ✅ | |
| Device basics: hostname, secrets, line passwords, encryption, banner, users | ✅ | |
| SSH / Telnet server | ✅ | |
| Startup-config, reload, erase | ✅ | |
| Interfaces, static routes, IPv4 addressing | ✅ | |
| DHCP server, relay, NAT overload | ✅ | Static NAT and NAT pools ❌ |
| VLANs, 802.1Q trunks, router-on-a-stick, SVIs | ✅ | |
| Inter-VLAN routing on multilayer switches (`ip routing`) | 🟡 | |
| IPv6 addressing | 🟡 | Configured and shown, not forwarded |
| RIP, OSPF, EIGRP, BGP | ❌ | Commands are saved but don't run |
| ACLs (standard, extended, named) | ❌ | Saved but not enforced |
| STP / RSTP, EtherChannel, port security, DHCP snooping | ❌ | Saved but not simulated |
| HSRP, PPP, Frame Relay, GRE, IPsec VPN, ZBF, QoS | ❌ | |
| Wireless LAN controllers, Meraki, ASA firewall | ❌ | |

## IoT, industrial and programming

| Feature | Status |
| --- | --- |
| IoT devices, registration server, blockly / Python / JS programming | ❌ |
| Industrial devices (PLC, HMI), OT protocols | ❌ |
| Network controller, REST API | ❌ |
