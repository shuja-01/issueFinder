const {
  searchIssues,
  fetchIssueByKey,
  escapeJqlValue,
  sanitizeJqlText,
  extractPlainText,
  sleep
} = require('./jira-client');
const { getAiStatus, callInternalLlm, parseJsonFromLlm } = require('./ai-client');
const { logInfo, logWarn } = require('./logger');

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'down', 'during', 'each', 'few',
  'for', 'from', 'further', 'get', 'getting', 'got', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'like', 'make', 'may', 'me', 'more', 'most', 'my', 'need', 'needs', 'new', 'no',
  'not', 'now', 'of', 'off', 'on', 'once', 'one', 'only', 'or', 'other', 'our', 'out', 'over',
  'own', 'please', 'same', 'see', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'use', 'used', 'using', 'very', 'want', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'issue', 'ticket', 'jira', 'able', 'unable', 'also', 'via', 'per', 'etc'
]);

const ISSUE_KEY_EXACT_RE = /^[A-Z][A-Z0-9_]{1,15}-\d+$/i;
const ISSUE_KEY_INLINE_RE = /\b([A-Z][A-Z0-9_]{1,15}-\d+)\b/g;

function getSearchFields() {
  const ppFieldId = String(process.env.JIRA_PROGRAM_PROJECT_FIELD_ID || '15309').trim();
  return [
    'summary',
    'description',
    'status',
    'resolution',
    'issuetype',
    'priority',
    'components',
    'labels',
    'updated',
    'created',
    'assignee',
    'reporter',
    'comment',
    'issuelinks',
    `customfield_${ppFieldId}`
  ];
}

function tokenize(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9_-]+/g, ' ')
    .replace(/[_-]+/g, ' ');

  const rawTokens = normalized.split(/\s+/).filter(Boolean);
  const meaningful = [];
  for (const tok of rawTokens) {
    if (tok.length < 2) continue;
    if (STOP_WORDS.has(tok)) continue;
    meaningful.push(tok);
  }
  return [...new Set(meaningful)];
}

function extractBigrams(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));

  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }
  return [...new Set(bigrams)];
}

function normalizeIssue(rawIssue, baseUrl) {
  const fields = rawIssue.fields || {};
  const ppFieldId = String(process.env.JIRA_PROGRAM_PROJECT_FIELD_ID || '15309').trim();

  const summary = String(fields.summary || '').trim();
  const description = extractPlainText(fields.description);

  const rawComments = fields.comment?.comments || [];
  const recentCommentItems = rawComments
    .slice(-4)
    .map(c => {
      const body = extractPlainText(c.body);
      if (!body) return null;
      return {
        author: c.author?.displayName || c.author?.name || 'Jira user',
        created: c.created || '',
        body: body.length > 420 ? `${body.slice(0, 417).trim()}...` : body
      };
    })
    .filter(Boolean);
  const recentComments = recentCommentItems.map(c => c.body);

  const components = (fields.components || [])
    .map(c => c && c.name)
    .filter(Boolean);

  const labels = (fields.labels || [])
    .map(l => String(l || '').trim())
    .filter(Boolean);

  const linkedIssues = (fields.issuelinks || [])
    .map(link => {
      const target = link.outwardIssue || link.inwardIssue;
      if (!target) return null;
      return {
        key: target.key,
        browseUrl: `${baseUrl}/browse/${encodeURIComponent(target.key)}`,
        relation: link.outwardIssue ? link.type?.outward : link.type?.inward,
        summary: target.fields?.summary || ''
      };
    })
    .filter(Boolean);

  return {
    key: rawIssue.key,
    browseUrl: `${baseUrl}/browse/${encodeURIComponent(rawIssue.key)}`,
    summary,
    description,
    descriptionFull: description.length > 2400 ? `${description.slice(0, 2397).trim()}...` : description,
    descriptionSnippet: description.length > 260 ? `${description.slice(0, 257).trim()}...` : description,
    commentsText: recentComments.join(' | '),
    recentComments: recentCommentItems.reverse(),
    commentCount: rawComments.length,
    issueType: fields.issuetype?.name || 'Other',
    status: fields.status?.name || 'Unknown',
    statusCategory: fields.status?.statusCategory?.key || '',
    resolution: fields.resolution?.name || '',
    priority: fields.priority?.name || '',
    components,
    labels,
    programProject: extractPlainText(fields[`customfield_${ppFieldId}`]),
    assignee: fields.assignee?.displayName || fields.assignee?.name || '',
    reporter: fields.reporter?.displayName || fields.reporter?.name || '',
    updated: fields.updated || '',
    created: fields.created || '',
    linkedIssues: linkedIssues.slice(0, 8)
  };
}

