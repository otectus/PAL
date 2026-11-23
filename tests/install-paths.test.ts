import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

async function stagedInstaller(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'pal-install-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'checkout'), commands = join(base, 'commands');
  const prefix = join(base, 'space "quote" $cash %code back\\slash');
  for (const dir of [commands, join(repo, 'tools'), join(prefix, 'bin'), join(prefix, 'share/applications'),
    join(prefix, 'share/kio/servicemenus'), join(prefix, 'lib/systemd/user'), join(prefix, 'lib/pal')]) await mkdir(dir, { recursive: true });
  await cp('tools/install-user.py', join(repo, 'tools/install-user.py'));
  await cp('packaging', join(repo, 'packaging'), { recursive: true });
  await writeFile(join(commands, 'cmake'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, HOME: base, PATH: commands + ':' + process.env.PATH, PAL_TEST_ARGV: join(base, 'arguments') };
  function install() {
    const result = spawnSync('python3', [join(repo, 'tools/install-user.py'), '--prefix', prefix], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return { repo, prefix, env, install };
}

test('reinstall preserves libraries already opened by the running overlay', async t => {
  const { repo, prefix, install } = await stagedInstaller(t);
  const libraries = [
    ['libLayerShellQtInterface.so.6', 'libLayerShellQtInterface.so.6'],
    ['qt6/plugins/wayland-shell-integration/liblayer-shell.so', 'plugins/wayland-shell-integration/liblayer-shell.so'],
  ].map(([source, destination]) => ({
    source: join(repo, '.local-deps/usr/lib', source),
    destination: join(prefix, 'lib/pal', destination),
  }));
  for (const { source } of libraries) {
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, 'first version');
  }
  install();
  const handles = await Promise.all(libraries.map(({ destination }) => open(destination)));
  t.after(() => Promise.all(handles.map(handle => handle.close())));
  for (const { source } of libraries) await writeFile(source, 'replacement version');
  install();
  for (const [i, { destination }] of libraries.entries()) {
    assert.equal(await handles[i].readFile('utf8'), 'first version');
    assert.equal(await readFile(destination, 'utf8'), 'replacement version');
  }
});

test('installer desktop entries launch the intended program from a prefix containing Exec metacharacters', async t => {
  if (spawnSync('gio', ['version']).error) return t.skip('requires GIO desktop entry support');
  const { prefix, env, install } = await stagedInstaller(t);
  install();
  const launcher = join(prefix, 'bin/pal');
  await writeFile(launcher, '#!/bin/sh\nprintf "%s\\n" "$0" "$@" > "$PAL_TEST_ARGV"\n');
  await chmod(launcher, 0o755);
  const launch = spawnSync('gio', ['launch', join(prefix, 'share/applications/pal.desktop')], { env, encoding: 'utf8' });
  assert.equal(launch.status, 0, launch.stderr);
  let received = '';
  for (let attempt = 0; attempt < 100 && !received; attempt++) {
    received = await readFile(env.PAL_TEST_ARGV, 'utf8').catch(() => '');
    if (!received) await sleep(10);
  }
  assert.equal(received, launcher + '\n--show\n');
  const unit = await readFile(join(prefix, 'share/systemd/user/pal-broker.service'), 'utf8');
  assert.ok(unit.includes('$$cash %%code'));
});
