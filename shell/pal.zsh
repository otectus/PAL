# PAL telemetry v1.
[[ -o interactive ]] || return 0
[[ ${__pal_hook_pid-} != $$ ]] || return 0
typeset -g __pal_hook_pid=$$
IFS= read -r __pal_session < /proc/sys/kernel/random/uuid
typeset -g __pal_seq=0
: ${PAL_REPORT:=pal-report}
: ${PAL_RUN:=pal-run}
autoload -Uz add-zsh-hook
__pal_preexec() { local pal_status=$?; typeset -g __pal_command=$1; return $pal_status; }
__pal_precmd() {
    local pal_status=$?
    if [[ -n ${__pal_wrapped-} ]]; then unset __pal_wrapped; return $pal_status; fi
    __pal_seq=$((__pal_seq+1))
    command "$PAL_REPORT" "$__pal_session" "$__pal_seq" "$$" "$PWD" "$pal_status" "${__pal_command-}" '' >/dev/null 2>&1 &!
    unset __pal_command
    return $pal_status
}
pal-run() {
    __pal_seq=$((__pal_seq+2)); typeset -g __pal_wrapped=1
    command "$PAL_RUN" --run "$__pal_session" "$((__pal_seq-1))" "$$" "$PWD" "$@"
    return $?
}
add-zsh-hook preexec __pal_preexec
add-zsh-hook precmd __pal_precmd
# Run first so the captured status belongs to the user command.
precmd_functions=(__pal_precmd ${precmd_functions:#__pal_precmd})
