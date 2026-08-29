import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '@qu/events';
import { registerPushHandler } from '../src/push-handler.js';

test('calls sendPush when online is false', async () => {
  const bus = new EventBus();
  const pushed = [];
  registerPushHandler(bus, { sendPush: (p) => pushed.push(p) });

  await bus.emit('relay.notify.chat.mention', { to: 'pubB', online: false, topic: 'mention' });
  assert.deepEqual(pushed, [{ to: 'pubB', online: false, topic: 'mention' }]);
});

test('does NOT call sendPush when online is true', async () => {
  const bus = new EventBus();
  const pushed = [];
  registerPushHandler(bus, { sendPush: (p) => pushed.push(p) });

  await bus.emit('relay.notify.chat.mention', { to: 'pubB', online: true, topic: 'mention' });
  assert.deepEqual(pushed, []);
});

test('a custom pattern narrows which topics the handler even looks at', async () => {
  const bus = new EventBus();
  const pushed = [];
  registerPushHandler(bus, { sendPush: (p) => pushed.push(p), pattern: 'relay.notify.chat.**' });

  await bus.emit('relay.notify.forum.reply', { to: 'pubB', online: false });
  assert.deepEqual(pushed, []);

  await bus.emit('relay.notify.chat.message', { to: 'pubB', online: false });
  assert.equal(pushed.length, 1);
});

test('the default sendPush stub does not throw (just logs)', async () => {
  const bus = new EventBus();
  registerPushHandler(bus); // no sendPush override - uses the built-in console.log stub
  await bus.emit('relay.notify.chat.mention', { to: 'pubB', online: false, topic: 'mention', kind: 'chat', nodeId: 'n1', authorPub: 'pubA' });
});

test('the returned unsubscribe function stops the handler from firing again', async () => {
  const bus = new EventBus();
  const pushed = [];
  const unsubscribe = registerPushHandler(bus, { sendPush: (p) => pushed.push(p) });
  unsubscribe();

  await bus.emit('relay.notify.chat.mention', { to: 'pubB', online: false });
  assert.deepEqual(pushed, []);
});
