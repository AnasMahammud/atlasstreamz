// ATLAS one-shot deployment: commit → private GitHub repository → Render web service → live URL.
//
// Run through deploy-to-render.bat (which first checks for secrets, runs the tests and builds).
// First run: signs in to GitHub with Git Credential Manager (browser), creates a private repo,
// pushes, then creates the Render web service with its disk and settings and waits for it to go
// live. Later runs: commit and push; Render redeploys automatically.
//
// Nothing secret is written to the repository. The Render API key is only held in memory.
// Local state (repo name, service id, URL, setup code) lives in deploy.local.json (gitignored).
//
// Options / environment (also used by the automated test with mock servers):
//   --dry-run                 show what would happen, change nothing
//   ATLAS_DEPLOY_ROOT         project folder (default: repo root)
//   GITHUB_API, GITHUB_GIT    API and git base URLs (default api.github.com, github.com)
//   RENDER_API                Render API base (default https://api.render.com/v1)
//   ATLAS_GITHUB_TOKEN        use this token instead of Git Credential Manager
//   RENDER_API_KEY            skip the API key prompt
//   ATLAS_DEPLOY_REPO, ATLAS_DEPLOY_PLAN (starter|free), ATLAS_DEPLOY_REGION, ATLAS_DEPLOY_YES=1
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const ROOT = process.env.ATLAS_DEPLOY_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB_API = (process.env.GITHUB_API ?? 'https://api.github.com').replace(/\/$/, '');
const GITHUB_GIT = (process.env.GITHUB_GIT ?? 'https://github.com').replace(/\/$/, '');
const RENDER_API = (process.env.RENDER_API ?? 'https://api.render.com/v1').replace(/\/$/, '');
const DRY = process.argv.includes('--dry-run');
const AUTO_YES = process.env.ATLAS_DEPLOY_YES === '1';
const STATE_FILE = join(ROOT, 'deploy.local.json');
const SERVICE_NAME_DEFAULT = 'atlas';

/* ---------------- console helpers ---------------- */

const ok = (m) => console.log(`[ok] ${m}`);
const step = (m) => console.log(`[..] ${m}`);
const warn = (m) => console.log(`[!]  ${m}`);
class Stop extends Error {}
const fail = (m) => {
  throw new Stop(m);
};

let rl;
function prompt(question, { hidden = false, fallback } = {}) {
  if (!process.stdin.isTTY && fallback !== undefined) return Promise.resolve(fallback);
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    const write = rl._writeToOutput;
    if (hidden) rl._writeToOutput = (s) => (s.includes(question) ? write.call(rl, s) : write.call(rl, '*'.repeat(Math.min(1, s.length))));
    rl.question(question, (answer) => {
      if (hidden) {
        rl._writeToOutput = write;
        process.stdout.write('\n');
      }
      resolve(answer.trim());
    });
  });
}

async function confirm(question) {
  if (AUTO_YES) return true;
  const a = (await prompt(`${question} [y/N] `)).toLowerCase();
  return a === 'y' || a === 'yes';
}

function openBrowser(url) {
  if (DRY || process.env.ATLAS_DEPLOY_NO_BROWSER === '1') return;
  try {
    spawnSync('cmd.exe', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* best effort */
  }
}

/* ---------------- state ---------------- */

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(state) {
  if (!DRY) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/* ---------------- git ---------------- */

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: opts.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'], input: opts.input }).trim();
}
function gitOk(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).status === 0;
}

const SECRET_PATHS = /(^|\/)(\.env\.local|data\/|deploy\.local\.json)|\.sqlite|secret\.key|keystore|\.jks$|\.apk$|local\.properties$/i;

function commitAll() {
  if (DRY) {
    step('Would commit all changes on branch main');
    return;
  }
  git(['add', '-A']);
  const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const leaked = staged.filter((f) => SECRET_PATHS.test(f));
  if (leaked.length) {
    git(['reset', '-q']);
    fail(`Secret files were about to be committed (${leaked.join(', ')}). Nothing was published.`);
  }
  if (staged.length) {
    git(['commit', '-q', '-m', 'ATLAS update']);
    ok(`Committed ${staged.length} changed file${staged.length === 1 ? '' : 's'}`);
  } else ok('Nothing new to commit');
  git(['branch', '-M', 'main']);
}

