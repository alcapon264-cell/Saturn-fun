import fs from 'node:fs';

const appPath = 'lib/app.js';
const routerPath = 'api/[route].js';
let app = fs.readFileSync(appPath, 'utf8');
let router = fs.readFileSync(routerPath, 'utf8');

function once(source, needle, replacement, label) {
  if (source.includes(replacement.trim())) return source;
  const at = source.indexOf(needle);
  if (at < 0) throw new Error(`Cannot safely patch ${label}: anchor not found. No files changed.`);
  return source.slice(0, at) + replacement + source.slice(at + needle.length);
}

// Import the provider adapter alongside the existing EVM holder adapter.
app = once(app,
  "import { evmHolders as getEvmHolders } from './evm-holders.js';\n",
  "import { bnbHolders as getBnbHolders } from './bnbHolders.js';\n",
  'BNB adapter import');

// Add a route through the same public-data guard as /api/evm-holders.
const evmBlock = `  const evmHolders = guard('GET', async (req, res) => {\n    const q = evmQuery(req);\n    const r = await getEvmHolders({\n      chain: q.chain,\n      token: q.token,\n      limit: q.limit,\n      cursor: q.cursor\n    }, { env });\n    return send(res, r.status, r.body);\n  }, { name: 'evm-holders', limit: 30 });\n`;
const bnbBlock = `\n  // GET /api/bnb-holders — public on-chain holder data, using the exact same\n  // shared origin/CORS guard and per-IP rate limiter as /api/evm-holders.\n  // This is intentionally public like EVM holders; it does not expose account data.\n  const bnbHolders = guard('GET', async (req, res) => {\n    const q = evmQuery(req);\n    const r = await getBnbHolders({ query: q, env });\n    return send(res, r.status, r.body);\n  }, { name: 'bnb-holders', limit: 30 });\n`;
if (!app.includes("const bnbHolders = guard('GET'")) {
  if (!app.includes(evmBlock)) throw new Error('Cannot safely patch lib/app.js: exact evmHolders block not found. No files changed.');
  app = app.replace(evmBlock, evmBlock + bnbBlock);
}
if (!/return \{[\s\S]*?\bbnbHolders,/.test(app)) {
  app = app.replace('  evmHolders,\n', '  evmHolders,\n  bnbHolders,\n');
  if (!/return \{[\s\S]*?\bbnbHolders,/.test(app)) throw new Error('Cannot safely patch lib/app.js: return export anchor not found.');
}

router = once(router, "  'evm-holders': 'evmHolders',\n", "  'bnb-holders': 'bnbHolders',\n", 'Vercel route mapping');

fs.writeFileSync(appPath, app);
fs.writeFileSync(routerPath, router);
console.log('Integrated /api/bnb-holders through Saturn shared CORS, rate limit and API router.');


// Append the BNB tests to the existing test command without removing other suites.
const packagePath = 'package.json';
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const currentTest = String(packageJson.scripts?.test || 'node --test');
if (!currentTest.includes('tests/bnbHolders.test.js')) {
  packageJson.scripts = packageJson.scripts || {};
  packageJson.scripts.test = currentTest + ' tests/bnbHolders.test.js';
  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
}
