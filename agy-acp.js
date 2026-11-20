'use strict';

/**
 * ACP engine entry for Cindy (`harnesses[].entry`).
 *
 * Cindy starts this file in raw-stdio mode, one process per task. It starts the
 * locally installed `agy acp` (session settings: no paid credits, no telemetry) and relays ACP traffic:
 *   stdin  -> agy stdin    (ACP JSON-RPC from Cindy, unchanged)
 *   agy stdout -> stdout   (ACP JSON-RPC to Cindy; patches `initialize` to add
 *                           `agentCapabilities.mcpCapabilities.http = true`, then relays bytes unchanged)
 *   agy stderr -> stderr   (diagnostics, ends up in the plugin log)
 * When Cindy closes stdin, agy's stdin is closed and agy exits on its own; when agy
 * exits, this process exits with the same code. When this process is asked to stop,
 * agy (and on Windows its whole process tree) is stopped first so nothing is orphaned.
 *
 * Started with `--cindy-remote-workspace` (the task's files and commands are on another
 * computer), the session runs under an agent without Antigravity's own file and command
 * tools, and the ACP messages are relayed by remote-workspace.js instead of byte for byte.
 * Nothing in the user's Antigravity settings is changed.
 */

const os = require('node:os');
const { Transform } = require('node:stream');
const { ACP_ARGS, detectAgy, resolveAgy, spawnAgy, killTree } = require('./resolve-agy.js');
const remoteWorkspace = require('./remote-workspace.js');

/** agy normally exits right after stdin closes; force it if it lingers. */
const STDIN_END_GRACE_MS = 5_000;
/** Cindy escalates to a hard kill 2 s after asking us to stop; stay inside that. */
const SIGNAL_GRACE_MS = 1_500;
const FLUSH_TIMEOUT_MS = 2_000;
const NOT_FOUND_EXIT_CODE = 127;
/** Cap buffered handshake bytes while waiting for the single initialize response. */
const MAX_HANDSHAKE_LINE_BYTES = 1024 * 1024;
/** Stop inspecting stdout lines once this many lines pass without matching initialize. */
const MAX_HANDSHAKE_LINES = 32;
const NEWLINE = Buffer.from('\n');

function parseJsonObject(line) {
  try {
    const parsed = JSON.parse(line.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * agy 1.5.13+ connects to HTTP MCP servers passed in session/new without advertising
 * `agentCapabilities.mcpCapabilities.http`. Gate on the checked agy version and fill it
 * in only when omitted so older CLIs and explicit `http: false` declarations are preserved.
 */
function completeLocalInitializeResult(result) {
  const version = result.agentInfo && typeof result.agentInfo === 'object' && !Array.isArray(result.agentInfo)
    ? result.agentInfo.version
    : undefined;
  if (!remoteWorkspace.versionSupported(version)) {
    return result;
  }
  const capabilities = result.agentCapabilities;
  const mcp = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
    ? capabilities.mcpCapabilities
    : undefined;
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp) && typeof mcp.http === 'boolean') {
    return result;
  }
  return remoteWorkspace.completeInitializeResult(result);
}

function exitAfterStderr(line, code) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    process.exit(code);
  };
  try {
    process.stderr.write(line + '\n', finish);
  } catch {
    finish();
  }
  setTimeout(finish, 1_000);
}

function describe(error) {
  if (!error) return 'unknown error';
  return error.code ? `${error.code}: ${error.message}` : String(error.message || error);
}

function exitCodeFor(code, signal) {
  if (typeof code === 'number') return code;
  if (signal && os.constants.signals[signal]) return 128 + os.constants.signals[signal];
  return 1;
}

