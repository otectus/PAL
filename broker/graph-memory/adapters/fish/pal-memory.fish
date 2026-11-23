# Source this file from config.fish. Handlers are installed immediately and emit no command lines.
if set -q __pal_memory_loaded
    return
end
set -g __pal_memory_loaded 1

if status is-interactive
    if not set -q PAL_MEMORY_EMITTER
        if set -q CERE_MEMORY_EMITTER; and test -x "$CERE_MEMORY_EMITTER"
            set -gx PAL_MEMORY_EMITTER "$CERE_MEMORY_EMITTER"
        else
            set -gx PAL_MEMORY_EMITTER (path resolve (status dirname)/pal-memory-emitter.py)
            if not test -x "$PAL_MEMORY_EMITTER"; and test -x (path resolve (status dirname)/cere-memory-emitter.py)
                set -gx PAL_MEMORY_EMITTER (path resolve (status dirname)/cere-memory-emitter.py)
            end
        end
    end
    if test -x "$PAL_MEMORY_EMITTER"
        set -g __pal_memory_session (command "$PAL_MEMORY_EMITTER" --print-session-id 2>/dev/null)
        set -g __pal_memory_sequence 0

        function __pal_memory_emit
            set -g __pal_memory_sequence (math $__pal_memory_sequence + 1)
            set -l pal_binding
            if set -q KITTY_WINDOW_ID
                set pal_binding --kitty-window-id "$KITTY_WINDOW_ID"
            end
            command "$PAL_MEMORY_EMITTER" --event $argv[1] --session-id "$__pal_memory_session" \
                --sequence $__pal_memory_sequence --cwd "$PWD" $argv[2..] $pal_binding >/dev/null 2>&1 &
        end

        function __pal_memory_pwd --on-variable PWD
            __pal_memory_emit cwd
        end

        function __pal_memory_preexec --on-event fish_preexec
            # The event's command argument is deliberately ignored.
            true
        end

        function __pal_memory_postexec --on-event fish_postexec
            set -l pal_status_snapshot $status $pipestatus
            set -l pal_status $pal_status_snapshot[1]
            set -l pal_pipeline $pal_status_snapshot[2..]
            set -l pal_args --status $pal_status --duration-ms "$CMD_DURATION"
            for value in $pal_pipeline
                set -a pal_args --pipeline-status $value
            end
            __pal_memory_emit postexec $pal_args
            return $pal_status
        end

        function __pal_memory_posterror --on-event fish_posterror
            set -l pal_status_snapshot $status $pipestatus
            set -l pal_status $pal_status_snapshot[1]
            set -l pal_pipeline $pal_status_snapshot[2..]
            set -l pal_args --status $pal_status --duration-ms "$CMD_DURATION"
            for value in $pal_pipeline
                set -a pal_args --pipeline-status $value
            end
            __pal_memory_emit posterror $pal_args
            return $pal_status
        end

        function __pal_memory_focus_in --on-event fish_focus_in
            __pal_memory_emit focus_in
        end

        function __pal_memory_focus_out --on-event fish_focus_out
            __pal_memory_emit focus_out
        end

        function __pal_memory_exit --on-event fish_exit
            set -l pal_status_snapshot $status $pipestatus
            __pal_memory_emit exit --status $pal_status_snapshot[1]
        end

        __pal_memory_emit start
    end
end
