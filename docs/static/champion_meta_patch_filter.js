(function () {
  let selectedPatch = '';

  function patchSelect() {
    return document.getElementById('championPatch');
  }

  function isSeason16Patch(value) {
    return /^16\.\d+$/.test(String(value || '').trim());
  }

  function numberValue(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function patchOptions(data) {
    const rawOptions = Array.isArray(data?.patch_options) ? data.patch_options : [];
    const options = rawOptions
      .map(option => ({
        value: String(option?.value || '').trim(),
        label: String(option?.label || option?.value || '').trim(),
      }))
      .filter(option => option.value && option.label && isSeason16Patch(option.value));
    if (options.length) return [{ value: 'all', label: 'ALL' }, ...options];
    const patch = String(data?.patch || '').trim();
    return isSeason16Patch(patch) ? [{ value: 'all', label: 'ALL' }, { value: patch, label: patch }] : [{ value: 'all', label: 'ALL' }];
  }

  function aggregateChampionRows(scopes, rowKey, totalGames) {
    const totals = new Map();
    for (const scope of scopes) {
      for (const row of scope?.[rowKey] || []) {
        const name = String(row?.name || '').trim();
        if (!name) continue;
        const current = totals.get(name) || { name, picks: 0, wins: 0, bans: 0 };
        current.picks += numberValue(row.picks ?? row.games);
        current.wins += numberValue(row.wins);
        current.bans += numberValue(row.bans);
        totals.set(name, current);
      }
    }
    return Array.from(totals.values())
      .map(row => {
        const winrate = row.picks > 0 ? `${((row.wins / row.picks) * 100).toFixed(1)}%` : '-';
        const presence = totalGames > 0 ? `${(((row.picks + row.bans) / totalGames) * 100).toFixed(1)}%` : '-';
        return { ...row, winrate, presence };
      })
      .sort((a, b) => (b.picks - a.picks) || (b.wins - a.wins) || a.name.localeCompare(b.name));
  }

  function season16Summary(data) {
    const summaries = data?.patch_summaries && typeof data.patch_summaries === 'object' ? data.patch_summaries : {};
    const scopes = Object.entries(summaries)
      .filter(([patch]) => isSeason16Patch(patch))
      .map(([, scope]) => scope)
      .filter(Boolean);
    if (!scopes.length) return null;
    const games = scopes.reduce((sum, scope) => sum + numberValue(scope.games), 0);
    const roleRows = {};
    for (const role of ['top', 'jng', 'mid', 'bot', 'sup']) {
      roleRows[role] = aggregateChampionRows(
        scopes.map(scope => ({ champions: (scope.champions_by_role || {})[role] || [] })),
        'champions',
        games
      );
    }
    const dateValues = scopes.flatMap(scope => [scope.data_from, scope.data_through]).filter(Boolean).sort();
    return {
      patch: 'all',
      games,
      leagues: Array.from(new Set(scopes.flatMap(scope => scope.leagues || []))).sort(),
      champions: aggregateChampionRows(scopes, 'champions', games),
      champions_by_role: roleRows,
      data_from: dateValues[0] || data?.data_from || '',
      data_through: dateValues[dateValues.length - 1] || data?.data_through || '',
    };
  }

  function fillPatchSelect(data) {
    const select = patchSelect();
    if (!select) return;
    const options = patchOptions(data);
    const fallback = isSeason16Patch(data?.patch) ? String(data.patch) : 'all';
    const current = selectedPatch || fallback;
    select.innerHTML = options
      .map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join('');
    selectedPatch = options.some(option => option.value === current) ? current : fallback;
    select.value = selectedPatch;
  }

  function summaryScope(data) {
    const summaries = data?.patch_summaries && typeof data.patch_summaries === 'object' ? data.patch_summaries : {};
    if (selectedPatch === 'all') return season16Summary(data) || data || {};
    return summaries[selectedPatch] || data || {};
  }

  function patchText(scope) {
    if (scope?.patch === 'all') return 'ALL';
    return patchLabel(scope?.patch);
  }

  renderChampionMeta = function (data) {
    fillPatchSelect(data);
    const scoped = summaryScope(data);
    const role = $('championRole')?.value || 'all';
    const rows = role === 'all' ? (scoped.champions || []) : ((scoped.champions_by_role || {})[role] || []);
    const label = roleLabel(role === 'all' ? 'All roles' : role);
    const summaryFreshness = summaryFreshnessLabel(data);
    const parts = [`${label}`, patchText(scoped), `${scoped.games ?? data.games} games`, summaryFreshness].filter(Boolean);
    if ($('championMetaSub')) $('championMetaSub').textContent = parts.join(' | ');
    renderChampionTable('champions', rows, scoped.patch && scoped.patch !== 'all' ? scoped.patch : data.patch);
  };

  function initPatchControls() {
    const select = patchSelect();
    if (!select) return;
    select.addEventListener('change', () => {
      selectedPatch = select.value || 'all';
      if (state.championSummary) renderChampionMeta(state.championSummary);
    });
    const group = $('championMetaGroup');
    if (group) {
      group.addEventListener('change', () => {
        selectedPatch = '';
      }, true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPatchControls);
  } else {
    initPatchControls();
  }
})();
