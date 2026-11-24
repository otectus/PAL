#!/usr/bin/env python3
"""Tiny, dependency-free editor event emitter. It tells PAL which document is open, saved or closed, never its text."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import uuid


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(add_help=False)
    result.add_argument("--print-session-id", action="store_true")
    result.add_argument("--event", choices=("document_opened", "document_focused", "document_saved", "document_closed", "editor_closed"))
    result.add_argument("--session-id")
    result.add_argument("--sequence", type=int)
    result.add_argument("--editor", default="editor")
    result.add_argument("--pid", type=int)
    result.add_argument("--path")
    result.add_argument("--revision")
    result.add_argument("--kitty-window-id")
    result.add_argument("--kitty-pid", type=int)
    result.add_argument("--socket")
    result.add_argument("--timeout-ms", type=int, default=50)
    return result


def socket_path(explicit: str | None) -> str:
    if explicit:
        return explicit
    configured = os.environ.get("PAL_MEMORY_SOCKET")
    if configured:
        return configured
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime:
        raise ValueError("XDG_RUNTIME_DIR is unavailable")
    return os.path.join(runtime, "pal-memory", "memory.sock")


def main() -> int:
    args = parser().parse_args()
    if args.print_session_id:
        sys.stdout.write(str(uuid.uuid4()))
        return 0
    if not args.event or not args.session_id or args.sequence is None or args.sequence < 1:
        return 2
    if args.event != "editor_closed" and not args.path:
        return 2
    params: dict[str, object] = {
        "source": "editor",
        "source_epoch": args.session_id,
        "source_sequence": args.sequence,
        "event": args.event,
        "editor": args.editor,
    }
    if args.pid:
        params["pid"] = args.pid
    if args.path:
        params["path"] = os.path.abspath(args.path)
    if args.revision:
        params["content_revision"] = args.revision
    if args.kitty_window_id:
        binding: dict[str, object] = {"kind": "kitty_window_id", "id": args.kitty_window_id}
        if args.kitty_pid:
            binding["pid"] = args.kitty_pid
        params["terminal_binding"] = binding
    request = {"protocol_version": 1, "request_id": str(uuid.uuid4()), "method": "collector.emit", "params": params}
    encoded = (json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(encoded) > 64 * 1024:
        return 2
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(max(1, args.timeout_ms) / 1000)
    try:
        client.connect(socket_path(args.socket))
        client.sendall(encoded)
    except (OSError, ValueError):
        return 0
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
