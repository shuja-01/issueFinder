const DEFAULT_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw createHttpError('Jira Base URL is required.', 400);
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw createHttpError('Invalid Jira URL format. Include https:// (e.g. https://jira.your-company.com).', 400);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createHttpError('Only HTTP and HTTPS Jira URLs are supported.', 400);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function createHttpError(message, statusCode = 500) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function buildHeaders(session, extra = {}) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'ZephyrApiClient/1.0',
    ...extra
  };

  if (session.authType === 'bearer') {
    headers.Authorization = `Bearer ${session.secret}`;
  } else {
    const encoded = Buffer.from(`${session.username}:${session.secret}`).toString('base64');
    headers.Authorization = `Basic ${encoded}`;
  }

  return headers;
}

async function jiraFetch(session, endpoint, options = {}) {
  if (!session || !session.baseUrl) {
    throw createHttpError('Connect to Jira first.', 401);
  }

  const url = session.baseUrl + endpoint;
  const maxRetries = 3;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        body: options.body,
        headers: buildHeaders(session, options.headers || {}),
        signal: AbortSignal.timeout(timeoutMs)
      });

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const textBody = await response.text();

      let data = null;
      const looksLikeHtml = contentType.includes('text/html') || /^\s*<(!doctype|html)/i.test(textBody);

      if (!looksLikeHtml && textBody) {
        try {
          data = JSON.parse(textBody);
        } catch {
          data = { message: textBody };
        }
      }

      const jiraErrorMsg =
        (data && Array.isArray(data.errorMessages) && data.errorMessages.filter(Boolean).join('; ')) ||
        (data && data.errors && typeof data.errors === 'object' && Object.values(data.errors).filter(Boolean).join('; ')) ||
        (data && data.message) ||
        '';

      const isRateLimited = response.status === 429 || /rate\s*limit/i.test(jiraErrorMsg);

      if (isRateLimited && attempt < maxRetries) {
        const retryAfterSec = Number(response.headers.get('retry-after'));
        const delayMs =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, 15000)
            : Math.min(2000 * Math.pow(2, attempt), 15000);
        console.warn(`[Jira] Rate limited (HTTP ${response.status}). Retrying in ${delayMs}ms...`);
        await sleep(delayMs);
        continue;
      }

      if (!response.ok) {
        if (response.status === 401) {
          const authReason = response.headers.get('x-authentication-denied-reason') || '';
          if (/captcha/i.test(authReason)) {
            throw createHttpError(
              'Jira requires CAPTCHA verification for this account. Sign in to Jira in your browser once, then reconnect here.',
              401
            );
          }
          throw createHttpError(
            session.authType === 'bearer'
              ? 'Authentication failed (HTTP 401). Please verify your Personal Access Token.'
              : 'Authentication failed (HTTP 401). Please check your Jira username and password (or switch to PAT if Basic Auth is disabled).',
            401
          );
        }

        if (response.status === 403) {
          throw createHttpError(
            jiraErrorMsg || 'Access denied by Jira (HTTP 403). Your account may lack permission or require PAT authentication.',
            403
          );
        }

        if (response.status === 404) {
          throw createHttpError(jiraErrorMsg || `Jira endpoint not found (HTTP 404): ${endpoint}`, 404);
        }

        if (isRateLimited) {
          throw createHttpError('Jira rate limit exceeded. Please wait a few seconds and try again.', 429);
        }

        if (looksLikeHtml) {
          throw createHttpError(
            `Jira returned an HTML page (HTTP ${response.status}) instead of JSON. Check your Jira Base URL and VPN/network access.`,
            response.status >= 400 ? response.status : 502
          );
        }

        throw createHttpError(jiraErrorMsg || `Jira request failed (HTTP ${response.status}).`, response.status);
      }

      if (looksLikeHtml) {
        throw createHttpError(
          'Jira returned an HTML login/SSO page instead of API JSON. Verify your Jira Base URL and credentials.',
          401
        );
      }

      return data || {};
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw createHttpError('Jira request timed out. Check your corporate VPN/network connection.', 504);
      }
      if (attempt >= maxRetries || !err.statusCode || err.statusCode !== 429) {
        throw err;
      }
    }
  }
}

async function validateJiraCredentials(candidate) {
  let me;
  try {
    me = await jiraFetch(candidate, '/rest/api/latest/myself');
  } catch (err) {
    // Only fall back to REST API v3 if v2/latest endpoint itself is missing (404)
    if (err.statusCode === 404) {
      me = await jiraFetch(candidate, '/rest/api/3/myself');
    } else {
      throw err;
    }
  }

  return {
    username: me.name || me.emailAddress || candidate.username,
    displayName: me.displayName || me.name || candidate.username,
    emailAddress: me.emailAddress || '',
    accountId: me.accountId || me.key || ''
  };
}