function run(agyPath) {
  let child;
  try {
    child = spawnAgy(agyPath, ACP_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    exitAfterStderr(`[agy-acp] Could not start Antigravity at ${agyPath} (${describe(error)}).`, NOT_FOUND_EXIT_CODE);
    return;
  }

  let childExited = false;
  let finished = false;
  let stopCode = null;
  let forceTimer = null;
  let stdoutRelay = null;

  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(forceTimer);
    process.stdin.unpipe(child.stdin);
    let exited = false;
    let flushTimer = null;
    const done = () => {
      if (exited) return;
      exited = true;
      clearTimeout(flushTimer);
      process.exit(code);
    };
    const flushStdout = () => {
      if (process.stdout.writableLength > 0) {
        try {
          process.stdout.write('', done);
        } catch {
          done();
        }
      } else {
        done();
      }
    };
    flushTimer = setTimeout(done, FLUSH_TIMEOUT_MS);
    if (stopCode !== null || !stdoutRelay || stdoutRelay.readableEnded || stdoutRelay.destroyed) {
      flushStdout();
    } else {
      stdoutRelay.once('end', flushStdout);
    }
  };

  const terminate = () => {
    if (childExited) return;
    if (process.platform === 'win32') {
      killTree(child);
      return;
    }
    killTree(child, 'SIGTERM');
    setTimeout(() => {
      if (!childExited) killTree(child, 'SIGKILL');
    }, SIGNAL_GRACE_MS).unref();
  };

  const stop = (signal) => {
    if (stopCode !== null) return;
    stopCode = 128 + (os.constants.signals[signal] || os.constants.signals.SIGTERM);
    terminate();
    setTimeout(() => finish(stopCode), SIGNAL_GRACE_MS + 300).unref();
  };

  child.on('error', (error) => {
    if (child.pid === undefined) {
      // Never started (missing file, permission denied): there will be no exit event.
      childExited = true;
      finished = true;
      exitAfterStderr(`[agy-acp] Could not start Antigravity at ${agyPath} (${describe(error)}).`, NOT_FOUND_EXIT_CODE);
      return;
    }
    process.stderr.write(`[agy-acp] Antigravity process error: ${describe(error)}\n`);
  });

  child.on('exit', (code, signal) => {
    childExited = true;
    const status = stopCode !== null ? stopCode : exitCodeFor(code, signal);
    // Let the remaining stdout bytes reach Cindy, but don't wait forever for pipes
    // that a grandchild may still hold open.
    const closeTimer = setTimeout(() => finish(status), FLUSH_TIMEOUT_MS);
    child.once('close', () => {
      clearTimeout(closeTimer);
      finish(status);
    });
  });

  // Backpressure-aware relay: completes the single `initialize` response with
  // `mcpCapabilities.http: true` when omitted so Cindy passes its local HTTP MCP bridge
  // (cindy_helper, cindy_orca, orca_worker_bridge) to agy, then passes all chunks raw.
  let initId;
  let initSettled = false;
  let stdinPending = [];
  let stdinPendingBytes = 0;
  let stdinOversized = false;

  const onStdinData = (chunk) => {
    if (initSettled || initId !== undefined) return;
    let start = 0;
    let index;
    while ((index = chunk.indexOf(0x0a, start)) !== -1) {
      const piece = chunk.subarray(start, index);
      start = index + 1;
      if (stdinOversized) {
        stdinOversized = false;
        stdinPending = [];
        stdinPendingBytes = 0;
        continue;
      }
      const line = stdinPending.length ? Buffer.concat([...stdinPending, piece]) : piece;
      stdinPending = [];
      stdinPendingBytes = 0;
      if (!line.length) continue;
      const message = parseJsonObject(line);
      if (message && message.method === 'initialize' && message.id !== undefined) {
        initId = message.id;
        process.stdin.off('data', onStdinData);
        return;
      }
      if (message && typeof message.method === 'string' && message.method !== 'initialize') {
        initSettled = true;
        process.stdin.off('data', onStdinData);
        return;
      }
    }
    if (start < chunk.length && !stdinOversized) {
      const rest = chunk.subarray(start);
      stdinPendingBytes += rest.length;
      if (stdinPendingBytes > MAX_HANDSHAKE_LINE_BYTES) {
        stdinOversized = true;
        stdinPending = [];
        stdinPendingBytes = 0;
      } else {
        stdinPending.push(rest);
      }
    }
  };

  let stdoutPending = [];
  let stdoutPendingBytes = 0;
  let stdoutOversized = false;
  let stdoutInspectedLines = 0;
  stdoutRelay = new Transform({
    transform(chunk, _encoding, callback) {
      if (initSettled) {
        if (stdoutPending.length) {
          this.push(Buffer.concat(stdoutPending));
          stdoutPending = [];
          stdoutPendingBytes = 0;
        }
        callback(null, chunk);
        return;
      }
      let start = 0;
      let index;
      while ((index = chunk.indexOf(0x0a, start)) !== -1) {
        const piece = chunk.subarray(start, index);
        start = index + 1;
        if (stdoutOversized) {
          stdoutOversized = false;
          this.push(Buffer.concat([piece, NEWLINE]));
          stdoutInspectedLines += 1;
          if (stdoutInspectedLines >= MAX_HANDSHAKE_LINES) {
            initSettled = true;
            process.stdin.off('data', onStdinData);
            stdinPending = [];
            stdinPendingBytes = 0;
            if (start < chunk.length) this.push(chunk.subarray(start));
            callback();
            return;
          }
          continue;
        }
        const line = stdoutPending.length ? Buffer.concat([...stdoutPending, piece]) : piece;
        stdoutPending = [];
        stdoutPendingBytes = 0;
        stdoutInspectedLines += 1;
        const message = line.length ? parseJsonObject(line) : null;
        if (message && initId !== undefined && message.id === initId && !('method' in message)) {
          initSettled = true;
          process.stdin.off('data', onStdinData);
          stdinPending = [];
          stdinPendingBytes = 0;
          if (message.result && typeof message.result === 'object' && !Array.isArray(message.result)) {
            const completed = { ...message, result: completeLocalInitializeResult(message.result) };
            this.push(Buffer.from(JSON.stringify(completed) + '\n', 'utf8'));
          } else {
            this.push(Buffer.concat([line, NEWLINE]));
          }
          if (start < chunk.length) this.push(chunk.subarray(start));
          callback();
          return;
        }
        this.push(Buffer.concat([line, NEWLINE]));
        if (stdoutInspectedLines >= MAX_HANDSHAKE_LINES) {
          initSettled = true;
          process.stdin.off('data', onStdinData);
          stdinPending = [];
          stdinPendingBytes = 0;
          if (start < chunk.length) this.push(chunk.subarray(start));
          callback();
          return;
        }
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        if (stdoutOversized) {
          this.push(rest);
        } else if (stdoutPendingBytes + rest.length > MAX_HANDSHAKE_LINE_BYTES) {
          stdoutOversized = true;
          if (stdoutPending.length) {
            this.push(Buffer.concat(stdoutPending));
            stdoutPending = [];
            stdoutPendingBytes = 0;
          }
          this.push(rest);
        } else {
          stdoutPending.push(rest);
          stdoutPendingBytes += rest.length;
        }
      }
      callback();
    },
    flush(callback) {
      if (stdoutPending.length) {
        this.push(Buffer.concat(stdoutPending));
        stdoutPending = [];
        stdoutPendingBytes = 0;
      }
      callback();
    },
  });

  process.stdin.on('data', onStdinData);
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {
    // EPIPE after agy exited; the exit handler takes care of shutting down.
  });
  child.stdout.pipe(stdoutRelay).pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  process.stdin.on('end', () => {
    // pipe() has already ended agy's stdin; agy treats that as disconnect.
    if (childExited || forceTimer) return;
    forceTimer = setTimeout(terminate, STDIN_END_GRACE_MS);
    forceTimer.unref();
  });
  process.stdout.on('error', () => {
    // Cindy stopped reading: nobody can receive ACP output any more.
    stop('SIGTERM');
  });

  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  for (const signal of signals) process.on(signal, () => stop(signal));
  process.on('disconnect', () => stop('SIGTERM'));
  process.on('uncaughtException', (error) => {
    try {
      process.stderr.write(`[agy-acp] internal error: ${describe(error)}\n`);
    } catch {
      // ignore
    }
    stop('SIGTERM');
  });
  // Last line of defence for any exit path: never leave agy running.
  process.on('exit', () => {
    if (!childExited) killTree(child, 'SIGKILL');
  });
}

