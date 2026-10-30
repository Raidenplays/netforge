export type DeviceKind =
  | 'router'
  | 'switch'
  | 'pc'
  | 'laptop'
  | 'server'
  | 'tablet'
  | 'phone'
  | 'printer'
  | 'homerouter'
  | 'ap'
  | 'cloud'
  | 'other';

export type Media = 'copper' | 'fiber' | 'wireless' | 'serial' | 'virtual';

export interface Iface {
  name: string;
  media: Media;
  /** Mbps */
  speed: number;
  mac: string;
  ip?: string;
  mask?: string;
  shutdown: boolean;
  description?: string;
  natRole?: 'inside' | 'outside';
  /** IOS lines inside this interface block we don't model, kept verbatim */
  extra?: string[];
}

export interface StaticRoute {
  network: string;
  mask: string;
  via?: string;
  iface?: string;
}

export interface DhcpPool {
  name: string;
  network?: string;
  mask?: string;
  router?: string;
  dns?: string;
}

export interface DhcpLease {
  ip: string;
  mac: string;
}

export interface IosState {
  hostname: string;
  enableSecret?: string;
  routes: StaticRoute[];
  pools: DhcpPool[];
  excluded: { from: string; to: string }[];
  leases: DhcpLease[];
  natRules: string[];
  defaultGateway?: string;
  /** global lines before the first interface we don't model */
  extraPre: string[];
  /** global lines after interfaces we don't model */
  extraPost: string[];
}

export interface ServerPool {
  name: string;
  network: string;
  mask: string;
  router: string;
  start: string;
  max: number;
  dns: string;
}

/** DHCP service on a Server-PT */
export interface ServerDhcp {
  enabled: boolean;
  pools: ServerPool[];
  leases: DhcpLease[];
}

export interface HomeRouterState {
  lanIp: string;
  lanMask: string;
  dhcpEnabled: boolean;
  startHost: number;
  maxUsers: number;
  wanMode: 'dhcp' | 'static';
  wanIp: string;
  wanMask: string;
  wanGateway: string;
  ssid: string;
  /** DNS server handed out and used by the router */
  dns?: string;
  leases: DhcpLease[];
}

export interface Device {
  id: string;
  kind: DeviceKind;
  model: string;
  name: string;
  x: number;
  y: number;
  ifaces: Iface[];
  /** hosts */
  gateway?: string;
  dns?: string;
  dhcpClient?: boolean;
  /** Wi-Fi clients: network they try to join */
  ssid?: string;
  /** DHCP service (servers) */
  dhcpService?: ServerDhcp;
  /** IOS devices (routers, switches) */
  ios?: IosState;
  /** Linksys-style home routers */
  home?: HomeRouterState;
  /** link back to the source .pkt device */
  ptRef?: string;
  ptIndex?: number;
  powered: boolean;
  note?: string;
}

export type CableType = 'straight' | 'cross' | 'fiber' | 'serial' | 'console' | 'auto';

export interface LinkEnd {
  dev: string;
  iface: string;
}

export interface Link {
  id: string;
  a: LinkEnd;
  b: LinkEnd;
  cable: CableType;
  /** index of the original <LINK> element when imported from .pkt */
  ptIndex?: number;
}

export interface Note {
  id: string;
  x: number;
  y: number;
  text: string;
}

export interface GradeItem {
  /** path below the device, e.g. ['ISP', 'Ports', 'GigabitEthernet0/0', 'IP Address'] */
  path: string[];
  expected: string;
  points: number;
  /** compared against an activity variable we don't evaluate */
  variable: boolean;
}

export interface Activity {
  title?: string;
  pages: string[];
  items: GradeItem[];
  completeFeedback?: string;
}

export interface Project {
  devices: Device[];
  links: Link[];
  notes: Note[];
  /** original decoded XML when opened from a .pkt file */
  sourceXml?: string;
  ptVersion?: string;
  /** .pka activity data (instructions + assessment) */
  activity?: Activity;
  fileName?: string;
  filePath?: string;
}

export const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 9)}`;
