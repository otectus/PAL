# PAL telemetry v1. PROMPT_COMMAND is prepended without replacing other entries.
[[ $- == *i* ]] || return 0
[[ ${__pal_hook_pid-} != "$$" ]] || return 0
__pal_hook_pid=$$
IFS= read -r __pal_session < /proc/sys/kernel/random/uuid
__pal_seq=0
: "${PAL_REPORT:=pal-report}"
: "${PAL_RUN:=pal-run}"
__pal_prompt() {
    local pal_status=$?
    local pal_line='' pal_number='' HISTTIMEFORMAT=''
    if [[ ${__pal_wrapped-} ]]; then unset __pal_wrapped; return "$pal_status"; fi
    if [[ ${__pal_command-} ]]; then pal_line=$__pal_command; unset __pal_command
    else
        IFS=' ' read -r pal_number pal_line <<< "$(builtin history 1)"
        if [[ $pal_number == "${__pal_history_id-}" ]]; then pal_line=''; fi
        __pal_history_id=$pal_number
    fi
    __pal_seq=$((__pal_seq+1))
    { command "$PAL_REPORT" "$__pal_session" "$__pal_seq" "$$" "$PWD" "$pal_status" "$pal_line" '' & disown "$!"; } >/dev/null 2>&1
    return "$pal_status"
}
__pal_preexec() { local pal_status=$?; __pal_command=$1; return "$pal_status"; }
pal-run() {
    __pal_seq=$((__pal_seq+2)); __pal_wrapped=1
    command "$PAL_RUN" --run "$__pal_session" "$((__pal_seq-1))" "$$" "$PWD" "$@"
    return $?
}
if declare -p precmd_functions >/dev/null 2>&1 && declare -F __bp_precmd_invoke_cmd >/dev/null 2>&1; then
    precmd_functions=(__pal_prompt "${precmd_functions[@]}")
    preexec_functions+=(__pal_preexec)
elif [[ $(declare -p PROMPT_COMMAND 2>/dev/null) =~ ^declare\ -[^[:space:]]*a ]]; then
    PROMPT_COMMAND=(__pal_prompt "${PROMPT_COMMAND[@]}")
else
    PROMPT_COMMAND="__pal_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
