/**
 * Panel Tab: Anticheat — flag review, risk scores, and player risk management.
 * @namespace Panel.tabs.anticheat
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const $ = Panel.core.$;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const fmtDateTime = Panel.core.utils.fmtDateTime;

  let _inited = false;

  function init() {
    if (_inited) return;
    _inited = true;
    // Wire anticheat filter controls
    const sf = $('#ac-status-filter');
    const svf = $('#ac-severity-filter');
    const rb = $('#ac-refresh');
    if (sf)
      sf.addEventListener('change', function () {
        if (S.currentTab === 'anticheat') loadAnticheat();
      });
    if (svf)
      svf.addEventListener('change', function () {
        if (S.currentTab === 'anticheat') loadAnticheat();
      });
    if (rb)
      rb.addEventListener('click', function () {
        if (S.currentTab === 'anticheat') loadAnticheat();
      });
  }

  // ══════════════════════════════════════════════════
  //  ANTICHEAT
  // ══════════════════════════════════════════════════

  async function loadAnticheat() {
    const flagsContainer = $('#ac-flags-table');
    const riskContainer = $('#ac-risk-table');
    const cardsContainer = $('#ac-risk-cards');
    const countEl = $('#ac-flag-count');
    if (!flagsContainer) return;

    const statusFilter = $('#ac-status-filter') ? $('#ac-status-filter').value : 'open';
    const severityFilter = $('#ac-severity-filter') ? $('#ac-severity-filter').value : '';

    flagsContainer.innerHTML =
      '<div class="feed-empty">' +
      i18next.t('web:anticheat.loading_flags', { defaultValue: 'Loading flags...' }) +
      '</div>';
    riskContainer.innerHTML =
      '<div class="feed-empty">' +
      i18next.t('web:anticheat.loading_risk_scores', { defaultValue: 'Loading risk scores...' }) +
      '</div>';

    // Load flags + risk scores in parallel
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (severityFilter) params.set('severity', severityFilter);
      params.set('limit', '100');

      const [flagsRes, riskRes] = await Promise.all([
        apiFetch('/api/panel/anticheat/flags?' + params),
        apiFetch('/api/panel/anticheat/risk-scores'),
      ]);

      if (!flagsRes.ok || !riskRes.ok) {
        let errMsg = i18next.t('web:anticheat.failed_to_load_data', { defaultValue: 'Failed to load anticheat data' });
        if (flagsRes.status === 403 || riskRes.status === 403)
          errMsg += ' ' + i18next.t('web:anticheat.requires_admin', { defaultValue: '(requires admin)' });
        else errMsg += ' ' + i18next.t('web:anticheat.server_error', { defaultValue: '(server error)' });
        flagsContainer.innerHTML = '<div class="feed-empty">' + errMsg + '</div>';
        riskContainer.innerHTML = '';
        if (cardsContainer) cardsContainer.innerHTML = '';
        return;
      }

      const flags = await flagsRes.json();
      const riskScores = await riskRes.json();

      // Render overview cards
      renderAcCards(cardsContainer, flags, riskScores);

      // Render flags table
      if (countEl) countEl.textContent = flags.length + ' flag(s)';
      renderAcFlags(flagsContainer, flags);

      // Render risk scores
      renderAcRiskScores(riskContainer, riskScores);
    } catch (e) {
      flagsContainer.innerHTML = '<div class="feed-empty">Error: ' + esc(e.message) + '</div>';
      riskContainer.innerHTML = '';
    }
  }

  function renderAcCards(container, flags, riskScores) {
    if (!container) return;
    const open = flags.filter(function (f) {
      return f.status === 'open';
    }).length;
    const critical = flags.filter(function (f) {
      return f.severity === 'critical' || f.severity === 'high';
    }).length;
    const atRisk = riskScores.filter(function (r) {
      return r.risk_score > 0.5;
    }).length;
    const total = flags.length;

    const cards = [
      {
        label: i18next.t('web:anticheat.open_flags', { defaultValue: 'Open Flags' }),
        value: open,
        color: open > 0 ? 'text-amber-400' : 'text-green-400',
        icon: 'alert-triangle',
      },
      {
        label: i18next.t('web:anticheat.critical_high', { defaultValue: 'Critical/High' }),
        value: critical,
        color: critical > 0 ? 'text-red-400' : 'text-green-400',
        icon: 'alert-octagon',
      },
      {
        label: i18next.t('web:anticheat.at_risk_players', { defaultValue: 'At Risk Players' }),
        value: atRisk,
        color: atRisk > 0 ? 'text-orange-400' : 'text-green-400',
        icon: 'user-x',
      },
      {
        label: i18next.t('web:anticheat.total_flags', { defaultValue: 'Total Flags' }),
        value: total,
        color: 'text-muted',
        icon: 'flag',
      },
    ];

    container.innerHTML = cards
      .map(function (c) {
        return (
          '<div class="card p-3 flex items-center gap-3">' +
          '<i data-lucide="' +
          c.icon +
          '" class="w-6 h-6 ' +
          c.color +
          '"></i>' +
          '<div><div class="text-xl font-bold ' +
          c.color +
          '">' +
          c.value +
          '</div>' +
          '<div class="text-xs text-muted">' +
          c.label +
          '</div></div></div>'
        );
      })
      .join('');
    if (typeof lucide !== 'undefined') lucide.createIcons({ attrs: { class: '' } });
  }

  const AC_SEVERITY_COLORS = {
    critical: 'bg-red-500/20 text-red-400',
    high: 'bg-orange-500/20 text-orange-400',
    medium: 'bg-amber-500/20 text-amber-400',
    low: 'bg-blue-500/20 text-blue-400',
    info: 'bg-gray-500/20 text-gray-400',
  };
  const AC_STATUS_COLORS = {
    open: 'bg-amber-500/20 text-amber-400',
    confirmed: 'bg-red-500/20 text-red-400',
    dismissed: 'bg-gray-500/20 text-gray-400',
    whitelisted: 'bg-green-500/20 text-green-400',
  };

  function renderAcFlags(container, flags) {
    if (!flags.length) {
      container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.no_flags_found') + '</div>';
      return;
    }

    let html =
      '<table class="db-table"><thead><tr>' +
      '<th>' +
      i18next.t('web:table.severity', { defaultValue: 'Severity' }) +
      '</th><th>' +
      i18next.t('web:table.detector', { defaultValue: 'Detector' }) +
      '</th><th>' +
      i18next.t('web:table.player', { defaultValue: 'Player' }) +
      '</th><th>' +
      i18next.t('web:table.score', { defaultValue: 'Score' }) +
      '</th><th>' +
      i18next.t('web:table.status', { defaultValue: 'Status' }) +
      '</th><th>' +
      i18next.t('web:table.created', { defaultValue: 'Created' }) +
      '</th><th>' +
      i18next.t('web:table.actions', { defaultValue: 'Actions' }) +
      '</th>' +
      '</tr></thead><tbody>';

    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      const sevClass = AC_SEVERITY_COLORS[f.severity] || '';
      const statClass = AC_STATUS_COLORS[f.status] || '';
      let details;
      try {
        details = typeof f.details === 'string' ? f.details : JSON.stringify(f.details || {});
      } catch (_e) {
        details = '';
      }
      const detailsTrunc = details.length > 80 ? details.slice(0, 80) + '...' : details;

      html +=
        '<tr>' +
        '<td><span class="px-1.5 py-0.5 rounded text-xs font-medium ' +
        sevClass +
        '">' +
        esc(f.severity) +
        '</span></td>' +
        '<td class="text-xs font-mono">' +
        esc(f.detector) +
        '</td>' +
        '<td>' +
        esc(f.player_name || f.steam_id || '-') +
        '</td>' +
        '<td class="font-mono text-xs">' +
        (f.score != null ? f.score.toFixed(3) : '-') +
        '</td>' +
        '<td><span class="px-1.5 py-0.5 rounded text-xs font-medium ' +
        statClass +
        '">' +
        esc(f.status) +
        '</span></td>' +
        '<td class="text-xs text-muted" title="' +
        esc(details) +
        '">' +
        (f.created_at ? fmtDateTime(f.created_at) : '-') +
        '</td>' +
        '<td class="flex gap-1">';

      if (f.status === 'open') {
        html +=
          '<button class="ac-review-btn btn-secondary text-xs px-1.5 py-0.5" data-id="' +
          f.id +
          '" data-action="confirmed" title="Confirm flag">✓</button>';
        html +=
          '<button class="ac-review-btn btn-secondary text-xs px-1.5 py-0.5" data-id="' +
          f.id +
          '" data-action="dismissed" title="Dismiss flag">✗</button>';
        html +=
          '<button class="ac-review-btn btn-secondary text-xs px-1.5 py-0.5" data-id="' +
          f.id +
          '" data-action="whitelisted" title="Whitelist">☆</button>';
      } else {
        html += '<span class="text-xs text-muted">' + esc(f.reviewed_by ? 'by ' + f.reviewed_by : '-') + '</span>';
      }
      html += '</td></tr>';

      // Expandable details row
      if (detailsTrunc) {
        html +=
          '<tr class="bg-surface-50/30"><td colspan="7" class="text-xs text-muted font-mono p-1 pl-4">' +
          esc(detailsTrunc) +
          '</td></tr>';
      }
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    // Wire review buttons
    container.querySelectorAll('.ac-review-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const flagId = btn.dataset.id;
        const action = btn.dataset.action;
        let notes = '';
        if (action === 'dismissed') {
          notes = prompt(i18next.t('web:anticheat.dismissal_reason')) || '';
        }
        reviewAcFlag(flagId, action, notes);
      });
    });
  }

  function renderAcRiskScores(container, scores) {
    if (!scores.length) {
      container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.no_player_risk_data') + '</div>';
      return;
    }

    let html =
      '<table class="db-table"><thead><tr>' +
      '<th>' +
      i18next.t('web:table.player', { defaultValue: 'Player' }) +
      '</th><th>' +
      i18next.t('web:anticheat.risk_score', { defaultValue: 'Risk Score' }) +
      '</th><th>' +
      i18next.t('web:table.open', { defaultValue: 'Open' }) +
      '</th><th>' +
      i18next.t('web:table.confirmed', { defaultValue: 'Confirmed' }) +
      '</th><th>' +
      i18next.t('web:table.dismissed', { defaultValue: 'Dismissed' }) +
      '</th><th>' +
      i18next.t('web:table.last_flag', { defaultValue: 'Last Flag' }) +
      '</th>' +
      '</tr></thead><tbody>';

    for (let i = 0; i < scores.length; i++) {
      const s = scores[i];
      const riskPct = Math.round((s.risk_score || 0) * 100);
      const riskColor = riskPct >= 70 ? 'text-red-400' : riskPct >= 40 ? 'text-amber-400' : 'text-green-400';
      const barColor = riskPct >= 70 ? 'bg-red-400' : riskPct >= 40 ? 'bg-amber-400' : 'bg-green-400';
      let riskPlayerName = '';
      if (s.steam_id) {
        const rp = S.players.find(function (p) {
          return p.steamId === s.steam_id;
        });
        if (rp) riskPlayerName = rp.name;
      }

      html +=
        '<tr>' +
        '<td class="font-medium"><span class="player-link cursor-pointer hover:underline" data-steam-id="' +
        esc(s.steam_id) +
        '">' +
        esc(riskPlayerName || s.steam_id) +
        '</span></td>' +
        '<td><div class="flex items-center gap-2"><div class="w-16 h-1.5 bg-surface-100 rounded-full overflow-hidden"><div class="h-full ' +
        barColor +
        ' rounded-full" style="width:' +
        riskPct +
        '%"></div></div><span class="font-mono text-xs ' +
        riskColor +
        '">' +
        riskPct +
        '%</span></div></td>' +
        '<td class="font-mono text-xs">' +
        (s.open_flags || 0) +
        '</td>' +
        '<td class="font-mono text-xs">' +
        (s.confirmed_flags || 0) +
        '</td>' +
        '<td class="font-mono text-xs">' +
        (s.dismissed_flags || 0) +
        '</td>' +
        '<td class="text-xs text-muted">' +
        (s.last_flag_at ? fmtDateTime(s.last_flag_at) : '-') +
        '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  async function reviewAcFlag(flagId, status, notes) {
    try {
      const r = await apiFetch('/api/panel/anticheat/flags/' + flagId + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status, notes: notes || '' }),
      });
      if (!r.ok) {
        let err = {};
        try {
          err = await r.json();
        } catch (_e) {}
        alert(i18next.t('web:toast.review_failed', { error: err.error || r.statusText }));
        return;
      }
      // Reload
      loadAnticheat();
    } catch (e) {
      alert(i18next.t('web:toast.review_failed', { error: e.message }));
    }
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.anticheat = { init: init, load: loadAnticheat, reset: reset };
})();
