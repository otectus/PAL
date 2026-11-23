/*
 * pal-terminal: one PTY-backed shell and its screen, for the PAL broker (broker/terminal/service.ts).
 *
 * The broker starts one worker per terminal. The worker owns a real controlling terminal (forkpty), feeds the
 * program's output into libvterm's screen model and reports the screen as JSON lines on stdout: whole snapshots,
 * changed rows, lines that scrolled off the top, the cursor, the window title and the foreground process.
 * Frames are rate limited (about 60 per second), so a program that floods output cannot flood the broker: the
 * screen is simply reported less often, and scrolled lines beyond a per-frame bound are counted, not sent.
 *
 * Terminal output is untrusted. Only the screen, cursor, title and bell are interpreted: no clipboard (OSC 52),
 * hyperlink, selection or other side-channel callback is registered, so escape sequences cannot reach the
 * clipboard, open URLs or call anything else.
 *
 * Input arrives on stdin as binary frames: one type byte, a big-endian 32-bit length and the payload.
 *   't' text (UTF-8, written to the program as typed)      'p' paste (bracketed when the program asked for it)
 *   'k' key: u8 key, u8 modifiers                           'u' character with modifiers: u8 mods, u32 codepoint
 *   'r' resize: u16 rows, u16 cols                          'i' interrupt the foreground process group (SIGINT)
 *   'x' stop the terminal and every process it started      's' send a full snapshot
 * End of input means the broker is gone: the terminal is stopped, never left running unowned.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <termios.h>
#include <unistd.h>

#include "vterm.h"

#define MAX_FRAME (256 * 1024)
#define MAX_PENDING_PTY (1024 * 1024)
#define MAX_SCROLL_LINES_PER_FRAME 2000
#define FRAME_INTERVAL_MS 16
#define MAX_TITLE 120

static VTerm *vt;
static VTermScreen *screen;
static int master = -1, rows = 24, cols = 80;
static pid_t child = -1;
static int exited = 0, exit_code = 0, exit_signal = 0, stopping = 0;

/* ── Growable buffer ───────────────────────────────────────────────────────────────────────────── */
typedef struct { char *data; size_t len, cap; } Buf;
static void buf_reserve(Buf *b, size_t extra) {
  if (b->len + extra + 1 <= b->cap) return;
  size_t cap = b->cap ? b->cap : 4096;
  while (cap < b->len + extra + 1) cap *= 2;
  char *next = realloc(b->data, cap);
  if (!next) { fputs("pal-terminal: out of memory\n", stderr); _exit(70); }
  b->data = next; b->cap = cap;
}
static void buf_add(Buf *b, const char *s, size_t n) { buf_reserve(b, n); memcpy(b->data + b->len, s, n); b->len += n; b->data[b->len] = 0; }
static void buf_str(Buf *b, const char *s) { buf_add(b, s, strlen(s)); }
static void buf_fmt(Buf *b, const char *fmt, ...) {
  char tmp[256]; va_list ap; va_start(ap, fmt); int n = vsnprintf(tmp, sizeof tmp, fmt, ap); va_end(ap);
  if (n > 0) buf_add(b, tmp, (size_t)n < sizeof tmp ? (size_t)n : sizeof tmp - 1);
}
static void buf_utf8(Buf *b, uint32_t c) {
  char out[4]; size_t n;
  if (c > 0x10FFFF || (c >= 0xD800 && c <= 0xDFFF)) c = 0xFFFD;
  if (c < 0x80) { out[0] = (char)c; n = 1; }
  else if (c < 0x800) { out[0] = (char)(0xC0 | (c >> 6)); out[1] = (char)(0x80 | (c & 0x3F)); n = 2; }
  else if (c < 0x10000) { out[0] = (char)(0xE0 | (c >> 12)); out[1] = (char)(0x80 | ((c >> 6) & 0x3F)); out[2] = (char)(0x80 | (c & 0x3F)); n = 3; }
  else { out[0] = (char)(0xF0 | (c >> 18)); out[1] = (char)(0x80 | ((c >> 12) & 0x3F)); out[2] = (char)(0x80 | ((c >> 6) & 0x3F)); out[3] = (char)(0x80 | (c & 0x3F)); n = 4; }
  buf_add(b, out, n);
}
/* A JSON string from codepoints already decoded by libvterm: control characters are escaped. */
static void json_codepoint(Buf *b, uint32_t c) {
  if (c == '"') buf_str(b, "\\\"");
  else if (c == '\\') buf_str(b, "\\\\");
  else if (c < 0x20 || c == 0x7F) buf_fmt(b, "\\u%04x", c);
  else buf_utf8(b, c);
}
/* A JSON string from bytes that may not be valid UTF-8 (a title): invalid sequences become U+FFFD. */
static void json_bytes(Buf *b, const char *s, size_t n) {
  buf_str(b, "\"");
  for (size_t i = 0; i < n;) {
    unsigned char c = (unsigned char)s[i];
    uint32_t cp; size_t len;
    if (c < 0x80) { cp = c; len = 1; }
    else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; len = 2; }
    else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; len = 3; }
    else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; len = 4; }
    else { json_codepoint(b, 0xFFFD); i++; continue; }
    if (i + len > n) { json_codepoint(b, 0xFFFD); break; }
    int ok = 1;
    for (size_t k = 1; k < len; k++) { unsigned char d = (unsigned char)s[i + k]; if ((d & 0xC0) != 0x80) { ok = 0; break; } cp = (cp << 6) | (d & 0x3F); }
    if (!ok) { json_codepoint(b, 0xFFFD); i++; continue; }
    json_codepoint(b, cp < 0x20 || cp == 0x7F ? 0xFFFD : cp);
    i += len;
  }
  buf_str(b, "\"");
}

