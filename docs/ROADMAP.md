# Roadmap to Packet Tracer parity

This is the plan for getting NetForge to do everything Cisco Packet Tracer 9 does. Each phase lists
the features, what "done" means and how to check it. [PARITY.md](PARITY.md) is the short status table
and gets updated as items land.

## How the work is done

- **Clean-room.** NetForge's code is written from scratch. Packet Tracer is used only as a behaviour
  reference: its help pages, its bundled sample networks, and what it prints and does. Nothing is
  decompiled, and no Cisco code, text blocks or images go into the repo.
- **Checked against real files.** Packet Tracer 9.0.1 ships 299 sample networks (`saves/`). Every
  feature names the samples that use it. A feature is done when those samples open, run and
  produce the same results as in Packet Tracer (pings, tables, show output). Keep the samples
  outside the repo and point `NETFORGE_CORPUS` at the decoded XML.
- **Tests for every feature.** Unit tests for the engine, plus a lab test that builds the scenario
  from scratch through the CLI.
- **Order follows the CCNA course.** The things a student meets first come first: ITN, then SRWE,
  then ENSA, then everything else.

## Engine changes that several phases need

| Change | Why | Phase |
| --- | --- | --- |
| **Control plane module** that computes each router's routing table (RIB) from the topology and configs, and recomputes when either changes | Dynamic routing, administrative distance, `show ip route` codes | 1 |
| **Packet filter hook** in forwarding (inbound and outbound per interface) | ACLs, ZBF, port security, firewalls on PCs | 1 |
| **IPv6 data plane**: v6 endpoints, ND instead of ARP, v6 routing table | IPv6 ping, SLAAC, DHCPv6, OSPFv3 | 1 |
| **Spanning tree** computed per VLAN on the switch graph, blocking ports removed from forwarding | STP, loops in labs, PortFast, BPDU Guard | 1 |
| **Event-based simulation clock** (timers, periodic events, retransmission) instead of one-shot ping paths | Routing hellos in simulation mode, DHCP and DNS events, periodic PDUs, HSRP | 2 |
| **Generic PDU model** (any protocol, any layer) for the packet inspector | TCP, UDP, HTTP, DNS, DHCP, routing protocol PDUs in the inspector | 2 |
| **Device model registry with modules** (slots, cards, ports), sourced from a NetForge-authored catalog | The Physical tab, adding HWIC/NM cards, the full device list | 4 |
| **App framework for end devices** (each Desktop app is a module with its own state saved to .pkt) | Email, FTP, text editor, firewall and the rest | 3 |

## Phase 1 — CCNA core (ITN and SRWE)

| Feature | Done when | Samples |
| --- | --- | --- |
| **RIP v1/v2** (`network`, `version`, `no auto-summary`, `passive-interface`, `default-information originate`) | Routes appear as `R` with AD 120 and hop counts; v1 summarizes classfully; passive interfaces don't advertise; pings across | `RIP/*` |
| **OSPFv2** single and multi-area (`network … area`, `router-id`, `passive-interface`, `default-information originate`, `ip ospf cost`, `auto-cost reference-bandwidth`) | Neighbors form only on matching subnets, areas and timers; `O`/`O IA` routes with correct costs; DR/BDR on multi-access links; `show ip ospf neighbor`, `show ip ospf interface`, `show ip protocols` | `OSPF/*` |
| **EIGRP** (`network` with wildcards, AS matching, `no auto-summary`, `passive-interface`, `bandwidth`/`delay`) | `D` routes with AD 90 and composite metrics; neighbors only on the same AS; `show ip eigrp neighbors`, `show ip eigrp topology` | `EIGRP/*` |
| **Administrative distance and route selection** across static, connected, RIP, OSPF, EIGRP; floating static routes | The lower AD wins; floating static takes over when the dynamic route goes away | — |
| **ACLs**: standard, extended, named; `ip access-group in/out`; `access-class` on VTY; `remark`; sequence numbers; `show access-lists` with match counts | Denied pings show "Destination host unreachable" like PT; the implicit deny works; counters increase | `03 Cybersecurity/*`, course labs |
| **IPv6 forwarding**: global and link-local addresses, `ipv6 unicast-routing`, static v6 routes, ND, `ping`/`tracert` over v6, `show ipv6 route` | v6 pings work end to end; PCs get addresses by SLAAC | `IPv6/*` |
| **SLAAC and DHCPv6** (stateless and stateful) on routers and Server-PT | PCs in auto-config mode get the right prefix, gateway and DNS | `IPv6/ipv6_slaac`, `ipv6_stateful_dhcpv6`, `ipv6_stateless_dhcpv6` |
| **OSPFv3 and EIGRP for IPv6**, RIPng | Same checks as v4 | `OSPF/ipv6_*`, `EIGRP/ipv6_*`, `RIP/*` |
| **Spanning tree** (PVST+, Rapid PVST+, root bridge election, priorities, `spanning-tree vlan … root primary`, PortFast, BPDU Guard) | Redundant switch loops block one port; `show spanning-tree` matches roles and states | `01 Networking/*` with loops |
| **EtherChannel** (LACP, PAgP, static), `show etherchannel summary` | Bundled links act as one; mismatch messages | — |
| **Port security** (max MACs, sticky, violation modes) | Violations shut the port and log `%PORT_SECURITY-2-PSECURE_VIOLATION` | `03 Cybersecurity/*` |
| **DHCP snooping, DAI** | Untrusted ports drop server replies | `DHCP/dhcp_snooping_*`, `03 Cybersecurity/DAI` |
| **NAT**: static NAT, dynamic pools, PAT to a pool, `show ip nat translations` with real entries | Translations listed and used in both directions | `NAT/Outside_Nat` |
| **HSRP** (priority, preempt, tracking) | Hosts using the virtual IP keep working when the active router fails | `HSRP/*` |
| **CDP and LLDP** (`show cdp neighbors [detail]`, `show lldp neighbors`) | Neighbors listed with ports and platforms | `LLDP/*` |
| **Inter-VLAN routing on multilayer switches** (`ip routing`, routed ports, SVIs) | Pings between VLANs through a 3650 | `3650/*` |
| **Static and default routes on switches**, `ip default-gateway` behaviour | — | — |