/**
 * Stage 1: Understand the query (detect ticket key, extract terms, enrich via AI if enabled).
 */
async function understandQuery(session, rawQuery) {
  const query = String(rawQuery || '').trim();
  const isExactKey = ISSUE_KEY_EXACT_RE.test(query);
  const inlineKeys = [...new Set((query.match(ISSUE_KEY_INLINE_RE) || []).map(k => k.toUpperCase()))];

  let sourceIssue = null;
  let effectiveText = query;

  if (isExactKey) {
    try {
      const fetched = await fetchIssueByKey(session, query.toUpperCase(), getSearchFields());
      sourceIssue = normalizeIssue(fetched, session.baseUrl);
      effectiveText = [sourceIssue.summary, sourceIssue.descriptionSnippet].filter(Boolean).join('. ');
    } catch (err) {
      logWarn('SEARCH', `Direct lookup for key ${query} failed: ${err.message}`);
    }
  }

  const baseTokens = tokenize(effectiveText);
  const baseBigrams = extractBigrams(effectiveText);

  const fallbackResult = {
    originalQuery: query,
    effectiveText,
    sourceIssue,
    inlineKeys,
    aiApplied: false,
    aiNote: '',
    interpretedQuery: baseTokens.slice(0, 10).join(' ') || query,
    coreKeywords: baseTokens.slice(0, 8),
    synonyms: [],
    phrases: baseBigrams.slice(0, 4)
  };

  const aiStatus = getAiStatus();
  if (!aiStatus.configured) {
    fallbackResult.aiNote = aiStatus.enabled
      ? 'AI enrichment skipped (configure INTERNAL_LLM_* in .env).'
      : 'AI enrichment disabled in .env.';
    return fallbackResult;
  }

  try {
    const llmRes = await callInternalLlm({
      messages: [
        {
          role: 'system',
          content: `You are a Jira search query analyzer helping engineers find existing duplicate or related Jira tickets.
Return ONLY valid JSON with this exact schema (no markdown, no extra text):
{
  "interpretedQuery": "short clean canonical search string (6-14 words)",
  "coreKeywords": ["4 to 8 most important specific nouns/verbs/tech terms from the query"],
  "synonyms": ["3 to 6 practical alternative Jira wording or technical synonyms"],
  "phrases": ["1 to 3 distinctive 2-4 word phrases from the query"]
}`
        },
        {
          role: 'user',
          content: `User Jira search input:\n${effectiveText.slice(0, 1200)}`
        }
      ],
      temperature: 0.05,
      maxTokens: 350
    });

    if (llmRes.blocked) {
      fallbackResult.aiNote = 'AI query enrichment was filtered by guardrails; using lexical keywords.';
      return fallbackResult;
    }

    const parsed = parseJsonFromLlm(llmRes.content);
    if (!parsed || typeof parsed !== 'object') {
      fallbackResult.aiNote = 'AI query enrichment returned non-JSON; using lexical keywords.';
      return fallbackResult;
    }

    const cleanArray = (arr, limit) =>
      [...new Set(
        (Array.isArray(arr) ? arr : [])
          .map(x => sanitizeJqlText(String(x || '').trim()))
          .filter(x => x.length >= 2)
      )].slice(0, limit);

    const coreKeywords = cleanArray(parsed.coreKeywords, 8);
    const synonyms = cleanArray(parsed.synonyms, 6);
    const phrases = cleanArray(parsed.phrases, 4);
    const interpretedQuery = String(parsed.interpretedQuery || '').trim() || fallbackResult.interpretedQuery;

    return {
      ...fallbackResult,
      aiApplied: true,
      interpretedQuery,
      coreKeywords: coreKeywords.length ? coreKeywords : fallbackResult.coreKeywords,
      synonyms,
      phrases: phrases.length ? phrases : fallbackResult.phrases
    };
  } catch (err) {
    logWarn('SEARCH', `AI query enrichment failed, falling back to lexical extraction: ${err.message}`);
    fallbackResult.aiNote = `AI query enrichment unavailable (${err.message}); used keyword search.`;
    return fallbackResult;
  }
}