/* ── Output to the broker ──────────────────────────────────────────────────────────────────────── */
static void emit(Buf *b) {
  buf_add(b, "\n", 1);
  size_t off = 0;
  while (off < b->len) {
    ssize_t n = write(STDOUT_FILENO, b->data + off, b->len - off);
    if (n < 0) { if (errno == EINTR) continue; if (errno == EPIPE) _exit(0); _exit(71); }
    off += (size_t)n;
  }
  b->len = 0; if (b->data) b->data[0] = 0;
}
static Buf out;
static void emit_simple(const char *fmt, ...) {
  char tmp[512]; va_list ap; va_start(ap, fmt); vsnprintf(tmp, sizeof tmp, fmt, ap); va_end(ap);
  buf_str(&out, tmp); emit(&out);
}

/* ── Screen encoding ───────────────────────────────────────────────────────────────────────────── */
static long color_value(const VTermColor *c, int fg) {
  if (fg ? VTERM_COLOR_IS_DEFAULT_FG(c) : VTERM_COLOR_IS_DEFAULT_BG(c)) return -1;
  if (VTERM_COLOR_IS_INDEXED(c)) return c->indexed.idx;
  if (VTERM_COLOR_IS_RGB(c)) return 0x1000000L | ((long)c->rgb.red << 16) | ((long)c->rgb.green << 8) | c->rgb.blue;
  return -1;
}
static int attr_bits(const VTermScreenCellAttrs *a) {
  return (a->bold ? 1 : 0) | (a->italic ? 2 : 0) | (a->underline ? 4 : 0) | (a->reverse ? 8 : 0) | (a->strike ? 16 : 0) | (a->blink ? 32 : 0) | (a->conceal ? 64 : 0) | (a->underline == VTERM_UNDERLINE_DOUBLE ? 128 : 0);
}
/* One row as runs [column, text, fg, bg, attributes]; a wide character is a run of its own. Trailing blanks
 * in the default style are omitted. */
