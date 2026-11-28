import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { childEnv } from '../resolve-agy.js';

test('restore the current Linux user bus only for a missing or disabled address', { skip: process.platform !== 'linux' }, (t) => {
  const uid = process.getuid();
  const runtime = '/run/user/' + uid;
  const socket = runtime + '/bus';
  const address = 'unix:path=' + socket;
  const disabled = { DBUS_SESSION_BUS_ADDRESS: 'disabled:' };
  const agyEnv = (env = {}, platform = 'linux') => childEnv(
    platform === 'win32' ? 'C:\\agy\\agy.exe' : '/usr/bin/agy',
    { platform, env },
  );
  const lstatSync = fs.lstatSync;
  let socketStat = { uid, isSocket: () => true };
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file !== socket) return lstatSync(file, ...args);
    if (!socketStat) throw Object.assign(new Error('no session bus'), { code: 'ENOENT' });
    return socketStat;
  });

  for (const env of [{}, disabled, { ...disabled, XDG_RUNTIME_DIR: runtime }]) {
    const result = agyEnv(env);
    assert.equal(result.DBUS_SESSION_BUS_ADDRESS, address);
    assert.equal(result.XDG_RUNTIME_DIR, runtime);
  }
  assert.deepEqual(disabled, { DBUS_SESSION_BUS_ADDRESS: 'disabled:' });
  const explicit = { DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=explicit' };
  assert.equal(agyEnv(explicit).DBUS_SESSION_BUS_ADDRESS, explicit.DBUS_SESSION_BUS_ADDRESS);
  const isolated = agyEnv({ ...disabled, XDG_RUNTIME_DIR: '/tmp/private-session' });
  assert.equal(isolated.DBUS_SESSION_BUS_ADDRESS, 'disabled:');
  assert.equal(isolated.XDG_RUNTIME_DIR, '/tmp/private-session');
  for (const platform of ['darwin', 'win32']) {
    assert.equal(agyEnv(disabled, platform).DBUS_SESSION_BUS_ADDRESS, 'disabled:');
  }
  for (const stat of [{ uid: uid + 1, isSocket: () => true }, { uid, isSocket: () => false }, null]) {
    socketStat = stat;
    const result = agyEnv(disabled);
    assert.equal(result.DBUS_SESSION_BUS_ADDRESS, 'disabled:');
    assert.equal(result.XDG_RUNTIME_DIR, undefined);
    assert.equal(agyEnv().DBUS_SESSION_BUS_ADDRESS, undefined);
  }
});
