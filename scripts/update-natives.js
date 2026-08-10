// Regenerates data/natives.json from the official FiveM natives databases.
// Run with: npm run update-natives
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_NATIVES_URL = 'https://runtime.fivem.net/doc/natives.json';
const CFX_NATIVES_URL = 'https://runtime.fivem.net/doc/natives_cfx.json';
const OUT_PATH = path.join(__dirname, '..', 'data', 'natives.json');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function addNatives(merged, natives_by_ns, defaultApiset) {
  for (const ns of Object.keys(natives_by_ns)) {
    const natives = natives_by_ns[ns];
    for (const hash of Object.keys(natives)) {
      const n = natives[hash];
      // Undocumented/hash-only natives have no name and so no Lua calling convention
      // (GET_ENTITY_COORDS -> GetEntityCoords) - they're useless for name-based completion,
      // and a null name crashes toLuaName() at runtime. Skip them entirely.
      if (!n.name) continue;
      const key = n.hash || hash;
      const entry = {
        hash: key,
        name: n.name,
        ns: n.ns || ns,
        apiset: n.apiset || defaultApiset,
        params: (n.params || []).map((p) => ({ name: p.name, type: p.type })),
        results: n.results || 'void',
      };
      if (n.description) entry.description = n.description;
      if (n.resultsDescription) entry.resultsDescription = n.resultsDescription;
      merged.set(key, entry);
    }
  }
}

async function main() {
  console.log(`Fetching ${BASE_NATIVES_URL} ...`);
  const base = await fetchJson(BASE_NATIVES_URL);
  console.log(`Fetching ${CFX_NATIVES_URL} ...`);
  const cfx = await fetchJson(CFX_NATIVES_URL);

  const merged = new Map();
  // Base RAGE/GTA natives don't carry official client/server tagging upstream; the
  // overwhelming majority are client-only, so that's the safe default (see README).
  addNatives(merged, base, 'client');
  // CFX-specific natives (exports, events, convars, entity/state-bag helpers, ...) DO carry
  // an authoritative apiset (client/server/shared) - these take priority for accuracy.
  addNatives(merged, cfx, 'shared');

  const natives = [...merged.values()].sort((a, b) => (a.ns + a.name).localeCompare(b.ns + b.name));

  const out = {
    source: `${BASE_NATIVES_URL} + ${CFX_NATIVES_URL}`,
    count: natives.length,
    natives,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`Wrote ${natives.length} natives to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
