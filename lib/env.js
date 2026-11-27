const fs = require('fs');
const path = require('path');

/**
 * Loads environment variables from .env.
 * Uses `dotenv` when installed, and falls back to a lightweight built-in parser
 * so `node server.js` can run even without `npm install` on restricted machines.
 */
function loadEnv(envPath = path.join(__dirname, '..', '.env')) {
  try {
    require('dotenv').config({ path: envPath });
    return;
  } catch {
    // Fallback parser when node_modules/dotenv is not installed
  }

  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

module.exports = { loadEnv };