/**
 * Builds common scope JQL clauses (Program/Project, Issue Type, Resolved status).
 */
function buildScopeClauses({ programProject, issueType, includeResolved }) {
  const clauses = [];
  const ppFieldName = String(process.env.JIRA_PROGRAM_PROJECT_FIELD_NAME || 'Program/Project').trim();

  if (programProject && programProject !== 'ALL') {
    clauses.push(`"${escapeJqlValue(ppFieldName)}" = "${escapeJqlValue(programProject)}"`);
  }

  if (issueType && issueType !== 'ALL') {
    clauses.push(`issuetype = "${escapeJqlValue(issueType)}"`);
  }

  if (includeResolved === false) {
    clauses.push('resolution = Unresolved');
  }

  return clauses;
}

function combineJql(scopeClauses, textClause) {
  const parts = [];
  if (scopeClauses.length > 0) {
    parts.push(...scopeClauses.map(c => `(${c})`));
  }
  if (textClause) {
    parts.push(`(${textClause})`);
  }
  const where = parts.join(' AND ');
  return where ? `${where} ORDER BY updated DESC` : 'ORDER BY updated DESC';
}

/**
 * Stage 2: Retrieve candidate Jira issues via multi-pass JQL queries.
 */
async function retrieveCandidates(session, queryPlan, filters) {
  const maxCandidates = Math.min(Math.max(Number(process.env.SEARCH_MAX_CANDIDATES || 50), 10), 100);
  const fields = getSearchFields();
  const scopeClauses = buildScopeClauses(filters);

  const candidateMap = new Map();
  const executedJqls = [];

  const addIssues = issues => {
    for (const raw of issues || []) {
      if (!raw || !raw.key) continue;
      if (candidateMap.has(raw.key)) continue;
      candidateMap.set(raw.key, normalizeIssue(raw, session.baseUrl));
    }
  };

  // If user directly entered an exact ticket key and we fetched it, include it unless filtered out
  if (queryPlan.sourceIssue && !filters.excludeSourceKey) {
    candidateMap.set(queryPlan.sourceIssue.key, queryPlan.sourceIssue);
  }

  // Also fetch any inline ticket keys referenced in the query
  for (const key of queryPlan.inlineKeys.slice(0, 3)) {
    if (!candidateMap.has(key)) {
      try {
        const direct = await fetchIssueByKey(session, key, fields);
        addIssues([direct]);
      } catch {
        // Ignore if key doesn't exist or user lacks permission
      }
    }
  }

  const coreTerms = queryPlan.coreKeywords
    .map(t => sanitizeJqlText(t))
    .filter(t => t.length >= 2);
  const synonymTerms = queryPlan.synonyms
    .map(t => sanitizeJqlText(t))
    .filter(t => t.length >= 2);
  const safeQueryText = sanitizeJqlText(queryPlan.effectiveText).split(/\s+/).slice(0, 12).join(' ');
  const safeInterpreted = sanitizeJqlText(queryPlan.interpretedQuery).split(/\s+/).slice(0, 10).join(' ');

  const jqlPasses = [];

  // Pass 1: High-precision summary match using interpreted/cleaned query or core terms
  if (safeQueryText) {
    jqlPasses.push({
      name: 'summary-precision',
      jql: combineJql(scopeClauses, `summary ~ "${escapeJqlValue(safeQueryText)}"`),
      maxResults: Math.min(35, maxCandidates)
    });
  }

  // Pass 2: Full-text match (summary + description + comments) using core keywords
  const coreSearchString = (coreTerms.length >= 2 ? coreTerms.slice(0, 6).join(' ') : safeInterpreted || safeQueryText).trim();
  if (coreSearchString) {
    jqlPasses.push({
      name: 'text-core',
      jql: combineJql(scopeClauses, `text ~ "${escapeJqlValue(coreSearchString)}"`),
      maxResults: Math.min(40, maxCandidates)
    });
  }

  // Pass 3: Broader OR expansion across top keywords + AI synonyms (summary + text)
  const expansionTerms = [...new Set([...coreTerms.slice(0, 4), ...synonymTerms.slice(0, 4)])]
    .filter(t => t.length >= 3);
  if (expansionTerms.length > 0) {
    const orSummary = expansionTerms
      .slice(0, 5)
      .map(term => `summary ~ "${escapeJqlValue(term)}"`)
      .join(' OR ');
    const orText = expansionTerms
      .slice(0, 3)
      .map(term => `text ~ "${escapeJqlValue(term)}"`)
      .join(' OR ');
    jqlPasses.push({
      name: 'broad-expansion',
      jql: combineJql(scopeClauses, `${orSummary} OR ${orText}`),
      maxResults: Math.min(40, maxCandidates)
    });
  }

  for (let i = 0; i < jqlPasses.length; i++) {
    if (candidateMap.size >= maxCandidates) break;
    // Skip broad pass if we already have plenty of high-precision hits
    if (i === 2 && candidateMap.size >= Math.min(30, maxCandidates)) break;

    const pass = jqlPasses[i];
    if (executedJqls.includes(pass.jql)) continue;

    try {
      const data = await searchIssues(session, pass.jql, {
        fields,
        maxResults: pass.maxResults
      });
      executedJqls.push(pass.jql);
      addIssues(data.issues || []);
      if (i < jqlPasses.length - 1 && candidateMap.size < maxCandidates) {
        await sleep(150);
      }
    } catch (err) {
      logWarn('SEARCH', `Retrieve pass "${pass.name}" failed: ${err.message}`);
      // If authentication/permission failed, surface immediately
      if (err.statusCode === 401 || err.statusCode === 403) {
        throw err;
      }
    }
  }

  return {
    candidates: [...candidateMap.values()].slice(0, maxCandidates),
    executedJqls
  };
}