static void encode_cells(Buf *b, int ncols, VTermScreenCell *(*cell_at)(int col, void *ctx), void *ctx) {
  int last = -1;
  for (int c = 0; c < ncols; c++) {
    VTermScreenCell *cell = cell_at(c, ctx);
    int blank = (cell->chars[0] == 0 || cell->chars[0] == ' ') && color_value(&cell->bg, 0) == -1 && !cell->attrs.reverse && !cell->attrs.underline && !cell->attrs.strike;
    if (!blank) last = c + (cell->width > 1 ? cell->width - 1 : 0);
  }
  buf_str(b, "[");
  int first = 1, open = 0; long fg = -2, bg = -2; int attrs = -1;
  for (int c = 0; c <= last && c < ncols; c++) {
    VTermScreenCell *cell = cell_at(c, ctx);
    if (cell->chars[0] == (uint32_t)-1) continue; /* the second half of a wide character */
    long cfg = color_value(&cell->fg, 1), cbg = color_value(&cell->bg, 0); int cattrs = attr_bits(&cell->attrs);
    int wide = cell->width > 1;
    if (!open || wide || cfg != fg || cbg != bg || cattrs != attrs) {
      if (open) buf_fmt(b, "\",%ld,%ld,%d]", fg, bg, attrs);
      buf_fmt(b, "%s[%d,\"", first ? "" : ",", c); first = 0; open = 1; fg = cfg; bg = cbg; attrs = cattrs;
    }
    if (cell->chars[0] == 0) json_codepoint(b, ' ');
    else for (int k = 0; k < VTERM_MAX_CHARS_PER_CELL && cell->chars[k]; k++) json_codepoint(b, cell->chars[k]);
    if (wide) { buf_fmt(b, "\",%ld,%ld,%d]", fg, bg, attrs); open = 0; c += cell->width - 1; }
  }
  if (open) buf_fmt(b, "\",%ld,%ld,%d]", fg, bg, attrs);
  buf_str(b, "]");
}
static VTermScreenCell scratch;
static int scratch_row;
static VTermScreenCell *screen_cell(int col, void *ctx) {
  (void)ctx; VTermPos pos = { .row = scratch_row, .col = col };
  if (!vterm_screen_get_cell(screen, pos, &scratch)) memset(&scratch, 0, sizeof scratch);
  return &scratch;
}
static VTermScreenCell *line_cell(int col, void *ctx) { return &((VTermScreenCell *)ctx)[col]; }

/* ── Screen state tracked between frames ───────────────────────────────────────────────────────── */
static unsigned char *dirty;
static int dirty_any = 0, cursor_row = 0, cursor_col = 0, cursor_visible = 1, alt_screen = 0, cursor_moved = 0;
static long revision = 0;
static Buf scroll_pending; static int scroll_count = 0, scroll_dropped = 0;
static Buf title; static int title_changed = 0;
static struct timespec last_bell = {0, 0};
static pid_t last_fg = -1;

static long now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000L + t.tv_nsec / 1000000L; }

static int on_damage(VTermRect rect, void *user) {
  (void)user;
  for (int r = rect.start_row; r < rect.end_row && r < rows; r++) if (r >= 0) dirty[r] = 1;
  dirty_any = 1; return 1;
}
static int on_movecursor(VTermPos pos, VTermPos old, int visible, void *user) {
  (void)old; (void)user; cursor_row = pos.row; cursor_col = pos.col; cursor_visible = visible; cursor_moved = 1; return 1;
}
static int on_settermprop(VTermProp prop, VTermValue *val, void *user) {
  (void)user;
  if (prop == VTERM_PROP_ALTSCREEN) { alt_screen = val->boolean; for (int r = 0; r < rows; r++) dirty[r] = 1; dirty_any = 1; }
  else if (prop == VTERM_PROP_CURSORVISIBLE) { cursor_visible = val->boolean; cursor_moved = 1; }
  else if (prop == VTERM_PROP_TITLE) {
    if (val->string.initial) title.len = 0;
    if (title.len < 1024) buf_add(&title, val->string.str, val->string.len);
    if (val->string.final) title_changed = 1;
  }
  return 1;
}
static int on_bell(void *user) {
  (void)user; struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  if ((t.tv_sec - last_bell.tv_sec) * 1000L + (t.tv_nsec - last_bell.tv_nsec) / 1000000L >= 500) { last_bell = t; emit_simple("{\"t\":\"bell\"}"); }
  return 1;
}
static int on_resize(int r, int c, void *user) { (void)user; (void)r; (void)c; return 1; }
static int on_pushline(int ncols, const VTermScreenCell *cells, void *user) {
  (void)user;
  if (scroll_count >= MAX_SCROLL_LINES_PER_FRAME) { scroll_dropped++; return 1; }
  if (scroll_count) buf_str(&scroll_pending, ",");
  encode_cells(&scroll_pending, ncols, line_cell, (void *)cells);
  scroll_count++; return 1;
}
static int on_sb_clear(void *user) { (void)user; emit_simple("{\"t\":\"scrollclear\"}"); return 1; }