const NOT_FOUND_MESSAGE =
  '[agy-acp] The Antigravity CLI (agy) was not found on this computer. Install it from https://antigravity.google, then start the task again.';

/**
 * The project is on another computer: only an agy that is known to honour the restricted agent
 * may run the task. Any doubt ends here, before agy sees a single message.
 */
async function runRemoteWorkspace() {
  const found = await detectAgy();
  if (!found.path) {
    exitAfterStderr(NOT_FOUND_MESSAGE, NOT_FOUND_EXIT_CODE);
    return;
  }
  if (!found.available) {
    exitAfterStderr(`[agy-acp] The Antigravity CLI at ${found.path} could not be run (${found.detail || 'unknown reason'}).`, NOT_FOUND_EXIT_CODE);
    return;
  }
  if (!remoteWorkspace.versionSupported(found.version)) {
    exitAfterStderr(
      `[agy-acp] Antigravity ${found.version || '(unknown version)'} cannot run a task whose files are on another computer; it needs ${remoteWorkspace.MIN_VERSION.join('.')} or later. It was not started.`,
      remoteWorkspace.REMOTE_WORKSPACE_EXIT_CODE,
    );
    return;
  }
  remoteWorkspace.startRemoteWorkspace(found.path, {
    acpArgs: ACP_ARGS,
    spawnAgy,
    killTree,
    exitAfterStderr,
    describe,
    exitCodeFor,
    notFoundExitCode: NOT_FOUND_EXIT_CODE,
    timings: { stdinEndGrace: STDIN_END_GRACE_MS, signalGrace: SIGNAL_GRACE_MS, flush: FLUSH_TIMEOUT_MS },
  });
}

if (remoteWorkspace.isRemoteWorkspaceLaunch(process.argv)) {
  runRemoteWorkspace();
} else {
  const agyPath = resolveAgy();
  if (agyPath) run(agyPath);
  else exitAfterStderr(NOT_FOUND_MESSAGE, NOT_FOUND_EXIT_CODE);
}
