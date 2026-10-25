// Runs the ATLAS server (watch mode) and the web dev server together.
//   npm run dev
// Web: http://localhost:5173 (proxies /api to the server on :4870)
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const procs = [
  { name: 'server', color: 36, args: [join(root, 'node_modules/tsx/dist/cli.mjs'), 'watch', '--clear-screen=false', 'apps/server/src/index.ts'] },
  { name: 'web', color: 35, args: [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'apps/web', '--port', '5173'] },
];

const children = procs.map(({ name, color, args }) => {
  const child = spawn(node, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${color}m${name.padEnd(6)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) if (!/ExperimentalWarning|trace-warnings/.test(line)) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited (${code})`);
    for (const c of children) if (c !== child) c.kill();
    process.exit(code ?? 0);
  });
  return child;
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => children.forEach((c) => c.kill()));
