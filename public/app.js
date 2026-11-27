(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const STORAGE_HISTORY_KEY = 'issuematcher_recent_queries';

  const state = {
    authMode: 'basic',
    session: null,
    ai: { enabled: false, configured: false, model: 'Not configured' },
    metadata: { programProjects: [], issueTypes: [] },
    selectedProgram: 'ALL',
    lastSearchResponse: null,
    activeTypeTab: 'ALL',
    activeTier: 'ALL',
    sortBy: 'overall',
    density: 'cards',
    resultFilterText: '',
    selectedKey: null,
    visibleResults: [],
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

  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlightTerms(text, terms) {
    const safe = escapeHtml(text || '');
    const usable = [...new Set((terms || []).map(t => String(t || '').trim()).filter(t => t.length >= 3))];
    if (!safe || usable.length === 0) return safe;

    usable.sort((a, b) => b.length - a.length);
    const pattern = new RegExp(`(${usable.slice(0, 8).map(escapeRegex).join('|')})`, 'gi');
    return safe.replace(pattern, '<mark class="term-hit">$1</mark>');
  }

  function getInitials(name) {
    const parts = String(name || 'U').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

  function showToast(message) {
    const container = $('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      setTimeout(() => toast.remove(), 220);
    }, 2600);
  }

  async function copyToClipboard(text, successMsg) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMsg || 'Copied to clipboard');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast(successMsg || 'Copied to clipboard');
    }
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

  // --- Recent Searches (Browser-local, zero credentials) ---
  function loadRecentSearches() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_HISTORY_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
    } catch {
      return [];
    }
  }

  function saveRecentSearch(query) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return;
    const current = loadRecentSearches().filter(q => q.toLowerCase() !== trimmed.toLowerCase());
    current.unshift(trimmed);
    try {
      localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(current.slice(0, 5)));
    } catch {
      // ignore
    }
    renderRecentSearches();
  }

  function renderRecentSearches() {
    const list = loadRecentSearches();
    const row = $('recentSearchesRow');
    if (list.length === 0) {
      row.classList.add('hidden');
      return;
    }
    row.classList.remove('hidden');
    $('recentSearchesList').innerHTML = list
      .map(q => `<button type="button" class="soft-chip" data-recent-query="${escapeHtml(q)}" title="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
      .join('');
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
      $('jiraUsernameInput').placeholder = 'Optional — auto-detected from token';
      $('secretLabel').textContent = 'Personal Access Token (PAT)';
      $('jiraSecretInput').placeholder = 'Enter your Jira PAT';
      $('jiraSecretInput').setAttribute('autocomplete', 'off');
    } else {
      $('usernameLabel').textContent = 'Jira username';
      $('jiraUsernameInput').placeholder = 'Enter your Jira login ID';
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
    statusPill.classList.toggle('chip-connected', connected);
    statusPill.classList.toggle('chip-disconnected', !connected);
    $('navStatusText').textContent = connected ? 'Connected' : 'Not connected';

    const aiPill = $('navAiPill');
    if (connected) {
      aiPill.classList.remove('hidden');
      $('navAiText').textContent = state.ai.configured ? `AI: ${state.ai.model}` : 'Keyword mode';

      $('navUserInitials').textContent = getInitials(session.displayName || session.username);
      $('navUserName').textContent = session.displayName || session.username;
      $('navUserId').textContent = session.username || '';

      $('accountDisplayName').textContent = session.displayName || session.username;
      $('accountUsername').textContent = `(${session.username} · ${session.authType === 'bearer' ? 'PAT' : 'Password'})`;
      $('accountServerHost').textContent = session.serverHost || session.baseUrl;
      $('accountSessionExpires').textContent = formatSessionExpiry(session.expiresAt);
      $('accountAiStatus').textContent = state.ai.configured
        ? `Enabled (${state.ai.model})`
        : 'Keyword-only';
    } else {
      aiPill.classList.add('hidden');
    }
  }

  // --- Searchable Program/Project Combobox ---
  function openProgramDropdown() {
    $('programDropdown').classList.remove('hidden');
    $('programTriggerBtn').setAttribute('aria-expanded', 'true');
    $('programSearchInput').value = '';
    renderProgramOptions('');
    setTimeout(() => $('programSearchInput').focus(), 20);
  }

  function closeProgramDropdown() {
    $('programDropdown').classList.add('hidden');
    $('programTriggerBtn').setAttribute('aria-expanded', 'false');
  }

  function selectProgramValue(value) {
    state.selectedProgram = value || 'ALL';
    $('programProjectSelect').value = state.selectedProgram;
    $('programSelectedLabel').textContent =
      state.selectedProgram === 'ALL' ? 'All Program/Projects' : state.selectedProgram;
    closeProgramDropdown();
  }

  function renderProgramOptions(filterText) {
    const q = String(filterText || '').trim().toLowerCase();
    const allPrograms = state.metadata.programProjects || [];
    const matched = q
      ? allPrograms.filter(p => p.toLowerCase().includes(q))
      : allPrograms;

    const container = $('programOptionsList');
    let html = '';

    if (!q || 'all program/projects'.includes(q)) {
      html += `
        <button type="button" class="combobox-option ${state.selectedProgram === 'ALL' ? 'selected' : ''}" data-prog-val="ALL">
          <span>All Program/Projects</span>
          ${state.selectedProgram === 'ALL' ? '<span>&#10003;</span>' : ''}
        </button>
      `;
    }

    if (matched.length === 0 && q) {
      html += `<div class="combobox-empty">No Program/Project matching "${escapeHtml(filterText)}"</div>`;
    } else {
      html += matched
        .map(p => `
          <button type="button" class="combobox-option ${state.selectedProgram === p ? 'selected' : ''}" data-prog-val="${escapeHtml(p)}">
            <span>${escapeHtml(p)}</span>
            ${state.selectedProgram === p ? '<span>&#10003;</span>' : ''}
          </button>
        `)
        .join('');
    }

    container.innerHTML = html;
  }

  // --- Metadata Loading ---
  async function loadMetadata(forceRefresh = false) {
    const refreshBtn = $('refreshMetadataBtn');
    refreshBtn.disabled = true;
    refreshBtn.classList.add('spinning');
    $('programCountLabel').textContent = 'Loading...';

    try {
      const data = await apiRequest(`/api/metadata${forceRefresh ? '?refresh=true' : ''}`);
      state.metadata = data;

      const programs = data.programProjects || [];
      $('programProjectSelect').innerHTML =
        `<option value="ALL">All Program/Projects</option>` +
        programs.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');

      if (state.selectedProgram !== 'ALL' && !programs.includes(state.selectedProgram)) {
        selectProgramValue('ALL');
      } else {
        $('programProjectSelect').value = state.selectedProgram;
      }

      $('programCountLabel').textContent = programs.length > 0
        ? `${programs.length} available`
        : (data.programProjectError ? 'Unavailable' : '0 available');

      const currentType = $('issueTypeSelect').value;
      const types = data.issueTypes || [];
      $('issueTypeSelect').innerHTML =
        `<option value="ALL">All issue types</option>` +
        types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
      if (currentType && types.includes(currentType)) {
        $('issueTypeSelect').value = currentType;
      }

      updateIssueTypeLabel();
      if (forceRefresh) {
        showToast(`Refreshed ${programs.length} Program/Projects and ${types.length} issue types`);
      }
    } catch (err) {
      $('programCountLabel').textContent = 'Failed to load';
      if (err.status === 401) {
        handleSessionExpired(err.message);
      } else {
        showToast(err.message || 'Could not load Jira metadata');
      }
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('spinning');
    }
  }

  function updateIssueTypeLabel() {
    const val = $('issueTypeSelect').value;
    $('issueTypeScopeStatus').textContent = val === 'ALL' ? 'All types' : val;
  }

  function handleSessionExpired(message) {
    applySessionUI(null);
    showBoxError('authErrorBox', message || 'Your Jira session expired. Please reconnect.');
  }

  // --- Progress Pipeline ---
  function startSearchProgress() {
    clearSearchProgressTimers();
    $('resultsSection').classList.add('hidden');
    $('searchProgressCard').classList.remove('hidden');

    const setStage = idx => {
      const ids = ['stepUnderstanding', 'stepRetrieving', 'stepRanking'];
      const subs = [
        'Understanding your query and extracting core concepts with AI...',
        'Querying Jira across summaries, descriptions, comments, and metadata...',
        'Computing lexical overlap and running AI semantic relevance scoring...'
      ];
      ids.forEach((id, i) => {
        const el = $(id);
        el.classList.remove('active', 'done');
        if (i < idx) el.classList.add('done');
        else if (i === idx) el.classList.add('active');
      });
      $('progressSubtitle').textContent = subs[idx] || subs[0];
    };

    setStage(0);
    state.progressTimers.push(setTimeout(() => setStage(1), 1500));
    state.progressTimers.push(setTimeout(() => setStage(2), 4200));
  }

  function stopSearchProgress() {
    clearSearchProgressTimers();
    $('searchProgressCard').classList.add('hidden');
  }

  function clearSearchProgressTimers() {
    state.progressTimers.forEach(t => clearTimeout(t));
    state.progressTimers = [];
  }

  // --- SVG Radial Score Ring ---
  function buildScoreRing(score, matchLevel, large = false) {
    const size = large ? 72 : 54;
    const center = size / 2;
    const radius = large ? 29 : 21;
    const strokeWidth = large ? 6 : 4.5;
    const circ = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(100, Number(score) || 0));
    const offset = circ - (clamped / 100) * circ;

    const stroke =
      matchLevel === 'HIGH'
        ? 'var(--high)'
        : matchLevel === 'MEDIUM'
          ? 'var(--med)'
          : 'var(--low)';

    return `
      <div class="score-ring ${large ? 'ring-lg' : ''}" title="Overall match: ${clamped}%">
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
          <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="var(--surface-3)" stroke-width="${strokeWidth}"></circle>
          <circle
            cx="${center}"
            cy="${center}"
            r="${radius}"
            fill="none"
            stroke="${stroke}"
            stroke-width="${strokeWidth}"
            stroke-linecap="round"
            stroke-dasharray="${circ.toFixed(2)}"
            stroke-dashoffset="${offset.toFixed(2)}"
          ></circle>
        </svg>
        <div class="score-ring-val">
          <strong>${clamped}</strong>
          ${large ? '<small>OVERALL</small>' : ''}
        </div>
      </div>
    `;
  }

  // --- Verdict & Enrichment Rendering ---
  function renderVerdict(data) {
    const verdict = data.verdict || {
      level: 'LOW_OVERLAP',
      badge: 'Results ready',
      headline: 'Review potential matches below',
      recommendation: '',
      topKeys: []
    };

    const card = $('verdictBanner');
    card.classList.remove('verdict-duplicate', 'verdict-overlap', 'verdict-safe');
    if (verdict.level === 'LIKELY_DUPLICATE') card.classList.add('verdict-duplicate');
    else if (verdict.level === 'POSSIBLE_OVERLAP') card.classList.add('verdict-overlap');
    else card.classList.add('verdict-safe');

    $('verdictBadge').textContent = verdict.badge || 'Summary';
    $('verdictHeadline').textContent = verdict.headline || '';
    $('verdictRecommendation').textContent = verdict.recommendation || '';

    $('verdictTopKeys').innerHTML = (verdict.topKeys || [])
      .map(key => `<button type="button" class="verdict-key-btn" data-jump-key="${escapeHtml(key)}">${escapeHtml(key)}</button>`)
      .join('');

    const sec = ((data.metrics?.searchTimeMs || 0) / 1000).toFixed(1);
    $('metricCandidates').textContent = String(data.metrics?.candidatesRetrieved ?? 0);
    $('metricResults').textContent = String(data.metrics?.resultsCount ?? 0);
    $('metricTime').textContent = `${sec}s`;
  }

  function renderEnrichment(data) {
    const enr = data.enrichment || {};
    const banner = $('enrichmentBanner');
    banner.classList.remove('hidden');

    if (enr.aiApplied) {
      $('enrichmentHeading').textContent = enr.sourceIssueKey
        ? `AI enriched from ${enr.sourceIssueKey}:`
        : 'AI interpreted as:';
      $('enrichmentInterpreted').textContent = enr.interpretedQuery || '';
    } else {
      $('enrichmentHeading').textContent = enr.sourceIssueKey
        ? `Matched from ${enr.sourceIssueKey}:`
        : 'Lexical keywords:';
      $('enrichmentInterpreted').textContent = enr.aiNote || enr.interpretedQuery || '';
    }

    const chips = [...new Set([...(enr.coreKeywords || []), ...(enr.synonyms || [])])].slice(0, 8);
    $('enrichmentChips').innerHTML = chips
      .map(t => `<span class="enrichment-chip">${escapeHtml(t)}</span>`)
      .join('');
  }

  // --- Type Tabs, Filtering, Sorting ---
  function renderTypeTabs(allResults) {
    const counts = new Map();
    for (const r of allResults) {
      const t = r.issueType || 'Other';
      counts.set(t, (counts.get(t) || 0) + 1);
    }

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const tabs = [{ key: 'ALL', label: 'All', count: allResults.length }];
    for (const [name, count] of sorted) {
      tabs.push({ key: name, label: name, count });
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
  }

  function computeVisibleResults() {
    const allResults = state.lastSearchResponse?.results || [];
    const text = state.resultFilterText.trim().toLowerCase();

    const filtered = allResults.filter(item => {
      if (state.activeTypeTab !== 'ALL' && item.issueType !== state.activeTypeTab) return false;
      if (state.activeTier !== 'ALL' && item.matchLevel !== state.activeTier) return false;
      if (!text) return true;
      const hay = [
        item.key,
        item.summary,
        item.descriptionSnippet,
        item.status,
        item.issueType,
        item.programProject,
        ...(item.components || []),
        ...(item.labels || [])
      ].join(' ').toLowerCase();
      return hay.includes(text);
    });

    filtered.sort((a, b) => {
      if (state.sortBy === 'ai') {
        return (b.aiRelevance ?? -1) - (a.aiRelevance ?? -1) || b.overallScore - a.overallScore;
      }
      if (state.sortBy === 'keyword') {
        return b.keywordScore - a.keywordScore || b.overallScore - a.overallScore;
      }
      if (state.sortBy === 'updated') {
        return new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime();
      }
      return b.overallScore - a.overallScore || (b.aiRelevance ?? -1) - (a.aiRelevance ?? -1);
    });

    return filtered;
  }

  // --- Master List Rendering ---
  function renderMasterCard(item, rank) {
    const tierClass =
      item.matchLevel === 'HIGH' ? 'tier-high' : item.matchLevel === 'MEDIUM' ? 'tier-medium' : 'tier-low';
    const badgeClass =
      item.matchLevel === 'HIGH' ? 'badge-high' : item.matchLevel === 'MEDIUM' ? 'badge-medium' : 'badge-low';
    const isSelected = state.selectedKey === item.key;

    const termsToHighlight = [
      ...(item.matchedTerms || []),
      ...(state.lastSearchResponse?.enrichment?.coreKeywords || [])
    ];

    const conceptPills = (item.aiAssessment?.sharedConcepts || []).slice(0, 3)
      .map(c => `<span class="mini-concept-pill">${escapeHtml(c)}</span>`)
      .join('');

    return `
      <article class="match-card ${tierClass} ${isSelected ? 'selected' : ''}" data-select-key="${escapeHtml(item.key)}">
        <div class="match-card-row">
          <div class="match-card-body">
            <div class="match-badges">
              <span class="rank-num">#${rank}</span>
              <a
                class="key-anchor"
                href="${escapeHtml(item.browseUrl)}"
                target="_blank"
                rel="noopener noreferrer"
                data-stop-select="true"
                title="Open ${escapeHtml(item.key)} in Jira"
              >
                <span>${escapeHtml(item.key)}</span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
              </a>
              <span class="badge badge-type">${escapeHtml(item.issueType)}</span>
              <span class="badge ${badgeClass}">${escapeHtml(item.matchLevel)}</span>
              <span class="badge badge-status">${escapeHtml(item.status)}</span>
            </div>

            <h3 class="match-summary">${highlightTerms(item.summary, termsToHighlight)}</h3>
            <p class="match-ai-preview">${escapeHtml(item.aiAssessment?.explanation || item.descriptionSnippet || '')}</p>

            <div class="match-footer-row">
              <div class="mini-concepts">${conceptPills}</div>
              <div class="card-quick-actions">
                <button type="button" class="card-action-btn" data-copy-key="${escapeHtml(item.key)}" data-stop-select="true" title="Copy Jira key">Copy key</button>
                <button type="button" class="card-action-btn" data-pivot-key="${escapeHtml(item.key)}" data-stop-select="true" title="Find tickets similar to ${escapeHtml(item.key)}">Find similar</button>
              </div>
            </div>
          </div>

          ${buildScoreRing(item.overallScore, item.matchLevel, false)}
        </div>
      </article>
    `;
  }

  // --- Right Sticky Inspector Rendering ---
  function renderInspector(item) {
    const container = $('inspectorContent');
    if (!item) {
      container.innerHTML = `
        <div class="inspector-placeholder">
          <p>Select any match on the left to inspect its full description, AI assessment, linked issues, and recent comments.</p>
        </div>
      `;
      return;
    }

    const badgeClass =
      item.matchLevel === 'HIGH' ? 'badge-high' : item.matchLevel === 'MEDIUM' ? 'badge-medium' : 'badge-low';
    const overallBarClass =
      item.matchLevel === 'HIGH' ? 'bf-high' : item.matchLevel === 'MEDIUM' ? 'bf-med' : 'bf-low';

    const conf = (item.aiAssessment?.confidence || 'MEDIUM').toUpperCase();
    const confClass = conf === 'HIGH' ? 'badge-high' : conf === 'MEDIUM' ? 'badge-medium' : 'badge-low';

    const termsToHighlight = [
      ...(item.matchedTerms || []),
      ...(state.lastSearchResponse?.enrichment?.coreKeywords || [])
    ];

    const sharedHtml = (item.aiAssessment?.sharedConcepts || []).length
      ? `
        <div class="concept-block">
          <div class="concept-title">Shared concepts</div>
          <div class="concept-wrap">
            ${item.aiAssessment.sharedConcepts.map(c => `<span class="c-tag c-shared">${escapeHtml(c)}</span>`).join('')}
          </div>
        </div>
      `
      : '';

    const diffHtml = (item.aiAssessment?.importantDifferences || []).length
      ? `
        <div class="concept-block">
          <div class="concept-title">Important differences</div>
          <div class="concept-wrap">
            ${item.aiAssessment.importantDifferences.map(d => `<span class="c-tag c-diff">${escapeHtml(d)}</span>`).join('')}
          </div>
        </div>
      `
      : '';

    const signalsHtml = (item.matchSignals || [])
      .map(s => `<span class="signal-tag">+ ${escapeHtml(s)}</span>`)
      .join('');

    const linkedHtml = (item.linkedIssues || []).length
      ? `
        <div class="inspector-section">
          <h4>Linked Jira Issues (${item.linkedIssues.length})</h4>
          <div class="linked-list">
            ${item.linkedIssues.map(link => `
              <div class="linked-row">
                <span class="linked-rel">${escapeHtml(link.relation || 'related')}</span>
                <a class="key-anchor" href="${escapeHtml(link.browseUrl || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.key)}</a>
                <span>${escapeHtml(link.summary || '')}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `
      : '';

    const commentsHtml = (item.recentComments || []).length
      ? `
        <div class="inspector-section">
          <h4>Recent Comments (${item.commentCount || item.recentComments.length})</h4>
          <div class="comments-list">
            ${item.recentComments.map(c => `
              <div class="comment-item">
                <div class="comment-head">
                  <strong>${escapeHtml(c.author)}</strong>
                  <span>${escapeHtml(formatDateShort(c.created))}</span>
                </div>
                <p class="comment-body">${escapeHtml(c.body)}</p>
              </div>
            `).join('')}
          </div>
        </div>
      `
      : '';

    const aiScoreLabel = item.aiRelevance != null ? `${item.aiRelevance}%` : 'N/A';
    const aiScoreWidth = item.aiRelevance != null ? item.aiRelevance : 0;

    container.innerHTML = `
      <div class="inspector-top">
        <div class="match-badges">
          <a class="key-anchor" href="${escapeHtml(item.browseUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:15px">
            ${escapeHtml(item.key)}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </a>
          <span class="badge badge-type">${escapeHtml(item.issueType)}</span>
          <span class="badge ${badgeClass}">${escapeHtml(item.matchLevel)} match</span>
          <span class="badge badge-status">${escapeHtml(item.status)}</span>
        </div>
        <button type="button" id="closeInspectorBtn" class="icon-btn inspector-close-mobile" aria-label="Close inspector">&times;</button>
      </div>

      <h3 class="inspector-title">${highlightTerms(item.summary, termsToHighlight)}</h3>

      <div class="inspector-actions">
        <a class="btn-secondary-sm" href="${escapeHtml(item.browseUrl)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">Open in Jira &nearr;</a>
        <button type="button" class="btn-secondary-sm" data-copy-key="${escapeHtml(item.key)}">Copy Key</button>
        <button type="button" class="btn-secondary-sm" data-pivot-key="${escapeHtml(item.key)}">Find Similar to This</button>
      </div>

      <div class="inspector-score-panel">
        ${buildScoreRing(item.overallScore, item.matchLevel, true)}
        <div class="inspector-bars">
          <div>
            <div class="bar-row-head"><span>Keyword Match</span><strong>${item.keywordScore}%</strong></div>
            <div class="bar-track"><div class="bar-fill bf-keyword" style="width:${item.keywordScore}%"></div></div>
          </div>
          <div>
            <div class="bar-row-head"><span>AI Relevance</span><strong>${aiScoreLabel}</strong></div>
            <div class="bar-track"><div class="bar-fill bf-ai" style="width:${aiScoreWidth}%"></div></div>
          </div>
          <div>
            <div class="bar-row-head"><span>Overall Match</span><strong>${item.overallScore}%</strong></div>
            <div class="bar-track"><div class="bar-fill ${overallBarClass}" style="width:${item.overallScore}%"></div></div>
          </div>
        </div>
      </div>

      <div class="inspector-ai-box">
        <div class="inspector-ai-head">
          <span class="eyebrow">${item.aiAssessment?.evaluated ? 'AI SEMANTIC ASSESSMENT' : 'SIMILARITY ASSESSMENT'}</span>
          <span class="badge ${confClass}">${escapeHtml(conf)} CONFIDENCE</span>
        </div>
        <p>${escapeHtml(item.aiAssessment?.explanation || '')}</p>
        ${sharedHtml}
        ${diffHtml}
      </div>

      ${signalsHtml ? `
        <div class="inspector-section" style="margin-top:0;padding-top:0;border-top:none">
          <h4>Match Signals</h4>
          <div class="signal-wrap">${signalsHtml}</div>
        </div>
      ` : ''}

      <div class="inspector-section">
        <h4>Description</h4>
        <p class="inspector-desc">${item.descriptionFull ? highlightTerms(item.descriptionFull, termsToHighlight) : 'No description provided in Jira.'}</p>
      </div>

      <div class="inspector-section">
        <h4>Ticket Metadata</h4>
        <div class="meta-grid">
          <div class="meta-cell"><span>Program / Project</span><strong>${escapeHtml(item.programProject || '—')}</strong></div>
          <div class="meta-cell"><span>Components</span><strong>${escapeHtml((item.components || []).join(', ') || '—')}</strong></div>
          <div class="meta-cell"><span>Resolution</span><strong>${escapeHtml(item.resolution || 'Unresolved')}</strong></div>
          <div class="meta-cell"><span>Priority</span><strong>${escapeHtml(item.priority || '—')}</strong></div>
          <div class="meta-cell"><span>Assignee</span><strong>${escapeHtml(item.assignee || 'Unassigned')}</strong></div>
          <div class="meta-cell"><span>Reporter</span><strong>${escapeHtml(item.reporter || '—')}</strong></div>
          <div class="meta-cell"><span>Updated</span><strong>${escapeHtml(formatDateShort(item.updated))}</strong></div>
          <div class="meta-cell"><span>Created</span><strong>${escapeHtml(formatDateShort(item.created))}</strong></div>
        </div>
        ${(item.labels || []).length ? `
          <div class="concept-block">
            <div class="concept-title">Labels</div>
            <div class="signal-wrap">
              ${item.labels.map(l => `<span class="signal-tag">${escapeHtml(l)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      ${linkedHtml}
      ${commentsHtml}
    `;

    const closeBtn = $('closeInspectorBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', closeMobileInspector);
    }
  }

  function openMobileInspector() {
    if (window.innerWidth <= 1080) {
      $('inspectorPanel').classList.add('drawer-open');
    }
  }

  function closeMobileInspector() {
    $('inspectorPanel').classList.remove('drawer-open');
  }

  function selectResultByKey(key, openDrawerOnMobile = false) {
    state.selectedKey = key;
    const found = state.visibleResults.find(r => r.key === key) || null;
    $('resultsList').querySelectorAll('.match-card').forEach(el => {
      el.classList.toggle('selected', el.dataset.selectKey === key);
    });
    renderInspector(found);
    if (openDrawerOnMobile && found) {
      openMobileInspector();
    }
  }

  function renderFilteredResults() {
    const data = state.lastSearchResponse;
    if (!data) return;

    renderTypeTabs(data.results || []);
    const visible = computeVisibleResults();
    state.visibleResults = visible;

    const total = (data.results || []).length;
    $('resultsCountBar').textContent = `Showing ${visible.length} of ${total} ${total === 1 ? 'issue' : 'issues'}`;

    const listEl = $('resultsList');
    listEl.classList.toggle('compact', state.density === 'compact');

    if (visible.length === 0) {
      listEl.innerHTML = '';
      $('splitWorkbench').classList.add('hidden');
      $('emptyResultsBox').classList.remove('hidden');
      renderInspector(null);
      return;
    }

    $('emptyResultsBox').classList.add('hidden');
    $('splitWorkbench').classList.remove('hidden');

    // Keep current selection if still visible, otherwise default to first result
    if (!visible.some(r => r.key === state.selectedKey)) {
      state.selectedKey = visible[0].key;
    }

    listEl.innerHTML = visible.map((item, idx) => renderMasterCard(item, idx + 1)).join('');
    const currentSelected = visible.find(r => r.key === state.selectedKey) || visible[0];
    renderInspector(currentSelected);
  }

  function renderSearchResponse(data) {
    state.lastSearchResponse = data;
    state.activeTypeTab = 'ALL';
    state.activeTier = 'ALL';
    state.resultFilterText = '';
    state.selectedKey = data.results?.[0]?.key || null;

    $('resultsFilterInput').value = '';
    $('tierFilterGroup').querySelectorAll('.tier-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tier === 'ALL');
    });

    $('resultsSection').classList.remove('hidden');
    renderVerdict(data);
    renderEnrichment(data);

    if (data.sessionExpiresAt) {
      $('accountSessionExpires').textContent = formatSessionExpiry(data.sessionExpiresAt);
    }

    renderFilteredResults();
    $('resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- Export Helpers ---
  function exportVisibleToCsv() {
    const rows = state.visibleResults || [];
    if (!rows.length) {
      showToast('No results to export');
      return;
    }

    const csvCell = val => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const headers = [
      'Rank', 'Key', 'Issue Type', 'Status', 'Match Level',
      'Overall %', 'Keyword %', 'AI Relevance %', 'Program/Project',
      'Summary', 'AI Explanation', 'Jira URL'
    ];

    const lines = [headers.map(csvCell).join(',')];
    rows.forEach((r, i) => {
      lines.push([
        i + 1, r.key, r.issueType, r.status, r.matchLevel,
        r.overallScore, r.keywordScore, r.aiRelevance ?? '',
        r.programProject, r.summary, r.aiAssessment?.explanation || '', r.browseUrl
      ].map(csvCell).join(','));
    });

    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `issuematcher-results-${dateStamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} matches to CSV`);
  }

  function copyMarkdownSummary() {
    const data = state.lastSearchResponse;
    const rows = (state.visibleResults || []).slice(0, 10);
    if (!data || !rows.length) {
      showToast('No results to summarize');
      return;
    }

    const lines = [
      `### IssueMatcher Duplicate Check`,
      `**Query:** ${data.query}`,
      `**Verdict:** ${data.verdict?.badge || ''} — ${data.verdict?.headline || ''}`,
      `**Top Matches (${rows.length} of ${data.results?.length || 0}):**`,
      ...rows.map((r, i) => `${i + 1}. **${r.key}** (${r.overallScore}% match · ${r.issueType} · ${r.status}) — ${r.summary} (${r.browseUrl})`)
    ];

    copyToClipboard(lines.join('\n'), 'Copied summary for Teams / Jira');
  }

  // --- Search Execution ---
  async function executeSearch(overrideQuery) {
    if (state.isSearching) return;
    if (typeof overrideQuery === 'string') {
      $('searchQueryInput').value = overrideQuery;
      syncQueryCounter();
    }

    const query = $('searchQueryInput').value.trim();
    if (!query) {
      showBoxError('searchErrorBox', 'Please describe the issue, paste a summary, or enter a Jira ticket key.');
      $('searchQueryInput').focus();
      return;
    }

    showBoxError('searchErrorBox', '');
    closeProgramDropdown();
    state.isSearching = true;
    $('searchBtn').disabled = true;
    $('searchBtnLabel').textContent = 'Searching...';
    startSearchProgress();

    try {
      const response = await apiRequest('/api/search', {
        method: 'POST',
        body: JSON.stringify({
          query,
          programProject: state.selectedProgram,
          issueType: $('issueTypeSelect').value,
          includeResolved: $('includeResolvedToggle').checked
        })
      });
      saveRecentSearch(query);
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
      $('searchBtnLabel').textContent = 'Find Similar';
    }
  }

  function syncQueryCounter() {
    const val = $('searchQueryInput').value;
    $('queryCharCount').textContent = String(val.length);
    $('clearQueryBtn').classList.toggle('hidden', val.length === 0);
  }

  // --- Event Listeners ---
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

    if (!baseUrl) return showBoxError('authErrorBox', 'Please enter your Jira Server URL.');
    if (state.authMode === 'basic' && !username) return showBoxError('authErrorBox', 'Please enter your Jira username.');
    if (!secret) {
      return showBoxError(
        'authErrorBox',
        state.authMode === 'bearer' ? 'Please enter your Jira Personal Access Token.' : 'Please enter your Jira password.'
      );
    }

    const btn = $('connectBtn');
    btn.disabled = true;
    $('connectBtnLabel').textContent = 'Connecting...';

    try {
      const data = await apiRequest('/api/auth/connect', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, username, secret, authType: state.authMode })
      });

      $('jiraSecretInput').value = '';
      $('jiraSecretInput').type = 'password';
      $('toggleSecretBtn').textContent = 'Show';

      applySessionUI(data.session);
      showToast(`Connected as ${data.session.displayName || data.session.username}`);
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
    state.selectedKey = null;
    $('resultsSection').classList.add('hidden');
    $('searchQueryInput').value = '';
    syncQueryCounter();
    applySessionUI(null);
    showToast('Disconnected from Jira');
  });

  // Search box & Clear button
  $('searchQueryInput').addEventListener('input', syncQueryCounter);
  $('searchQueryInput').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      executeSearch();
    }
  });
  $('clearQueryBtn').addEventListener('click', () => {
    $('searchQueryInput').value = '';
    syncQueryCounter();
    $('searchQueryInput').focus();
  });

  // Searchable Program/Project Combobox events
  $('programTriggerBtn').addEventListener('click', () => {
    const isOpen = !$('programDropdown').classList.contains('hidden');
    if (isOpen) closeProgramDropdown();
    else openProgramDropdown();
  });

  $('programSearchInput').addEventListener('input', e => {
    renderProgramOptions(e.target.value);
  });

  $('programOptionsList').addEventListener('click', e => {
    const btn = e.target.closest('[data-prog-val]');
    if (!btn) return;
    selectProgramValue(btn.dataset.progVal);
  });

  document.addEventListener('click', e => {
    if (!$('programCombobox').contains(e.target)) {
      closeProgramDropdown();
    }
  });

  $('issueTypeSelect').addEventListener('change', updateIssueTypeLabel);
  $('refreshMetadataBtn').addEventListener('click', () => loadMetadata(true));
  $('searchBtn').addEventListener('click', () => executeSearch());

  // Examples & Recent Searches
  $('quickExamplesList').addEventListener('click', e => {
    const chip = e.target.closest('[data-example]');
    if (!chip) return;
    $('searchQueryInput').value = chip.dataset.example || '';
    syncQueryCounter();
    $('searchQueryInput').focus();
  });

  $('recentSearchesList').addEventListener('click', e => {
    const chip = e.target.closest('[data-recent-query]');
    if (!chip) return;
    executeSearch(chip.dataset.recentQuery || '');
  });

  $('clearHistoryBtn').addEventListener('click', () => {
    try {
      localStorage.removeItem(STORAGE_HISTORY_KEY);
    } catch {
      // ignore
    }
    renderRecentSearches();
    showToast('Cleared recent searches');
  });

  // Verdict jump-to-ticket chips & Export actions
  $('verdictTopKeys').addEventListener('click', e => {
    const btn = e.target.closest('[data-jump-key]');
    if (!btn) return;
    const key = btn.dataset.jumpKey;
    selectResultByKey(key, true);
    const card = $('resultsList').querySelector(`[data-select-key="${CSS.escape(key)}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('copySummaryBtn').addEventListener('click', copyMarkdownSummary);
  $('exportCsvBtn').addEventListener('click', exportVisibleToCsv);

  // Results Toolbar Events
  $('resultTypeTabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-type-tab]');
    if (!btn) return;
    state.activeTypeTab = btn.dataset.typeTab;
    renderFilteredResults();
  });

  $('tierFilterGroup').addEventListener('click', e => {
    const btn = e.target.closest('[data-tier]');
    if (!btn) return;
    state.activeTier = btn.dataset.tier;
    $('tierFilterGroup').querySelectorAll('.tier-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    renderFilteredResults();
  });

  $('sortSelect').addEventListener('change', e => {
    state.sortBy = e.target.value;
    renderFilteredResults();
  });

  $('densityCardsBtn').addEventListener('click', () => {
    state.density = 'cards';
    $('densityCardsBtn').classList.add('active');
    $('densityCompactBtn').classList.remove('active');
    renderFilteredResults();
  });

  $('densityCompactBtn').addEventListener('click', () => {
    state.density = 'compact';
    $('densityCompactBtn').classList.add('active');
    $('densityCardsBtn').classList.remove('active');
    renderFilteredResults();
  });

  $('resultsFilterInput').addEventListener('input', e => {
    state.resultFilterText = e.target.value;
    renderFilteredResults();
  });

  // Delegated Master List & Inspector Actions
  function handleDelegatedTicketActions(e) {
    const copyBtn = e.target.closest('[data-copy-key]');
    if (copyBtn) {
      e.stopPropagation();
      const key = copyBtn.dataset.copyKey;
      copyToClipboard(key, `Copied ${key}`);
      return true;
    }

    const pivotBtn = e.target.closest('[data-pivot-key]');
    if (pivotBtn) {
      e.stopPropagation();
      const key = pivotBtn.dataset.pivotKey;
      closeMobileInspector();
      executeSearch(key);
      return true;
    }
    return false;
  }

  $('resultsList').addEventListener('click', e => {
    if (handleDelegatedTicketActions(e)) return;
    if (e.target.closest('[data-stop-select]')) return;
    const card = e.target.closest('[data-select-key]');
    if (!card) return;
    selectResultByKey(card.dataset.selectKey, true);
  });

  $('inspectorContent').addEventListener('click', e => {
    handleDelegatedTicketActions(e);
  });

  $('inspectorBackdrop').addEventListener('click', closeMobileInspector);

  // Modal & Global Keyboard Shortcuts
  function openGuide() { $('guideModal').classList.remove('hidden'); }
  function closeGuide() { $('guideModal').classList.add('hidden'); }

  $('openGuideBtn').addEventListener('click', openGuide);
  $('footerGuideBtn').addEventListener('click', openGuide);
  $('closeGuideBtn').addEventListener('click', closeGuide);
  $('confirmGuideBtn').addEventListener('click', closeGuide);
  $('guideModal').addEventListener('click', e => {
    if (e.target === $('guideModal')) closeGuide();
  });

  document.addEventListener('keydown', e => {
    const activeTag = document.activeElement?.tagName;
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag);

    if (e.key === 'Escape') {
      closeGuide();
      closeProgramDropdown();
      closeMobileInspector();
      return;
    }

    if (inInput) return;

    if (e.key === '/' && state.session?.connected) {
      e.preventDefault();
      $('searchQueryInput').focus();
      return;
    }

    if (e.key === '?') {
      e.preventDefault();
      openGuide();
      return;
    }

    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.visibleResults.length > 0) {
      e.preventDefault();
      const idx = state.visibleResults.findIndex(r => r.key === state.selectedKey);
      const nextIdx =
        e.key === 'ArrowDown'
          ? Math.min(state.visibleResults.length - 1, idx + 1)
          : Math.max(0, idx - 1);
      const target = state.visibleResults[nextIdx];
      if (target) {
        selectResultByKey(target.key, false);
        const card = $('resultsList').querySelector(`[data-select-key="${CSS.escape(target.key)}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  });

  // --- Bootstrap ---
  async function init() {
    setAuthMode('basic');
    renderRecentSearches();
    syncQueryCounter();

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
    } catch {
      showBoxError('authErrorBox', 'Could not reach the local IssueMatcher backend. Make sure `node server.js` is running.');
    }
  }

  init();
})();