static void encode_row(Buf *b, int row) { scratch_row = row; encode_cells(b, cols, screen_cell, NULL); }

static void report_foreground(void) {
  if (master < 0) return;
  pid_t fg = tcgetpgrp(master);
  if (fg <= 0 || fg == last_fg) return;
  last_fg = fg;
  char path[64], name[64] = ""; snprintf(path, sizeof path, "/proc/%d/comm", (int)fg);
  FILE *f = fopen(path, "r");
  if (f) { if (fgets(name, sizeof name, f)) name[strcspn(name, "\n")] = 0; fclose(f); }
  buf_fmt(&out, "{\"t\":\"fg\",\"pgid\":%d,\"name\":", (int)fg); json_bytes(&out, name, strlen(name)); buf_str(&out, "}"); emit(&out);
}

static void flush(int full) {
  vterm_screen_flush_damage(screen);
  if (scroll_count || scroll_dropped) {
    buf_str(&out, "{\"t\":\"scroll\",\"lines\":["); buf_add(&out, scroll_pending.data ? scroll_pending.data : "", scroll_pending.len);
    buf_fmt(&out, "],\"dropped\":%d}", scroll_dropped); emit(&out);
    scroll_pending.len = 0; scroll_count = 0; scroll_dropped = 0;
  }
  if (title_changed) {
    size_t n = title.len > MAX_TITLE ? MAX_TITLE : title.len;
    buf_str(&out, "{\"t\":\"title\",\"text\":"); json_bytes(&out, title.data ? title.data : "", n); buf_str(&out, "}"); emit(&out);
    title_changed = 0;
  }
  if (!full && !dirty_any && !cursor_moved) return;
  int changed = 0; for (int r = 0; r < rows; r++) changed += dirty[r];
  if (changed * 2 > rows) full = 1;
  revision++;
  buf_fmt(&out, "{\"t\":\"screen\",\"rev\":%ld,\"full\":%d,\"rows\":%d,\"cols\":%d,\"cursor\":[%d,%d,%d],\"alt\":%d,", revision, full, rows, cols, cursor_row, cursor_col, cursor_visible, alt_screen);
  if (full) {
    buf_str(&out, "\"lines\":[");
    for (int r = 0; r < rows; r++) { if (r) buf_str(&out, ","); encode_row(&out, r); }
    buf_str(&out, "]}");
  } else {
    buf_str(&out, "\"changed\":{"); int first = 1;
    for (int r = 0; r < rows; r++) if (dirty[r]) { buf_fmt(&out, "%s\"%d\":", first ? "" : ",", r); first = 0; encode_row(&out, r); }
    buf_str(&out, "}}");
  }
  emit(&out);
  memset(dirty, 0, (size_t)rows); dirty_any = 0; cursor_moved = 0;
  report_foreground();
}

/* ── Writing to the program ────────────────────────────────────────────────────────────────────── */
static Buf pty_pending;
static void pty_flush(void) {
  while (pty_pending.len) {
    ssize_t n = write(master, pty_pending.data, pty_pending.len);
    if (n < 0) { if (errno == EINTR) continue; if (errno == EAGAIN) return; pty_pending.len = 0; return; }
    memmove(pty_pending.data, pty_pending.data + n, pty_pending.len - (size_t)n); pty_pending.len -= (size_t)n;
  }
}
static int pty_write(const char *s, size_t n) {
  if (pty_pending.len + n > MAX_PENDING_PTY) return 0;
  buf_add(&pty_pending, s, n); pty_flush(); return 1;
}
/* What libvterm sends to the program: key encodings, paste brackets, replies to the program's queries. */
static void on_output(const char *s, size_t n, void *user) { (void)user; if (!pty_write(s, n)) emit_simple("{\"t\":\"error\",\"code\":\"input_blocked\",\"message\":\"The program is not reading its input.\"}"); }

