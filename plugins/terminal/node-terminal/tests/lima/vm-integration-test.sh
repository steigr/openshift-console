#!/bin/bash
# Runs INSIDE the Lima VM, as root. Exercises the privileged parts of the
# shim that unit tests / Docker's build sandbox can't reach: real setns(),
# real mount()/umount2(), real /etc/passwd|shadow|group writes, and the
# kill sweeps -- against a real Linux kernel.
#
# To approximate the pod/container boundary the shim is designed to cross
# (§6.4 of IMPLEMENTATION-PLAN.md: the CSI mount is visible at a
# container-local path only in the *container's* mount namespace, and must
# be resolved before setns(mnt) into the host), each session is launched
# inside `unshare --mount`, which gives it its own mount namespace distinct
# from the VM's -- standing in for "the pod's container". The VM's own
# root namespaces stand in for "the host". PID/net/uts/ipc namespaces are
# intentionally left shared with the VM (matching hostPID: true, and this
# harness doesn't model hostNetwork/hostIPC) -- see README.md for what this
# does and doesn't cover relative to a real cluster.

set -u
SHIM=/root/citest/node-terminal-shim
PTY_RUN=/root/citest/pty_run.py
WORKDIR=/root/citest
PASS=0
FAIL=0

log() { echo "[vm-test] $*"; }
ok()  { PASS=$((PASS+1)); echo "[PASS] $*"; }
bad() { FAIL=$((FAIL+1)); echo "[FAIL] $*"; }

require_root() {
    if [ "$(id -u)" != "0" ]; then
        echo "must run as root" >&2
        exit 1
    fi
}

# Refuses to run against a VM with leftover k8s-sess-* state from a prior
# run (crashed test, manual debugging, etc). Tests below identify "their"
# session by diffing /etc/passwd before/after start_session -- stale
# entries wouldn't break that, but a stale *process* still holding a stale
# UID could shadow a real bug, so fail loudly instead of silently coexisting.
require_clean_state() {
    if grep -q '^k8s-sess-' /etc/passwd; then
        echo "leftover k8s-sess-* passwd entries from a prior run -- clean up before testing:" >&2
        grep '^k8s-sess-' /etc/passwd >&2
        exit 1
    fi
}

# Prints the set of k8s-sess-* usernames currently in /etc/passwd, one per line.
current_users() { grep '^k8s-sess-' /etc/passwd | cut -d: -f1 | sort; }

# Waits for exactly one new username to appear relative to a snapshot taken
# via current_users, and prints it. This is what lets each test identify
# *its own* session's passwd/home_dir instead of assuming it's the only (or
# first) k8s-sess-* entry present -- load-bearing once tests run
# concurrently or anything is left over from a previous run.
new_user_since() {
    local before="$1" timeout="$2"
    local waited=0
    while true; do
        local now diff
        now=$(current_users)
        diff=$(comm -13 <(echo "$before") <(echo "$now"))
        if [ -n "$diff" ]; then
            echo "$diff" | head -1
            return 0
        fi
        sleep 0.5
        waited=$(( waited + 1 ))
        if [ "$waited" -gt $(( timeout * 2 )) ]; then
            return 1
        fi
    done
}