/**
 * Deterministic lexical/keyword similarity scoring (0-100) with IDF weighting
 * and human-readable match signal pills.
 */
function scoreLexicalCandidates(queryPlan, candidates) {
  const originalLower = queryPlan.effectiveText.toLowerCase().trim();
  const queryTerms = [...new Set([
    ...tokenize(queryPlan.effectiveText),
    ...queryPlan.coreKeywords.flatMap(tokenize)
  ])];
  const synonymTerms = [...new Set(
    queryPlan.synonyms.flatMap(tokenize).filter(t => !queryTerms.includes(t))
  )];
  const phrases = [...new Set([
    ...extractBigrams(queryPlan.effectiveText),
    ...queryPlan.phrases.map(p => p.toLowerCase().trim()).filter(p => p.includes(' '))
  ])];

  // Document frequency across candidate pool for IDF weighting
  const docFreq = new Map();
  const allTerms = [...new Set([...queryTerms, ...synonymTerms])];
  const docCount = Math.max(candidates.length, 1);

  const prepared = candidates.map(issue => {
    const summaryLower = issue.summary.toLowerCase();
    const descLower = issue.description.toLowerCase();
    const commentsLower = issue.commentsText.toLowerCase();
    const metaLower = [...issue.components, ...issue.labels, issue.programProject].join(' ').toLowerCase();
    const linksLower = issue.linkedIssues.map(l => `${l.key} ${l.summary}`).join(' ').toLowerCase();
    const fullText = `${summaryLower} ${descLower} ${commentsLower} ${metaLower} ${linksLower}`;
    const fullTokenSet = new Set(tokenize(fullText));

    for (const term of allTerms) {
      if (fullTokenSet.has(term) || fullText.includes(term)) {
        docFreq.set(term, (docFreq.get(term) || 0) + 1);
      }
    }

    return {
      issue,
      summaryLower,
      descLower,
      commentsLower,
      metaLower,
      linksLower,
      summaryTokens: new Set(tokenize(summaryLower)),
      bodyTokens: new Set(tokenize(`${descLower} ${commentsLower}`)),
      metaTokens: new Set(tokenize(`${metaLower} ${linksLower}`))
    };
  });

  const idf = term => Math.log(1 + (docCount + 1) / ((docFreq.get(term) || 0) + 1));
  const totalQueryIdf = queryTerms.reduce((sum, t) => sum + idf(t), 0) || 1;

  return prepared.map(entry => {
    const { issue, summaryLower, descLower, commentsLower, metaLower, summaryTokens, bodyTokens, metaTokens } = entry;

    let summaryWeight = 0;
    let bodyWeight = 0;
    let metaWeight = 0;
    const matchedSummaryTerms = [];
    const matchedBodyTerms = [];
    const matchedMetaTerms = [];

    for (const term of queryTerms) {
      const w = idf(term);
      const inSummary = summaryTokens.has(term) || (term.length >= 4 && summaryLower.includes(term));
      const inBody = bodyTokens.has(term) || (term.length >= 4 && (descLower.includes(term) || commentsLower.includes(term)));
      const inMeta = metaTokens.has(term) || (term.length >= 4 && metaLower.includes(term));

      if (inSummary) {
        summaryWeight += w;
        matchedSummaryTerms.push(term);
      }
      if (inBody) {
        bodyWeight += w;
        matchedBodyTerms.push(term);
      }
      if (inMeta) {
        metaWeight += w;
        matchedMetaTerms.push(term);
      }
    }

    // Synonym hits (weighted at 0.55x of core terms)
    let synSummaryHits = 0;
    let synBodyHits = 0;
    for (const syn of synonymTerms) {
      if (summaryTokens.has(syn) || (syn.length >= 4 && summaryLower.includes(syn))) synSummaryHits++;
      else if (bodyTokens.has(syn) || (syn.length >= 4 && descLower.includes(syn))) synBodyHits++;
    }

    // Phrase matches
    let summaryPhraseHits = 0;
    let bodyPhraseHits = 0;
    for (const phrase of phrases) {
      if (summaryLower.includes(phrase)) summaryPhraseHits++;
      else if (descLower.includes(phrase) || commentsLower.includes(phrase)) bodyPhraseHits++;
    }

    const summaryCoverage = Math.min(1, summaryWeight / totalQueryIdf);
    const bodyCoverage = Math.min(1, bodyWeight / totalQueryIdf);
    const metaCoverage = Math.min(1, metaWeight / totalQueryIdf);
    const phraseRatio = phrases.length > 0 ? Math.min(1, (summaryPhraseHits + bodyPhraseHits * 0.5) / Math.min(phrases.length, 3)) : 0;
    const synBonus = Math.min(0.12, synSummaryHits * 0.05 + synBodyHits * 0.025);

    // Exact or near-exact summary match check
    const exactSummaryMatch =
      originalLower.length >= 8 &&
      (summaryLower === originalLower || summaryLower.includes(originalLower) || originalLower.includes(summaryLower));

    const exactKeyMatch = queryPlan.inlineKeys.includes(issue.key.toUpperCase());

    let rawScore =
      summaryCoverage * 54 +
      bodyCoverage * 22 +
      phraseRatio * 14 +
      metaCoverage * 6 +
      synBonus * 100;

    if (exactSummaryMatch) {
      rawScore = Math.max(rawScore, 82);
    }
    if (exactKeyMatch) {
      rawScore = Math.max(rawScore, 92);
    }

    const keywordScore = Math.max(1, Math.min(100, Math.round(rawScore)));

    // Build human-readable match signals (matching IssueMatcher UI pills)
    const matchSignals = [];
    if (exactKeyMatch) {
      matchSignals.push('Direct ticket key match');
    }
    if (exactSummaryMatch || summaryCoverage >= 0.65) {
      matchSignals.push('Summary closely matches the search');
    }
    if (matchedSummaryTerms.length >= 2) {
      matchSignals.push('Multiple matching terms in summary');
    }
    if (summaryPhraseHits > 0 || bodyPhraseHits > 0) {
      matchSignals.push('Distinctive phrases matched');
    }
    if (matchedBodyTerms.length > 0 || synBodyHits > 0) {
      matchSignals.push('Related description or comments');
    }
    if (matchedMetaTerms.length > 0) {
      matchSignals.push('Matching components, labels, or links');
    }
    if (matchSignals.length === 0) {
      matchSignals.push('Broad keyword similarity');
    }

    return {
      ...issue,
      keywordScore,
      exactSummaryMatch,
      exactKeyMatch,
      matchSignals: matchSignals.slice(0, 4),
      matchedTerms: [...new Set([...matchedSummaryTerms, ...matchedBodyTerms])].slice(0, 6)
    };
  });
}

