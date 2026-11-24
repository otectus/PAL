"""One analysis session: a Python namespace that stays between cells, inside PAL's sandbox.

Commands arrive as JSON lines on standard input; events leave as JSON lines on descriptor 3. What a cell prints goes to
its own standard output and error. Everything here belongs to the sandbox: PAL treats each event as untrusted.
"""
import _thread
import ast
import base64
import json
import os
import queue
import sys
import threading
import traceback
from pathlib import Path

LIMIT_FILES, LIMIT_BYTES, CHUNK, LIMIT_VARIABLES, LIMIT_TEXT = 20, 32 * 1024 * 1024, 192 * 1024, 200, 20000
control = os.fdopen(3, "w", buffering=1, encoding="utf-8")
commands = os.fdopen(os.dup(0), "r", encoding="utf-8")
null = os.open(os.devnull, os.O_RDONLY)
os.dup2(null, 0)
for descriptor in (3, commands.fileno()):
    os.set_inheritable(descriptor, False)
sys.path.insert(0, "/work/lab")
import lab_data  # noqa: E402

lock, waiting, running = threading.Lock(), queue.Queue(), threading.Event()
namespace = {}


def send(**event):
    with lock:
        control.write(json.dumps(event, ensure_ascii=True) + "\n")
        control.flush()


def fresh():
    namespace.clear()
    namespace.update({"__name__": "__main__", "lab_data": lab_data, "inputs": list(lab_data.paths)})


def describe(value):
    """A short, safe account of a value: no code of its own is run to describe it."""
    kind = type(value)
    name = kind.__name__ if kind.__module__ in ("builtins", "__main__") else kind.__module__.split(".")[0] + "." + kind.__name__
    if kind in (int, float, bool, complex, type(None)):
        text = repr(value)[:80]
    elif kind is str:
        text = repr(value[:60]) + ("…" if len(value) > 60 else "") + " · " + str(len(value)) + " characters"
    elif kind in (bytes, bytearray):
        text = str(len(value)) + " bytes"
    elif kind in (list, tuple, dict, set, frozenset):
        text = str(len(value)) + " items"
    else:
        text = ""
        if kind.__module__.split(".")[0] in ("numpy", "pandas", "polars", "pyarrow", "scipy"):
            shape = getattr(value, "shape", None)
            if type(shape) is tuple and all(type(part) is int for part in shape):
                text = " × ".join(str(part) for part in shape)
    return name[:80], text[:160]


def variables():
    rows = []
    for name, value in list(namespace.items()):
        if name.startswith("_") or name in ("lab_data", "inputs") or type(name) is not str:
            continue
        kind, text = describe(value)
        if kind in ("module", "function", "type", "builtin_function_or_method", "ABCMeta", "EnumType"):
            continue
        rows.append({"name": name[:80], "type": kind, "detail": text})
        if len(rows) >= LIMIT_VARIABLES:
            break
    return rows


def figures(folder):
    """Figures a cell drew and did not save are kept as pictures, like a notebook shows them."""
    plots = sys.modules.get("matplotlib.pyplot")
    if plots is None:
        return
    for index, number in enumerate(plots.get_fignums()[:4]):
        target = folder / f"figure-{index + 1}.png"
        if not target.exists():
            plots.figure(number).savefig(target, dpi=120, bbox_inches="tight")
    plots.close("all")


def deliver(number, folder):
    files = sorted(path for path in folder.rglob("*") if path.is_file() and not path.is_symlink())
    total, problem = 0, ""
    for path in files[:LIMIT_FILES]:
        size = path.stat().st_size
        if total + size > LIMIT_BYTES:
            problem = "Files over 32 MB in one cell are not kept"
            break
        total += size
        name = path.relative_to(folder).as_posix()
        with path.open("rb") as handle:
            while True:
                data = handle.read(CHUNK)
                send(event="file", cell=number, name=name, data=base64.b64encode(data).decode("ascii"), last=len(data) < CHUNK)
                if len(data) < CHUNK:
                    break
    if len(files) > LIMIT_FILES:
        problem = f"Only the first {LIMIT_FILES} files were kept"
    return problem


def execute(number, code):
    folder = Path("/work/output") / f"cell-{number}"
    folder.mkdir(parents=True, exist_ok=True)
    os.chdir(folder)
    lab_data.output = folder
    lab_data.paths = [Path(path) for path in json.loads(Path("/work/inputs.json").read_text())]
    lab_data.params = json.loads(Path("/work/parameters.json").read_text())
    namespace["inputs"] = list(lab_data.paths)
    ok, problem = True, ""
    running.set()
    try:
        tree = ast.parse(code, f"<cell {number}>")
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        if tree.body:
            exec(compile(tree, f"<cell {number}>", "exec"), namespace)
        if last is not None:
            value = eval(compile(ast.Expression(last.value), f"<cell {number}>", "eval"), namespace)
            if value is not None:
                namespace["_"] = value
                print(repr(value)[:LIMIT_TEXT])
        figures(folder)
    except KeyboardInterrupt:
        ok = False
        print("Interrupted", file=sys.stderr)
    except SystemExit:
        ok = False
        print("exit() ends a cell, not the session", file=sys.stderr)
    except BaseException as error:
        ok = False
        error.__traceback__ = error.__traceback__.tb_next if error.__traceback__ else None
        traceback.print_exc(limit=20)
    finally:
        running.clear()
    try:
        sys.stdout.flush()
        sys.stderr.flush()
        problem = deliver(number, folder)
    except BaseException as error:
        problem = type(error).__name__
    return ok, problem


def read():
    for line in commands:
        try:
            command = json.loads(line)
        except ValueError:
            continue
        if command.get("op") == "interrupt":
            if running.is_set():
                _thread.interrupt_main()
        else:
            waiting.put(command)
    os._exit(0)


fresh()
threading.Thread(target=read, daemon=True).start()
send(event="ready")
while True:
    try:
        command = waiting.get()
        number = command.get("cell", 0)
        if command.get("op") == "run":
            send(event="started", cell=number)
            ok, problem = execute(number, command["code"])
            send(event="done", cell=number, ok=ok, problem=problem, variables=variables())
        elif command.get("op") == "clear":
            fresh()
            plots = sys.modules.get("matplotlib.pyplot")
            if plots is not None:
                plots.close("all")
            send(event="cleared", cell=number, variables=[])
    except KeyboardInterrupt:
        continue
