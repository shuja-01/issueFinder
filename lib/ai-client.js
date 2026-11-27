function buildEndpoint(baseUrl) {
  const trimmed = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function isPlaceholder(value) {
  const v = String(value || '').trim();
  return !v || /^<.*>$/.test(v);
}

function getAiStatus() {
  const enabledFlag = String(process.env.INTERNAL_LLM_ENABLED || '').toLowerCase() === 'true';
  const baseUrl = String(process.env.INTERNAL_LLM_BASE_URL || '').trim();
  const model = String(process.env.INTERNAL_LLM_MODEL || '').trim();
  const apiKey = String(process.env.INTERNAL_LLM_API_KEY || '').trim();

  const configured =
    enabledFlag &&
    !isPlaceholder(baseUrl) &&
    !isPlaceholder(model) &&
    !isPlaceholder(apiKey);

  return {
    enabled: enabledFlag,
    configured,
    model: isPlaceholder(model) ? 'Not configured' : model
  };
}

async function callInternalLlm({ messages, temperature, maxTokens }) {
  const status = getAiStatus();
  if (!status.enabled) {
    throw new Error('Internal LLM is disabled (INTERNAL_LLM_ENABLED != true).');
  }
  if (!status.configured) {
    throw new Error('Internal LLM environment variables are incomplete or contain placeholder values.');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Messages array is required for LLM call.');
  }

  const endpoint = buildEndpoint(process.env.INTERNAL_LLM_BASE_URL);
  const model = process.env.INTERNAL_LLM_MODEL.trim();
  const apiKey = process.env.INTERNAL_LLM_API_KEY.trim();
  const timeoutMs = Number(process.env.INTERNAL_LLM_TIMEOUT_MS || 60000);

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'IssueMatcher/1.0'
  };

  if (apiKey) {
    const authHeader = process.env.INTERNAL_LLM_AUTH_HEADER || 'Authorization';
    const authScheme = process.env.INTERNAL_LLM_AUTH_SCHEME;
    headers[authHeader] = authScheme ? `${authScheme} ${apiKey}` : apiKey;
  }

  const body = {
    model,
    messages,
    temperature:
      typeof temperature === 'number'
        ? temperature
        : Number(process.env.INTERNAL_LLM_TEMPERATURE || 0.05)
  };

  if (typeof maxTokens === 'number' && maxTokens > 0) {
    body.max_tokens = maxTokens;
  }

  const start = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`Invalid JSON from AI gateway (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const errDetail = data?.error?.message || data?.message || `AI HTTP ${response.status}`;
      throw new Error(errDetail);
    }

    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'content_filter') {
      return {
        content: '',
        blocked: true,
        model,
        processingTimeMs: Date.now() - start
      };
    }

    const content = choice?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new Error('Empty response from AI gateway.');
    }

    return {
      content,
      blocked: false,
      model,
      processingTimeMs: Date.now() - start
    };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('AI request timed out.');
    }
    throw err;
  }
}

/**
 * Extracts and parses a JSON object or array from LLM text output,
 * tolerating markdown code fences and surrounding prose.
 */
function parseJsonFromLlm(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  // 1. Direct parse
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  // 2. Markdown code block ```json ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  // 3. First {...} or [...] slice
  const firstObj = text.indexOf('{');
  const lastObj = text.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) {
    try {
      return JSON.parse(text.slice(firstObj, lastObj + 1));
    } catch {
      // continue
    }
  }

  const firstArr = text.indexOf('[');
  const lastArr = text.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) {
    try {
      return JSON.parse(text.slice(firstArr, lastArr + 1));
    } catch {
      // continue
    }
  }

  return null;
}

module.exports = {
  getAiStatus,
  callInternalLlm,
  parseJsonFromLlm
};