# Sets up a fresh CSI-source fixture with known content, and launches one
# session inside its own mount namespace (the "container"). Prints the
# session's PID (of the `unshare` wrapper) to stdout and returns immediately
# -- the session itself runs in the background for the caller to observe.
#
# args: <label> <test_mode_duration_secs> <marker_content>
start_session() {
    local label="$1" duration="$2" content="$3"
    local src="$WORKDIR/src-$label"
    local logf="$WORKDIR/log-$label.txt"
    # The detached grandchild's marker file (session 2's test) is written
    # *through* the bind mount into this same host-side directory, so it
    # physically persists here after the session ends -- rm -rf first, or a
    # rerun with the same label picks up a stale marker (dead pid) left
    # over from a previous invocation instead of a fresh one.
    rm -rf "$src"
    mkdir -p "$src"
    # World-writable: the fixture dir is created as root, but once bind-
    # mounted it becomes the session's home dir, and test-worker (standing
    # in for a real login) drops privilege to the session's own ephemeral
    # (non-root) uid before writing its detached-process marker there --
    # without this, that write fails EACCES and silently never happens.
    chmod 0777 "$src"
    echo "$content" > "$src/marker.txt"

    setsid unshare --mount -- bash -c "
        mkdir -p /mnt/userhome-$label
        mount --bind '$src' /mnt/userhome-$label
        exec '$SHIM' --csi-path=/mnt/userhome-$label --test-mode=$duration
    " >"$logf" 2>&1 &
    echo $!
}

# Same idea as start_session, but WITHOUT --test-mode -- exercises the real
# agetty->login->PAM chain instead of the synthetic test-worker. This needs
# a real pty (agetty refuses to run without one), which `unshare --mount`
# alone doesn't provide, so the whole thing runs under pty_run.py -- see
# that file's header for why a plain `script` wrapper doesn't work
# non-interactively.
start_real_session() {
    local label="$1" duration="$2"
    local src="$WORKDIR/src-$label"
    local logf="$WORKDIR/log-$label.txt"
    local innerf="$WORKDIR/inner-$label.sh"
    rm -rf "$src"
    mkdir -p "$src"

    cat > "$innerf" <<INNER
#!/bin/bash
mkdir -p /mnt/userhome-$label
mount --bind '$src' /mnt/userhome-$label
exec '$SHIM' --csi-path=/mnt/userhome-$label
INNER
    chmod +x "$innerf"

    setsid python3 "$PTY_RUN" "$duration" unshare --mount -- "$innerf" >"$logf" 2>"$logf.stderr" &
}

wait_for() {
    # wait_for <description> <timeout_secs> <check-command...>
    local desc="$1" timeout="$2"; shift 2
    local waited=0
    while ! "$@" >/dev/null 2>&1; do
        sleep 0.5
        waited=$(( waited + 1 ))
        if [ "$waited" -gt $(( timeout * 2 )) ]; then
            bad "$desc (timed out after ${timeout}s)"
            return 1
        fi
    done
    return 0
}

# --- test 1: basic lifecycle -------------------------------------------
test_basic_lifecycle() {
    log "== test_basic_lifecycle =="
    local before uname home
    before=$(current_users)
    start_session lifecycle 6 "lifecycle-marker" >/dev/null

    if uname=$(new_user_since "$before" 5); then
        ok "passwd entry appeared ($uname)"
    else
        bad "session created a passwd entry (timed out after 5s)"
        return
    fi
    home="/home/$uname"

    if [ -f "$home/marker.txt" ] && grep -q lifecycle-marker "$home/marker.txt"; then
        ok "bind-mounted content visible under home_dir on host ($home/marker.txt)"
    else
        bad "expected $home/marker.txt with CSI-source content"
    fi

    grep -q "^${uname}:" /etc/shadow && ok "shadow entry present" || bad "shadow entry missing"
    grep -q "^${uname}:" /etc/group  && ok "group entry present"  || bad "group entry missing"

    # The concrete thing an operator actually cares about: while the
    # session is active, standard host tooling reveals it -- both the
    # identity itself (getent, reading the passwd/shadow/group entries this
    # tool just wrote) and a live process actually running as that
    # identity (ps), not just a passwd row with nothing behind it. Real
    # `who`/`w`/`last` visibility additionally requires the actual
    # agetty->login->PAM chain (utmp/wtmp registration), which --test-mode
    # deliberately bypasses -- see README.md's "what's not covered" section
    # for the manual `kubectl exec -it` + `who`/`last` verification step.
    if getent passwd "$uname" >/dev/null 2>&1; then
        ok "host tooling (getent) resolves the active session's identity"
    else
        bad "getent passwd $uname found nothing while the session should still be active"
    fi
    if ps -eo user:32,pid,cmd --no-headers | awk -v u="$uname" '$1==u{found=1} END{exit !found}'; then
        ok "host ps shows a live process actually running as $uname while the session is active"
    else
        bad "expected a live process owned by $uname visible via ps while the session is active"
    fi

    # session runs ~4s; give it time to finish + roll back
    wait_for "passwd entry removed after session end" 10 bash -c "! grep -q '^${uname}:' /etc/passwd" \
        && ok "passwd entry removed on rollback"
    wait_for "home dir removed after rollback" 5 bash -c "! [ -d '$home' ]" \
        && ok "home dir removed on rollback"

    if mount | grep -q "$home"; then
        bad "bind mount for $home still present after rollback"
    else
        ok "bind mount removed on rollback"
    fi
}

