# PAL telemetry v1. Source only; never modifies shell history.
if not status is-interactive
    return
end
if set -q __pal_hook_pid; and test "$__pal_hook_pid" = "$fish_pid"
    return
end
set -g __pal_hook_pid $fish_pid
read -l pal_uuid < /proc/sys/kernel/random/uuid
set -g __pal_session $pal_uuid
set -g __pal_seq 0
if not set -q PAL_REPORT
    set -g PAL_REPORT pal-report
end
if not set -q PAL_RUN
    set -g PAL_RUN pal-run
end
function __pal_postexec --on-event fish_postexec
    set -l pal_snapshot $status $pipestatus
    if set -q __pal_wrapped
        set -e __pal_wrapped
        return $pal_snapshot[1]
    end
    set -g __pal_seq (math $__pal_seq + 1)
    begin
        command "$PAL_REPORT" "$__pal_session" "$__pal_seq" "$fish_pid" "$PWD" "$pal_snapshot[1]" "$argv[1]" "" &
        disown $last_pid
    end >/dev/null 2>&1
    return $pal_snapshot[1]
end
function pal-run
    set -g __pal_seq (math $__pal_seq + 2)
    set -g __pal_wrapped 1
    command "$PAL_RUN" --run "$__pal_session" (math $__pal_seq - 1) "$fish_pid" "$PWD" $argv
    return $status
end
