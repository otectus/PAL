" Vim: source this file to tell PAL which document is open, saved or closed. Only the path goes out, to PAL's own
" socket, and PAL keeps it only inside folders you approved. Text is never sent.
if exists('g:pal_memory_loaded') || !has('job') | finish | endif
let g:pal_memory_loaded = 1
let s:emitter = empty($PAL_MEMORY_EDITOR) ? expand('<sfile>:p:h') . '/pal-memory-editor.py' : $PAL_MEMORY_EDITOR
if !executable(s:emitter) | finish | endif
let s:session = trim(system(shellescape(s:emitter) . ' --print-session-id'))
let s:sequence = 0

function! s:Emit(event, path) abort
  let s:sequence += 1
  let l:command = [s:emitter, '--event', a:event, '--session-id', s:session, '--sequence', string(s:sequence), '--editor', 'Vim', '--pid', string(getpid())]
  if a:path !=# '' | call extend(l:command, ['--path', a:path]) | endif
  if !empty($KITTY_WINDOW_ID) | call extend(l:command, ['--kitty-window-id', $KITTY_WINDOW_ID]) | endif
  if !empty($KITTY_PID) | call extend(l:command, ['--kitty-pid', $KITTY_PID]) | endif
  call job_start(l:command, {'stoponexit': ''})
endfunction

function! s:Document(event, buffer) abort
  if getbufvar(a:buffer, '&buftype') !=# '' || bufname(a:buffer) ==# '' || bufname(a:buffer) =~# '^\a\+://' | return | endif
  call s:Emit(a:event, fnamemodify(bufname(a:buffer), ':p'))
endfunction

augroup PalMemory
  autocmd!
  autocmd BufReadPost,BufNewFile * call s:Document('document_opened', str2nr(expand('<abuf>')))
  autocmd BufEnter,FocusGained * call s:Document('document_focused', str2nr(expand('<abuf>')))
  autocmd BufWritePost * call s:Document('document_saved', str2nr(expand('<abuf>')))
  autocmd BufDelete * call s:Document('document_closed', str2nr(expand('<abuf>')))
  autocmd VimLeavePre * call s:Emit('editor_closed', '')
augroup END