# --- test 2: SIGTERM mid-session kills a setsid-detached grandchild ------
test_sigterm_kills_detached_process() {
    log "== test_sigterm_kills_detached_process =="
    local before pid uname
    before=$(current_users)
    pid=$(start_session detach 30 "detach-marker")

    if ! uname=$(new_user_since "$before" 5); then
        bad "session created a passwd entry (timed out after 5s)"
        return
    fi

    local home marker_path detached_pid
    home="/home/$uname"
    marker_path="$home/.test-worker-detached-marker"

    if wait_for "detached grandchild wrote its pid marker" 10 test -f "$marker_path"; then
        detached_pid=$(cat "$marker_path" 2>/dev/null)
        ok "detached grandchild marker present (pid $detached_pid)"
    else
        bad "detached grandchild never wrote its marker"
        return
    fi

    if kill -0 "$detached_pid" 2>/dev/null; then
        ok "detached grandchild is alive before SIGTERM (sanity check)"
    else
        bad "detached grandchild already dead before SIGTERM -- test invalid"
    fi

    # Simulate `kubectl exec` disconnecting / pod deletion signaling the
    # container: SIGTERM the shim's own process group.
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null

    wait_for "passwd entry removed after SIGTERM" 10 bash -c "! grep -q '^${uname}:' /etc/passwd" \
        && ok "rollback triggered by SIGTERM"

    sleep 1
    if kill -0 "$detached_pid" 2>/dev/null; then
        bad "detached grandchild (pid $detached_pid) survived rollback -- §8.1 pgid-kill alone would miss this, §8.2/8.3 sweeps should have caught it"
    else
        ok "detached grandchild killed by uid/path-ref sweep, not just pgid kill"
    fi
}

# --- test 3: two concurrent sessions get distinct, non-colliding state ---
test_concurrent_sessions() {
    log "== test_concurrent_sessions =="
    start_session concurrent-a 5 "a-marker" >/dev/null
    start_session concurrent-b 5 "b-marker" >/dev/null

    wait_for "two passwd entries present" 5 bash -c '[ "$(grep -c "^k8s-sess-" /etc/passwd)" -ge 2 ]'
    local count
    count=$(grep -c '^k8s-sess-' /etc/passwd)
    if [ "$count" -ge 2 ]; then
        ok "two concurrent sessions got two distinct passwd entries (count=$count)"
    else
        bad "expected >=2 concurrent passwd entries, got $count"
    fi

    local uids
    uids=$(grep '^k8s-sess-' /etc/passwd | cut -d: -f3 | sort -u | wc -l)
    if [ "$uids" -eq "$count" ]; then
        ok "no UID collision across concurrent sessions"
    else
        bad "UID collision detected across concurrent sessions"
    fi

    wait_for "both sessions rolled back" 10 bash -c '! grep -q "^k8s-sess-" /etc/passwd' \
        && ok "both concurrent sessions cleaned up"
}

