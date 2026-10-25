'use strict';
// Preloaded into every API test process in CI (NODE_OPTIONS=--require).
// Unit tests must never reach Shopify, a database or any other host, so all
// outbound connections and DNS lookups throw, and any attempt — even one a test
// swallowed — fails the process at exit.

const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');

const attempts = [];
const deny = (what) => function () {
  attempts.push(what);
  throw new Error(`[ci/no-network] blocked ${what}`);
};

net.connect = net.createConnection = deny('net.connect');
net.Socket.prototype.connect = deny('net.Socket.connect');
tls.connect = deny('tls.connect');
dns.lookup = deny('dns.lookup');
dns.promises.lookup = async () => { attempts.push('dns.promises.lookup'); throw new Error('[ci/no-network] blocked dns.promises.lookup'); };
globalThis.fetch = async (url) => { attempts.push(`fetch ${url}`); throw new Error('[ci/no-network] blocked fetch'); };

process.on('exit', () => {
  if (attempts.length > 0) {
    process.stderr.write(`[ci/no-network] outbound network attempted: ${JSON.stringify(attempts)}\n`);
    process.exitCode = 1;
  }
});