/**
 * Stage 3b: AI Semantic Reranking & Assessment in small batches.
 */
async function assessBatchWithAi(queryPlan, batch) {
  const candidatePayload = batch.map(item => ({
    key: item.key,
    issueType: item.issueType,
    status: item.status,
    summary: item.summary,
    description: item.description.slice(0, 480),
    comments: item.commentsText.slice(0, 220),
    components: item.components.slice(0, 5),
    labels: item.labels.slice(0, 6)
  }));

  const res = await callInternalLlm({
    messages: [
      {
        role: 'system',
        content: `You are a senior engineering triage assistant evaluating whether existing Jira tickets are duplicates or semantically related to a user's proposed issue/search query.

For EACH candidate ticket provided, return a JSON object with:
- "key": exact Jira issue key
- "aiRelevance": integer 0-100 (90-100 = near-duplicate / exact same work, 65-89 = strongly related / overlapping scope, 35-64 = partially related / same area but different task, 0-34 = weakly related / false positive)
- "confidence": "HIGH" | "MEDIUM" | "LOW"
- "explanation": 1-2 clear, specific sentences explaining why this issue may be related and how its scope compares to the user input
- "sharedConcepts": array of 1 to 4 concise shared concept phrases (2-5 words each)
- "importantDifferences": array of 0 to 3 concise key differences in scope, component, or functionality (empty array if essentially identical)

Return ONLY valid JSON with shape:
{"assessments": [ ... ]}
No markdown, no commentary outside JSON.`
      },
      {
        role: 'user',
        content: `USER SEARCH INPUT:
${queryPlan.effectiveText.slice(0, 1000)}

INTERPRETED INTENT:
${queryPlan.interpretedQuery}

CANDIDATE JIRA ISSUES:
${JSON.stringify(candidatePayload, null, 2)}`
      }
    ],
    temperature: 0.05,
    maxTokens: 1600
  });

  if (res.blocked) return new Map();

  const parsed = parseJsonFromLlm(res.content);
  const list = Array.isArray(parsed) ? parsed : parsed?.assessments;
  const map = new Map();

  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || !item.key) continue;
      const score = Math.max(0, Math.min(100, Math.round(Number(item.aiRelevance) || 0)));
      const conf = String(item.confidence || 'MEDIUM').toUpperCase();
      map.set(String(item.key).toUpperCase(), {
        aiRelevance: score,
        confidence: ['HIGH', 'MEDIUM', 'LOW'].includes(conf) ? conf : 'MEDIUM',
        explanation: String(item.explanation || '').trim(),
        sharedConcepts: Array.isArray(item.sharedConcepts)
          ? item.sharedConcepts.map(s => String(s || '').trim()).filter(Boolean).slice(0, 4)
          : [],
        importantDifferences: Array.isArray(item.importantDifferences)
          ? item.importantDifferences.map(s => String(s || '').trim()).filter(Boolean).slice(0, 3)
          : []
      });
    }
  }

  return map;
}

