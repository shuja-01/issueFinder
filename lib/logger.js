const fs = require('fs');
const path = require('path');

const SENSITIVE_KEY_RE = /^(secret|password|passwd|pwd|token|pat|api[-_]?key|authorization|cookie|set-cookie|x-api-key)$/i;
const LOG_FILE_DATE_RE = /^(\d{4}-\d{2}-\d{2})\.log$/;

let lastCleanupDateKey = '';
let initialized = false;
let cleanupTimer = null;

function getLogConfig() {
  const rawDir = String(process.env.LOG_DIR || 'logs').trim() || 'logs';
  const logDir = path.isAbsolute(rawDir)
    ? rawDir
    : path.join(__dirname, '..', rawDir);

  const parsedDays = Number(process.env.LOG_RETENTION_DAYS);
  const retentionDays = Number.isFinite(parsedDays) && parsedDays >= 1
    ? Math.floor(parsedDays)
    : 5;

  const parsedMaxChars = Number(process.env.LOG_MAX_BODY_CHARS);
  const maxBodyChars = Number.isFinite(parsedMaxChars) && parsedMaxChars >= 200
    ? Math.floor(parsedMaxChars)
    : 4000;

  return { logDir, retentionDays, maxBodyChars };
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getLocalTimestamp(date = new Date()) {
  const datePart = getLocalDateKey(date);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${datePart} ${hours}:${minutes}:${seconds}.${ms}`;
}

function ensureLogDirectory(logDir) {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

/**
 * Deletes date-wise log files (YYYY-MM-DD.log) older than LOG_RETENTION_DAYS.
 * For example, with LOG_RETENTION_DAYS=5, today and the previous 4 days are kept.
 */
function cleanupOldLogs(now = new Date()) {
  const { logDir, retentionDays } = getLogConfig();
  ensureLogDirectory(logDir);

  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoffDate = new Date(todayMidnight);
  cutoffDate.setDate(cutoffDate.getDate() - (retentionDays - 1));
  const cutoffKey = getLocalDateKey(cutoffDate);

  let removed = [];
  try {
    const entries = fs.readdirSync(logDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(LOG_FILE_DATE_RE);
      if (!match) continue;

      const fileDateKey = match[1];
      if (fileDateKey < cutoffKey) {
        const fullPath = path.join(logDir, entry.name);
        try {
          fs.unlinkSync(fullPath);
          removed.push(entry.name);
        } catch (err) {
          console.error(`[Logger] Failed to delete old log file ${entry.name}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[Logger] Failed to scan log directory ${logDir}: ${err.message}`);
  }

  lastCleanupDateKey = getLocalDateKey(now);
  initialized = true;
  return removed;
}

/**
 * Recursively masks credentials, passwords, tokens, and Authorization headers
 * before writing anything to console or log files.
 */
function redactSensitive(value, depth = 0) {
  if (value == null || depth > 8) return value;

  if (typeof value === 'string') {
    return value
      .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, '$1[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._\-~+/=]+/gi, '$1[REDACTED]');
  }

  if (Array.isArray(value)) {
    return value.map(item => redactSensitive(item, depth + 1));
  }

  if (typeof value === 'object') {
    const customAuthHeader = String(process.env.INTERNAL_LLM_AUTH_HEADER || '').trim().toLowerCase();
    const cleaned = {};
    for (const [key, val] of Object.entries(value)) {
      const isCustomAuth = customAuthHeader && key.toLowerCase() === customAuthHeader;
      if (SENSITIVE_KEY_RE.test(key) || isCustomAuth) {
        if (typeof val === 'string' && /^(Basic|Bearer)\s+/i.test(val)) {
          cleaned[key] = `${val.split(/\s+/)[0]} [REDACTED]`;
        } else {
          cleaned[key] = '[REDACTED]';
        }
      } else {
        cleaned[key] = redactSensitive(val, depth + 1);
      }
    }
    return cleaned;
  }

  return value;
}

function formatPayload(payload, maxChars) {
  if (payload === undefined) return '';

  const safePayload = redactSensitive(payload);
  let serialized;

  if (typeof safePayload === 'string') {
    serialized = safePayload;
  } else {
    try {
      serialized = JSON.stringify(safePayload, null, 2);
    } catch {
      serialized = String(safePayload);
    }
  }

  if (serialized.length > maxChars) {
    const omitted = serialized.length - maxChars;
    return `${serialized.slice(0, maxChars)}\n... [TRUNCATED ${omitted} chars; adjust LOG_MAX_BODY_CHARS in .env]`;
  }

  return serialized;
}

function writeLog(level, category, message, details) {
  const now = new Date();
  const dateKey = getLocalDateKey(now);
  const { logDir, maxBodyChars } = getLogConfig();

  // Trigger retention cleanup on startup and whenever the date rolls over
  if (!initialized || lastCleanupDateKey !== dateKey) {
    initialized = true;
    cleanupOldLogs(now);
  }

  const timestamp = getLocalTimestamp(now);
  const header = `[${timestamp}] [${level}] [${category}] ${message}`;
  const formattedDetails = details !== undefined ? formatPayload(details, maxBodyChars) : '';
  const entryText = formattedDetails ? `${header}\n${formattedDetails}` : header;

  // 1. Print to CMD / terminal
  if (level === 'ERROR') {
    console.error(entryText);
  } else if (level === 'WARN') {
    console.warn(entryText);
  } else {
    console.log(entryText);
  }

  // 2. Append to date-wise log file (logs/YYYY-MM-DD.log)
  try {
    ensureLogDirectory(logDir);
    const logFilePath = path.join(logDir, `${dateKey}.log`);
    fs.appendFileSync(logFilePath, `${entryText}\n`, 'utf8');
  } catch (err) {
    console.error(`[Logger] Failed to write log file: ${err.message}`);
  }
}

function initLogger() {
  const { logDir, retentionDays } = getLogConfig();
  ensureLogDirectory(logDir);
  const removed = cleanupOldLogs(new Date());

  // Schedule periodic hourly check so multi-day runs also rotate cleanly
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      const currentKey = getLocalDateKey(new Date());
      if (currentKey !== lastCleanupDateKey) {
        const cleaned = cleanupOldLogs(new Date());
        if (cleaned.length > 0) {
          writeLog('INFO', 'LOGGER', `Daily log cleanup removed ${cleaned.length} expired file(s)`, { removed: cleaned });
        }
      }
    }, 60 * 60 * 1000);
    if (typeof cleanupTimer.unref === 'function') {
      cleanupTimer.unref();
    }
  }

  writeLog('INFO', 'LOGGER', `Logging initialized (dir=${logDir}, retentionDays=${retentionDays})`, {
    activeLogFile: path.join(logDir, `${getLocalDateKey()}.log`),
    removedExpiredFiles: removed
  });
}

function logInfo(category, message, details) {
  writeLog('INFO', category, message, details);
}

function logWarn(category, message, details) {
  writeLog('WARN', category, message, details);
}

function logError(category, message, details) {
  writeLog('ERROR', category, message, details);
}

function logRequest(category, summary, details) {
  writeLog('REQ', category, summary, details);
}

function logResponse(category, summary, details) {
  writeLog('RES', category, summary, details);
}

module.exports = {
  initLogger,
  cleanupOldLogs,
  getLogConfig,
  redactSensitive,
  logInfo,
  logWarn,
  logError,
  logRequest,
  logResponse
};
