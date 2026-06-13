(function () {
  let selectedPatch = '';

  function patchSelect() {
    return document.getElementById('championPatch');
  }

  function isSeason16Patch(value) {
    return /^16\.\d+$/.test(String(value || '').trim());
  }

  function patchOptions(data) {
    const rawOptions = Array.isArray(data?.patch_options) ? data.patch_options : [];
    const options = rawOptions
      .map(option => ({
        value: String(option?.value || '').trim(),
        label: String(option?.label || option?.value || '').trim(),
      }))
      .filter(option => option.value && option.label && isSeason16Patch(option.value));
    if (options.length) return options;
    const patch = String(data?.patch || '').trim();
    return isSeason16Patch(patch) ? [{ value: patch, label: patch }] : [];
  }

  function fillPatchSelect(data) {
    const select = patchSelect();
    if (!select) return;
    const options = patchOptions(data);
    const current = selectedPatch || select.value || '';
    select.innerHTML = options
      .map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join('');
    selectedPatch = options.some(option => option.value === current) ? current : (options[0]?.value || '');
    select.value = selectedPatch;
  }

  function summaryScope(data) {
    const summaries = data?.patch_summaries && typeof data.patch_summaries === 'object' ? data.patch_summaries : {};
    return summaries[selectedPatch] || data || {};
  }

  function patchText(scope) {
    if (scope?.patch === 'all') return 'All patches';
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
