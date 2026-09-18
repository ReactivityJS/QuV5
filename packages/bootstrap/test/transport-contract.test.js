import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTransportShape, REQUIRED_TRANSPORT_METHODS } from '../src/transport-contract.js';

test('assertTransportShape(): accepts an object implementing connect/send/onMessage', () => {
  assert.doesNotThrow(() => assertTransportShape({ connect: async () => {}, send: () => {}, onMessage: () => {} }));
});

test('assertTransportShape(): accepts extra OPTIONAL methods too (onStatusChange/getPeerId/close)', () => {
  assert.doesNotThrow(() =>
    assertTransportShape({
      connect: async () => {},
      send: () => {},
      onMessage: () => {},
      onStatusChange: () => {},
      getPeerId: () => 'x',
      close: () => {},
    })
  );
});

test('assertTransportShape(): throws, naming every missing required method', () => {
  assert.throws(() => assertTransportShape({ connect: async () => {} }), (err) => {
    assert.match(err.message, /missing required method\(s\): send, onMessage/);
    return true;
  });
});

test('assertTransportShape(): throws on null/non-object input', () => {
  assert.throws(() => assertTransportShape(null), /must be an object/);
  assert.throws(() => assertTransportShape('not-an-object'), /must be an object/);
  assert.throws(() => assertTransportShape(undefined), /must be an object/);
});

test('REQUIRED_TRANSPORT_METHODS: exactly connect/send/onMessage, per docs/peer-transport-contract.md', () => {
  assert.deepEqual(REQUIRED_TRANSPORT_METHODS, ['connect', 'send', 'onMessage']);
});
