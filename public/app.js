(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  const state = {
    authMode: 'basic', // 'basic' (username + password) | 'bearer' (PAT)
    session: null,
    ai: { enabled: false, configured: false, model: 'Not configured' },
    metadata: { programProjects: [], issueTypes: [] },
    lastSearchResponse: null,
    activeTypeTab: 'ALL',
    resultFilterText: '',
    isSearching: false,
    progressTimers: []
  };

  // --- Utilities ---
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getInitials(name) {
    const parts = String(name || 'U').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return String(parts[0] || 'U').slice(0, 2).toUpperCase();
  }

  function formatSessionExpiry(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  function formatDateShort(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

  async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      const err = new Error(data.error || data.message || `Request failed (HTTP ${response.status})`);
      err.status = response.status;
      throw err;
    }
    return data;
  }

  function showBoxError(elId, message) {
    const el = $(elId);
    if (!message) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  // --- Auth Mode Switching ---
  function setAuthMode(mode) {
    state.authMode = mode === 'bearer' ? 'bearer' : 'basic';
    const isBearer = state.authMode === 'bearer';

    $('tabBasic').classList.toggle('active', !isBearer);
    $('tabBasic').setAttribute('aria-selected', String(!isBearer));
    $('tabBearer').classList.toggle('active', isBearer);
    $('tabBearer').setAttribute('aria-selected', String(isBearer));

    if (isBearer) {
      $('usernameLabel').textContent = 'Jira username (optional for PAT)';
      $('jiraUsernameInput').placeholder = 'Optional — auto-detected from your token';
      $('secretLabel').textContent = 'Personal Access Token (PAT)';
      $('jiraSecretInput').placeholder = 'Enter your Jira Personal Access Token';
      $('jiraSecretInput').setAttribute('autocomplete', 'off');
    } else {
      $('usernameLabel').textContent = 'Jira username';
      $('jiraUsernameInput').placeholder = 'Enter your Jira username / login ID';
      $('secretLabel').textContent = 'Jira password';
      $('jiraSecretInput').placeholder = 'Enter your Jira password';
      $('jiraSecretInput').setAttribute('autocomplete', 'current-password');
    }

    showBoxError('authErrorBox', '');
  }

  // --- Session UI Rendering ---
  function applySessionUI(session) {
    state.session = session || null;
    const connected = Boolean(session && session.connected);

    $('authSection').classList.toggle('hidden', connected);
    $('workspaceSection').classList.toggle('hidden', !connected);
    $('navUserChip').classList.toggle('hidden', !connected);
    $('disconnectBtn').classList.toggle('hidden', !connected);

    const statusPill = $('navStatusPill');
    statusPill.classList.toggle('status-connected', connected);
    statusPill.classList.toggle('status-disconnected', !connected);
    $('navStatusText').textContent = connected ? 'Jira connected' : 'Jira not connected';

    if (connected) {
      $('navUserInitials').textContent = getInitials(session.displayName || session.username);
      $('navUserName').textContent = session.displayName || session.username;
      $('navUserId').textContent = session.username || '';

      $('accountDisplayName').textContent = session.displayName || session.username;
      $('accountUsername').textContent = `${session.username} (${session.authType === 'bearer' ? 'PAT' : 'Password'})`;
      $('accountServerHost').textContent = session.serverHost || session.baseUrl;
      $('accountSessionExpires').textContent = formatSessionExpiry(session.expiresAt);
      $('accountAiStatus').textContent = state.ai.configured
        ? `Enabled (${state.ai.model})`
        : 'Keyword mode';
    }
  }

  // --- Metadata Loading ---
  async function loadMetadata(forceRefresh = false) {
    const refreshBtn = $('refreshMetadataBtn');
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing...';
    $('programCountLabel').textContent = 'Loading values...';

    try {
      const data = await apiRequest(`/api/metadata${forceRefresh ? '?refresh=true' : ''}`);
      state.metadata = data;

      const currentProgram = $('programProjectSelect').value;
      const programOptions = (data.programProjects || [])
        .map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
        .join('');
      $('programProjectSelect').innerHTML =
        `<option value="ALL">All Program/Projects</option>${programOptions}`;
      if (currentProgram && (data.programProjects || []).includes(currentProgram)) {
        $('programProjectSelect').value = currentProgram;
      }

      const ppCount = (data.programProjects || []).length;
      $('programCountLabel').textContent = ppCount > 0
        ? `${ppCount} values available`
        : (data.programProjectError ? 'Custom field unavailable' : '0 values available');

      const currentType = $('issueTypeSelect').value;
      const typeOptions = (data.issueTypes || [])
        .map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)
        .join('');
      $('issueTypeSelect').innerHTML =
        `<option value="ALL">All issue types</option>${typeOptions}`;
      if (currentType && (data.issueTypes || []).includes(currentType)) {
        $('issueTypeSelect').value = currentType;
      }

      updateFilterStatusLabels();
    } catch (err) {
      $('programCountLabel').textContent = 'Could not load values';
      if (err.status === 401) {
        handleSessionExpired(err.message);
      }
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh';
    }
  }

  function updateFilterStatusLabels() {
    const prog = $('programProjectSelect').value;
    $('programScopeStatus').innerHTML = prog === 'ALL'
      ? `<span class="dot-blue"></span> Searching across all Program/Projects`
      : `<span class="dot-blue"></span> Restricted to <strong>${escapeHtml(prog)}</strong>`;

    const type = $('issueTypeSelect').value;
    $('issueTypeScopeStatus').innerHTML = type === 'ALL'
      ? `<span class="dot-blue"></span> No issue-type restriction`
      : `<span class="dot-blue"></span> Restricted to <strong>${escapeHtml(type)}</strong>`;
  }

  function handleSessionExpired(message) {
    applySessionUI(null);
    showBoxError('authErrorBox', message || 'Your Jira session expired. Please reconnect.');
  }

  // --- Progress Stage Indicator ---
  function startSearchProgress() {
    clearSearchProgressTimers();
    $('searchProgressCard').classList.remove('hidden');

    const setStage = stageIndex => {
      const steps = ['stepUnderstanding', 'stepRetrieving', 'stepRanking'];
      const subtitles = [
        'Analyzing your query and enriching key concepts with AI...',
        'Querying Jira across summaries, descriptions, comments, and metadata...',
        'Calculating lexical overlap and running AI semantic relevance assessment...'
      ];
      steps.forEach((id, idx) => {
        const el = $(id);
        el.classList.remove('active', 'done');
        if (idx < stageIndex) el.classList.add('done');
        else if (idx === stageIndex) el.classList.add('active');
      });
      $('progressSubtitle').textContent = subtitles[stageIndex] || subtitles[0];
    };

    setStage(0);
    state.progressTimers.push(setTimeout(() => setStage(1), 1600));
    state.progressTimers.push(setTimeout(() => setStage(2), 4500));
  }

  function stopSearchProgress() {
    clearSearchProgressTimers();
    $('searchProgressCard').classList.add('hidden');
  }

  function clearSearchProgressTimers() {
    state.progressTimers.forEach(t => clearTimeout(t));
    state.progressTimers = [];
  }

  // --- Results Rendering ---
  function buildRingSvg(score, matchLevel) {
    const radius = 27;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(100, Number(score) || 0));
    const offset = circumference - (clamped / 100) * circumference;

    const strokeColor =
      matchLevel === 'HIGH'
        ? '#16a34a'
        : matchLevel === 'MEDIUM'
          ? '#d97706'
          : '#2563eb';

    return `
      <div class="score-ring-wrap" title="Overall match score: ${clamped}%">
        <svg width="66" height="66" viewBox="0 0 66 66">
          <circle cx="33" cy="33" r="${radius}" fill="none" stroke="#e2e8f0" stroke-width="5.5"></circle>
          <circle
            cx="33"
            cy="33"
            r="${radius}"
            fill="none"
            stroke="${strokeColor}"
            stroke-width="5.5"
            stroke-linecap="round"
            stroke-dasharray="${circumference.toFixed(2)}"
            stroke-dashoffset="${offset.toFixed(2)}"
          ></circle>
        </svg>
        <div class="score-ring-center">
          <span class="score-ring-num">${clamped}</span>
          <span class="score-ring-label">OVERALL</span>
        </div>
      </div>
    `;
  }

  function renderTypeTabs(results) {
    const counts = new Map();
    for (const item of results) {
      const t = item.issueType || 'Other';
      counts.set(t, (counts.get(t) || 0) + 1);
    }

    const sortedTypes = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const tabs = [{ key: 'ALL', label: 'All', count: results.length }];

    for (const [typeName, count] of sortedTypes) {
      tabs.push({ key: typeName, label: typeName, count });
    }

    $('resultTypeTabs').innerHTML = tabs
      .map(tab => `
        <button
          type="button"
          class="type-tab ${state.activeTypeTab === tab.key ? 'active' : ''}"
          data-type-tab="${escapeHtml(tab.key)}"
          role="tab"
          aria-selected="${state.activeTypeTab === tab.key}"
        >
          <span>${escapeHtml(tab.label)}</span>
          <span class="type-tab-count">${tab.count}</span>
        </button>
      `)
      .join('');

    $('resultTypeTabs').querySelectorAll('[data-type-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeTypeTab = btn.dataset.typeTab;
        renderFilteredResults();
      });
    });
  }

  function renderResultCard(item, rankNumber) {
    const matchBadgeClass =
      item.matchLevel === 'HIGH'
        ? 'pill-match-high'
        : item.matchLevel === 'MEDIUM'
          ? 'pill-match-medium'
          : 'pill-match-low';

    const overallFillClass =
      item.matchLevel === 'HIGH'
        ? 'fill-overall-high'
        : item.matchLevel === 'MEDIUM'
          ? 'fill-overall-medium'
          : 'fill-overall-low';

    const conf = (item.aiAssessment?.confidence || 'MEDIUM').toUpperCase();
    const confClass =
      conf === 'HIGH' ? 'conf-high' : conf === 'MEDIUM' ? 'conf-medium' : 'conf-low';

    const signalsHtml = (item.matchSignals || [])
      .map(sig => `<span class="signal-pill">+ ${escapeHtml(sig)}</span>`)
      .join('');

    const sharedHtml = (item.aiAssessment?.sharedConcepts || []).length
      ? `
        <div class="concept-group">
          <div class="concept-group-label">Shared concepts</div>
          <div class="concept-tags">
            ${item.aiAssessment.sharedConcepts
              .map(c => `<span class="concept-tag concept-shared">${escapeHtml(c)}</span>`)
              .join('')}
          </div>
        </div>
      `
      : '';

    const diffHtml = (item.aiAssessment?.importantDifferences || []).length
      ? `
        <div class="concept-group">
          <div class="concept-group-label">Important differences</div>
          <div class="concept-tags">
            ${item.aiAssessment.importantDifferences
              .map(d => `<span class="concept-tag concept-diff">${escapeHtml(d)}</span>`)
              .join('')}
          </div>
        </div>
      `
      : '';

    const aiScoreLabel = item.aiRelevance != null ? `${item.aiRelevance}%` : 'N/A';
    const aiScoreWidth = item.aiRelevance != null ? item.aiRelevance : 0;

    const componentsText = (item.components || []).length ? item.components.join(', ') : '—';
    const programText = item.programProject || '—';
    const updatedText = formatDateShort(item.updated);
    const resolutionText = item.resolution || 'Unresolved';

    return `
      <article class="result-card">
        <div class="result-top-row">
          <div class="rank-badge">${rankNumber}</div>
          <div class="result-main">
            <div class="result-badges">
              <a
                class="issue-key-link"
                href="${escapeHtml(item.browseUrl)}"
                target="_blank"
                rel="noopener noreferrer"
                title="Open ${escapeHtml(item.key)} in Jira"
              >
                <span>${escapeHtml(item.key)}</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
              </a>
              <span class="pill pill-type">${escapeHtml(item.issueType)}</span>
              <span class="pill ${matchBadgeClass}">${escapeHtml(item.matchLevel)} match</span>
              <span class="pill pill-status">${escapeHtml(item.status)}</span>
            </div>

            <h3 class="result-summary">${escapeHtml(item.summary)}</h3>
            ${item.descriptionSnippet ? `<p class="result-desc">${escapeHtml(item.descriptionSnippet)}</p>` : ''}

            ${signalsHtml ? `<div class="signal-list">${signalsHtml}</div>` : ''}

            <div class="ai-box">
              <div class="ai-box-header">
                <span class="ai-box-eyebrow">
                  ${item.aiAssessment?.evaluated ? 'AI SEMANTIC ASSESSMENT' : 'SIMILARITY ASSESSMENT'}
                </span>
                <span class="confidence-badge ${confClass}">${escapeHtml(conf)} CONFIDENCE</span>
              </div>
              <div class="ai-box-subtitle">Why this issue may be related</div>
              <p class="ai-box-explanation">${escapeHtml(item.aiAssessment?.explanation || '')}</p>
              ${sharedHtml}
              ${diffHtml}
            </div>

            <div class="result-meta-row">
              <div class="result-meta-item">
                <span class="meta-label">COMPONENTS</span>
                <span class="result-meta-val">${escapeHtml(componentsText)}</span>
              </div>
              <div class="result-meta-item">
                <span class="meta-label">PROGRAM / PROJECT</span>
                <span class="result-meta-val">${escapeHtml(programText)}</span>
              </div>
              <div class="result-meta-item">
                <span class="meta-label">UPDATED</span>
                <span class="result-meta-val">${escapeHtml(updatedText)}</span>
              </div>
              <div class="result-meta-item">
                <span class="meta-label">RESOLUTION</span>
                <span class="result-meta-val">${escapeHtml(resolutionText)}</span>
              </div>
            </div>

            <div class="score-footer">
              ${buildRingSvg(item.overallScore, item.matchLevel)}
              <div class="score-bars">
                <div class="score-bar-box">
                  <div class="score-bar-head">
                    <span>Keyword Match</span>
                    <strong>${item.keywordScore}%</strong>
                  </div>
                  <div class="score-track">
                    <div class="score-fill fill-keyword" style="width: ${item.keywordScore}%"></div>
                  </div>
                </div>

                <div class="score-bar-box">
                  <div class="score-bar-head">
                    <span>AI Relevance</span>
                    <strong>${aiScoreLabel}</strong>
                  </div>
                  <div class="score-track">
                    <div class="score-fill fill-ai" style="width: ${aiScoreWidth}%"></div>
                  </div>
                </div>

                <div class="score-bar-box">
                  <div class="score-bar-head">
                    <span>Overall Match</span>
                    <strong>${item.overallScore}%</strong>
                  </div>
                  <div class="score-track">
                    <div class="score-fill ${overallFillClass}" style="width: ${item.overallScore}%"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function renderFilteredResults() {
    const data = state.lastSearchResponse;
    if (!data) return;

    const allResults = data.results || [];
    renderTypeTabs(allResults);

    const filterText = state.resultFilterText.trim().toLowerCase();
    const filtered = allResults.filter(item => {
      if (state.activeTypeTab !== 'ALL' && item.issueType !== state.activeTypeTab) {
        return false;
      }
      if (!filterText) return true;
      const haystack = [
        item.key,
        item.summary,
        item.descriptionSnippet,
        item.status,
        item.issueType,
        ...(item.components || []),
        ...(item.labels || []),
        item.programProject
      ].join(' ').toLowerCase();
      return haystack.includes(filterText);
    });

    const label = state.activeTypeTab === 'ALL' ? 'All results' : `${state.activeTypeTab} results`;
    $('resultsCountBar').textContent = `${label} — ${filtered.length} ${filtered.length === 1 ? 'issue' : 'issues'} shown`;

    if (filtered.length === 0) {
      $('resultsList').innerHTML = '';
      $('emptyResultsBox').classList.remove('hidden');
      return;
    }

    $('emptyResultsBox').classList.add('hidden');
    $('resultsList').innerHTML = filtered
      .map((item, idx) => renderResultCard(item, idx + 1))
      .join('');
  }

  function renderSearchResponse(data) {
    state.lastSearchResponse = data;
    state.activeTypeTab = 'ALL';
    state.resultFilterText = '';
    $('resultsFilterInput').value = '';

    $('resultsSection').classList.remove('hidden');

    const seconds = ((data.metrics?.searchTimeMs || 0) / 1000).toFixed(1);
    $('metricCandidates').textContent = String(data.metrics?.candidatesRetrieved ?? 0);
    $('metricResults').textContent = String(data.metrics?.resultsCount ?? 0);
    $('metricTime').textContent = `${seconds} sec`;

    // Enrichment banner
    const enr = data.enrichment || {};
    const banner = $('enrichmentBanner');
    banner.classList.remove('hidden');

    if (enr.aiApplied) {
      $('enrichmentHeading').textContent = enr.sourceIssueKey
        ? `AI query enrichment applied (from ${enr.sourceIssueKey})`
        : 'AI query enrichment applied';
      $('enrichmentInterpreted').textContent = `Interpreted as: ${enr.interpretedQuery}`;
    } else {
      $('enrichmentHeading').textContent = enr.sourceIssueKey
        ? `Ticket lookup applied (${enr.sourceIssueKey})`
        : 'Lexical query analysis applied';
      $('enrichmentInterpreted').textContent = enr.aiNote || `Key search terms: ${enr.interpretedQuery}`;
    }

    const chips = [...new Set([...(enr.coreKeywords || []), ...(enr.synonyms || [])])].slice(0, 10);
    $('enrichmentChips').innerHTML = chips
      .map(term => `<span class="enrichment-chip">${escapeHtml(term)}</span>`)
      .join('');

    if (data.sessionExpiresAt) {
      $('accountSessionExpires').textContent = formatSessionExpiry(data.sessionExpiresAt);
    }

    renderFilteredResults();
    $('resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- Search Execution ---
  async function executeSearch() {
    if (state.isSearching) return;
    const query = $('searchQueryInput').value.trim();
    if (!query) {
      showBoxError('searchErrorBox', 'Please describe the issue, paste a summary, or enter a Jira ticket key.');
      $('searchQueryInput').focus();
      return;
    }

    showBoxError('searchErrorBox', '');
    state.isSearching = true;
    $('searchBtn').disabled = true;
    $('searchBtnLabel').textContent = 'Searching Jira...';
    startSearchProgress();

    try {
      const response = await apiRequest('/api/search', {
        method: 'POST',
        body: JSON.stringify({
          query,
          programProject: $('programProjectSelect').value,
          issueType: $('issueTypeSelect').value,
          includeResolved: $('includeResolvedToggle').checked
        })
      });
      renderSearchResponse(response);
    } catch (err) {
      if (err.status === 401) {
        handleSessionExpired(err.message);
      } else {
        showBoxError('searchErrorBox', err.message || 'Search failed. Please try again.');
      }
    } finally {
      state.isSearching = false;
      stopSearchProgress();
      $('searchBtn').disabled = false;
      $('searchBtnLabel').textContent = 'Find related issues';
    }
  }

  // --- Event Handlers ---
  $('tabBasic').addEventListener('click', () => setAuthMode('basic'));
  $('tabBearer').addEventListener('click', () => setAuthMode('bearer'));

  $('toggleSecretBtn').addEventListener('click', () => {
    const input = $('jiraSecretInput');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    $('toggleSecretBtn').textContent = showing ? 'Show' : 'Hide';
  });

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    showBoxError('authErrorBox', '');

    const baseUrl = $('jiraUrlInput').value.trim();
    const username = $('jiraUsernameInput').value.trim();
    const secret = $('jiraSecretInput').value;

    if (!baseUrl) {
      showBoxError('authErrorBox', 'Please enter your Jira Server URL.');
      return;
    }
    if (state.authMode === 'basic' && !username) {
      showBoxError('authErrorBox', 'Please enter your Jira username.');
      return;
    }
    if (!secret) {
      showBoxError(
        'authErrorBox',
        state.authMode === 'bearer'
          ? 'Please enter your Jira Personal Access Token.'
          : 'Please enter your Jira password.'
      );
      return;
    }

    const btn = $('connectBtn');
    btn.disabled = true;
    $('connectBtnLabel').textContent = 'Connecting to Jira...';

    try {
      const data = await apiRequest('/api/auth/connect', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl,
          username,
          secret,
          authType: state.authMode
        })
      });

      // Clear secret from DOM immediately after successful connect
      $('jiraSecretInput').value = '';
      $('jiraSecretInput').type = 'password';
      $('toggleSecretBtn').textContent = 'Show';

      applySessionUI(data.session);
      await loadMetadata(false);
      $('searchQueryInput').focus();
    } catch (err) {
      showBoxError('authErrorBox', err.message || 'Could not connect to Jira.');
    } finally {
      btn.disabled = false;
      $('connectBtnLabel').textContent = 'Connect to Jira';
    }
  });

  $('disconnectBtn').addEventListener('click', async () => {
    try {
      await apiRequest('/api/auth/disconnect', { method: 'POST' });
    } catch {
      // ignore
    }
    state.lastSearchResponse = null;
    $('resultsSection').classList.add('hidden');
    $('searchQueryInput').value = '';
    $('queryCharCount').textContent = '0';
    applySessionUI(null);
  });

  $('searchQueryInput').addEventListener('input', () => {
    $('queryCharCount').textContent = String($('searchQueryInput').value.length);
  });

  $('searchQueryInput').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      executeSearch();
    }
  });

  $('programProjectSelect').addEventListener('change', updateFilterStatusLabels);
  $('issueTypeSelect').addEventListener('change', updateFilterStatusLabels);
  $('refreshMetadataBtn').addEventListener('click', () => loadMetadata(true));
  $('searchBtn').addEventListener('click', executeSearch);

  $('quickExamplesList').addEventListener('click', e => {
    const chip = e.target.closest('[data-example]');
    if (!chip) return;
    const sample = chip.dataset.example || '';
    $('searchQueryInput').value = sample;
    $('queryCharCount').textContent = String(sample.length);
    $('searchQueryInput').focus();
  });

  $('resultsFilterInput').addEventListener('input', e => {
    state.resultFilterText = e.target.value;
    renderFilteredResults();
  });

  // Modal controls
  function openGuide() {
    $('guideModal').classList.remove('hidden');
  }
  function closeGuide() {
    $('guideModal').classList.add('hidden');
  }

  $('openGuideBtn').addEventListener('click', openGuide);
  $('howToSearchBtn').addEventListener('click', openGuide);
  $('footerGuideBtn').addEventListener('click', openGuide);
  $('closeGuideBtn').addEventListener('click', closeGuide);
  $('confirmGuideBtn').addEventListener('click', closeGuide);
  $('guideModal').addEventListener('click', e => {
    if (e.target === $('guideModal')) closeGuide();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('guideModal').classList.contains('hidden')) {
      closeGuide();
    }
  });

  // --- Bootstrap on Page Load ---
  async function init() {
    setAuthMode('basic');
    try {
      const cfg = await apiRequest('/api/config');
      state.ai = cfg.ai || state.ai;
      if (cfg.defaultJiraUrl && !$('jiraUrlInput').value) {
        $('jiraUrlInput').value = cfg.defaultJiraUrl;
      }
      if (cfg.programProjectFieldName) {
        $('programProjectTitle').textContent = cfg.programProjectFieldName;
      }
      if (cfg.session && cfg.session.connected) {
        applySessionUI(cfg.session);
        await loadMetadata(false);
      } else {
        applySessionUI(null);
      }
    } catch (err) {
      showBoxError('authErrorBox', 'Could not reach the local IssueMatcher backend. Make sure `node server.js` is running.');
    }
  }

  init();
})();
