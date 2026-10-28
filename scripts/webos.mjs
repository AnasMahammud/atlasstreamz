// ATLAS for LG webOS TVs: build the app package and install it on a TV in Developer Mode.
//   node scripts/webos.mjs build [https://your-atlas.onrender.com]   → dist/ATLAS.ipk
//   node scripts/webos.mjs install <tv-ip-address>                   → installs and opens it
//
// The app (apps/webos/app) is a small launcher that opens your ATLAS server, like the Android
// app, so the interface updates with every deploy. Without an address it uses the Render URL
// from your last deploy (deploy.local.json), or asks on the TV if there is none.
//
// Packaging and installing use LG's webOS CLI (@webos-tools/cli). It is installed on first use
// into %USERPROFILE%\.tools\webos-cli, outside the project, so Render never installs it.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'apps/webos/app');
const work = join(root, 'apps/webos/build');
const ipkPath = join(root, 'dist/ATLAS.ipk');
const cliDir = join(homedir(), '.tools', 'webos-cli');
const CLI_VERSION = '3.2.6';
const DEVICE = 'atlas-tv';
const appinfo = JSON.parse(readFileSync(join(appDir, 'appinfo.json'), 'utf8'));

function fail(message) {
  console.error(`[X] ${message}`);
  process.exit(1);
}

/** What the person typed → scheme + host (+ port), as the TV launcher and Android app do. */
function normalise(raw) {
  let v = (raw ?? '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) {
    const local = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(v) || /^localhost/i.test(v) || /^[^/]+:\d+(\/|$)/.test(v);
    v = (local ? 'http://' : 'https://') + v;
  }
  try {
    return new URL(v).origin.toLowerCase();
  } catch {
    fail(`"${raw}" isn't a server address.`);
  }
}

function lastDeployedUrl() {
  try {
    return JSON.parse(readFileSync(join(root, 'deploy.local.json'), 'utf8')).renderUrl ?? '';
  } catch {
    return '';
  }
}

function run(args, { allowFail = false, quiet = false } = {}) {
  const r = spawnSync(process.execPath, args, { stdio: quiet ? 'ignore' : 'inherit' });
  if (r.status !== 0 && !allowFail) fail(`${args.slice(0, 2).map((a) => a.split(/[\\/]/).pop()).join(' ')} failed (exit ${r.status}).`);
  return r.status === 0;
}

function ares(tool, args, opts) {
  return run([join(cliDir, 'node_modules/@webos-tools/cli/bin', `${tool}.js`), ...args], opts);
}

function ensureCli() {
  const pkg = join(cliDir, 'node_modules/@webos-tools/cli/package.json');
  if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).version === CLI_VERSION) return;
  console.log(`[..] Installing LG's webOS CLI ${CLI_VERSION} into ${cliDir} (first run only)`);
  mkdirSync(cliDir, { recursive: true });
  const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(npmCli)) fail(`npm not found next to ${process.execPath}.`);
  run([npmCli, 'install', '--prefix', cliDir, `@webos-tools/cli@${CLI_VERSION}`, '--no-audit', '--no-fund', '--loglevel=error']);
}

function build(serverArg) {
  const server = normalise(serverArg || lastDeployedUrl());
  const stage = join(work, 'app');
  const out = join(work, 'out');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(appDir, stage, { recursive: true });
  const index = join(stage, 'index.html');
  writeFileSync(index, readFileSync(index, 'utf8').replace('%%ATLAS_SERVER%%', server));

  ensureCli();
  console.log(`[..] Packaging ${appinfo.id} ${appinfo.version}`);
  ares('ares-package', [stage, '--outdir', out, '--no-minify']);
  const built = readdirSync(out).find((f) => f.endsWith('.ipk'));
  if (!built) fail('ares-package produced no .ipk.');
  mkdirSync(dirname(ipkPath), { recursive: true });
  copyFileSync(join(out, built), ipkPath);

  console.log(`\n[ok] webOS app ready: ${ipkPath}`);
  console.log(server ? `     Opens ${server}` : '     Asks for your server address on first launch.');
  console.log('     Install it with apps\\webos\\install-webos.bat (TV in Developer Mode, see docs\\WEBOS.md).');
}

function install(host) {
  if (!host || !/^[\w.-]+$/.test(host)) fail('Give the TV\'s IP address, shown as "Device IP" in the Developer Mode app.');
  if (!existsSync(ipkPath)) fail('dist\\ATLAS.ipk not found. Run build-webos.bat first.');
  ensureCli();
  // Developer Mode's SSH login is always user "prisoner" on port 9922.
  ares('ares-setup-device', ['--remove', DEVICE], { allowFail: true, quiet: true });
  ares('ares-setup-device', ['--add', DEVICE, '--info', `host=${host}`, '--info', 'port=9922', '--info', 'username=prisoner']);
  console.log('\n[..] Getting the TV\'s key. When asked, type the Passphrase shown in the Developer Mode app.');
  ares('ares-novacom', ['--device', DEVICE, '--getkey']);
  console.log('[..] Installing');
  ares('ares-install', ['--device', DEVICE, ipkPath]);
  ares('ares-launch', ['--device', DEVICE, appinfo.id]);
  console.log('\n[ok] ATLAS is installed and open on the TV. It also appears in the TV\'s app list.');
}

const [command, arg] = process.argv.slice(2);
if (command === 'build') build(arg);
else if (command === 'install') install(arg);
else fail('Usage: node scripts/webos.mjs build [server-address] | install <tv-ip-address>');