/* ── Process tree ──────────────────────────────────────────────────────────────────────────────── */
/* The processes this terminal started: its session, and descendants of its shell that left the session. */
static int owned_pids(pid_t *list, int max) {
  DIR *proc = opendir("/proc"); if (!proc) return 0;
  struct { pid_t pid, ppid, sid; } *all = calloc(65536, sizeof *all); int count = 0;
  struct dirent *e;
  while ((e = readdir(proc)) && count < 65536) {
    if (!isdigit((unsigned char)e->d_name[0])) continue;
    char path[300], line[1024]; snprintf(path, sizeof path, "/proc/%s/stat", e->d_name);
    FILE *f = fopen(path, "r"); if (!f) continue;
    if (fgets(line, sizeof line, f)) {
      char *close = strrchr(line, ')');
      if (close) { char state; int ppid, pgrp, sid; if (sscanf(close + 2, "%c %d %d %d", &state, &ppid, &pgrp, &sid) == 4 && state != 'Z') { all[count].pid = atoi(e->d_name); all[count].ppid = ppid; all[count].sid = sid; count++; } }
    }
    fclose(f);
  }
  closedir(proc);
  int n = 0;
  for (int changed = 1; changed;) {
    changed = 0;
    for (int i = 0; i < count; i++) {
      int mine = all[i].pid == child || all[i].sid == child;
      for (int k = 0; !mine && k < n; k++) if (all[i].ppid == list[k]) mine = 1;
      int known = 0; for (int k = 0; k < n; k++) if (list[k] == all[i].pid) { known = 1; break; }
      if (mine && !known && n < max) { list[n++] = all[i].pid; changed = 1; }
    }
  }
  free(all);
  return n;
}
static void reap(void) {
  if (exited || child <= 0) return;
  int status; pid_t r = waitpid(child, &status, WNOHANG);
  if (r == child) { exited = 1; if (WIFEXITED(status)) exit_code = WEXITSTATUS(status); if (WIFSIGNALED(status)) exit_signal = WTERMSIG(status); }
}
/* Hang up, then kill what remains; report how many processes were signalled and whether any survived. */
static void stop_all(void) {
  stopping = 1;
  pid_t pids[4096]; int n = owned_pids(pids, 4096), signalled = n;
  if (child > 0) kill(-child, SIGHUP);
  for (int i = 0; i < n; i++) { kill(pids[i], SIGHUP); kill(pids[i], SIGCONT); }
  long deadline = now_ms() + 1500;
  while (now_ms() < deadline) { reap(); if (!owned_pids(pids, 4096)) break; usleep(50000); }
  n = owned_pids(pids, 4096);
  for (int i = 0; i < n; i++) kill(pids[i], SIGKILL);
  if (n) { deadline = now_ms() + 1000; while (now_ms() < deadline) { reap(); if (!owned_pids(pids, 4096)) break; usleep(20000); } }
  int remaining = owned_pids(pids, 4096);
  emit_simple("{\"t\":\"stopped\",\"signalled\":%d,\"killed\":%d,\"remaining\":%d}", signalled, n, remaining);
}

/* ── Input frames from the broker ──────────────────────────────────────────────────────────────── */
static Buf in;
static const VTermKey keymap[] = { VTERM_KEY_NONE, VTERM_KEY_ENTER, VTERM_KEY_TAB, VTERM_KEY_BACKSPACE, VTERM_KEY_ESCAPE, VTERM_KEY_UP, VTERM_KEY_DOWN, VTERM_KEY_LEFT, VTERM_KEY_RIGHT,
  VTERM_KEY_INS, VTERM_KEY_DEL, VTERM_KEY_HOME, VTERM_KEY_END, VTERM_KEY_PAGEUP, VTERM_KEY_PAGEDOWN };
