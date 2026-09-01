#define _GNU_SOURCE
#include "session.h"
#include "log.h"
#include "signals.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

int session_phase_agetty_exec(const char *username) {
    const char *term = getenv("TERM");
    if (!term) term = "xterm-256color";
    /* "-" tells agetty to trust the fd it already has as the tty, rather
     * than opening a device by path itself. That fd is, by this point,
     * already a fresh open of mountns_bind_ctty's host-mount-namespace-
     * valid alias (see its own doc comment) - re-pointed onto fd 0/1/2 by
     * the shim's own top-level process, before this one was ever forked,
     * specifically so agetty (and login/PAM after it) never has to open or
     * explicitly claim (setsid + TIOCSCTTY) the line itself: doing that
     * itself reliably fails with EPERM ("cannot get controlling tty") in
     * this environment, for reasons that didn't resolve to any single
     * namespace switch under isolated testing. Inheriting an
     * already-correct, already-claimed controlling terminal via plain
     * fork() sidesteps that path entirely. The full agetty -> /sbin/login
     * -> PAM chain still runs, so utmp/wtmp and pam_lastlog behave as a
     * real interactive login would.
     *
     * termtype is a trailing POSITIONAL argument here
     * (`agetty [options] <line> [<baud_rate>] [<termtype>]`), not a flag --
     * util-linux agetty has no `--term`/`-T` long option at all (confirmed
     * against util-linux 2.39.3's --help); passing it as `--term <val>`
     * makes agetty reject the whole invocation with "unrecognized option". */
    /* TEMP diagnostic - to be removed once root-caused. */
    shim_log("session_phase_agetty_exec: pre-exec pid=%d pgrp=%d sid=%d tcgetpgrp=%d",
             (int)getpid(), (int)getpgrp(), (int)getsid(0), (int)tcgetpgrp(STDIN_FILENO));
    execlp("agetty", "agetty", "--autologin", username,
           "--local-line", "--noclear", "-", "38400", term, (char *)NULL);
    shim_logerr("session_phase_agetty_exec: execlp agetty");
    return 1;
}

int session_phase_test_worker(const char *home_dir, int duration_secs, uid_t uid, gid_t gid) {
    /* A real session gets here via agetty -> /sbin/login -> PAM, which
     * drops privilege to the target ephemeral user before running
     * anything -- so every descendant of the real session, detached or
     * not, carries that user's real UID, which is what makes
     * cleanup_kill_by_uid() (§8.2) authoritative. This synthetic
     * stand-in has to do the same drop itself (gid then uid, standard
     * order) or the kill-by-UID sweep has nothing real to test against.
     * uid/gid are passed explicitly rather than recovered via
     * stat(home_dir): mountns_mkdir_home() does chown() the directory,
     * but mountns_bind_mount() immediately shadows that with the CSI
     * source's own ownership, so by the time this phase runs, stat()
     * would report the fixture's ownership (root, in the integration
     * tests), not the session's. */
    if (setgid(gid) != 0) {
        shim_logerr("session_phase_test_worker: setgid(%u)", (unsigned)gid);
        return 1;
    }
    if (setuid(uid) != 0) {
        shim_logerr("session_phase_test_worker: setuid(%u)", (unsigned)uid);
        return 1;
    }

    /* Deliberately detach a grandchild via setsid() to simulate a
     * nohup'd/daemonized process that escapes the session's process group
     * (§8.1's blind spot) -- integration tests use this to verify the
     * kill-by-UID and kill-by-mountpoint sweeps (§8.2/§8.3) still catch it. */
    pid_t detached = fork();
    if (detached == 0) {
        setsid();
        char marker[512];
        snprintf(marker, sizeof(marker), "%s/.test-worker-detached-marker", home_dir);
        int fd = open(marker, O_CREAT | O_WRONLY | O_TRUNC, 0600);
        if (fd >= 0) {
            char pidbuf[32];
            int len = snprintf(pidbuf, sizeof(pidbuf), "%d\n", getpid());
            if (write(fd, pidbuf, (size_t)len) < 0) { /* best-effort marker write */ }
            close(fd);
        } else {
            shim_logerr("session_phase_test_worker: open(%s)", marker);
        }
        /* Sleep well beyond the parent's own duration so a sweep that only
         * targets the session pgid would leave this process alive. */
        sleep((unsigned)(duration_secs > 0 ? duration_secs * 10 : 60));
        _exit(0);
    }
    sleep((unsigned)(duration_secs > 0 ? duration_secs : 5));
    return 0;
}