async function fetchMetadata(session, options = {}) {
  const fieldId = String(options.programProjectFieldId || process.env.JIRA_PROGRAM_PROJECT_FIELD_ID || '15309').trim();
  const fieldName = String(options.programProjectFieldName || process.env.JIRA_PROGRAM_PROJECT_FIELD_NAME || 'Program/Project').trim();

  let programProjects = [];
  let programProjectError = null;

  try {
    const ppData = await jiraFetch(
      session,
      `/rest/api/latest/customFields/${encodeURIComponent(fieldId)}/options?maxResults=1000&useAllContexts=true&sortByOptionName=true`
    );
    const values = (ppData.options || ppData.values || [])
      .filter(item => item && item.value && !item.disabled)
      .map(item => String(item.value).trim())
      .filter(Boolean);
    programProjects = [...new Set(values)].sort((a, b) => a.localeCompare(b));
  } catch (err) {
    programProjectError = err.message;
    console.warn(`[Metadata] Could not load customfield_${fieldId} options: ${err.message}`);
  }

  // Polite small delay between Jira calls to avoid rate limiting
  await sleep(300);

  let issueTypes = [];
  try {
    const typeData = await jiraFetch(session, '/rest/api/latest/issuetype');
    const list = Array.isArray(typeData) ? typeData : typeData.issueTypes || [];
    const names = list
      .filter(t => t && t.name)
      .map(t => String(t.name).trim())
      .filter(Boolean);
    issueTypes = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.warn(`[Metadata] Could not load Jira issue types, using defaults: ${err.message}`);
    issueTypes = ['Bug', 'Defect', 'Epic', 'Story', 'Sub-task', 'Task', 'Tech Enabler', 'Test Cases'];
  }

  return {
    programProjects,
    programProjectError,
    issueTypes,
    fieldId,
    fieldName
  };
}

function escapeJqlValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

/**
 * Cleans user text for Jira Lucene `~` operator so special query syntax characters
 * do not trigger HTTP 400 JQL parse errors.
 */
function sanitizeJqlText(value) {
  return String(value || '')
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchIssues(session, jql, { fields = [], maxResults = 50, startAt = 0 } = {}) {
  const fieldList = Array.isArray(fields) ? fields : String(fields || '').split(',').filter(Boolean);

  // Use POST when JQL is long to avoid URL length limits; GET for normal queries
  if (jql.length > 1400) {
    return jiraFetch(session, '/rest/api/latest/search', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        startAt,
        maxResults,
        fields: fieldList
      })
    });
  }

  const params = new URLSearchParams({
    jql,
    startAt: String(startAt),
    maxResults: String(maxResults),
    fields: fieldList.join(',')
  });

  return jiraFetch(session, `/rest/api/latest/search?${params.toString()}`);
}

async function fetchIssueByKey(session, issueKey, fields = []) {
  const params = new URLSearchParams();
  if (fields.length > 0) {
    params.set('fields', fields.join(','));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return jiraFetch(session, `/rest/api/latest/issue/${encodeURIComponent(issueKey)}${suffix}`);
}

/**
 * Extracts readable plain text from Jira strings, Jira wiki markup,
 * custom field objects, or Jira Cloud Atlassian Document Format (ADF).
 */
function extractPlainText(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    return value
      .replace(/\{code(?::[^}]*)?\}([\s\S]*?)\{code\}/gi, ' $1 ')
      .replace(/\{noformat\}([\s\S]*?)\{noformat\}/gi, ' $1 ')
      .replace(/\{color(?::[^}]*)?\}/gi, '')
      .replace(/\{panel(?::[^}]*)?\}/gi, ' ')
      .replace(/\{quote\}/gi, ' ')
      .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$1')
      .replace(/!([^!\s]+)!/g, ' ')
      .replace(/^h[1-6]\.\s*/gim, '')
      .replace(/[*_~^#]+/g, ' ')
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (Array.isArray(value)) {
    return value.map(extractPlainText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.value != null) return extractPlainText(value.value);
    if (value.name != null) return extractPlainText(value.name);
    if (Array.isArray(value.content)) return extractPlainText(value.content);
    return Object.values(value).map(extractPlainText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  return String(value);
}

module.exports = {
  cleanBaseUrl,
  createHttpError,
  buildHeaders,
  jiraFetch,
  validateJiraCredentials,
  fetchMetadata,
  searchIssues,
  fetchIssueByKey,
  escapeJqlValue,
  sanitizeJqlText,
  extractPlainText,
  sleep
};
