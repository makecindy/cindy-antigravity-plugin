'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ACCOUNT_DIR_ARG = '--cindy-account-dir';
const PYTHON = '/usr/bin/python3';
const SCRIPT = path.join(__dirname, 'agy-linux-keyring.py');
const TOOLS = [PYTHON, '/usr/bin/dbus-daemon', '/usr/bin/gnome-keyring-daemon', '/usr/bin/gdbus'];

function linuxAccountsSupported() {
  if (process.platform !== 'linux') return false;
  return TOOLS.every(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  });
}

function accountDirFromArgv(argv) {
  const index = argv.indexOf(ACCOUNT_DIR_ARG, 2);
  if (index === -1) return undefined;
  if (argv.indexOf(ACCOUNT_DIR_ARG, index + 1) !== -1 || !argv[index + 1]) {
    throw new Error('Invalid Antigravity account directory argument.');
  }
  return argv[index + 1];
}

function privatePath(file, predicate) {
  const stat = fs.lstatSync(file);
  return predicate(stat) && stat.uid === process.getuid() && !(stat.mode & 0o077) && fs.realpathSync(file) === file;
}

function validateAccountDir(dir) {
  if (typeof dir !== 'string' || dir.length > 4096 || dir.includes('\0') || !path.isAbsolute(dir) ||
      dir === '/' || !privatePath(dir, stat => stat.isDirectory())) {
    throw new Error('Antigravity needs a dedicated private account directory.');
  }
}

function liveSocket(socket) {
  return new Promise(resolve => {
    const client = net.createConnection(socket);
    const finish = result => { client.destroy(); resolve(result); };
    client.once('connect', () => finish(true));
    client.once('error', () => finish(false));
    client.setTimeout(300, () => finish(false));
  });
}

async function readySocket(dir) {
  try {
    const ready = path.join(dir, 'keyring-bus');
    if (!privatePath(ready, stat => stat.isFile() && stat.size <= 200)) return null;
    const { socket, profile } = JSON.parse(fs.readFileSync(ready, 'utf8'));
    const current = fs.lstatSync(dir);
    if (!Array.isArray(profile) || profile[0] !== current.dev || profile[1] !== current.ino ||
        typeof socket !== 'string') return null;
    if (!/^\/tmp\/cindy-agy-[a-z0-9_]{8}\/bus$/.test(socket) ||
        !privatePath(path.dirname(socket), stat => stat.isDirectory()) ||
        !privatePath(socket, stat => stat.isSocket()) ||
        process.env.DBUS_SESSION_BUS_ADDRESS?.includes('unix:path=' + socket)) return null;
    return await liveSocket(socket) ? socket : null;
  } catch { return null; }
}

const starting = new Map();
function ensureSocket(dir) {
  if (starting.has(dir)) return starting.get(dir);
  const pending = (async () => {
    const ready = await readySocket(dir);
    if (ready) return ready;
    // The helper takes a per-profile lock, so concurrent workers and harnesses share one keyring.
    const child = spawn(PYTHON, ['-B', SCRIPT, 'serve', dir], { detached: true, stdio: 'ignore' });
    let failed = false;
    child.on('error', () => { failed = true; });
    child.unref();
    const end = Date.now() + 6500;
    while (!failed && Date.now() < end) {
      const socket = await readySocket(dir);
      if (socket) return socket;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The isolated Antigravity keyring could not be started.');
  })().finally(() => starting.delete(dir));
  starting.set(dir, pending);
  return pending;
}

async function accountOptions(dir) {
  if (dir === undefined) return undefined;
  if (!linuxAccountsSupported()) throw new Error('Isolated Antigravity accounts require Linux Secret Service tools.');
  validateAccountDir(dir);
  const socket = await ensureSocket(dir);
  // Resolve the executable in the normal environment; only the launched agy gets the private one.
  const agyPath = require('./resolve-agy.js').resolveAgy();
  if (!agyPath) throw new Error('Antigravity CLI was not found.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:DBUS_|GNOME_KEYRING_|GOOGLE_|GEMINI_|GCLOUD_|CLOUDSDK_|AGY_|XDG_)/.test(key)));
  Object.assign(env, {
    HOME: path.join(dir, 'home'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    XDG_RUNTIME_DIR: path.dirname(socket),
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + socket,
  });
  return { agyPath, env };
}

/**
 * Opt-in migration of an existing private keyring. The path comes through Cindy's protected
 * account input; send it to the helper over stdin and never include it in diagnostic output.
 */
async function importAccount(dir, source) {
  if (!linuxAccountsSupported() || typeof source !== 'string' || source.length > 4096 ||
      !path.isAbsolute(source) || /[\r\n\0]/.test(source)) return false;
  validateAccountDir(dir);
  return new Promise(resolve => {
    const child = spawn(PYTHON, ['-B', SCRIPT, 'import', dir], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
    child.stdin.on('error', () => {});
    child.stdin.end(source + '\n');
  });
}

module.exports = { accountDirFromArgv, accountOptions, importAccount, linuxAccountsSupported };
