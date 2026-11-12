import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
export interface PublicAddress { address: string; family: 4 | 6 }
export type PublicResolver = (hostname: string) => Promise<PublicAddress[]>;
const deniedV4 = new BlockList(), deniedV6 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) deniedV4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) deniedV6.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
export function isPublicJobAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !deniedV4.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
}
export function normalizeJobUrl(value: string): URL {
  const reject = (): never => { throw new Error('MATERIALS_URL_REJECTED'); };
  if (typeof value !== 'string' || !value || value.length > 2048 || value !== value.trim() || /[\\\u0000-\u0020\u007f]/u.test(value)) reject();
  let url: URL; try { url = new URL(value); } catch { return reject(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) reject();
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (!hostname || hostname.includes('%') || hostname.endsWith('.') || hostname === 'localhost'
    || /\.(?:localhost|local|internal|lan|home|onion|invalid|test)$/u.test(hostname)) reject();
  if (isIP(hostname) && !isPublicJobAddress(hostname)) reject();
  url.hash = ''; return url;
}
const defaultResolver: PublicResolver = async hostname => (await lookup(hostname, { all: true, verbatim: true }))
  .map(row => ({ address: row.address, family: row.family as 4 | 6 }));
export async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    abort = () => reject(new Error('MATERIALS_ACQUISITION_CANCELLED')); signal.addEventListener('abort', abort, { once: true });
  })]); } finally { if (abort) signal.removeEventListener('abort', abort); }
}
export async function resolvePublicJobUrl(value: string, options: { resolver?: PublicResolver; signal?: AbortSignal } = {}) {
  const url = normalizeJobUrl(value), hostname = url.hostname.replace(/^\[|\]$/gu, '');
  options.signal?.throwIfAborted();
  let addresses: PublicAddress[];
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  else {
    try { addresses = await abortable((options.resolver ?? defaultResolver)(hostname), options.signal); }
    catch { throw new Error(options.signal?.aborted ? 'MATERIALS_ACQUISITION_CANCELLED' : 'MATERIALS_FETCH_FAILED'); }
  }
  if (!addresses.length || addresses.length > 32 || addresses.some(row => !isPublicJobAddress(row.address) || isIP(row.address) !== row.family))
    throw new Error('MATERIALS_URL_REJECTED');
  return { url, hostname, addresses, selected: addresses[0]! };
}
export async function validatePublicJobUrl(value: string, signal?: AbortSignal): Promise<string> {
  return (await resolvePublicJobUrl(value, { signal })).url.href;
}
export function sanitizeJobSourceUrl(value: string): string {
  const url = normalizeJobUrl(value);
  for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|ka$|lid$|securityid$|token$|access_token$|refresh_token$|auth$|password$|session|cookie|code$|seed$|ts$)/iu.test(key)) url.searchParams.delete(key);
  return url.href;
}
export function isJobVerificationUrl(value: string): boolean {
  let url: URL; try { url = new URL(value); } catch { return true; }
  return /\/(?:passport|security|captcha|login|signin|verify|verification|challenge)(?:[/.]|$)/iu.test(url.pathname);
}
