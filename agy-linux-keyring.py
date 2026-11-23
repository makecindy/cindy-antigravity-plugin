#!/usr/bin/python3
"""Own one Linux Secret Service per Cindy-managed Antigravity account."""

import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

UID = os.getuid()
DIRS = ("home", "config", "data", "state", "cache")
BUS_CONFIG = (
    '<busconfig><type>session</type><listen>unix:path={socket}</listen>'
    '<policy context="default"><allow own="*"/><allow send_destination="*"/>'
    '<allow receive_sender="*"/></policy></busconfig>'
)


def checked(path, predicate):
    info = path.lstat()
    if path != path.resolve() or not predicate(info.st_mode) or info.st_uid != UID or info.st_mode & 0o077:
        raise ValueError("Expected a private path belonging to the current Linux user.")
    return info


def private_dir(path):
    path.mkdir(mode=0o700, exist_ok=True)
    return checked(path, stat.S_ISDIR)


def private_file(path, flags, mode):
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != UID or info.st_mode & 0o077:
        os.close(fd)
        raise ValueError("Expected a private regular keyring file.")
    # gnome-keyring-daemon inherits the descriptor, including its kernel file offset.
    return os.fdopen(fd, mode, buffering=0)


def stop(child):
    if child and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def keyring_ready(bus_address, daemon):
    check = subprocess.run(
        ["/usr/bin/gdbus", "call", "--address", bus_address, "--dest", "org.freedesktop.DBus",
         "--object-path", "/org/freedesktop/DBus", "--method",
         "org.freedesktop.DBus.GetConnectionUnixProcessID", "org.freedesktop.secrets"],
        capture_output=True, text=True, timeout=1,
    )
    return check.returncode == 0 and check.stdout.strip() == f"(uint32 {daemon.pid},)"


def wait_for(test, child):
    deadline = time.monotonic() + 2.5
    while child.poll() is None and time.monotonic() < deadline:
        if test():
            return
        time.sleep(0.05)
    raise RuntimeError("The private keyring did not become ready.")


def serve(profile, original):
    marker = profile / "keyring-bus"
    marker.unlink(missing_ok=True)
    for name in DIRS:
        private_dir(profile / name)
    with private_file(profile / "unlock", os.O_RDWR | os.O_CREAT, "r+b") as password:
        if not password.read(1):
            password.write(secrets.token_hex(32).encode("ascii"))
            password.flush()
            os.fsync(password.fileno())
        password.seek(0)
        with tempfile.TemporaryDirectory(prefix="cindy-agy-", dir="/tmp") as runtime:
            socket = Path(runtime) / "bus"
            env = {"HOME": str(profile / "home"), "XDG_RUNTIME_DIR": runtime}
            env.update({f"XDG_{name.upper()}_HOME": str(profile / name) for name in DIRS[1:]})
            conf = Path(runtime) / "bus.conf"
            conf.write_text(BUS_CONFIG.format(socket=socket), encoding="utf8")
            bus = daemon = None
            try:
                bus = subprocess.Popen(["/usr/bin/dbus-daemon", f"--config-file={conf}", "--nofork"], env=env)
                wait_for(socket.is_socket, bus)
                socket.chmod(0o600)
                address = "unix:path=" + str(socket)
                env["DBUS_SESSION_BUS_ADDRESS"] = address
                daemon = subprocess.Popen(
                    ["/usr/bin/gnome-keyring-daemon", "--foreground", "--unlock",
                     "--components=secrets", "--control-directory", runtime + "/keyring"],
                    env=env, stdin=password, stdout=subprocess.DEVNULL,
                )
                wait_for(lambda: keyring_ready(address, daemon), daemon)
                with tempfile.NamedTemporaryFile(mode="w", dir=profile, delete=False) as ready:
                    json.dump({"socket": str(socket), "profile": list(original)}, ready)
                    stage = Path(ready.name)
                try:
                    stage.replace(marker)
                finally:
                    stage.unlink(missing_ok=True)
                while bus.poll() is None and daemon.poll() is None:
                    try:
                        current = profile.lstat()
                    except FileNotFoundError:
                        break  # Cindy removed this account.
                    if (current.st_dev, current.st_ino) != original:
                        break
                    time.sleep(0.5)
            finally:
                try:
                    current = profile.lstat()
                    if (current.st_dev, current.st_ino) == original:
                        marker.unlink(missing_ok=True)
                except FileNotFoundError:
                    pass
                stop(daemon)
                stop(bus)


def import_keyring(profile, source):
    """Seed an empty profile using encrypted GNOME keyring files from an existing private profile."""
    checked(source, stat.S_ISDIR)
    source_data = source / "data" / "keyrings"
    checked(source_data, stat.S_ISDIR)
    unlock = source / "unlock"
    checked(unlock, stat.S_ISREG)
    files = sorted(p for p in source_data.iterdir()
                   if p.suffix == ".keyring" or p.name in ("default", "user.keystore"))
    if not any(p.suffix == ".keyring" for p in files):
        raise ValueError("The source profile has no native keyring.")
    if (profile / "unlock").exists() or (profile / "data" / "keyrings").exists():
        raise ValueError("Import requires an empty account profile.")
    for file in files:
        checked(file, stat.S_ISREG)
    private_dir(profile / "data")
    with tempfile.TemporaryDirectory(dir=profile) as tmp:
        stage = Path(tmp)
        keys = stage / "keyrings"
        keys.mkdir(mode=0o700)
        for source_file, target in [(unlock, stage / "unlock"), *((f, keys / f.name) for f in files)]:
            with private_file(source_file, os.O_RDONLY, "rb") as src, private_file(
                target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, "wb"
            ) as dst:
                shutil.copyfileobj(src, dst)
        keys.rename(profile / "data" / "keyrings")
        try:
            (stage / "unlock").rename(profile / "unlock")
        except OSError:
            shutil.rmtree(profile / "data" / "keyrings")
            raise


def main():
    action, raw, *args = sys.argv[1:]
    profile = Path(raw)
    info = checked(profile, stat.S_ISDIR)
    with private_file(profile / "keyring.lock", os.O_RDWR | os.O_CREAT, "r+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if action == "serve":
                return  # Another harness or worker is already starting or running this keyring.
            raise ValueError("Stop the profile's keyring before importing.")
        if action == "serve" and not args:
            serve(profile, (info.st_dev, info.st_ino))
        elif action == "import" and not args:
            source = sys.stdin.readline(4097).rstrip("\n")
            if not source.startswith("/") or len(source) > 4096:
                raise ValueError("An absolute source profile path is required.")
            import_keyring(profile, Path(source))
        else:
            raise ValueError("Use serve ACCOUNT_DIR or pass the source path to import ACCOUNT_DIR over stdin.")


def terminate(_signal, _frame):
    raise SystemExit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate)
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Antigravity profile: {error}", file=sys.stderr)
        sys.exit(1)
