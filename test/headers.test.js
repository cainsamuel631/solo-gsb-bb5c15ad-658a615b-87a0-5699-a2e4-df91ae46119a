import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildApp } from '../src/app.js';

// Raw-socket tests: light-my-request normalises repeated header lines, so
// duplicate If-Range rejection can only be exercised on a real listener.
const app = buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const port = app.server.address().port;
after(async () => app.close());

function rawRequest(lines, body = '') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write([...lines, '', body].join('\r\n'));
    });
    let data = '';
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
    sock.on('data', (chunk) => { data += chunk; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

// Like rawRequest but takes a fully assembled head, allowing bare CR/LF bytes
// inside a field value (joining lines with CRLF first would hide them).
function rawRequestBytes(head, body = '') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(head + '\r\n\r\n' + body));
    let data = '';
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
    sock.on('data', (chunk) => { data += chunk; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

test('duplicate If-Range headers are rejected with 400 DUPLICATE_IF_RANGE_HEADER', async () => {
  const body = JSON.stringify({ size: 1000, etag: '"v1"' });
  const lines = [
    'POST /plan HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Range: bytes=0-99',
    'If-Range: "v1"',
    'If-Range: "v1"',
  ];
  const raw = await rawRequest(lines, body);
  assert.match(raw.split('\r\n')[0], /^HTTP\/1\.1 400/);
  const payload = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  assert.equal(JSON.parse(payload).code, 'DUPLICATE_IF_RANGE_HEADER');
});

test('duplicate Range headers are still rejected', async () => {
  const body = JSON.stringify({ size: 1000 });
  const raw = await rawRequest([
    'POST /plan HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Range: bytes=0-9',
    'Range: bytes=10-19',
  ], body);
  assert.match(raw.split('\r\n')[0], /^HTTP\/1\.1 400/);
  assert.match(raw, /DUPLICATE_RANGE_HEADER/);
});

test('bare CR in the If-Range value is rejected, never reaching the planner', async () => {
  const body = JSON.stringify({ size: 1000, etag: '"v1"' });
  const head = [
    'POST /plan HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Range: bytes=0-99',
    'If-Range: "v1"\rX-Injected: yes',
  ].join('\r\n');
  const raw = await rawRequestBytes(head, body);
  assert.match(raw.split('\r\n')[0], /^HTTP\/1\.1 400/);
  assert.doesNotMatch(raw, /206/);
});

test('bare LF in the If-Range value is rejected, never reaching the planner', async () => {
  const body = JSON.stringify({ size: 1000, etag: '"v1"' });
  const head = [
    'POST /plan HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Range: bytes=0-99',
  ].join('\r\n') + '\r\nIf-Range: "v1"\nX-Injected: yes';
  const raw = await rawRequestBytes(head, body);
  assert.match(raw.split('\r\n')[0], /^HTTP\/1\.1 400/);
});
