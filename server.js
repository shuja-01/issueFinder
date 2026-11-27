const { loadEnv } = require('./lib/env');
loadEnv();

const {
  initLogger,
  getLogConfig,
  logInfo,
  logError,
  logRequest,
  logResponse
} = require('./lib/logger');
initLogger();

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
let requestCounter = 0;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload, reqCtx) {
  const durationMs = reqCtx ? Date.now() - reqCtx.startedAt : 0;
  if (reqCtx) {
    logResponse(
      'HTTP',
      `${reqCtx.id} ${reqCtx.method} ${reqCtx.url} -> HTTP ${statusCode} (${durationMs}ms)`,
      { statusCode, durationMs, body: payload }
    );
  }
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

function serveStaticFile(reqPath, res, reqCtx) {
  const safeRelative = reqPath === '/' ? '/index.html' : reqPath;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, safeRelative));

  // Prevent directory traversal outside public/
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'Forbidden' }, reqCtx);
  }

  fs.readFile(resolvedPath, (err, content) => {
    if (err) {
      return sendJson(res, 404, { error: 'Not found' }, reqCtx);
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const durationMs = reqCtx ? Date.now() - reqCtx.startedAt : 0;

    if (reqCtx) {
      logResponse(
        'HTTP',
        `${reqCtx.id} ${reqCtx.method} ${reqCtx.url} -> HTTP 200 (${durationMs}ms, ${content.length} bytes, ${contentType})`
      );
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const reqCtx = {
    id: `REQ-${++requestCounter}`,
    method: req.method,
    url: req.url,
    startedAt: Date.now()
  };

  try {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;

    // Static assets (HTML, CSS, JS)
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      logRequest('HTTP', `${reqCtx.id} ${req.method} ${req.url} (static)`);
      return serveStaticFile(pathname, res, reqCtx);
    }

    // Parse body upfront for POST/PUT/PATCH API requests so we can log every request cleanly
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      body = await readJsonBody(req);
    }

    const queryObj = Object.fromEntries(parsedUrl.searchParams.entries());
    logRequest('HTTP', `${reqCtx.id} ${req.method} ${req.url}`, {
      method: req.method,
      path: pathname,
      ...(Object.keys(queryObj).length > 0 ? { query: queryObj } : {}),
      ...(Object.keys(body).length > 0 ? { body } : {})
    });

    // Health check
    if (req.method === 'GET' && pathname === '/api/health') {
      const session = getActiveSession();
      const ai = getAiStatus();
      return sendJson(res, 200, {
        ok: true,
        connected: Boolean(session),
        aiConfigured: ai.configured,
        aiModel: ai.model
      }, reqCtx);
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
      }, reqCtx);
    }

    // Authenticate with Jira (Username + Password Basic Auth OR PAT Bearer Auth)
    if (req.method === 'POST' && pathname === '/api/auth/connect') {
      const rawUrl = (body.baseUrl || process.env.JIRA_BASE_URL || '').trim();
      const authType = body.authType === 'bearer' ? 'bearer' : 'basic';
      const username = String(body.username || '').trim();
      const secret = String(body.secret || '');

      if (!rawUrl) {
        return sendJson(res, 400, { error: 'Jira Base URL is required.' }, reqCtx);
      }
      if (!secret) {
        return sendJson(res, 400, {
          error: authType === 'bearer' ? 'Personal Access Token is required.' : 'Jira password is required.'
        }, reqCtx);
      }
      if (authType !== 'bearer' && !username) {
        return sendJson(res, 400, { error: 'Jira username is required for password login.' }, reqCtx);
      }

      const baseUrl = cleanBaseUrl(rawUrl);
      const candidate = { baseUrl, username, secret, authType };

      logInfo('AUTH', `${reqCtx.id} Validating Jira connection (${authType}) for ${username || 'PAT user'} -> ${baseUrl}`);
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
      }, reqCtx);
    }

    // Disconnect and wipe credentials from memory
    if (req.method === 'POST' && pathname === '/api/auth/disconnect') {
      const prevUser = activeSession?.username || 'none';
      activeSession = null;
      metadataCache = null;
      logInfo('AUTH', `${reqCtx.id} Disconnected Jira session (user=${prevUser})`);
      return sendJson(res, 200, { disconnected: true }, reqCtx);
    }

    // Load Program/Project options & Jira Issue Types
    if (req.method === 'GET' && pathname === '/api/metadata') {
      const session = getActiveSession();
      if (!session) {
        return sendJson(res, 401, { error: 'Jira session expired or not connected. Please reconnect.' }, reqCtx);
      }

      const forceRefresh = parsedUrl.searchParams.get('refresh') === 'true';
      const CACHE_TTL_MS = 10 * 60 * 1000;

      if (
        !forceRefresh &&
        metadataCache &&
        metadataCache.username === session.username &&
        Date.now() - metadataCache.loadedAtMs < CACHE_TTL_MS
      ) {
        logInfo('METADATA', `${reqCtx.id} Serving cached metadata for ${session.username}`);
        return sendJson(res, 200, metadataCache.data, reqCtx);
      }

      const data = await fetchMetadata(session);
      metadataCache = {
        username: session.username,
        loadedAtMs: Date.now(),
        data
      };

      return sendJson(res, 200, data, reqCtx);
    }

    // Similarity Search API (Understanding -> Retrieving -> Hybrid Lexical + AI Ranking)
    if (req.method === 'POST' && pathname === '/api/search') {
      const session = getActiveSession();
      if (!session) {
        return sendJson(res, 401, { error: 'Jira session expired or not connected. Please reconnect.' }, reqCtx);
      }

      const query = String(body.query || '').trim();

      if (!query) {
        return sendJson(res, 400, { error: 'Please enter an issue description, summary, or Jira ticket key.' }, reqCtx);
      }
      if (query.length > 1000) {
        return sendJson(res, 400, { error: 'Search query must be 1000 characters or fewer.' }, reqCtx);
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
      }, reqCtx);
    }

    return sendJson(res, 404, { error: 'Endpoint not found.' }, reqCtx);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    logError('SERVER', `${reqCtx.id} ${req.method} ${req.url} -> HTTP ${statusCode}: ${err.message}`, {
      stack: err.stack
    });
    return sendJson(res, statusCode, {
      error: err.message || 'An unexpected server error occurred.'
    }, reqCtx);
  }
});

process.on('uncaughtException', err => {
  logError('PROCESS', `Uncaught exception: ${err.message}`, { stack: err.stack });
});

process.on('unhandledRejection', reason => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logError('PROCESS', `Unhandled promise rejection: ${message}`, { stack });
});

server.listen(PORT, 'localhost', () => {
  const ai = getAiStatus();
  const logCfg = getLogConfig();
  logInfo('SERVER', `IssueMatcher started at http://localhost:${PORT}`, {
    port: PORT,
    aiEngine: ai.configured ? `Enabled (${ai.model})` : 'Keyword-only mode (configure INTERNAL_LLM_* in .env)',
    logDir: logCfg.logDir,
    logRetentionDays: logCfg.retentionDays,
    logMaxBodyChars: logCfg.maxBodyChars
  });
});
