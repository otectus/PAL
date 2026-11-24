#!/usr/bin/env python3
"""Install or remove the LiteLLM environment of PAL's optional local bridge, without changing system Python.

The environment is PAL's own folder. Every file must match a hash in litellm-lock.txt, only prebuilt packages are
used, and the new environment replaces the old one only after LiteLLM starts in it. Progress is printed as JSON lines.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile

LOCK = Path(__file__).resolve().with_name("litellm-lock.txt")
# One reply with a tool on offer, made up by LiteLLM itself: nothing leaves this computer.
CHECK = "import litellm; litellm.completion(model='openai/check', api_key='check', messages=[{'role': 'user', 'content': 'check'}], mock_response='ok', tools=[{'type': 'function', 'function': {'name': 'check', 'parameters': {'type': 'object', 'properties': {}}}}])"


def say(**event) -> None:
    print(json.dumps(event, separators=(",", ":")), flush=True)


def locked_version() -> str:
    for line in LOCK.read_text().splitlines():
        if line.startswith("litellm=="):
            return line.split("==", 1)[1].split()[0]
    raise RuntimeError("the lock file does not name LiteLLM")


def default_root() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "pal/litellm"


def clean_environment() -> dict:
    """No index, proxy credential or option of the person's own pip configuration decides what is installed."""
    kept = {name: os.environ[name] for name in ("PATH", "HOME", "LANG", "TMPDIR", "SSL_CERT_FILE", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy") if name in os.environ}
    return {**kept, "PIP_CONFIG_FILE": os.devnull, "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PIP_NO_INPUT": "1", "PYTHONDONTWRITEBYTECODE": "1", "LITELLM_LOCAL_MODEL_COST_MAP": "True"}


def run(command: list, environment: dict) -> None:
    done = subprocess.run(command, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if done.returncode:
        raise RuntimeError((done.stderr.strip().splitlines() or ["the command failed"])[-1][:300])


def clear_leftovers(root: Path) -> None:
    """What an installation that was cut short left; a finished one leaves nothing."""
    for leftover in root.glob("new-*") if root.is_dir() else ():
        if leftover.is_dir() and not leftover.is_symlink():
            shutil.rmtree(leftover, ignore_errors=True)


def install(root: Path) -> None:
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "aarch64") or not (3, 11) <= sys.version_info[:2] <= (3, 14):
        raise RuntimeError("this needs Python 3.11 to 3.14 on 64-bit Linux")
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    environment, version = clean_environment(), locked_version()
    clear_leftovers(root)
    staging = Path(tempfile.mkdtemp(prefix="new-", dir=root))
    try:
        say(state="working", stage="environment", version=version)
        run([sys.executable, "-I", "-m", "venv", str(staging / "venv")], environment)
        python = staging / "venv/bin/python"
        say(state="working", stage="packages", version=version)
        run([str(python), "-I", "-m", "pip", "install", "--quiet", "--no-cache-dir", "--no-deps", "--only-binary=:all:", "--require-hashes", "--index-url", "https://pypi.org/simple", "-r", str(LOCK)], environment)
        say(state="working", stage="checking", version=version)
        run([str(python), "-I", "-c", CHECK], environment)
        final = root / "venv"
        # A virtual environment names its own folder, so it is moved only together with its interpreter links.
        previous = root / "previous"
        shutil.rmtree(previous, ignore_errors=True)
        if final.exists():
            final.rename(previous)
        try:
            (staging / "venv").rename(final)
            run([str(final / "bin/python"), "-I", "-c", CHECK], environment)
        except BaseException:
            shutil.rmtree(final, ignore_errors=True)
            if previous.exists():
                previous.rename(final)
            raise
        shutil.rmtree(previous, ignore_errors=True)
        manifest = {"version": 1, "litellm": version, "python": str(final / "bin/python"), "lock": hashlib.sha256(LOCK.read_bytes()).hexdigest()}
        temporary = root / "manifest.json.tmp"
        temporary.write_text(json.dumps(manifest, indent=2) + "\n")
        temporary.chmod(0o600)
        temporary.replace(root / "manifest.json")
        say(state="installed", **manifest)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def remove(root: Path) -> None:
    """Only what this tool makes is deleted; anything else in the folder stays."""
    (root / "manifest.json").unlink(missing_ok=True)
    (root / "manifest.json.tmp").unlink(missing_ok=True)
    for name in ("venv", "previous"):
        if (root / name).is_dir() and not (root / name).is_symlink():
            shutil.rmtree(root / name)
    clear_leftovers(root)
    try:
        root.rmdir()
    except OSError:
        pass
    say(state="removed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "remove"), nargs="?", default="install")
    parser.add_argument("--root", type=Path, default=default_root())
    args = parser.parse_args()
    root = args.root.expanduser().absolute()
    # Being stopped ends the work through the same cleanup as a failure.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    install(root) if args.action == "install" else remove(root)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        say(state="error", message=str(error)[:300])
        raise SystemExit(1)
