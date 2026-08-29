import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus.js';
import { createDebugLogger } from '../src/debug-logger.js';

test('logs every event on the bus by default (pattern "**")', async () => {
  const bus = new EventBus();
  const lines = [];
  createDebugLogger(bus, { log: (line, payload) => lines.push([line, payload]) });

  await bus.emit('debug.relay.write.received', { nodeId: 'n1' });
  await bus.emit('notification.chat.mention', { topic: 'mention' });

  assert.deepEqual(lines, [
    ['debug.relay.write.received', { nodeId: 'n1' }],
    ['notification.chat.mention', { topic: 'mention' }],
  ]);
});

test('a narrower pattern only logs matching topics', async () => {
  const bus = new EventBus();
  const lines = [];
  createDebugLogger(bus, { pattern: 'debug.**', log: (line) => lines.push(line) });

  await bus.emit('notification.chat.mention', {});
  await bus.emit('debug.space.write.local', {});

  assert.deepEqual(lines, ['debug.space.write.local']);
});

test('label prefixes every logged line, for telling multiple buses apart', async () => {
  const bus = new EventBus();
  const lines = [];
  createDebugLogger(bus, { label: '[relay]', log: (line) => lines.push(line) });

  await bus.emit('debug.relay.write.received', {});
  assert.deepEqual(lines, ['[relay] debug.relay.write.received']);
});

test('the returned unsubscribe function stops logging without touching other listeners', async () => {
  const bus = new EventBus();
  const lines = [];
  const otherCalls = [];
  bus.on('x', () => otherCalls.push('other'));
  const stopLogging = createDebugLogger(bus, { log: (line) => lines.push(line) });

  stopLogging();
  await bus.emit('x', {});

  assert.deepEqual(lines, []);
  assert.deepEqual(otherCalls, ['other']);
});

test('attaching no logger at all costs nothing observable - a bus with only domain listeners behaves identically', async () => {
  const bus = new EventBus();
  const domainCalls = [];
  bus.on('notification.chat.mention', (p) => domainCalls.push(p));
  // no createDebugLogger() call here at all
  await bus.emit('notification.chat.mention', { text: 'hi' });
  assert.deepEqual(domainCalls, [{ text: 'hi' }]);
});
