const { loadEnv } = require('./lib/env');
loadEnv();

// Optional: allow enterprise self-signed TLS certificates when explicitly enabled in .env
if (String(process.env.ALLOW_INSECURE_TLS || '').toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const {
  cleanBaseUrl,
  createHttpError,
  validateJiraCredentials,
  fetchMetadata
} = require('./lib/jira-client');
const { getAiStatus } = require('./lib/ai-client');
const { runSimilaritySearch } = require('./lib/similarity-engine');

const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MINUTES = Math.max(Number(process.env.SESSION_TTL_MINUTES || 60), 5);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Strictly in-memory session & short-lived metadata cache. Never written to disk.
let activeSession = null;
let metadataCache = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        reject(createHttpError('Request payload too large.', 413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(createHttpError('Invalid JSON request body.', 400));
      }
    });

    req.on('error', err => {
      if (!aborted) reject(err);
    });
  });
}

function getActiveSession() {
  if (!activeSession) return null;
  if (Date.now() >= activeSession.expiresAtMs) {
    activeSession = null;
    metadataCache = null;
    return null;
  }
  return activeSession;
}

function buildPublicSessionInfo(session) {
  if (!session) return null;
  let serverHost = session.baseUrl;
  try {
    serverHost = new URL(session.baseUrl).hostname;
  } catch {
    // keep raw baseUrl
  }
  return {
    connected: true,
    username: session.username,
    displayName: session.displayName,
    authType: session.authType,
    baseUrl: session.baseUrl,
    serverHost,
    connectedAt: session.connectedAt,
    expiresAt: new Date(session.expiresAtMs).toISOString()
  };
}

function serveStaticFile(reqPath, res) {
  const safeRelative = reqPath === '/' ? '/index.html' : reqPath;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, safeRelative));

  // Prevent directory traversal outside public/
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  fs.readFile(resolvedPath, (err, content) => {
    if (err) {
      return sendJson(res, 404, { error: 'Not found' });
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;

    // Static assets (HTML, CSS, JS)
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      return serveStaticFile(pathname, res);
    }

    // Health check
    if (req.method === 'GET' && pathname === '/api/health') {
      const session = getActiveSession();
      const ai = getAiStatus();
      return sendJson(res, 200, {
        ok: true,
        connected: Boolean(session),
        aiConfigured: ai.configured,
        aiModel: ai.model
      });
    }

    // Bootstrap configuration & live session status (never returns secrets)
    if (req.method === 'GET' && pathname === '/api/config') {
      const session = getActiveSession();
      const ai = getAiStatus();
      const rawDefaultUrl = String(process.env.JIRA_BASE_URL || '').trim();
      const defaultJiraUrl = /^<.*>$/.test(rawDefaultUrl) ? '' : rawDefaultUrl;

      return sendJson(res, 200, {
        defaultJiraUrl,
        programProjectFieldName: String(process.env.JIRA_PROGRAM_PROJECT_FIELD_NAME || 'Program/Project').trim(),
        sessionTtlMinutes: SESSION_TTL_MINUTES,
        ai,
        session: buildPublicSessionInfo(session)
      });
    }

    // Authenticate with Jira (Username + Password Basic Auth OR PAT Bearer Auth)
    if (req.method === 'POST' && pathname === '/api/auth/connect') {
      const body = await readJsonBody(req);
      const rawUrl = (body.baseUrl || process.env.JIRA_BASE_URL || '').trim();
      const authType = body.authType === 'bearer' ? 'bearer' : 'basic';
      const username = String(body.username || '').trim();
      const secret = String(body.secret || '');

      if (!rawUrl) {
        return sendJson(res, 400, { error: 'Jira Base URL is required.' });
      }
      if (!secret) {
        return sendJson(res, 400, {
          error: authType === 'bearer' ? 'Personal Access Token is required.' : 'Jira password is required.'
        });
      }
      if (authType !== 'bearer' && !username) {
        return sendJson(res, 400, { error: 'Jira username is required for password login.' });
      }

      const baseUrl = cleanBaseUrl(rawUrl);
      const candidate = { baseUrl, username, secret, authType };

      console.log(`[Auth] Validating Jira connection (${authType}) for ${username || 'PAT user'} -> ${baseUrl}`);
      const profile = await validateJiraCredentials(candidate);

      const now = Date.now();
      activeSession = {
        baseUrl,
        username: profile.username,
        displayName: profile.displayName,
        emailAddress: profile.emailAddress,
        secret,
        authType,
        connectedAt: new Date(now).toISOString(),
        expiresAtMs: now + SESSION_TTL_MINUTES * 60 * 1000
      };
      metadataCache = null;

      return sendJson(res, 200, {
        session: buildPublicSessionInfo(activeSession)
      });
    }

    // Disconnect and wipe credentials from memory
    if (req.method === 'POST' && pathname === '/api/auth/disconnect') {
      activeSession = null;
      metadataCache = null;
      return sendJson(res, 200, { disconnected: true });
    }

    // Load Program/Project options & Jira Issue Types
    if (req.method === 'GET' && pathname === '/api/metadata') {
      const session = getActiveSession();
      if (!session) {
        return sendJson(res, 401, { error: 'Jira session expired or not connected. Please reconnect.' });
      }

      const forceRefresh = parsedUrl.searchParams.get('refresh') === 'true';
      const CACHE_TTL_MS = 10 * 60 * 1000;

      if (
        !forceRefresh &&
        metadataCache &&
        metadataCache.username === session.username &&
        Date.now() - metadataCache.loadedAtMs < CACHE_TTL_MS
      ) {
        return sendJson(res, 200, metadataCache.data);
      }

      const data = await fetchMetadata(session);
      metadataCache = {
        username: session.username,
        loadedAtMs: Date.now(),
        data
      };

      return sendJson(res, 200, data);
    }

    // Similarity Search API (Understanding -> Retrieving -> Hybrid Lexical + AI Ranking)
    if (req.method === 'POST' && pathname === '/api/search') {
      const session = getActiveSession();
      if (!session) {
        return sendJson(res, 401, { error: 'Jira session expired or not connected. Please reconnect.' });
      }

      const body = await readJsonBody(req);
      const query = String(body.query || '').trim();

      if (!query) {
        return sendJson(res, 400, { error: 'Please enter an issue description, summary, or Jira ticket key.' });
      }
      if (query.length > 1000) {
        return sendJson(res, 400, { error: 'Search query must be 1000 characters or fewer.' });
      }

      // Slide session expiry forward on active usage
      session.expiresAtMs = Date.now() + SESSION_TTL_MINUTES * 60 * 1000;

      const searchResult = await runSimilaritySearch(session, {
        query,
        programProject: body.programProject || 'ALL',
        issueType: body.issueType || 'ALL',
        includeResolved: body.includeResolved !== false
      });

      return sendJson(res, 200, {
        ...searchResult,
        sessionExpiresAt: new Date(session.expiresAtMs).toISOString()
      });
    }

    return sendJson(res, 404, { error: 'Endpoint not found.' });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    console.error(`[Server Error] ${req.method} ${req.url} -> ${statusCode}: ${err.message}`);
    return sendJson(res, statusCode, {
      error: err.message || 'An unexpected server error occurred.'
    });
  }
});

server.listen(PORT, 'localhost', () => {
  const ai = getAiStatus();
  console.log('====================================================');
  console.log(`IssueMatcher running at http://localhost:${PORT}`);
  console.log(`AI Engine: ${ai.configured ? `Enabled (${ai.model})` : 'Keyword-only mode (configure INTERNAL_LLM_* in .env)'}`);
  console.log('====================================================');
});