/* ---------------- GitHub ---------------- */

/** A GitHub token from Git Credential Manager (browser sign-in), or ATLAS_GITHUB_TOKEN. */
function githubCredential() {
  if (process.env.ATLAS_GITHUB_TOKEN) return { username: 'x-access-token', token: process.env.ATLAS_GITHUB_TOKEN };
  step('Signing in to GitHub (a browser window may open)');
  const host = new URL(GITHUB_GIT).host;
  const out = spawnSync('git', ['credential', 'fill'], { cwd: ROOT, input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (out.status !== 0) fail('GitHub sign-in was cancelled or failed. Run this again, or set ATLAS_GITHUB_TOKEN to a personal access token with "repo" access.');
  const fields = Object.fromEntries(out.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  if (!fields.password) fail('GitHub didn’t return a sign-in token.');
  return { username: fields.username, token: fields.password, raw: out.stdout };
}

async function gh(token, method, path, body) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'atlas-deploy', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

async function ensureGitHubRepo(state) {
  if (gitOk(['remote', 'get-url', 'origin'])) {
    const origin = git(['remote', 'get-url', 'origin']);
    ok(`GitHub repository: ${origin}`);
    return origin;
  }
  if (DRY) {
    step('Would sign in to GitHub, create a PRIVATE repository and add it as origin');
    return `${GITHUB_GIT}/<you>/${process.env.ATLAS_DEPLOY_REPO ?? 'atlas'}.git`;
  }
  const cred = githubCredential();
  const me = await gh(cred.token, 'GET', '/user');
  if (me.status !== 200) fail(`GitHub rejected the sign-in (HTTP ${me.status}).`);
  const login = me.json.login;
  ok(`Signed in to GitHub as ${login}`);

  let name = process.env.ATLAS_DEPLOY_REPO ?? (await prompt(`Repository name [${SERVICE_NAME_DEFAULT}]: `, { fallback: SERVICE_NAME_DEFAULT })) ?? '';
  name = (name || SERVICE_NAME_DEFAULT).replace(/[^A-Za-z0-9._-]/g, '-');
  for (;;) {
    const existing = await gh(cred.token, 'GET', `/repos/${login}/${name}`);
    if (existing.status === 404) {
      step(`Creating private repository ${login}/${name}`);
      const created = await gh(cred.token, 'POST', '/user/repos', { name, private: true, description: 'ATLAS — Your Universe of Entertainment', has_issues: false, has_wiki: false, auto_init: false });
      if (created.status !== 201) fail(`GitHub couldn’t create the repository (HTTP ${created.status}: ${created.json.message ?? 'unknown error'}).`);
      ok(`Created private repository ${created.json.html_url ?? `${login}/${name}`}`);
      break;
    }
    if (existing.status === 200) {
      const commits = await gh(cred.token, 'GET', `/repos/${login}/${name}/commits?per_page=1`);
      const empty = commits.status === 409;
      if (empty || state.githubRepo === `${login}/${name}`) {
        ok(`Using your existing repository ${login}/${name}`);
        break;
      }
      warn(`${login}/${name} already exists and has other content.`);
      const other = await prompt('Choose another repository name: ', { fallback: '' });
      if (!other) fail('No repository name given.');
      name = other.replace(/[^A-Za-z0-9._-]/g, '-');
      continue;
    }
    fail(`GitHub returned HTTP ${existing.status} while checking the repository.`);
  }
  const remote = `${GITHUB_GIT}/${login}/${name}.git`;
  git(['remote', 'add', 'origin', remote]);
  state.githubRepo = `${login}/${name}`;
  saveState(state);
  // Keep the sign-in for git push (Git Credential Manager stores it).
  if (cred.raw) spawnSync('git', ['credential', 'approve'], { cwd: ROOT, input: cred.raw + '\n', encoding: 'utf8' });
  return remote;
}

function push() {
  if (DRY) {
    step('Would push branch main to GitHub');
    return;
  }
  step('Uploading to GitHub');
  const r = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) fail('Push to GitHub failed. Check your access to the repository, then run this again.');
  ok('All files are on GitHub');
}

/* ---------------- Render ---------------- */

async function render(key, method, path, body) {
  const res = await fetch(`${RENDER_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

function readEnvLocal() {
  const file = join(ROOT, '.env.local');
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    out[line.slice(0, line.indexOf('=')).trim()] = line.slice(line.indexOf('=') + 1).trim();
  }
  return out;
}

/** Same settings as render.yaml, so the dashboard Blueprint and this script agree. */
function serviceBody({ ownerId, name, repo, plan, region, setupToken, providerUrl, providerName }) {
  const envVars = [
    { key: 'NODE_VERSION', value: '22' },
    { key: 'ATLAS_HOST', value: '0.0.0.0' },
    { key: 'ATLAS_SECURE_COOKIES', value: 'true' },
    { key: 'ATLAS_TRUST_PROXY', value: '1' },
    { key: 'ATLAS_PUBLIC', value: 'true' },
    { key: 'ATLAS_SETUP_TOKEN', value: setupToken },
  ];
  if (plan !== 'free') envVars.push({ key: 'ATLAS_DATA_DIR', value: '/var/data/atlas' });
  if (providerUrl) envVars.push({ key: 'ATLAS_INITIAL_M3U_URL', value: providerUrl }, { key: 'ATLAS_INITIAL_PROVIDER_NAME', value: providerName || 'Primary provider' });
  return {
    type: 'web_service',
    name,
    ownerId,
    repo,
    branch: 'main',
    autoDeployTrigger: 'commit',
    envVars,
    serviceDetails: {
      runtime: 'node',
      plan,
      region,
      numInstances: 1,
      healthCheckPath: '/api/status',
      ...(plan !== 'free' ? { disk: { name: 'atlas-data', mountPath: '/var/data', sizeGB: 1 } } : {}),
      envSpecificDetails: { buildCommand: 'npm ci --include=dev && npm run build', startCommand: 'npm start' },
    },
  };
}

async function waitForDeploy(key, serviceId, deployId) {
  const started = Date.now();
  let last = '';
  const interval = Number(process.env.ATLAS_DEPLOY_POLL_MS ?? 10_000);
  for (;;) {
    const r = await render(key, 'GET', `/services/${serviceId}/deploys/${deployId}`);
    const status = r.json.status ?? `HTTP ${r.status}`;
    if (status !== last) {
      const label = { created: 'Queued', queued: 'Queued', build_in_progress: 'Building (a few minutes)', update_in_progress: 'Starting the server', pre_deploy_in_progress: 'Preparing' }[status] ?? status;
      step(`Render: ${label}`);
      last = status;
    }
    if (status === 'live') return true;
    if (['build_failed', 'update_failed', 'canceled', 'deactivated', 'pre_deploy_failed'].includes(status)) return false;
    if (Date.now() - started > 30 * 60_000) {
      warn('Still deploying after 30 minutes. Check the Render dashboard.');
      return false;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

const BUILD_COMMAND = 'npm ci --include=dev && npm run build';
const START_COMMAND = 'npm start';

const sameRepo = (a, b) => !!a && !!b && a.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase() === b.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();

async function renderKey() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY;
  console.log('\n  Render needs an API key for this step:');
  console.log('  1. A browser tab opens on Render → Account Settings → API Keys.');
  console.log('  2. Sign in or sign up, click "Create API Key", name it ATLAS, copy it.');
  console.log('  3. Also make sure Render is connected to GitHub (Account Settings → Git Providers)');
  console.log('     and can see your private repository.\n');
  openBrowser('https://dashboard.render.com/u/settings#api-keys');
  const key = await prompt('Paste your Render API key (hidden): ', { hidden: true });
  if (!key) fail('No Render API key given.');
  return key;
}

/** Render can't read the repo yet: open the GitHub connection page and let the user retry. */
async function waitForRepoAccess(message) {
  warn(`Render can’t read the repository yet: ${message}`);
  console.log('  Connect GitHub in Render and give it access to this repository, then press Enter to retry.');
  openBrowser('https://dashboard.render.com/select-repo?type=web');
  if (!process.stdin.isTTY) fail('Render can’t access the repository.');
  await prompt('Press Enter when done (or Ctrl+C to stop)... ');
}

const repoAccessError = (status, message) => status < 500 && /repo|git|github|access|permission|not found/i.test(message);

/**
 * Bring an existing Render service in line with this project: right repository and branch,
 * build/start commands, and every setting ATLAS needs. Then deploy with a clean build cache.
 */
async function reconcileAndDeploy(key, svc, repoHttps, state) {
  const details = svc.serviceDetails ?? {};
  const commands = details.envSpecificDetails ?? {};
  const wrongRepo = !sameRepo(svc.repo, repoHttps) || svc.branch !== 'main';
  const wrongCommands = commands.buildCommand !== BUILD_COMMAND || commands.startCommand !== START_COMMAND || details.healthCheckPath !== '/api/status';
  if (wrongRepo || wrongCommands) {
    step(
      wrongRepo
        ? `Pointing Render service "${svc.name}" at ${repoHttps} (it was using ${svc.repo || 'no repository'})`
        : `Correcting the build and start commands of Render service "${svc.name}"`,
    );
    for (;;) {
      const r = await render(key, 'PATCH', `/services/${svc.id}`, {
        repo: repoHttps,
        branch: 'main',
        autoDeployTrigger: 'commit',
        serviceDetails: { healthCheckPath: '/api/status', envSpecificDetails: { buildCommand: BUILD_COMMAND, startCommand: START_COMMAND } },
      });
      if (r.status === 200) {
        svc = r.json;
        break;
      }
      const message = r.json.message ?? `HTTP ${r.status}`;
      if (repoAccessError(r.status, message)) {
        await waitForRepoAccess(message);
        continue;
      }
      fail(`Render couldn’t update the service: ${message}`);
    }
    ok(wrongRepo ? 'Render service now builds from the right repository' : 'Render build and start commands corrected');
  }

  const list = await render(key, 'GET', `/services/${svc.id}/env-vars?limit=100`);
  if (list.status !== 200 || !Array.isArray(list.json)) fail(`Couldn’t read the service settings (HTTP ${list.status}).`);
  const current = Object.fromEntries(list.json.map((i) => [i.envVar.key, i.envVar.value]));
  const disk = svc.serviceDetails?.disk;
  const wanted = {
    NODE_VERSION: '22',
    ATLAS_HOST: '0.0.0.0',
    ATLAS_SECURE_COOKIES: 'true',
    ATLAS_TRUST_PROXY: '1',
    ATLAS_PUBLIC: 'true',
    ...(disk?.mountPath ? { ATLAS_DATA_DIR: `${disk.mountPath.replace(/\/$/, '')}/atlas` } : {}),
  };
  if (!current.ATLAS_SETUP_TOKEN) wanted.ATLAS_SETUP_TOKEN = randomBytes(9).toString('base64url');
  const env = readEnvLocal();
  if (!current.ATLAS_INITIAL_M3U_URL && env.ATLAS_INITIAL_M3U_URL) {
    if (await confirm('Send the playlist link from .env.local to Render as an encrypted setting, so it is imported into YOUR account on first start?')) {
      wanted.ATLAS_INITIAL_M3U_URL = env.ATLAS_INITIAL_M3U_URL;
      wanted.ATLAS_INITIAL_PROVIDER_NAME = env.ATLAS_INITIAL_PROVIDER_NAME || 'Primary provider';
    }
  }
  let changed = 0;
  for (const [k, v] of Object.entries(wanted)) {
    if (current[k] === v) continue;
    const r = await render(key, 'PUT', `/services/${svc.id}/env-vars/${encodeURIComponent(k)}`, { value: v });
    if (r.status !== 200) fail(`Couldn’t set ${k} on Render (HTTP ${r.status}: ${r.json.message ?? 'error'}).`);
    changed++;
  }
  ok(changed ? `Updated ${changed} Render setting${changed === 1 ? '' : 's'}` : 'Render settings already correct');
  if (!disk) warn('This Render service has no disk: accounts and history are wiped on every restart. Add a 1 GB disk at /var/data in the Render dashboard to keep them.');

  Object.assign(state, {
    renderServiceId: svc.id,
    renderUrl: svc.serviceDetails?.url ?? state.renderUrl,
    renderDashboard: svc.dashboardUrl ?? state.renderDashboard,
    renderRepo: repoHttps,
    setupCode: wanted.ATLAS_SETUP_TOKEN ?? current.ATLAS_SETUP_TOKEN,
  });
  saveState(state);

  step('Starting a clean deploy');
  const d = await render(key, 'POST', `/services/${svc.id}/deploys`, { clearCache: 'clear' });
  if (!d.json.id) fail(`Render didn’t start a deploy (HTTP ${d.status}: ${d.json.message ?? 'error'}).`);
  const live = await waitForDeploy(key, svc.id, d.json.id);
  if (!live) fail(`The deploy didn’t go live. Open ${state.renderDashboard} → Logs to see why.`);
}

async function ensureRenderService(state, repoUrl) {
  const repoHttps = repoUrl.replace(/\.git$/, '');
  // Already set up and verified against this repository: the push triggers the redeploy.
  if (state.renderServiceId && sameRepo(state.renderRepo, repoHttps)) {
    ok(`Render redeploys automatically from GitHub: ${state.renderUrl ?? state.renderDashboard ?? state.renderServiceId}`);
    return;
  }
  if (DRY) {
    step(state.renderServiceId ? 'Would check the Render service uses this repository and fix its settings, then deploy' : 'Would ask for a Render API key, create the web service (after you confirm the plan) and wait for it to go live');
    return;
  }

  const key = await renderKey();

  if (state.renderServiceId) {
    step('Checking your Render service');
    const existing = await render(key, 'GET', `/services/${state.renderServiceId}`);
    if (existing.status === 401) fail('Render rejected that API key.');
    if (existing.status === 200) return reconcileAndDeploy(key, existing.json, repoHttps, state);
    if (existing.status !== 404) fail(`Couldn’t read the Render service (HTTP ${existing.status}).`);
    warn('The Render service saved in deploy.local.json no longer exists. Creating a new one.');
    delete state.renderServiceId;
    delete state.renderUrl;
    delete state.renderDashboard;
  }

  const owners = await render(key, 'GET', '/owners?limit=20');
  if (owners.status === 401) fail('Render rejected that API key.');
  if (owners.status !== 200 || !Array.isArray(owners.json) || !owners.json.length) fail(`Couldn’t read your Render workspaces (HTTP ${owners.status}).`);
  let owner = owners.json[0].owner;
  if (owners.json.length > 1) {
    owners.json.forEach((o, i) => console.log(`  ${i + 1}. ${o.owner.name} (${o.owner.type})`));
    const pick = Number(await prompt('Which workspace? [1] ', { fallback: '1' })) || 1;
    owner = owners.json[Math.min(owners.json.length, Math.max(1, pick)) - 1].owner;
  }
  ok(`Render workspace: ${owner.name}`);

  let name = SERVICE_NAME_DEFAULT;
  const same = await render(key, 'GET', `/services?name=${encodeURIComponent(name)}&ownerId=${encodeURIComponent(owner.id)}&limit=20`);
  if (same.status === 200 && Array.isArray(same.json) && same.json.length) {
    const svc = same.json[0].service;
    const where = sameRepo(svc.repo, repoHttps) ? 'already uses this repository' : `uses ${svc.repo || 'another repository'}; it will be switched to ${repoHttps}`;
    if (await confirm(`A Render service named "${name}" already exists (${svc.serviceDetails?.url ?? svc.dashboardUrl}; it ${where}). Use it?`)) {
      return reconcileAndDeploy(key, svc, repoHttps, state);
    }
    name = `atlas-${randomBytes(2).toString('hex')}`;
  }

  const planEnv = process.env.ATLAS_DEPLOY_PLAN;
  let plan = planEnv === 'free' || planEnv === 'starter' ? planEnv : '';
  if (!plan) {
    console.log('\n  Choose a Render plan:');
    console.log('  1. Starter + 1 GB disk (paid, recommended): accounts, profiles and history are kept.');
    console.log('  2. Free: no disk. Everything is wiped on every deploy or restart, and it sleeps when idle.');
    plan = (await prompt('Plan [1]: ', { fallback: '1' })) === '2' ? 'free' : 'starter';
  }
  if (plan === 'starter' && !(await confirm('This creates a PAID Starter instance and 1 GB disk on your Render account (see render.com/pricing). Continue?'))) {
    fail('Stopped before creating anything on Render.');
  }
  const region = process.env.ATLAS_DEPLOY_REGION ?? 'frankfurt';

  const env = readEnvLocal();
  let providerUrl = env.ATLAS_INITIAL_M3U_URL;
  if (providerUrl && !(await confirm('Send the playlist link from .env.local to Render as an encrypted setting, so it is imported into YOUR account on first start?'))) providerUrl = undefined;

  const setupToken = randomBytes(9).toString('base64url');
  for (;;) {
    step(`Creating Render web service "${name}" (${plan}, ${region})`);
    const created = await render(key, 'POST', '/services', serviceBody({ ownerId: owner.id, name, repo: repoHttps, plan, region, setupToken, providerUrl, providerName: env.ATLAS_INITIAL_PROVIDER_NAME }));
    if (created.status === 201) {
      const svc = created.json.service;
      Object.assign(state, { renderServiceId: svc.id, renderUrl: svc.serviceDetails?.url, renderDashboard: svc.dashboardUrl, renderRepo: repoHttps, setupCode: setupToken, plan });
      saveState(state);
      ok(`Render service created: ${svc.dashboardUrl}`);
      const live = await waitForDeploy(key, svc.id, created.json.deployId);
      if (!live) fail(`The first deploy didn’t go live. Open ${svc.dashboardUrl} → Logs to see why.`);
      return;
    }
    const message = created.json.message ?? created.json.error?.message ?? `HTTP ${created.status}`;
    if (repoAccessError(created.status, message)) {
      await waitForRepoAccess(message);
      continue;
    }
    if (/payment|card|billing/i.test(message)) fail(`Render needs a payment method for the Starter plan: ${message}. Add one in the Render dashboard, or run again and choose Free.`);
    fail(`Render couldn’t create the service: ${message}`);
  }
}

/** Returns whether the website still needs its owner account (so the setup code matters). */
async function checkSite(state) {
  if (DRY || !state.renderUrl) return false;
  try {
    const r = await fetch(`${state.renderUrl}/api/status`, { headers: { 'User-Agent': 'atlas-deploy' } });
    const j = await r.json();
    if (j.server) ok(`Website is up: ${state.renderUrl}`);
    return !!j.setupRequired;
  } catch {
    warn('The website didn’t answer yet; it may need another minute.');
    return !!state.setupCode;
  }
}

/* ---------------- main ---------------- */

async function main() {
  console.log(DRY ? '\n  Dry run: nothing will be changed.\n' : '');
  const state = loadState();
  if (!gitOk(['rev-parse', '--is-inside-work-tree'])) fail('This folder isn’t a Git repository.');
  commitAll();
  const repo = await ensureGitHubRepo(state);
  push();
  await ensureRenderService(state, repo);
  const needsSetup = await checkSite(state);

  console.log('\n  ------------------------------------------------------------');
  if (state.renderUrl) {
    console.log(`  Your website:  ${state.renderUrl}`);
    if (needsSetup && state.setupCode) {
      console.log(`  Setup code:    ${state.setupCode}   (needed once, to create the owner account)`);
      console.log('  Next: open the website, enter the setup code, create your account,');
      console.log('        then allow your provider’s HTTP connection when asked.');
      openBrowser(state.renderUrl);
    }
    console.log('  Saved in deploy.local.json (kept off GitHub).');
  }
  console.log('  Run deploy-to-render.bat again any time to publish changes.');
  console.log('  ------------------------------------------------------------');
}

main()
  .then(() => {
    rl?.close();
    process.exit(0);
  })
  .catch((err) => {
    rl?.close();
    console.log(`\n[X] ${err instanceof Stop ? err.message : `Unexpected error: ${err?.message ?? err}`}`);
    process.exit(1);
  });
