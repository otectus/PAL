pkgname=pal
replaces=('cere')
conflicts=('cere')
pkgver=2.0.1
pkgrel=1
pkgdesc='Personal Assistant for Linux, a native desktop companion for Hyprland'
arch=('x86_64' 'aarch64')
license=('custom' 'MIT' 'GPL-3.0-or-later' 'CC-BY-SA-4.0')
depends=('qt6-base' 'qt6-declarative' 'layer-shell-qt' 'nodejs>=24.22.0' 'hyprland' 'gtk3' 'xdg-utils' 'wireplumber' 'libnotify' 'grim' 'satty' 'systemd' 'openssl' 'python>=3.12' 'alsa-utils' 'sox' 'pipewire-alsa' 'pulse-native-provider')
makedepends=('cmake' 'ninja' 'npm')
optdepends=('codex: Codex sessions' 'claude-code: Claude sessions' 'speech-dispatcher: System speech routing with the PAL Piper module'
            'bubblewrap: Workbench Code Lab and commands in isolation' 'ripgrep: Workbench regular-expression search' 'poppler: Workbench PDF text'
            'tesseract: Workbench OCR' 'python-numpy: Workbench Code Lab charts' 'python-matplotlib: Workbench Code Lab charts')
build() {
  npm ci --ignore-scripts --prefix "$startdir"
  cmake -S "$startdir" -B "$srcdir/build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr -DBUILD_TESTING=OFF
  cmake --build "$srcdir/build"
}
package() {
  DESTDIR="$pkgdir" cmake --install "$srcdir/build"
}
