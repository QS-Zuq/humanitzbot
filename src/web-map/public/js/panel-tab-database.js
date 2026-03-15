/**
 * Panel Tab: Database — table browser, query builder, raw SQL, and CSV export.
 * @namespace Panel.tabs.database
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const $ = Panel.core.$;
  const el = Panel.core.el;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const fmtDateTime = Panel.core.utils.fmtDateTime;
  const fmtNum = Panel.core.utils.fmtNum;
  const humanizeSettingKey = Panel.core.utils.humanizeSettingKey;
  const showToast = Panel.core.utils.showToast;

  let _inited = false;

  function init() {
    if (_inited) return;
    _inited = true;
  }

  // ── Data Loading ────────────────────────────────────────────────

  async function loadDatabase() {
    const container = $('#db-results');
    if (!container) return;
    const table = $('#db-table') ? $('#db-table').value : 'activity_log';
    const search = ($('#db-search') ? $('#db-search').value : '').trim();
    const limit = parseInt($('#db-limit') ? $('#db-limit').value : '50', 10);

    container.innerHTML =
      '<div class="feed-empty">' + i18next.t('web:loading.generic', { defaultValue: 'Loading...' }) + '</div>';

    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (search) params.set('search', search);
      const r = await apiFetch('/api/panel/db/' + table + '?' + params);
      if (!r.ok) {
        let err = {};
        try {
          err = await r.json();
        } catch (_e) {}
        container.innerHTML = '<div class="feed-empty">Error: ' + esc(err.error || r.statusText) + '</div>';
        return;
      }
      const d = await r.json();
      const rows = d.rows || [];
      const columns = d.columns || [];
      S.dbLastResult = { table: table, rows: rows, columns: columns };
      if (!rows.length) {
        container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.no_data_found') + '</div>';
        return;
      }
      renderDbTable(container, rows, columns);
    } catch (e) {
      container.innerHTML =
        '<div class="feed-empty">' +
        i18next.t('web:empty_states.failed_to_load_data', {
          message: esc(e.message),
          defaultValue: 'Failed to load data: {{message}}',
        }) +
        '</div>';
    }
  }

  // ── Table Rendering ─────────────────────────────────────────────

  function renderDbTable(container, rows, columns) {
    if (!rows || !rows.length) {
      container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.no_data') + '</div>';
      return;
    }
    const hasResolved = rows.some(function (r) {
      return r._resolved_name;
    });

    const steamToName = {};
    for (let pi = 0; pi < S.players.length; pi++) {
      if (S.players[pi].steamId) steamToName[S.players[pi].steamId] = S.players[pi].name;
    }

    const steamCols = {};
    for (let sc = 0; sc < columns.length; sc++) {
      const cn = columns[sc].toLowerCase();
      if (cn === 'steam_id' || cn === 'target_steam_id' || cn === 'steamid' || cn === 'owner_steam_id')
        steamCols[columns[sc]] = true;
    }

    const fkMap = {
      player_id: 'players',
      clan_id: 'clans',
      steam_id: 'activity_log',
      target_steam_id: 'activity_log',
      owner_steam_id: 'players',
    };

    const table = el('table', 'db-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (let ci = 0; ci < columns.length; ci++) {
      headRow.appendChild(el('th', '', humanizeSettingKey(columns[ci])));
    }
    if (hasResolved)
      headRow.appendChild(el('th', '', i18next.t('web:table.player_name', { defaultValue: 'Player Name' })));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const tr = el('tr');
      for (let ci2 = 0; ci2 < columns.length; ci2++) {
        const col = columns[ci2];
        const td = el('td');
        let val = row[col];
        if (val == null) val = '';
        else if (typeof val === 'object') val = JSON.stringify(val);
        if (
          (col === 'created_at' ||
            col === 'updated_at' ||
            col === 'first_seen' ||
            col === 'last_seen' ||
            col === 'timestamp') &&
          val
        ) {
          try {
            val = fmtDateTime(val) || val;
          } catch (_e) {}
        }

        if (steamCols[col] && val && String(val).length > 10) {
          const resolved = steamToName[String(val)] || '';
          td.innerHTML =
            '<span class="player-link text-accent cursor-pointer" data-steam-id="' +
            esc(String(val)) +
            '">' +
            esc(resolved || String(val)) +
            '</span>';
          if (resolved) td.title = String(val);
          else td.title = String(val);
        } else if (fkMap[col] && val && !steamCols[col]) {
          const linkEl = document.createElement('span');
          linkEl.className = 'db-link text-accent cursor-pointer hover:underline';
          linkEl.dataset.table = fkMap[col];
          linkEl.dataset.search = String(val);
          linkEl.textContent = String(val);
          td.appendChild(linkEl);
          td.title = i18next.t('web:database.click_to_lookup_in', {
            table: fkMap[col],
            defaultValue: 'Click to look up in {{table}}',
          });
        } else if (typeof val === 'number' && val > 9999) td.textContent = fmtNum(val);
        else td.textContent = String(val);

        if (!td.title) td.title = String(row[col] != null ? row[col] : '');
        tr.appendChild(td);
      }
      if (hasResolved) {
        const nameTd = el('td');
        nameTd.textContent = row._resolved_name || '';
        nameTd.className = 'text-accent';
        tr.appendChild(nameTd);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);
  }

  // ── CSV Export ───────────────────────────────────────────────────

  function exportDbCsv() {
    if (!S.dbLastResult || !S.dbLastResult.rows.length) return;
    const d = S.dbLastResult;
    const cols = d.columns;
    const rows = d.rows;

    const lines = [];
    lines.push(cols.map(csvEsc).join(','));
    for (let i = 0; i < rows.length; i++) {
      const cells = [];
      for (let j = 0; j < cols.length; j++) {
        let val = rows[i][cols[j]];
        if (val == null) val = '';
        else if (typeof val === 'object') val = JSON.stringify(val);
        cells.push(csvEsc(String(val)));
      }
      lines.push(cells.join(','));
    }

    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = d.table + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvEsc(str) {
    if (!str) return '';
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // ── Live Table List ─────────────────────────────────────────────

  async function fetchDbTableList() {
    try {
      const r = await apiFetch('/api/panel/db/tables');
      if (!r.ok) return;
      const d = await r.json();
      S.dbTablesLive = d.tables || [];
      const selects = [$('#db-table'), $('#qb-table')];
      for (let si = 0; si < selects.length; si++) {
        const sel = selects[si];
        if (!sel) continue;
        const prevVal = sel.value;
        sel.innerHTML = '';
        for (let i = 0; i < S.dbTablesLive.length; i++) {
          const t = S.dbTablesLive[i];
          const opt = document.createElement('option');
          opt.value = t.name;
          opt.textContent =
            t.name +
            ' (' +
            (t.rowCount || 0).toLocaleString() +
            ' ' +
            i18next.t('web:database.rows', { defaultValue: 'rows' }) +
            ')';
          sel.appendChild(opt);
        }
        if (prevVal) sel.value = prevVal;
      }
      for (let j = 0; j < S.dbTablesLive.length; j++) {
        S.dbSchemaCache[S.dbTablesLive[j].name] = S.dbTablesLive[j].columns || [];
      }
    } catch (_e) {
      /* ignore — will fall back to static list */
    }
  }

  // ── Schema Viewer ───────────────────────────────────────────────

  function showDbSchema() {
    const table = $('#db-table') ? $('#db-table').value : '';
    const container = $('#db-schema-info');
    if (!container) return;
    const cols = S.dbSchemaCache[table];
    if (!cols || !cols.length) {
      container.innerHTML =
        '<span class="text-muted text-xs">' + i18next.t('web:empty_states.no_schema_info_available') + '</span>';
      return;
    }
    let html = '<div class="overflow-x-auto"><table class="db-table text-xs"><thead><tr>';
    html +=
      '<th>' +
      i18next.t('web:table.column', { defaultValue: 'Column' }) +
      '</th><th>' +
      i18next.t('web:table.type', { defaultValue: 'Type' }) +
      '</th><th>' +
      i18next.t('web:table.pk', { defaultValue: 'PK' }) +
      '</th><th>' +
      i18next.t('web:table.nullable', { defaultValue: 'Nullable' }) +
      '</th>';
    html += '</tr></thead><tbody>';
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      html += '<tr>';
      html += '<td class="font-mono text-accent">' + esc(c.name) + '</td>';
      html += '<td>' + esc(c.type || 'TEXT') + '</td>';
      html += '<td>' + (c.pk ? '\u2713' : '') + '</td>';
      html +=
        '<td>' +
        (c.nullable
          ? i18next.t('web:table.yes', { defaultValue: 'yes' })
          : i18next.t('web:table.no', { defaultValue: 'no' })) +
        '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    container.innerHTML = html;
  }

  // ── Query Builder ───────────────────────────────────────────────

  function updateQbColumns() {
    const table = $('#qb-table') ? $('#qb-table').value : '';
    const cols = S.dbSchemaCache[table] || [];
    const whereCol = $('#qb-where-col');
    const orderCol = $('#qb-order-col');
    const selects = [whereCol, orderCol];
    for (let si = 0; si < selects.length; si++) {
      const sel = selects[si];
      if (!sel) continue;
      sel.innerHTML = '<option value="">--</option>';
      for (let i = 0; i < cols.length; i++) {
        const opt = document.createElement('option');
        opt.value = cols[i].name;
        opt.textContent = cols[i].name;
        sel.appendChild(opt);
      }
    }
  }

  function buildQbSql() {
    const table = $('#qb-table') ? $('#qb-table').value : '';
    const columns = ($('#qb-columns') ? $('#qb-columns').value : '').trim() || '*';
    const whereCol = $('#qb-where-col') ? $('#qb-where-col').value : '';
    const whereOp = $('#qb-where-op') ? $('#qb-where-op').value : '=';
    const whereVal = ($('#qb-where-val') ? $('#qb-where-val').value : '').trim();
    const orderCol = $('#qb-order-col') ? $('#qb-order-col').value : '';
    const orderDir = $('#qb-order-dir') ? $('#qb-order-dir').value : 'DESC';
    const limit = ($('#qb-limit') ? $('#qb-limit').value : '100').trim() || '100';

    if (!table) return '';
    let sql = 'SELECT ' + columns + ' FROM ' + table;
    if (whereCol && (whereVal || whereOp === 'IS NULL' || whereOp === 'IS NOT NULL')) {
      if (whereOp === 'IS NULL') sql += ' WHERE ' + whereCol + ' IS NULL';
      else if (whereOp === 'IS NOT NULL') sql += ' WHERE ' + whereCol + ' IS NOT NULL';
      else if (whereOp === 'LIKE') sql += ' WHERE ' + whereCol + " LIKE '%" + whereVal.replace(/'/g, "''") + "%'";
      else if (whereOp === 'IN') sql += ' WHERE ' + whereCol + ' IN (' + whereVal + ')';
      else sql += ' WHERE ' + whereCol + ' ' + whereOp + " '" + whereVal.replace(/'/g, "''") + "'";
    }
    if (orderCol) sql += ' ORDER BY ' + orderCol + ' ' + orderDir;
    sql += ' LIMIT ' + Math.max(1, Math.min(parseInt(limit, 10) || 100, 1000));
    return sql;
  }

  function updateQbPreview() {
    const preview = $('#qb-preview');
    if (preview) preview.textContent = buildQbSql();
  }

  async function runQueryBuilder() {
    const sql = buildQbSql();
    if (!sql) return showToast(i18next.t('web:toast.select_table_first'), 'error');
    await executeRawQuery(sql);
  }

  async function runRawSql() {
    const input = $('#db-raw-sql');
    const sql = (input ? input.value : '').trim();
    if (!sql) return showToast(i18next.t('web:toast.enter_sql_query'), 'error');
    await executeRawQuery(sql);
  }

  async function executeRawQuery(sql) {
    const container = $('#db-query-results');
    const status = $('#db-query-status');
    if (!container) return;
    container.innerHTML =
      '<div class="feed-empty">' + i18next.t('web:database.running', { defaultValue: 'Running...' }) + '</div>';
    if (status) status.textContent = '';

    try {
      const r = await apiFetch('/api/panel/db/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: sql, limit: 500 }),
      });
      const d = await r.json();
      if (d.error) {
        container.innerHTML = '<div class="feed-empty text-danger">' + esc(d.error) + '</div>';
        if (status) status.textContent = i18next.t('web:dashboard.error');
        return;
      }
      const rows = d.rows || [];
      const columns = d.columns || [];
      S.dbLastResult = { table: 'query', rows: rows, columns: columns };
      if (status)
        status.textContent = i18next.t('web:database.rows_returned', {
          count: rows.length,
          defaultValue: '{{count}} row returned',
          defaultValue_plural: '{{count}} rows returned',
        });
      if (!rows.length) {
        container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.no_results') + '</div>';
        return;
      }
      renderDbTable(container, rows, columns);
    } catch (e) {
      container.innerHTML = '<div class="feed-empty text-danger">Request failed: ' + esc(e.message) + '</div>';
      if (status) status.textContent = i18next.t('web:status.failed', { defaultValue: 'Failed' });
    }
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.database = {
    init: init,
    load: loadDatabase,
    reset: reset,
    exportCsv: exportDbCsv,
    showSchema: showDbSchema,
    fetchTableList: fetchDbTableList,
    updateQbColumns: updateQbColumns,
    updateQbPreview: updateQbPreview,
    runQueryBuilder: runQueryBuilder,
    runRawSql: runRawSql,
    buildQbSql: buildQbSql,
  };
})();
