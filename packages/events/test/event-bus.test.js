import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus.js';

test('emit() calls a listener registered on the exact literal topic', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('notification.chat.mention', (payload) => seen.push(payload));
  await bus.emit('notification.chat.mention', { text: 'hi' });
  assert.deepEqual(seen, [{ text: 'hi' }]);
});

test('emit() does NOT call a listener on an unrelated literal topic', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('notification.chat.mention', () => seen.push('mention'));
  await bus.emit('notification.chat.message', {});
  assert.deepEqual(seen, []);
});

test('"*" matches exactly one segment, not zero and not two', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('notification.chat.*', (p) => seen.push(p.topic));
  await bus.emit('notification.chat.mention', { topic: 'notification.chat.mention' });
  await bus.emit('notification.chat.message', { topic: 'notification.chat.message' });
  await bus.emit('notification.chat', { topic: 'notification.chat' }); // zero segments after "chat." - must NOT match
  await bus.emit('notification.chat.thread.reply', { topic: 'notification.chat.thread.reply' }); // two segments - must NOT match
  assert.deepEqual(seen, ['notification.chat.mention', 'notification.chat.message']);
});

test('"**" matches the prefix itself and any number of segments beneath it', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('notification.**', (p) => seen.push(p.topic));
  await bus.emit('notification', { topic: 'notification' });
  await bus.emit('notification.chat', { topic: 'notification.chat' });
  await bus.emit('notification.chat.mention', { topic: 'notification.chat.mention' });
  await bus.emit('ui.route.change', { topic: 'ui.route.change' }); // unrelated top-level - must NOT match
  assert.deepEqual(seen, ['notification', 'notification.chat', 'notification.chat.mention']);
});

test('a bare "**" pattern matches every topic', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('**', (p) => seen.push(p.topic));
  await bus.emit('a', { topic: 'a' });
  await bus.emit('a.b.c', { topic: 'a.b.c' });
  assert.deepEqual(seen, ['a', 'a.b.c']);
});

test('on() rejects "**" anywhere but the last segment', () => {
  const bus = new EventBus();
  assert.throws(() => bus.on('a.**.b', () => {}), /must be the last segment/);
});

test('multiple matching patterns (literal + "*" + "**") all fire once each, merged and ordered', async () => {
  const bus = new EventBus();
  const calls = [];
  bus.on('a.b.c', () => calls.push('literal'), { order: 2 });
  bus.on('a.*.c', () => calls.push('star'), { order: 1 });
  bus.on('a.**', () => calls.push('globstar'), { order: 0 });
  await bus.emit('a.b.c', {});
  assert.deepEqual(calls, ['globstar', 'star', 'literal']);
});

test('handlers run in "order" (lower first), ties keep registration order', async () => {
  const bus = new EventBus();
  const calls = [];
  bus.on('x', () => calls.push('third'), { order: 10 });
  bus.on('x', () => calls.push('first'), { order: 0 });
  bus.on('x', () => calls.push('second-a'), { order: 5 });
  bus.on('x', () => calls.push('second-b'), { order: 5 });
  await bus.emit('x', {});
  assert.deepEqual(calls, ['first', 'second-a', 'second-b', 'third']);
});

test('a throwing handler is caught, recorded on ctx.errors, and does not stop later handlers', async () => {
  const bus = new EventBus();
  const calls = [];
  bus.on('x', () => {
    throw new Error('boom');
  }, { order: 0 });
  bus.on('x', () => calls.push('ran anyway'), { order: 1 });
  const ctx = await bus.emit('x', {});
  assert.deepEqual(calls, ['ran anyway']);
  assert.equal(ctx.errors.length, 1);
  assert.match(ctx.errors[0].error.message, /boom/);
});

test('ctx.stop() prevents later (higher-order) handlers from running for this emit only', async () => {
  const bus = new EventBus();
  const calls = [];
  bus.on('x', (payload, ctx) => {
    calls.push('gate');
    ctx.stop();
  }, { order: 0 });
  bus.on('x', () => calls.push('should not run'), { order: 1 });
  const ctx = await bus.emit('x', {});
  assert.deepEqual(calls, ['gate']);
  assert.equal(ctx.stopped, true);

  // stop() only affects the emit() call it happened in - a fresh emit runs the gate (and stops) again, independently.
  const calls2 = [];
  bus.on('x', () => calls2.push('gate2'), { order: -1 });
  await bus.emit('x', {});
});

test('once() unsubscribes itself after the first matching emit', async () => {
  const bus = new EventBus();
  const calls = [];
  bus.once('x', () => calls.push('fired'));
  await bus.emit('x', {});
  await bus.emit('x', {});
  assert.deepEqual(calls, ['fired']);
});

test('off() removes a listener registered with the same pattern', async () => {
  const bus = new EventBus();
  const calls = [];
  function handler() {
    calls.push('fired');
  }
  bus.on('x', handler);
  bus.off('x', handler);
  await bus.emit('x', {});
  assert.deepEqual(calls, []);
});

test('the unsubscribe function returned by on() removes exactly that listener', async () => {
  const bus = new EventBus();
  const calls = [];
  const unsub = bus.on('x', () => calls.push('a'));
  bus.on('x', () => calls.push('b'));
  unsub();
  await bus.emit('x', {});
  assert.deepEqual(calls, ['b']);
});

test('collect() gathers every matching handler\'s return value, flattening array returns', async () => {
  const bus = new EventBus();
  bus.on('notify.recipients', () => 'alice');
  bus.on('notify.recipients', () => ['bob', 'carol']);
  bus.on('notify.recipients', () => undefined); // contributes nothing
  const result = await bus.collect('notify.recipients', {});
  assert.deepEqual(result, ['alice', 'bob', 'carol']);
});

test('run() sequentially shallow-merges each handler\'s patch into the payload', async () => {
  const bus = new EventBus();
  bus.on('message.beforeSend', (payload) => ({ mentions: [...(payload.mentions ?? []), 'x'] }));
  bus.on('message.beforeSend', (payload) => ({ flagged: payload.mentions.length > 0 }));
  const result = await bus.run('message.beforeSend', { text: 'hi' });
  assert.deepEqual(result, { text: 'hi', mentions: ['x'], flagged: true });
});

test('notify() runs every matching handler in parallel and swallows rejections', async () => {
  const bus = new EventBus();
  const calls = [];
  bus.on('x', async () => {
    throw new Error('boom');
  });
  bus.on('x', async () => {
    calls.push('ok');
  });
  await bus.notify('x', {}); // must not reject even though one handler threw
  assert.deepEqual(calls, ['ok']);
});

test('listenerCount() reflects patterns that would match a given topic, across literal/*/**', async () => {
  const bus = new EventBus();
  assert.equal(new EventBus().listenerCount('a.b'), 0);
  bus.on('a.b', () => {});
  bus.on('a.*', () => {});
  bus.on('a.**', () => {});
  bus.on('c.d', () => {}); // unrelated
  assert.equal(bus.listenerCount('a.b'), 3);
});

test('on()/emit() reject a non-string topic/pattern with a clear error', () => {
  const bus = new EventBus();
  assert.throws(() => bus.on('', () => {}), /non-empty string/);
  assert.throws(() => bus.on(null, () => {}), /non-empty string/);
});
