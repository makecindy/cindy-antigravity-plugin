import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { accountDirFromArgv, accountOptions, importAccount, linuxAccountsSupported } from '../agy-linux-accounts.js';
import { accountErrorRelay } from '../agy-account-errors.js';

test('account argument distinguishes the default from malformed explicit selection', async () => {
  assert.equal(accountDirFromArgv(['node', 'agy-acp.js']), undefined);
  assert.equal(await accountOptions(undefined), undefined);
  assert.equal(accountDirFromArgv(['node', 'agy-acp.js', '--cindy-account-dir', '/tmp/account']), '/tmp/account');
  assert.throws(() => accountDirFromArgv(['node', 'agy-acp.js', '--cindy-account-dir']), /Invalid/);
  assert.throws(() => accountDirFromArgv([
    'node', 'agy-acp.js', '--cindy-account-dir', '/a', '--cindy-account-dir', '/b',
  ]), /Invalid/);
});

test('two Linux account directories share one keyring per account and never the default', {
  skip: !linuxAccountsSupported(),
}, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-account-test-'));
  const oldPath = process.env.PATH;
  const sockets = [];
  try {
    const bin = path.join(temporary, 'agy');
    await fs.writeFile(bin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    process.env.PATH = temporary + ':' + (oldPath ?? '');
    const dirs = await Promise.all(['one', 'two'].map(name => fs.mkdtemp(path.join(temporary, name))));
    await assert.rejects(accountOptions(temporary + '/missing'));
    const publicDir = path.join(temporary, 'public');
    await fs.mkdir(publicDir, { mode: 0o755 });
    await fs.chmod(publicDir, 0o755);
    await assert.rejects(accountOptions(publicDir), /private/);
    const alias = path.join(temporary, 'alias');
    await fs.symlink(dirs[0], alias);
    await assert.rejects(accountOptions(alias), /private/);
    const [one, oneAgain, two] = await Promise.all([
      accountOptions(dirs[0]), accountOptions(dirs[0]), accountOptions(dirs[1]),
    ]);
    const address = opts => opts.env.DBUS_SESSION_BUS_ADDRESS;
    for (const opts of [one, two]) sockets.push(address(opts).slice('unix:path='.length));
    assert.equal(address(oneAgain), address(one));
    assert.notEqual(address(one), address(two));
    assert.notEqual(address(one), process.env.DBUS_SESSION_BUS_ADDRESS);
    assert.equal(one.env.HOME, path.join(dirs[0], 'home'));
    assert.equal(two.env.XDG_DATA_HOME, path.join(dirs[1], 'data'));
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await fs.rm(temporary, { recursive: true });
    const alive = socket => fs.stat(socket).then(() => true, () => false);
    for (let tries = 0; tries < 35 && (await Promise.all(sockets.map(alive))).some(Boolean); tries++) await delay(100);
    assert.deepEqual(await Promise.all(sockets.map(alive)), sockets.map(() => false));
  }
});

test('import copies an existing native store once and rejects linked inputs', {
  skip: !linuxAccountsSupported(),
}, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-import-test-'));
  try {
    const [source, target, badTarget] = await Promise.all(
      ['source', 'target', 'other'].map(name => fs.mkdtemp(path.join(temporary, name))),
    );
    const store = path.join(source, 'data', 'keyrings');
    await fs.mkdir(store, { mode: 0o700, recursive: true });
    const files = ['login.keyring', 'user.keystore'];
    for (const file of files) await fs.writeFile(path.join(store, file), 'fixture ' + file, { mode: 0o600 });
    await fs.writeFile(path.join(source, 'unlock'), 'fixture password', { mode: 0o600 });
    assert.equal(await importAccount(target, source), true);
    for (const file of files) {
      assert.equal(await fs.readFile(path.join(target, 'data', 'keyrings', file), 'utf8'), 'fixture ' + file);
    }
    assert.equal(await importAccount(target, source), false);
    await fs.symlink(path.join(store, 'login.keyring'), path.join(store, 'other.keyring'));
    assert.equal(await importAccount(badTarget, source), false);
    await assert.rejects(fs.stat(path.join(badTarget, 'unlock')), { code: 'ENOENT' });
  } finally {
    await fs.rm(temporary, { recursive: true });
  }
});

test('only explicit quota or authentication errors reach the host account router', () => {
  const relay = accountErrorRelay();
  const response = (id, error) => relay.response({ jsonrpc: '2.0', id, error }).error;
  const quota = { code: -32603, message: 'Provider request failed', data: { reason: 'MODEL_QUOTA_EXHAUSTED' } };
  const capacity = { code: -32603, message: 'HTTP 503: model capacity exhausted' };
  const rateLimited = { code: -32603, message: 'HTTP 429: too many requests' };
  relay.request({ id: 1, method: 'session/prompt' });
  relay.request({ id: 2, method: 'session/prompt' });
  relay.request({ id: 3, method: 'session/new' });
  relay.request({ id: 4, method: 'session/set_config_option' });
  relay.request({ id: 5, method: 'session/prompt' });
  assert.equal(response(1, quota).data._meta.cindy.kind, 'usage-limit');
  assert.equal(response(2, capacity), capacity);
  assert.equal(response(3, { code: -32000, message: 'auth_required' }).data._meta.cindy.kind, 'auth-required');
  assert.equal(response(4, quota), quota);
  assert.equal(response(5, rateLimited), rateLimited);
});

test('the CLI Argon quota is scoped to Argon rather than the general Gemini pool', async () => {
  const { usageFromReport } = await import('../agy-usage.js');
  const result = usageFromReport({
    status: 'SUCCESS', num_turns: 0,
    command: { name: 'usage', data: { groups: [
      { name: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remaining_fraction: 0 }] },
      { name: 'Gemini Models', buckets: [{ window: 'weekly', remaining_fraction: 1 }] },
    ] } },
  });
  assert.ok(result.windows[0].models.includes('gemini-4-argon'));
  assert.ok(!result.windows[0].models.includes('gemini-4-hydrogen'));
  assert.ok(result.windows[1].models.includes('gemini-4-hydrogen'));
});
