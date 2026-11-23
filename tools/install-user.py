#!/usr/bin/env python3
"""Install a built PAL under ~/.local, or stage it with --prefix."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--prefix', type=Path, default=Path.home() / '.local')
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
prefix = args.prefix.resolve()
if any(character in str(prefix) for character in '\r\n'):
    parser.error('the installation path cannot contain a newline')
local = repo / '.local-deps/usr'
env = os.environ.copy()
cmake = shutil.which('cmake')
if not cmake:
    cmake = str(local / 'bin/cmake')
    env['LD_LIBRARY_PATH'] = str(local / 'lib') + ':' + env.get('LD_LIBRARY_PATH', '')
subprocess.run([cmake, '--install', str(repo / 'build'), '--prefix', str(prefix)], env=env, check=True)

# Arch's Qt and Node remain system dependencies. Bundle the optional layer-shell
# integration when development used a locally extracted package.
def install_library(source, destination):
    # A running workspace or overlay may still have the previous inode mapped.
    # Finish writing the replacement before making it visible to new processes.
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as staged:
        temporary = Path(staged.name)
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


if (local / 'lib/libLayerShellQtInterface.so.6').exists():
    install_library(local / 'lib/libLayerShellQtInterface.so.6', prefix / 'lib/pal/libLayerShellQtInterface.so.6')
    plugins = prefix / 'lib/pal/plugins/wayland-shell-integration'
    plugins.mkdir(parents=True, exist_ok=True)
    install_library(local / 'lib/qt6/plugins/wayland-shell-integration/liblayer-shell.so', plugins / 'liblayer-shell.so')

def desktop_quote(value):
    # Apply Exec's argument quoting before encoding the token as a key-file string.
    token = str(value).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%')
    return '"' + token.replace('\\', '\\\\') + '"'

launcher = prefix / 'bin/pal'
command = desktop_quote(launcher)
# GIO looks up the executable before expanding literal percent fields. The specification
# also reserves equals in the executable name. Keep these paths in the argument list.
if '%' in str(launcher) or '=' in str(launcher):
    command = '/usr/bin/bash ' + command
desktop = (repo / 'packaging/pal.desktop').read_text().replace('Exec=pal --show', 'Exec=' + command + ' --show')
(prefix / 'share/applications/pal.desktop').write_text(desktop)
service_menu = prefix / 'share/kio/servicemenus/pal-dolphin.desktop'
service_menu.write_text((repo / 'packaging/pal-dolphin.desktop').read_text().replace(
    'Exec=pal --new-conversation', 'Exec=' + command + ' --new-conversation'))
service_menu.chmod(0o755)

# The user data unit directory is in systemd's standard per-user search path.
units = prefix / 'share/systemd/user'
units.mkdir(parents=True, exist_ok=True)
unit = (repo / 'packaging/pal-broker.service').read_text()
broker = str(prefix / 'share/pal/broker/main.ts').replace('$', '$$').replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
unit = unit.replace('/usr/share/pal/broker/main.ts', '"' + broker + '"')
(units / 'pal-broker.service').write_text(unit)
(prefix / 'lib/systemd/user/pal-broker.service').write_text(unit)

if prefix == Path.home() / '.local':
    # Keep the user's existing choice to launch at login, using installed files.
    autostart = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'autostart/pal.desktop'
    previous = autostart.with_name('cere.desktop')
    source_entry = autostart if autostart.is_file() else previous
    if source_entry.is_file():
        # Keep desktop-environment restrictions, including a user's disabled-at-login choice.
        lines = source_entry.read_text().splitlines()
        for index, line in enumerate(lines):
            key = line.partition('=')[0]
            if key in ('Exec', 'TryExec', 'Icon', 'Name'):
                lines[index] = {'Exec': 'Exec=' + command, 'TryExec': 'TryExec=' + str(launcher),
                                'Icon': 'Icon=pal', 'Name': 'Name=PAL'}[key]
        autostart.write_text('\n'.join(lines) + '\n')
        previous.unlink(missing_ok=True)
    # Retire menu entries from a previous per-user installation.
    for directory, filename in [('share/applications', 'cere.desktop'),
                                ('share/kio/servicemenus', 'cere-dolphin.desktop')]:
        entry = prefix / directory / filename
        if entry.is_file() and ('Name=Cere\n' in entry.read_text() or 'Name=Start Cere Conversation Here\n' in entry.read_text()):
            entry.unlink()
    old_unit = units / 'cere-broker.service'
    if old_unit.is_file() and 'Description=Cere session broker' in old_unit.read_text():
        old_unit.unlink()
        old_unit.symlink_to('pal-broker.service')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    for command in (['update-desktop-database', str(prefix / 'share/applications')],
                    ['gtk-update-icon-cache', '-f', '-t', str(prefix / 'share/icons/hicolor')]):
        if shutil.which(command[0]):
            subprocess.run(command, check=True)
print(f'Installed PAL: {launcher}')