## Phase 2 — simulation and files

| Feature | Done when |
| --- | --- |
| Event-based clock: hellos, timers, ARP ageing, DHCP leases | Simulation mode shows routing protocol packets, DHCP DORA, DNS queries |
| All protocols in the event list and inspector (TCP handshake, UDP, HTTP, DNS, DHCP, OSPF, EIGRP, RIP, STP, CDP, HSRP) | Each PDU opens with its real header fields |
| Several scenarios, periodic PDUs, complex PDUs (any protocol, port, size, TTL) | Matches PT's "Add Complex PDU" dialog |
| Save devices added in NetForge into .pkt | A NetForge-built network opens in PT with all devices and cables |
| `.pkz` (packaged files) and `.pksz` | Open and save |
| Activity grading: every check type, variables, cable codes, timer, locked features, dynamic feedback | Scores match PT on the course's .pka files |
| Activity Wizard (author your own .pka) | Create, save, open in PT |

## Phase 3 — end devices and servers

| Feature | Done when |
| --- | --- |
| Desktop apps: Email, FTP client, TFTP, Text Editor, Firewall (v4 and v6), VPN client, PPPoE dialer, Dial-up, Traffic Generator, MIB Browser, Bluetooth, Cisco IP Communicator, IPv6 configuration | Each works against the matching server service |
| Server services: HTTPS, TFTP, FTP, Email (SMTP/POP3), AAA (RADIUS/TACACS+), NTP, Syslog, IoT registration | Clients interoperate and logs/counters update |
| PC firewall rules applied to traffic | Blocked pings and web requests fail like in PT |
| Printers, IP phones, tablets, smartphones with their own apps | — |

## Phase 4 — workspace and devices

| Feature | Done when |
| --- | --- |
| Full device library: every router, switch, wireless, security, WAN emulation, end device and IoT model in PT 9 | Each model has the right ports and modules |
| Physical tab: power switch, slots, drag modules in and out | Ports appear and disappear as in PT |
| Physical workspace: intercity, city, building, closet, racks; cable length limits; wireless range by distance | — |
| Clusters, shapes, drawing tools, notes with formatting | — |
| Cables: coaxial, phone, USB, octal, IoT custom cable | — |
| Multiuser (connecting two NetForge instances) | — |

## Phase 5 — WAN and security

PPP (PAP/CHAP), Frame Relay, GRE tunnels, IPsec site-to-site and remote access VPN, Zone-Based
Firewall, CBAC, AAA with RADIUS and TACACS+, 802.1X, ASA 5505/5506 (interfaces, security levels, NAT,
ACLs, DHCP), syslog, NTP, SNMP, NetFlow, SPAN, QoS. Samples: `03 Cybersecurity/*`, `VPN/*`,
`QoS/*`, `SNMP/*`, `NTP/*`, `Netflow/*`, `SPAN/*`.

## Phase 6 — wireless, IoT, programming, automation

- Wireless: WPA/WPA2/WPA3 security, WLC and lightweight APs, Meraki devices, home gateways, cellular.
- IoT: things, sensors, actuators, the registration server, the IoT Monitor app, MCU boards.
- Programming: Blockly, Python and JavaScript editors on devices, the `05 Programming` samples.
- Industrial and OT devices and protocols (`06 Industrial - OT`).
- Network Controller with its REST API and the `02 Infrastructure Automation` sample.

## Current phase

Phase 1.

- [x] Dynamic routing: RIP, OSPFv2, EIGRP, administrative distance, floating and recursive static routes
- [x] ACLs: standard, extended, named, interfaces and VTY lines
- [x] IPv6 forwarding, SLAAC, DHCPv6
- [x] Activity grading: cable types, variables, saved port settings (checked against real course labs)
- [ ] OSPFv3, EIGRP for IPv6, RIPng
- [ ] Spanning tree
- [ ] EtherChannel, port security, DHCP snooping, DAI
- [ ] NAT static and pools, HSRP, CDP/LLDP, multilayer switching
