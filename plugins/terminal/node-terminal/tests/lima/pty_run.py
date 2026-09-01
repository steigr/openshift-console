#!/usr/bin/env python3
# Runs a command with a real pty attached as its stdio, and keeps the pty
# master persistently open (draining it) for a fixed duration -- unlike
# `script`, which tears the pty down the moment ITS OWN stdin (inherited
# from a non-interactive SSH exec, not a live terminal) hits EOF, closing
# the master out from under a still-running login session and producing
# "Input/output error" on its side. A real `kubectl exec -it` keeps a live
# bidirectional stream open for the session's duration, so this class of
# failure never happens in production -- this script exists purely to give
# a headless test harness the same "someone is holding the other end open"
# property, so the real login->PAM path (as opposed to --test-mode, which
# bypasses it) can be exercised at all.
#
# Usage: pty_run.py <duration_secs> <command> [args...]
# Prints "[pty_run] child_pid=<pid>" to stderr immediately (before the
# command necessarily produces any output), so a caller running this in
# the background can pick the pid up without waiting for the full
# duration. The pty's own output is relayed to stdout as it arrives.
import os
import selectors
import sys
import time

duration = float(sys.argv[1])
cmd = sys.argv[2:]

master_fd, slave_fd = os.openpty()

pid = os.fork()
if pid == 0:
    os.close(master_fd)
    # Deliberately does NOT call setsid()/TIOCSCTTY here: the shim's own
    # forked child (deep in the exec chain this launches -- see
    # mountns_claim_ctty(), called from session_spawn_and_wait right before
    # its exec into login) needs to be the FIRST process to claim this pty
    # as its controlling terminal, exactly the real
    # kubectl-exec-attaches-a-fresh-pty scenario this is standing in for.
    # Claiming it here first would leave the tty already "owned" by this
    # process's session by the time the shim's child gets to it, and ITS
    # TIOCSCTTY claim would then need to steal from a different session
    # than the one it inherited -- the same class of tty-ownership problem
    # mountns_claim_ctty's own doc comment describes for agetty/login's own
    # (now-avoided) internal claim attempts.
    os.dup2(slave_fd, 0)
    os.dup2(slave_fd, 1)
    os.dup2(slave_fd, 2)
    if slave_fd > 2:
        os.close(slave_fd)
    os.execvp(cmd[0], cmd)
    os._exit(127)

os.close(slave_fd)
sys.stderr.write(f"[pty_run] child_pid={pid}\n")
sys.stderr.flush()

sel = selectors.DefaultSelector()
sel.register(master_fd, selectors.EVENT_READ)
deadline = time.time() + duration
out = []
while time.time() < deadline:
    for _key, _ in sel.select(timeout=0.2):
        try:
            chunk = os.read(master_fd, 4096)
        except OSError:
            chunk = b""
        if chunk:
            out.append(chunk)
        else:
            deadline = 0  # EOF: child's side closed, stop early
            break
    try:
        wpid, _status = os.waitpid(pid, os.WNOHANG)
        if wpid == pid:
            break
    except ChildProcessError:
        break

sys.stdout.buffer.write(b"".join(out))
sys.stdout.flush()
