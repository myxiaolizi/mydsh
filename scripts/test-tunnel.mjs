/**
 * Tunnel protocol tests.
 *
 * The frame codec and header sanitizer are the parts of the tunnel that must
 * agree byte-for-byte with the relay, so they are tested directly rather than
 * through a live socket.
 */
import assert from 'node:assert/strict';

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
  }
};

const { protocol } = await import('../lib/host/remote/tunnel.js');
const { KIND, BINARY_FLAG, encodeFrame, decodeFrame, sanitizeHeaders, PROTOCOL_VERSION } = protocol;

await check('tunnel: protocol version is 1', async () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

await check('tunnel: a frame round-trips kind, stream id, payload, and binary-ness', async () => {
  const payload = Buffer.from('hello tunnel', 'utf8');
  const frame = encodeFrame(KIND.wsData, 0xdeadbeef, payload, true);
  const decoded = decodeFrame(new Uint8Array(frame));

  assert.equal(decoded.kind, KIND.wsData);
  assert.equal(decoded.streamId, 0xdeadbeef);
  assert.equal(decoded.isBinary, true);
  assert.deepEqual(Buffer.from(decoded.payload), payload);
});

await check('tunnel: text frames do not set the binary bit', async () => {
  const frame = encodeFrame(KIND.wsData, 1, Buffer.from('text', 'utf8'), false);
  assert.equal(frame[0] & BINARY_FLAG, 0);
  assert.equal(decodeFrame(new Uint8Array(frame)).isBinary, false);
});

await check('tunnel: the binary bit belongs to the frame, not the stream', async () => {
  // The same stream sends binary then text. A per-stream flag would corrupt the
  // second message; per-frame bits keep both intact.
  const streamId = 42;
  const binary = decodeFrame(new Uint8Array(encodeFrame(KIND.wsData, streamId, Buffer.from([1, 2, 3]), true)));
  const text = decodeFrame(new Uint8Array(encodeFrame(KIND.wsData, streamId, Buffer.from('plain', 'utf8'), false)));

  assert.equal(binary.isBinary, true);
  assert.equal(text.isBinary, false);
  assert.equal(Buffer.from(text.payload).toString('utf8'), 'plain');
});

await check('tunnel: HTTP body kinds are distinct from WS data', async () => {
  for (const kind of [KIND.httpRequest, KIND.httpResponse]) {
    const decoded = decodeFrame(new Uint8Array(encodeFrame(kind, 7, Buffer.from('x'), true)));
    assert.equal(decoded.kind, kind);
    assert.notEqual(decoded.kind, KIND.wsData);
  }
});

await check('tunnel: a stream id of 0 and the maximum survive', async () => {
  for (const id of [0, 0xffffffff, 0x7fffffff]) {
    const decoded = decodeFrame(new Uint8Array(encodeFrame(KIND.httpRequest, id, Buffer.alloc(0), false)));
    assert.equal(decoded.streamId, id >>> 0, `id ${id} must round-trip`);
  }
});

await check('tunnel: an empty payload is legal', async () => {
  const decoded = decodeFrame(new Uint8Array(encodeFrame(KIND.httpResponse, 5, Buffer.alloc(0), true)));
  assert.equal(decoded.payload.length, 0);
});

await check('tunnel: a frame shorter than its header is rejected', async () => {
  assert.equal(decodeFrame(new Uint8Array([0x01, 0x00])), undefined);
  assert.equal(decodeFrame(new Uint8Array([])), undefined);
  assert.equal(decodeFrame(undefined), undefined);
  assert.equal(decodeFrame('not bytes'), undefined);
});

await check('tunnel: hop-by-hop headers are stripped before forwarding', async () => {
  const headers = sanitizeHeaders({
    Connection: 'keep-alive',
    'Transfer-Encoding': 'chunked',
    'Content-Length': '999',
    Host: 'public.example.com',
    'X-Real-IP': '1.2.3.4',
    'Content-Type': 'application/json',
  });
  assert.equal(headers.connection, undefined);
  assert.equal(headers['transfer-encoding'], undefined);
  assert.equal(headers['content-length'], undefined, 'length is recomputed by the forwarding request');
  assert.equal(headers.host, undefined, 'host is replaced with the local origin');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-real-ip'], '1.2.3.4');
});

await check('tunnel: a header carrying CR/LF is dropped, not forwarded', async () => {
  const headers = sanitizeHeaders({
    'X-Evil': 'value\r\nInjected: header',
    'X-Null': 'a\0b',
    'X-Fine': 'ok',
  });
  assert.equal(headers['x-evil'], undefined, 'response splitting must be impossible');
  assert.equal(headers['x-null'], undefined);
  assert.equal(headers['x-fine'], 'ok');
});

await check('tunnel: repeated headers are joined and arrays become comma lists', async () => {
  const headers = sanitizeHeaders({ 'X-Multi': ['a', 'b'], 'X-Single': 'solo' });
  assert.equal(headers['x-multi'], 'a, b');
  assert.equal(headers['x-single'], 'solo');
});

await check('tunnel: a non-object header bag yields an empty result', async () => {
  assert.deepEqual(sanitizeHeaders(undefined), {});
  assert.deepEqual(sanitizeHeaders(null), {});
  assert.deepEqual(sanitizeHeaders('nope'), {});
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`);
}
console.log(`\ntunnel protocol: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
