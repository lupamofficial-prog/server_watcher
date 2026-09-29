// SSRF guard. Used by the backend (validating targets on creation) and by the probe (validating the
// *resolved* IP right before connecting, which defeats DNS rebinding).

import { BlockList, isIPv4, isIPv6 } from 'node:net';

const blocked = new BlockList();
const v4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];
for (const [a, p] of v4) blocked.addSubnet(a, p, 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6'); // unique local
blocked.addSubnet('fe80::', 10, 'ipv6'); // link local
blocked.addSubnet('ff00::', 8, 'ipv6'); // multicast

/** Convert ::ffff:a.b.c.d / ::ffff:7f00:1 to plain IPv4, otherwise null. */
function unmapV4(ip: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isBlockedIp(ip: string): boolean {
  const mapped = unmapV4(ip);
  if (mapped) return blocked.check(mapped, 'ipv4');
  if (isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (isIPv6(ip)) return blocked.check(ip, 'ipv6');
  return true; // not an IP at all -> refuse
}

const BLOCKED_NAMES = /^(localhost|metadata|metadata\.google\.internal|instance-data)$|\.(local|localhost|internal|lan|home|corp)$/i;

export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_NAMES.test(h)) return true;
  if (isIPv4(h) || isIPv6(h.replace(/^\[|\]$/g, ''))) return isBlockedIp(h.replace(/^\[|\]$/g, ''));
  return false;
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
export const isValidHostname = (h: string) => HOSTNAME_RE.test(h) || isIPv4(h);