# --- test 4: resolve_src failure aborts before touching any state -------
test_resolve_src_failure_touches_nothing() {
    log "== test_resolve_src_failure_touches_nothing =="
    local before_passwd before_homes
    before_passwd=$(md5sum /etc/passwd | cut -d' ' -f1)
    before_homes=$(ls -d /home/k8s-sess-* 2>/dev/null | sort)

    unshare --mount -- "$SHIM" --csi-path=/mnt/does-not-exist --test-mode=1 >"$WORKDIR/log-badpath.txt" 2>&1
    local rc=$?

    if [ "$rc" -ne 0 ]; then
        ok "shim exits nonzero when csi-path doesn't resolve"
    else
        bad "shim exited 0 despite an unresolvable csi-path"
    fi

    local after_passwd
    after_passwd=$(md5sum /etc/passwd | cut -d' ' -f1)
    if [ "$before_passwd" = "$after_passwd" ]; then
        ok "passwd untouched when resolve_src fails before any state was created"
    else
        bad "passwd was modified even though resolve_src should have failed first"
    fi

    # Diff against the pre-existing set (rather than asserting none exist at
    # all) so this test stays correct even if run after a test that leaves
    # its own home dir around -- it only cares that *this* call didn't add one.
    local after_homes new_homes
    after_homes=$(ls -d /home/k8s-sess-* 2>/dev/null | sort)
    new_homes=$(comm -13 <(echo "$before_homes") <(echo "$after_homes"))
    if [ -z "$new_homes" ]; then
        ok "no home dir created despite resolve_src failure"
    else
        bad "a home dir was created despite resolve_src failure: $new_homes"
    fi
}

# --- test 5: real agetty->login->PAM chain registers in utmp (who) -------
test_real_login_visible_via_who() {
    log "== test_real_login_visible_via_who =="
    local before uname
    before=$(current_users)
    start_real_session realauth 20

    if ! uname=$(new_user_since "$before" 8); then
        bad "real session created a passwd entry (timed out after 8s)"
        return
    fi
    ok "passwd entry appeared ($uname)"

    if wait_for "who reports the active session" 8 bash -c "who | grep -q '^${uname} '"; then
        ok "who reports the active session -- confirms the real agetty->login->PAM chain (not just --test-mode) registers in utmp"
    else
        bad "who never showed $uname despite the session being active (agetty/login may have failed -- see $WORKDIR/log-realauth.txt)"
    fi

    # Informational only, not asserted: `w` has been observed in this VM to
    # NOT surface the session even while `who` does and utmpdump shows a
    # correct USER_PROCESS entry -- looks like a procps `w` quirk around a
    # stale duplicate agetty-owned utmp line sharing the same truncated
    # `ut_id`, not something this tool controls. `who` is the authoritative
    # check above; this is just visibility into whether that quirk is still
    # present.
    if w | grep -q "$uname"; then
        log "(informational) w also reports $uname"
    else
        log "(informational) w does NOT report $uname -- who remains authoritative for this check"
    fi

    local shim_pid
    shim_pid=$(pgrep -f -- "--csi-path=/mnt/userhome-realauth" | head -1)
    if [ -z "$shim_pid" ]; then
        bad "could not find the running shim process to signal (already exited?)"
        return
    fi
    # Simulate `kubectl exec` disconnecting / pod deletion signaling the
    # container, same as test 2 -- but this time tearing down a real
    # agetty/login/shell chain, not the synthetic test-worker.
    kill -TERM "$shim_pid" 2>/dev/null

    wait_for "passwd entry removed after SIGTERM" 10 bash -c "! grep -q '^${uname}:' /etc/passwd" \
        && ok "rollback triggered by SIGTERM on the real agetty/login/shell chain"

    if who | grep -q "^${uname} "; then
        bad "who still shows $uname after rollback"
    else
        ok "who no longer shows $uname after rollback"
    fi
}

require_root
require_clean_state
test_basic_lifecycle
test_sigterm_kills_detached_process
test_concurrent_sessions
test_resolve_src_failure_touches_nothing
test_real_login_visible_via_who

echo
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