int session_spawn_and_wait(session_ctx_t *ctx) {
    pid_t pid = fork();
    if (pid < 0) {
        shim_logerr("session_spawn_and_wait: fork");
        return -1;
    }
    if (pid == 0) {
        if (ctx->test_mode) {
            /* Only needed here: the real path's agetty calls setsid()
             * itself to become the pty's session leader (standard agetty
             * behavior, needed to properly acquire the controlling
             * terminal and its foreground process group) -- and setsid()
             * fails with EPERM if the caller is already a process-group
             * leader. Calling setpgid(0,0) here first would make agetty's
             * own setsid() fail, leaving it without a controlling terminal
             * and stuck stopped on SIGTTOU the first time it touches the
             * tty. test-mode has no real tty to fight over, so it's safe
             * (and still wanted, for the §8.1 fast-path pgid kill) here. */
            if (setpgid(0, 0) != 0) {
                shim_logerr("session_spawn_and_wait: setpgid (child)");
                _exit(1);
            }
        }
        char *argv[7];
        if (ctx->test_mode) {
            char durbuf[16], uidbuf[16], gidbuf[16];
            snprintf(durbuf, sizeof(durbuf), "%d", ctx->test_duration_secs);
            snprintf(uidbuf, sizeof(uidbuf), "%u", (unsigned)ctx->uid);
            snprintf(gidbuf, sizeof(gidbuf), "%u", (unsigned)ctx->gid);
            argv[0] = (char *)"/proc/self/exe";
            argv[1] = (char *)"--phase=test-worker";
            argv[2] = ctx->home_dir;
            argv[3] = durbuf;
            argv[4] = uidbuf;
            argv[5] = gidbuf;
            argv[6] = NULL;
            /* /proc/self/exe is bound to the executable's inode, not a
             * path lookup -- it keeps resolving correctly after
             * setns(mnt), where the container's own path no longer exists
             * (§5.1). Static linking means execve here needs no ELF
             * interpreter resolution in the new mount namespace either. */
            execve("/proc/self/exe", argv, environ);
        } else {
            /* TEMP diagnostic - to be removed once root-caused. */
            shim_log("session_spawn_and_wait: post-fork child pid=%d pgrp=%d sid=%d tcgetpgrp=%d",
                     (int)getpid(), (int)getpgrp(), (int)getsid(0), (int)tcgetpgrp(STDIN_FILENO));
            char *aargv[4] = { (char *)"/proc/self/exe", (char *)"--phase=agetty-exec", ctx->username, NULL };
            execve("/proc/self/exe", aargv, environ);
        }
        shim_logerr("session_spawn_and_wait: execve /proc/self/exe");
        _exit(1);
    }

    ctx->session_pid = pid;
    ctx->session_pgid = pid; /* child set its own pgid to its own pid */

    int status = 0;
    for (;;) {
        pid_t r = waitpid(pid, &status, 0);
        if (r == pid) break;
        if (r < 0 && errno == EINTR) {
            if (g_termination_requested) {
                shim_log("session_spawn_and_wait: termination requested, ending session");
                return -1; /* caller proceeds straight to rollback/kill sweep */
            }
            continue;
        }
        if (r < 0) {
            shim_logerr("session_spawn_and_wait: waitpid");
            return -1;
        }
    }
    return status;
}
