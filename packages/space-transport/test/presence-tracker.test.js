import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceTracker } from '../src/presence-tracker.js';

test('setOnline() then isOnline() reports true for that pubkey', () => {
  const presence = new PresenceTracker();
  presence.setOnline('pubA', 'peer-1');
  assert.equal(presence.isOnline('pubA'), true);
  assert.equal(presence.isOnline('pubB'), false);
});

test('disconnect() clears the pubkey that was mapped to that peerId', () => {
  const presence = new PresenceTracker();
  presence.setOnline('pubA', 'peer-1');
  presence.disconnect('peer-1');
  assert.equal(presence.isOnline('pubA'), false);
});

test('disconnect() on an unknown peerId is a harmless no-op', () => {
  const presence = new PresenceTracker();
  presence.disconnect('never-registered');
  assert.equal(presence.isOnline('pubA'), false);
});

test('a pubkey reconnecting on a NEW peerId moves online status to the new connection', () => {
  const presence = new PresenceTracker();
  presence.setOnline('pubA', 'peer-1');
  presence.setOnline('pubA', 'peer-2'); // e.g. reconnect after a network blip
  presence.disconnect('peer-1'); // the OLD connection's close event, arriving late
  assert.equal(presence.isOnline('pubA'), true); // must still be online via peer-2
  presence.disconnect('peer-2');
  assert.equal(presence.isOnline('pubA'), false);
});

test('a second pubkey claiming a peerId that already belonged to a different pubkey replaces it', () => {
  const presence = new PresenceTracker();
  presence.setOnline('pubA', 'peer-1');
  presence.setOnline('pubB', 'peer-1'); // e.g. two hello messages on the same connection - the later one wins
  assert.equal(presence.isOnline('pubA'), false);
  assert.equal(presence.isOnline('pubB'), true);
});
