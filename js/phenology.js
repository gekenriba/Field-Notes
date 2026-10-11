// Growth stages and phenology diagrams.
// The record-level scale follows the principal stages of the BBCH scale, simplified for wild
// plants in the field. For diagrams the stages are grouped into six display groups whose colours
// were checked for colour-blind separation.

export const STAGES = [
  { key: 'emerging',   label: 'Emerging',        hint: 'Shoots or first leaves appearing', bbch: '0', group: 'veg' },
  { key: 'vegetative', label: 'Vegetative',      hint: 'Leaves only, no buds',              bbch: '1–3', group: 'veg' },
  { key: 'bud',        label: 'Flower buds',     hint: 'Buds visible, none open',           bbch: '5', group: 'bud' },
  { key: 'flowering',  label: 'Flowering',       hint: 'At least one flower open',          bbch: '6', group: 'flower' },
  { key: 'fruiting',   label: 'Fruiting',        hint: 'Fruits forming, not ripe',          bbch: '7', group: 'fruit' },
  { key: 'seed',       label: 'Ripe / seeding',  hint: 'Fruits ripe or seeds dispersing',   bbch: '8', group: 'seed' },
  { key: 'senescent',  label: 'Senescent',       hint: 'Leaves yellowing or dying back',    bbch: '9', group: 'rest' },
  { key: 'dormant',    label: 'Dormant',         hint: 'Above-ground parts dead or absent', bbch: '9+', group: 'rest' },
];
export const FLOWERING_DETAIL = [
  { key: 'early', label: 'Early (<10% open)' },
  { key: 'peak', label: 'Peak (most open)' },
  { key: 'late', label: 'Late (mostly faded)' },
];

export const GROUPS = [
  { key: 'veg',    label: 'Vegetative',         color: '#2F8A55' },
  { key: 'bud',    label: 'Buds',               color: '#8E63CE' },
  { key: 'flower', label: 'Flowering',          color: '#D23F7A' },
  { key: 'fruit',  label: 'Fruiting',           color: '#D9731A' },
  { key: 'seed',   label: 'Ripe / seeding',     color: '#7E6A10' },
  { key: 'rest',   label: 'Senescent / dormant', color: '#4F7FC0' },
];

const byKey = Object.fromEntries(STAGES.map((s) => [s.key, s]));
export const stageLabel = (k) => byKey[k]?.label || '';
export const stageGroup = (k) => GROUPS.find((g) => g.key === byKey[k]?.group);

// Records from version 2 stored several phenology chips; take the most advanced as the stage.
export function migrateStage(e) {
  if (e.stage || !Array.isArray(e.phenology) || !e.phenology.length) return false;
  const p = e.phenology;
  e.stage = p.includes('Seeding') ? 'seed' : p.includes('Fruiting') ? 'fruiting' : p.includes('Flowering') ? 'flowering'
    : p.includes('Budding') ? 'bud' : p.includes('Senescent') ? 'senescent' : p.includes('Vegetative') ? 'vegetative' : '';
  return !!e.stage;
}

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// counts[species][month][group] = n
export function phenoMatrix(entries) {
  const m = new Map();
  for (const e of entries) {
    if (e.status !== 'identified' || !e.scientificName || !e.stage || !e.date) continue;
    const g = byKey[e.stage]?.group; if (!g) continue;
    const mo = +e.date.slice(5, 7) - 1;
    if (!m.has(e.scientificName)) m.set(e.scientificName, Array.from({ length: 12 }, () => ({})));
    const cell = m.get(e.scientificName)[mo];
    cell[g] = (cell[g] || 0) + 1;
  }
  return m;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A phenogram: one row per species, one column per month. Each cell is split vertically by the
// share of records in each growth stage. Hover/tap shows the counts.
export function phenogramHTML(matrix, { names = [...matrix.keys()].sort(), link = true } = {}) {
  if (!names.length) return '';
  const rows = names.map((name) => {
    const months = matrix.get(name) || [];
    const cells = months.map((cell, i) => {
      const total = Object.values(cell).reduce((a, b) => a + b, 0);
      if (!total) return `<div class="pg-cell empty" aria-hidden="true"></div>`;
      const segs = GROUPS.filter((g) => cell[g.key]).map((g) =>
        `<span style="flex:${cell[g.key]};background:${g.color}"></span>`).join('');
      const tip = `${MONTH_NAMES[i]}: ${total} record${total > 1 ? 's' : ''} — ` +
        GROUPS.filter((g) => cell[g.key]).map((g) => `${g.label.toLowerCase()} ${cell[g.key]}`).join(', ');
      return `<button type="button" class="pg-cell" data-tip="${esc(tip)}" aria-label="${esc(name + ', ' + tip)}">${segs}</button>`;
    }).join('');
    const label = link ? `<a class="pg-name sci" href="#/taxon/${encodeURIComponent(name)}">${esc(name)}</a>` : `<span class="pg-name sci">${esc(name)}</span>`;
    return `<div class="pg-row">${label}<div class="pg-cells">${cells}</div></div>`;
  }).join('');
  return `<div class="phenogram">
    <div class="pg-row pg-head"><span class="pg-name"></span><div class="pg-cells">${MONTHS.map((m) => `<span>${m}</span>`).join('')}</div></div>
    ${rows}
  </div>${legendHTML()}<p class="pg-tip muted small" aria-live="polite">Tap a cell for the counts.</p>`;
}

export function legendHTML() {
  return `<div class="pg-legend">${GROUPS.map((g) => `<span><i style="background:${g.color}"></i>${g.label}</span>`).join('')}</div>`;
}

// Text table of the same data (accessible alternative to the colour diagram).
export function phenoTableHTML(matrix, names = [...matrix.keys()].sort()) {
  const head = `<tr><th>Species</th>${MONTH_NAMES.map((m) => `<th>${m.slice(0, 3)}</th>`).join('')}</tr>`;
  const body = names.map((n) => `<tr><td class="sci">${esc(n)}</td>${(matrix.get(n) || []).map((c) => {
    const parts = GROUPS.filter((g) => c[g.key]).map((g) => `${g.label.split(' ')[0]} ${c[g.key]}`);
    return `<td>${parts.join('<br>') || ''}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="pheno-table">${head}${body}</table></div>`;
}

export function wirePhenogram(root) {
  const tip = root.querySelector('.pg-tip');
  root.addEventListener('click', (e) => {
    const c = e.target.closest('.pg-cell[data-tip]');
    if (!c || !tip) return;
    root.querySelectorAll('.pg-cell.on').forEach((x) => x.classList.remove('on'));
    c.classList.add('on');
    tip.textContent = `${c.closest('.pg-row').querySelector('.pg-name').textContent} · ${c.dataset.tip}`;
  });
}