async function rankCandidates(queryPlan, candidates) {
  if (!candidates.length) {
    return {
      results: [],
      aiRerankedCount: 0,
      aiUsed: false
    };
  }

  // 1. Score all candidates lexically first
  const lexicallyScored = scoreLexicalCandidates(queryPlan, candidates)
    .sort((a, b) => b.keywordScore - a.keywordScore);

  const aiStatus = getAiStatus();
  const topN = Math.min(
    Math.max(Number(process.env.AI_RERANK_TOP_N || 20), 5),
    lexicallyScored.length
  );
  const batchSize = Math.min(Math.max(Number(process.env.AI_RERANK_BATCH_SIZE || 5), 1), 10);

  const aiAssessments = new Map();
  let aiUsed = false;

  if (aiStatus.configured) {
    const topSlice = lexicallyScored.slice(0, topN);
    const batches = [];
    for (let i = 0; i < topSlice.length; i += batchSize) {
      batches.push(topSlice.slice(i, i + batchSize));
    }

    // Process up to 2 batches concurrently to balance speed and gateway stability
    const CONCURRENCY = 2;
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const wave = batches.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        wave.map(batch => assessBatchWithAi(queryPlan, batch))
      );

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled' && outcome.value.size > 0) {
          aiUsed = true;
          for (const [k, v] of outcome.value.entries()) {
            aiAssessments.set(k, v);
          }
        } else if (outcome.status === 'rejected') {
          logWarn('SEARCH', `AI batch assessment failed: ${outcome.reason?.message || outcome.reason}`);
        }
      }
    }
  }

  // 2. Merge lexical + AI scores into final ranked results
  const finalResults = lexicallyScored.map(item => {
    const assessment = aiAssessments.get(item.key.toUpperCase()) || null;

    let aiRelevance = null;
    let overallScore = item.keywordScore;

    if (assessment) {
      aiRelevance = assessment.aiRelevance;
      overallScore = Math.round(aiRelevance * 0.65 + item.keywordScore * 0.35);
      if (item.exactKeyMatch) {
        overallScore = Math.max(overallScore, 94);
      } else if (item.exactSummaryMatch && aiRelevance >= 80) {
        overallScore = Math.max(overallScore, 86);
      }
    } else {
      // Fallback estimate for items beyond topN or when AI is off
      aiRelevance = null;
      overallScore = item.keywordScore;
    }

    overallScore = Math.max(1, Math.min(100, overallScore));
    const matchLevel = overallScore >= 70 ? 'HIGH' : overallScore >= 40 ? 'MEDIUM' : 'LOW';

    return {
      key: item.key,
      browseUrl: item.browseUrl,
      summary: item.summary,
      descriptionSnippet: item.descriptionSnippet,
      descriptionFull: item.descriptionFull,
      issueType: item.issueType,
      status: item.status,
      resolution: item.resolution,
      priority: item.priority,
      components: item.components,
      labels: item.labels,
      programProject: item.programProject,
      assignee: item.assignee,
      reporter: item.reporter,
      updated: item.updated,
      created: item.created,
      commentCount: item.commentCount,
      recentComments: item.recentComments,
      linkedIssues: item.linkedIssues,
      matchSignals: item.matchSignals,
      matchedTerms: item.matchedTerms,
      keywordScore: item.keywordScore,
      aiRelevance,
      overallScore,
      matchLevel,
      aiAssessment: assessment
        ? {
            evaluated: true,
            confidence: assessment.confidence,
            explanation: assessment.explanation,
            sharedConcepts: assessment.sharedConcepts,
            importantDifferences: assessment.importantDifferences
          }
        : {
            evaluated: false,
            confidence: item.keywordScore >= 60 ? 'MEDIUM' : 'LOW',
            explanation: aiUsed
              ? `Ranked by lexical similarity (${item.keywordScore}% keyword match) outside the top ${topN} AI-assessed candidates.`
              : `Ranked by keyword and metadata similarity (${item.keywordScore}% keyword match). Enable Internal LLM in .env for deep semantic assessment.`,
            sharedConcepts: item.matchedTerms.slice(0, 4),
            importantDifferences: []
          }
    };
  });

  finalResults.sort((a, b) => {
    if (b.overallScore !== a.overallScore) return b.overallScore - a.overallScore;
    const bAi = b.aiRelevance ?? -1;
    const aAi = a.aiRelevance ?? -1;
    if (bAi !== aAi) return bAi - aAi;
    return b.keywordScore - a.keywordScore;
  });

  return {
    results: finalResults,
    aiRerankedCount: aiAssessments.size,
    aiUsed
  };
}

