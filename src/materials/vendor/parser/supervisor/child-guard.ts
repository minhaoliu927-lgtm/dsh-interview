import { createRequire, syncBuiltinESMExports } from 'node:module';

// Application-level defense in depth; Node permissions and the Windows Job are separate layers.
// Native addons are permitted for PDF.js dependencies, so this is not an OS network sandbox.
export function installParserCapabilityGuard(): void {
  const require = createRequire(import.meta.url);
  const deny = (): never => { throw new Error('PARSER_CAPABILITY_DENIED'); };
  const replace = (object: Record<string, any>, name: string, constructor = false): void => {
    if (typeof object[name] === 'function') object[name] = constructor ? new Proxy(object[name], { construct: deny, apply: deny }) : deny;
  };
  replace(globalThis, 'fetch');
  for (const name of ['WebSocket', 'EventSource', 'Worker']) replace(globalThis, name, true);
  for (const name of ['http', 'https']) {
    const api = require(`node:${name}`);
    for (const method of ['request', 'get', 'createServer']) replace(api, method);
    replace(api.Agent.prototype, 'createConnection');
  }
  const http2 = require('node:http2');
  for (const name of ['connect', 'createServer', 'createSecureServer']) replace(http2, name);
  const net = require('node:net');
  for (const name of ['connect', 'createConnection', 'createServer']) replace(net, name);
  replace(net.Socket.prototype, 'connect'); replace(net.Server.prototype, 'listen');
  const tls = require('node:tls');
  for (const name of ['connect', 'createServer']) replace(tls, name);
  const dgram = require('node:dgram');
  replace(dgram, 'createSocket');
  for (const name of ['connect', 'send', 'bind']) replace(dgram.Socket.prototype, name);
  const dns = require('node:dns');
  for (const object of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const name of Object.getOwnPropertyNames(object)) if (/^(?:lookup|resolve|reverse)/u.test(name)) replace(object, name);
  }
  const child = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) replace(child, name);
  replace(child.ChildProcess.prototype, 'spawn');
  replace(require('node:worker_threads'), 'Worker', true);
  replace(process, 'execve');
  syncBuiltinESMExports();
}
