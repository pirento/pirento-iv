import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

let installed = false;

function rejectOutboundConnection() {
  const error = new Error('Outbound connections are disabled in disposable synthetic preview.');
  error.code = 'IV_PREVIEW_NETWORK_DISABLED';
  throw error;
}

function lock(target, key) {
  Object.defineProperty(target, key, {
    value: rejectOutboundConnection,
    enumerable: Object.getOwnPropertyDescriptor(target, key)?.enumerable ?? true,
    writable: false,
    configurable: false,
  });
}

/**
 * Install only after tsx and the complete application import graph have loaded.
 * This irreversible, process-local guard blocks application outbound transports,
 * including loopback and Unix sockets. It is not an operating-system firewall.
 * Listening sockets and accepted HTTP connections remain available.
 */
export function installPreviewNetworkLock() {
  if (installed) return;
  lock(globalThis, 'fetch');
  for (const key of ['WebSocket', 'EventSource']) {
    if (typeof globalThis[key] !== 'undefined') lock(globalThis, key);
  }
  for (const module of [http, https]) {
    lock(module, 'request');
    lock(module, 'get');
  }
  lock(net.Socket.prototype, 'connect');
  lock(net, 'connect');
  lock(net, 'createConnection');
  lock(tls, 'connect');
  lock(dgram, 'createSocket');
  // Also replace live named exports imported before this function was called.
  syncBuiltinESMExports();
  installed = true;
}