static void resize(int r, int c) {
  if (r < 2 || c < 2 || r > 500 || c > 1000) return;
  struct winsize ws = { .ws_row = (unsigned short)r, .ws_col = (unsigned short)c };
  ioctl(master, TIOCSWINSZ, &ws);
  unsigned char *next = realloc(dirty, (size_t)r);
  if (!next) return;
  dirty = next; rows = r; cols = c; memset(dirty, 1, (size_t)rows);
  vterm_set_size(vt, rows, cols);
  flush(1);
}
static void handle_frame(unsigned char type, const unsigned char *p, uint32_t len) {
  switch (type) {
    case 't': if (!pty_write((const char *)p, len)) emit_simple("{\"t\":\"error\",\"code\":\"input_blocked\",\"message\":\"The program is not reading its input.\"}"); break;
    case 'p': vterm_keyboard_start_paste(vt); pty_write((const char *)p, len); vterm_keyboard_end_paste(vt); break;
    case 'k':
      if (len >= 2) {
        unsigned key = p[0], mods = p[1];
        if (key < sizeof keymap / sizeof keymap[0] && key > 0) vterm_keyboard_key(vt, keymap[key], (VTermModifier)mods);
        else if (key >= 101 && key <= 112) vterm_keyboard_key(vt, (VTermKey)(VTERM_KEY_FUNCTION_0 + (key - 100)), (VTermModifier)mods);
      }
      break;
    case 'u': if (len >= 5) { uint32_t cp = ((uint32_t)p[1] << 24) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 8) | p[4]; vterm_keyboard_unichar(vt, cp, (VTermModifier)p[0]); } break;
    case 'r': if (len >= 4) resize((p[0] << 8) | p[1], (p[2] << 8) | p[3]); break;
    case 'i': { pid_t fg = tcgetpgrp(master); if (fg > 0) { kill(-fg, SIGINT); emit_simple("{\"t\":\"interrupted\",\"pgid\":%d}", (int)fg); } else emit_simple("{\"t\":\"interrupted\",\"pgid\":0}"); break; }
    case 'x': stop_all(); break;
    case 's': for (int r = 0; r < rows; r++) dirty[r] = 1; flush(1); break;
    default: emit_simple("{\"t\":\"error\",\"code\":\"bad_frame\",\"message\":\"Unknown input frame.\"}");
  }
}
static int read_input(void) {
  char chunk[65536];
  ssize_t n = read(STDIN_FILENO, chunk, sizeof chunk);
  if (n == 0) return 0;
  if (n < 0) return errno == EINTR || errno == EAGAIN;
  buf_add(&in, chunk, (size_t)n);
  size_t off = 0;
  while (in.len - off >= 5) {
    const unsigned char *h = (const unsigned char *)in.data + off;
    uint32_t len = ((uint32_t)h[1] << 24) | ((uint32_t)h[2] << 16) | ((uint32_t)h[3] << 8) | h[4];
    if (len > MAX_FRAME) { emit_simple("{\"t\":\"error\",\"code\":\"frame_too_large\",\"message\":\"Input frame too large.\"}"); return 0; }
    if (in.len - off - 5 < len) break;
    handle_frame(h[0], h + 5, len);
    off += 5 + len;
  }
  memmove(in.data, in.data + off, in.len - off); in.len -= off;
  return 1;
}

static void usage(void) { fputs("usage: pal-terminal --shell PATH [--cwd DIR] [--rows N] [--cols N] [--arg ARG]...\n", stderr); exit(64); }