/**
 * Full end-to-end similarity search orchestration.
 */
async function runSimilaritySearch(session, params) {
  const startedAt = Date.now();
  const query = String(params.query || '').trim();
  const programProject = String(params.programProject || 'ALL').trim();
  const issueType = String(params.issueType || 'ALL').trim();
  const includeResolved = params.includeResolved !== false;

  // Stage 1: Understand
  logInfo('SEARCH', 'Stage 1/3 Understanding query', { query, programProject, issueType, includeResolved });
  const queryPlan = await understandQuery(session, query);

  // Stage 2: Retrieve
  logInfo('SEARCH', 'Stage 2/3 Retrieving Jira candidates', {
    interpretedQuery: queryPlan.interpretedQuery,
    coreKeywords: queryPlan.coreKeywords,
    synonyms: queryPlan.synonyms
  });
  const { candidates, executedJqls } = await retrieveCandidates(session, queryPlan, {
    programProject,
    issueType,
    includeResolved
  });

  // Stage 3: Rank (Lexical + AI Semantic)
  logInfo('SEARCH', `Stage 3/3 Ranking ${candidates.length} candidate(s)`, {
    queriesExecuted: executedJqls.length
  });
  const { results, aiRerankedCount, aiUsed } = await rankCandidates(queryPlan, candidates);

  logInfo('SEARCH', `Completed search in ${Date.now() - startedAt}ms`, {
    candidatesRetrieved: candidates.length,
    resultsCount: results.length,
    aiRerankedCount,
    aiUsed
  });

  // Compute issue-type breakdown for result filter tabs
  const issueTypeCounts = {};
  for (const r of results) {
    const typeName = r.issueType || 'Other';
    issueTypeCounts[typeName] = (issueTypeCounts[typeName] || 0) + 1;
  }

  // Compute actionable duplicate verdict from top ranked matches
  const highMatches = results.filter(r => r.overallScore >= 70);
  const mediumMatches = results.filter(r => r.overallScore >= 40 && r.overallScore < 70);
  const topMatch = results[0] || null;
  let verdict;

  if (!topMatch) {
    verdict = {
      level: 'NO_MATCHES',
      badge: 'No close matches',
      headline: 'No similar Jira tickets found in this scope',
      recommendation: 'Looks safe to create a new ticket — or broaden your Program/Project and Issue Type filters to double-check.',
      topKeys: []
    };
  } else if (topMatch.overallScore >= 78 || highMatches.length >= 2) {
    const topKeys = highMatches.slice(0, 3).map(r => r.key);
    verdict = {
      level: 'LIKELY_DUPLICATE',
      badge: 'High duplicate risk',
      headline: `${highMatches.length} strong ${highMatches.length === 1 ? 'match' : 'matches'} found — review before creating a new ticket`,
      recommendation: `${topMatch.key} (${topMatch.overallScore}% match) closely overlaps with your query. Inspect its description and comments before opening a duplicate.`,
      topKeys
    };
  } else if (topMatch.overallScore >= 48 || highMatches.length === 1) {
    const topKeys = results.slice(0, 3).map(r => r.key);
    verdict = {
      level: 'POSSIBLE_OVERLAP',
      badge: 'Partial overlap detected',
      headline: `Related work exists — consider linking to ${topMatch.key}`,
      recommendation: `${topMatch.key} (${topMatch.overallScore}% match) shares related concepts${mediumMatches.length > 0 ? ` along with ${mediumMatches.length} moderate match(es)` : ''}. Check important differences in the inspector to decide whether to reuse or link.`,
      topKeys
    };
  } else {
    verdict = {
      level: 'LOW_OVERLAP',
      badge: 'Low overlap',
      headline: 'Only weak matches found — likely safe to create a new ticket',
      recommendation: `Top match ${topMatch.key} scored ${topMatch.overallScore}%. You can review the closest references below or proceed with a new Jira ticket.`,
      topKeys: [topMatch.key]
    };
  }

  return {
    query: queryPlan.originalQuery,
    verdict,
    enrichment: {
      aiApplied: queryPlan.aiApplied,
      aiRerankApplied: aiUsed,
      aiRerankedCount,
      aiNote: queryPlan.aiNote,
      interpretedQuery: queryPlan.interpretedQuery,
      coreKeywords: queryPlan.coreKeywords,
      synonyms: queryPlan.synonyms,
      sourceIssueKey: queryPlan.sourceIssue?.key || null
    },
    filters: {
      programProject,
      issueType,
      includeResolved
    },
    metrics: {
      candidatesRetrieved: candidates.length,
      resultsCount: results.length,
      searchTimeMs: Date.now() - startedAt,
      queriesExecuted: executedJqls.length
    },
    issueTypeCounts,
    results
  };
}

module.exports = {
  runSimilaritySearch
};