int main(int argc, char **argv) {
  const char *shell = NULL, *cwd = NULL; char *args[34]; int nargs = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--shell") && i + 1 < argc) shell = argv[++i];
    else if (!strcmp(argv[i], "--cwd") && i + 1 < argc) cwd = argv[++i];
    else if (!strcmp(argv[i], "--rows") && i + 1 < argc) rows = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--cols") && i + 1 < argc) cols = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--arg") && i + 1 < argc && nargs < 32) args[1 + nargs++] = argv[++i];
    else usage();
  }
  if (!shell || shell[0] != '/' || rows < 2 || cols < 2 || rows > 500 || cols > 1000) usage();
  signal(SIGPIPE, SIG_IGN);

  struct winsize ws = { .ws_row = (unsigned short)rows, .ws_col = (unsigned short)cols };
  child = forkpty(&master, NULL, NULL, &ws);
  if (child < 0) { emit_simple("{\"t\":\"error\",\"code\":\"pty\",\"message\":\"Could not open a terminal: %s\"}", strerror(errno)); return 1; }
  if (child == 0) {
    if (cwd && chdir(cwd) != 0) { fprintf(stderr, "pal-terminal: cannot enter %s: %s\r\n", cwd, strerror(errno)); }
    signal(SIGPIPE, SIG_DFL);
    args[0] = (char *)shell; args[1 + nargs] = NULL;
    execv(shell, args);
    fprintf(stderr, "pal-terminal: cannot start %s: %s\r\n", shell, strerror(errno));
    _exit(127);
  }
  fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);
  fcntl(master, F_SETFD, FD_CLOEXEC);

  dirty = calloc((size_t)rows, 1);
  vt = vterm_new(rows, cols); vterm_set_utf8(vt, 1);
  vterm_output_set_callback(vt, on_output, NULL);
  screen = vterm_obtain_screen(vt);
  vterm_screen_enable_altscreen(screen, 1);
  static VTermScreenCallbacks callbacks = { .damage = on_damage, .movecursor = on_movecursor, .settermprop = on_settermprop, .bell = on_bell, .resize = on_resize, .sb_pushline = on_pushline, .sb_clear = on_sb_clear };
  vterm_screen_set_callbacks(screen, &callbacks, NULL);
  vterm_screen_set_damage_merge(screen, VTERM_DAMAGE_ROW);
  vterm_screen_reset(screen, 1);

  buf_fmt(&out, "{\"t\":\"ready\",\"pid\":%d,\"rows\":%d,\"cols\":%d,\"shell\":", (int)child, rows, cols); json_bytes(&out, shell, strlen(shell)); buf_str(&out, "}"); emit(&out);
  flush(1);

  long last_flush = now_ms(), last_fg_check = 0; int input_open = 1, pty_open = 1;
  char chunk[65536];
  while (pty_open || !exited) {
    long now = now_ms();
    int pending = dirty_any || cursor_moved || scroll_count || scroll_dropped || title_changed;
    int timeout = pending ? (int)(FRAME_INTERVAL_MS - (now - last_flush)) : 500;
    if (timeout < 0) timeout = 0;
    struct pollfd fds[2] = { { .fd = pty_open ? master : -1, .events = POLLIN | (pty_pending.len ? POLLOUT : 0) }, { .fd = input_open ? STDIN_FILENO : -1, .events = POLLIN } };
    int ready = poll(fds, 2, pty_open ? timeout : 100);
    if (ready < 0 && errno != EINTR) break;
    if (pty_open && (fds[0].revents & POLLOUT)) pty_flush();
    if (pty_open && (fds[0].revents & (POLLIN | POLLHUP | POLLERR))) {
      /* Read a bounded amount per wake-up so input and Stop stay responsive under a flood. */
      for (int round = 0; round < 16; round++) {
        ssize_t n = read(master, chunk, sizeof chunk);
        if (n > 0) { vterm_input_write(vt, chunk, (size_t)n); continue; }
        if (n < 0 && (errno == EAGAIN || errno == EINTR)) break;
        pty_open = 0; break; /* EIO: the program side of the terminal is closed */
      }
    }
    if (input_open && (fds[1].revents & (POLLIN | POLLHUP | POLLERR))) {
      if (!read_input()) { input_open = 0; if (!stopping) stop_all(); }
    }
    now = now_ms();
    if (now - last_flush >= FRAME_INTERVAL_MS) { flush(0); last_flush = now; }
    if (now - last_fg_check >= 500) { report_foreground(); last_fg_check = now; }
    reap();
    /* The shell ended: report what it printed last, then end (a background job does not keep the terminal). */
    if (exited) { if (pty_open) for (int round = 0; round < 16; round++) { ssize_t n = read(master, chunk, sizeof chunk); if (n <= 0) break; vterm_input_write(vt, chunk, (size_t)n); } break; }
    if (!pty_open && !exited) { long wait_until = now_ms() + 2000; while (!exited && now_ms() < wait_until) { reap(); usleep(20000); } if (!exited) stop_all(); }
  }
  flush(0);
  while (!exited) { int status; pid_t r = waitpid(child, &status, 0); if (r == child) { exited = 1; if (WIFEXITED(status)) exit_code = WEXITSTATUS(status); if (WIFSIGNALED(status)) exit_signal = WTERMSIG(status); } else if (r < 0 && errno != EINTR) break; }
  /* Processes the shell left behind in its session are hung up like a closed terminal would; their count is reported. */
  int leftover = 0;
  if (!stopping) {
    pid_t pids[4096]; int n = owned_pids(pids, 4096);
    for (int i = 0; i < n; i++) kill(pids[i], SIGHUP);
    long deadline = now_ms() + 1000; while (n && now_ms() < deadline && owned_pids(pids, 4096)) usleep(20000);
    n = owned_pids(pids, 4096); for (int i = 0; i < n; i++) kill(pids[i], SIGKILL);
    leftover = n;
  }
  emit_simple("{\"t\":\"exit\",\"code\":%d,\"signal\":%d,\"leftover\":%d}", exit_code, exit_signal, leftover);
  return 0;
}
