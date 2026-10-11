// Minimal SVG icons for plant families, generated from each family's key diagnostic traits:
// flower symmetry and merosity, petal shape, fusion, inflorescence type and typical flower colour.
// Families not in the table get a neutral leaf with their initial, so no traits are implied.

const INK = '#1E3A33';

// Trait table. type = drawing recipe; n = parts; colour = typical flower colour in the Himalaya.
export const FAMILY_TRAITS = {
  Asteraceae:      { type: 'capitulum', color: '#E4B22C', note: 'Flower heads (capitula): ray and disc florets' },
  Rosaceae:        { type: 'radial', n: 5, petal: 'round', stamens: true, color: '#F2B6C6', note: '5 free petals, many stamens' },
  Ranunculaceae:   { type: 'radial', n: 5, petal: 'round', stamens: true, color: '#E8C13A', note: 'Free parts, many stamens and carpels' },
  Primulaceae:     { type: 'salver', n: 5, petal: 'notched', color: '#D9599A', note: '5 fused petals, often notched lobes' },
  Gentianaceae:    { type: 'trumpet', n: 5, color: '#3E64C8', note: 'Tubular to bell flowers, 4–5 lobes' },
  Orchidaceae:     { type: 'orchid', color: '#9B5BC4', note: 'Zygomorphic: 3 sepals, 2 petals and a lip' },
  Fabaceae:        { type: 'pea', color: '#E0A82E', note: 'Papilionaceous: banner, wings, keel' },
  Lamiaceae:       { type: 'bilabiate', color: '#8E63CE', note: 'Two-lipped corolla, square stems' },
  Apiaceae:        { type: 'umbel', compound: true, color: '#E6DDB4', note: 'Compound umbels of small flowers' },
  Ericaceae:       { type: 'funnel', n: 5, color: '#C9367A', note: 'Funnel or urn-shaped fused corolla' },
  Poaceae:         { type: 'grass', color: '#A7B36A', note: 'Spikelets, hollow jointed stems' },
  Cyperaceae:      { type: 'sedge', color: '#8F9C5A', note: 'Spikelets, triangular solid stems' },
  Juncaceae:       { type: 'sedge', color: '#9C8F5A', note: 'Small 6-parted flowers, round stems' },
  Liliaceae:       { type: 'radial', n: 6, petal: 'pointed', stamens: true, color: '#E6A13A', note: '6 tepals, 6 stamens' },
  Melanthiaceae:   { type: 'whorl', color: '#9BB54A', note: 'Whorled leaves, solitary 4–7-merous flower' },
  Amaryllidaceae:  { type: 'umbel', compound: false, color: '#C7A6E0', note: 'Simple umbel of 6-tepaled flowers' },
  Asparagaceae:    { type: 'raceme', color: '#B9A6D9', note: 'Racemes of 6-tepaled flowers' },
  Iridaceae:       { type: 'radial', n: 6, petal: 'pointed', color: '#6F72D6', note: '3+3 tepals, 3 stamens' },
  Papaveraceae:    { type: 'radial', n: 4, petal: 'crumpled', stamens: true, color: '#7AA7E8', note: '4–8 crumpled petals, many stamens' },
  Brassicaceae:    { type: 'cross', color: '#F0E06B', note: 'Cruciform: 4 petals in a cross' },
  Polygonaceae:    { type: 'spike', color: '#E796B2', note: 'Dense spikes of small flowers, sheathing stipules' },
  Saxifragaceae:   { type: 'radial', n: 5, petal: 'round', dots: true, color: '#F4D35E', note: '5 free petals, often spotted' },
  Caryophyllaceae: { type: 'radial', n: 5, petal: 'notched', color: '#F1D5E0', note: '5 notched petals, swollen nodes' },
  Campanulaceae:   { type: 'bell', n: 5, color: '#6E8BE0', note: 'Bell-shaped fused corolla' },
  Boraginaceae:    { type: 'salver', n: 5, petal: 'round', color: '#5B8FE0', note: 'Coiled cymes, 5 fused petals' },
  Plantaginaceae:  { type: 'bilabiate', color: '#A387D9', note: 'Mostly two-lipped flowers in spikes' },
  Scrophulariaceae:{ type: 'bilabiate', color: '#C9A13A', note: 'Two-lipped corolla' },
  Orobanchaceae:   { type: 'beak', color: '#D86AA3', note: 'Two-lipped, often beaked (Pedicularis)' },
  Caprifoliaceae:  { type: 'cyme', color: '#F0C9D6', note: 'Small fused flowers in dense cymes' },
  Valerianaceae:   { type: 'cyme', color: '#F0C9D6', note: 'Small fused flowers in dense cymes' },
  Crassulaceae:    { type: 'rosette', color: '#E7B53A', note: 'Succulent leaves, star-shaped flowers' },
  Geraniaceae:     { type: 'radial', n: 5, petal: 'round', veins: true, color: '#B27BD6', note: '5 veined petals, beaked fruit' },
  Balsaminaceae:   { type: 'spur', color: '#E4659A', note: 'Spurred zygomorphic flowers' },
  Berberidaceae:   { type: 'radial', n: 6, petal: 'round', color: '#F2D24B', note: 'Parts in 3s or 6s' },
  Araceae:         { type: 'spathe', color: '#7FA05A', note: 'Spadix enclosed by a spathe' },
  Urticaceae:      { type: 'spike', color: '#A9B98A', note: 'Tiny wind-pollinated flowers, stinging hairs' },
  Violaceae:       { type: 'spur', color: '#7C69D9', note: 'Zygomorphic, spurred lower petal' },
  Onagraceae:      { type: 'radial', n: 4, petal: 'round', color: '#E2709F', note: '4 petals, inferior ovary' },
  Euphorbiaceae:   { type: 'cyathium', color: '#C8C35A', note: 'Cyathia with glands, milky latex' },
  Pinaceae:        { type: 'cone', color: '#8A6A3E', note: 'Woody cones, needle leaves' },
  Cupressaceae:    { type: 'cone', color: '#7B7A48', note: 'Small cones, scale leaves' },
  Taxaceae:        { type: 'aril', color: '#D6452F', note: 'Seed in a fleshy aril' },
  Betulaceae:      { type: 'catkin', color: '#B79A5A', note: 'Catkins' },
  Salicaceae:      { type: 'catkin', color: '#C8B865', note: 'Catkins' },
  Fagaceae:        { type: 'catkin', color: '#9C7E4A', note: 'Catkins, nuts in cupules' },
  Dryopteridaceae: { type: 'frond', color: '#4E9A62', note: 'Fern: pinnate fronds, sori beneath' },
  Polypodiaceae:   { type: 'frond', color: '#4E9A62', note: 'Fern: fronds with round sori' },
  Pteridaceae:     { type: 'frond', color: '#4E9A62', note: 'Fern: marginal sori' },
  Aspleniaceae:    { type: 'frond', color: '#4E9A62', note: 'Fern: linear sori' },
  Athyriaceae:     { type: 'frond', color: '#4E9A62', note: 'Fern: lacy fronds' },
  Woodsiaceae:     { type: 'frond', color: '#4E9A62', note: 'Fern' },
  Lycopodiaceae:   { type: 'clubmoss', color: '#5F8F45', note: 'Clubmoss: small leaves, strobili' },
  Selaginellaceae: { type: 'clubmoss', color: '#5F8F45', note: 'Spikemoss' },
  Bryaceae:        { type: 'moss', color: '#6E9A3A', note: 'Moss' },
  Polytrichaceae:  { type: 'moss', color: '#6E9A3A', note: 'Moss' },
  Sphagnaceae:     { type: 'moss', color: '#8DA94A', note: 'Peat moss' },
  Parmeliaceae:    { type: 'lichen', color: '#A8B89A', note: 'Foliose lichen' },
  Agaricaceae:     { type: 'mushroom', color: '#C9A27A', note: 'Gilled mushrooms' },
  Russulaceae:     { type: 'mushroom', color: '#D06A55', note: 'Brittle gilled mushrooms' },
  Boletaceae:      { type: 'mushroom', color: '#9A6A3A', note: 'Pored mushrooms' },
  Ophiocordycipitaceae: { type: 'club', color: '#B07A3A', note: 'Club-shaped stromata (Ophiocordyceps)' },
};
const SYNONYMS = { Compositae: 'Asteraceae', Leguminosae: 'Fabaceae', Labiatae: 'Lamiaceae', Umbelliferae: 'Apiaceae', Cruciferae: 'Brassicaceae',
  Gramineae: 'Poaceae', Guttiferae: 'Clusiaceae', Palmae: 'Arecaceae', Trilliaceae: 'Melanthiaceae', Dipsacaceae: 'Caprifoliaceae' };

export function familyTraits(family) {
  const f = SYNONYMS[family] || family;
  return FAMILY_TRAITS[f] || null;
}

// ---------- drawing primitives (48×48 viewBox, centre 24,24) ----------
const r2 = (v) => Math.round(v * 100) / 100;
const pt = (cx, cy, a, d) => [r2(cx + Math.cos(a) * d), r2(cy + Math.sin(a) * d)];

function petal(cx, cy, a, len, w, shape = 'round') {
  const tip = pt(cx, cy, a, len);
  const l = pt(cx, cy, a - 0.5 * w / len * 2, len * 0.55);
  const r = pt(cx, cy, a + 0.5 * w / len * 2, len * 0.55);
  if (shape === 'pointed') return `M${cx},${cy} Q${l} ${tip} Q${r} ${cx},${cy}Z`;
  if (shape === 'notched') {
    const t1 = pt(cx, cy, a - 0.16, len), t2 = pt(cx, cy, a + 0.16, len), mid = pt(cx, cy, a, len * 0.82);
    const lo = pt(cx, cy, a - 0.55, len * 0.75), ro = pt(cx, cy, a + 0.55, len * 0.75);
    return `M${cx},${cy} Q${lo} ${t1} L${mid} L${t2} Q${ro} ${cx},${cy}Z`;
  }
  if (shape === 'crumpled') {
    const lo = pt(cx, cy, a - 0.75, len * 0.95), ro = pt(cx, cy, a + 0.75, len * 0.95), t1 = pt(cx, cy, a - 0.25, len * 1.02), t2 = pt(cx, cy, a + 0.25, len);
    return `M${cx},${cy} C${lo} ${t1} ${tip} C${t2} ${ro} ${cx},${cy}Z`;
  }
  const lo = pt(cx, cy, a - 0.7, len * 0.9), ro = pt(cx, cy, a + 0.7, len * 0.9);
  return `M${cx},${cy} C${lo} ${pt(cx, cy, a - 0.25, len * 1.05)} ${tip} C${pt(cx, cy, a + 0.25, len * 1.05)} ${ro} ${cx},${cy}Z`;
}

const S = (d, fill, extra = '') => `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round" ${extra}/>`;
const line = (x1, y1, x2, y2, w = 1.3) => `<path d="M${x1},${y1} L${x2},${y2}" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`;
const dot = (x, y, r, fill = INK) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;

function radial(t, cx = 24, cy = 24, len = 15) {
  const n = t.n || 5; let g = '';
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / n;
    g += S(petal(cx, cy, a, len, t.petal === 'pointed' ? 9 : 13, t.petal), t.color);
    if (t.veins) g += line(...pt(cx, cy, a, 4), ...pt(cx, cy, a, len - 3), 0.8);
    if (t.dots) g += dot(...pt(cx, cy, a, len * 0.55), 1.1, '#C0392B');
  }
  if (t.stamens) for (let i = 0; i < 10; i++) g += dot(...pt(cx, cy, i * 0.628, 4.2), 0.9);
  return g + `<circle cx="${cx}" cy="${cy}" r="${t.stamens ? 2.6 : 3}" fill="#F7E7A1" stroke="${INK}" stroke-width="1.1"/>`;
}

const RECIPES = {
  radial: (t) => radial(t),
  salver: (t) => radial({ ...t, petal: t.petal || 'round' }, 24, 24, 14) + `<circle cx="24" cy="24" r="2" fill="${INK}"/>`,
  cross: (t) => { let g = ''; for (let i = 0; i < 4; i++) g += S(petal(24, 24, i * Math.PI / 2 + Math.PI / 4, 15, 11), t.color); return g + dot(24, 24, 2.2, '#9AA75A'); },
  capitulum: (t) => {
    let g = ''; for (let i = 0; i < 14; i++) g += S(petal(24, 24, i * 2 * Math.PI / 14, 17, 5, 'pointed'), t.color);
    g += `<circle cx="24" cy="24" r="7" fill="#C98A1E" stroke="${INK}" stroke-width="1.2"/>`;
    for (let i = 0; i < 9; i++) g += dot(...pt(24, 24, i * 0.7, 2 + (i % 3) * 1.6), 0.8, '#5A3A0E');
    return g;
  },
  umbel: (t) => {
    let g = line(24, 44, 24, 30); const n = t.compound ? 6 : 7;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI + 0.25 + i * (Math.PI - 0.5) / (n - 1); const [x, y] = pt(24, 30, a, 15);
      g += line(24, 30, x, y, 1.1);
      if (t.compound) { for (let k = -1; k <= 1; k++) { const [x2, y2] = pt(x, y, a + k * 0.5, 4); g += line(x, y, x2, y2, 0.9) + `<circle cx="${x2}" cy="${y2}" r="1.7" fill="${t.color}" stroke="${INK}" stroke-width="0.8"/>`; } }
      else g += `<circle cx="${x}" cy="${y}" r="2.9" fill="${t.color}" stroke="${INK}" stroke-width="1"/>`;
    }
    return g;
  },
  pea: (t) => S('M24,8 C34,8 38,16 33,22 C30,25 26,24 24,22 C22,24 18,25 15,22 C10,16 14,8 24,8Z', t.color)
    + S('M24,22 C30,22 36,26 34,32 C32,36 27,33 24,28Z', t.color) + S('M24,22 C18,22 12,26 14,32 C16,36 21,33 24,28Z', t.color)
    + S('M24,26 C28,30 29,38 24,41 C19,38 20,30 24,26Z', '#F6E7B8') + line(24, 41, 24, 45),
  bilabiate: (t) => S('M8,30 C14,29 18,27 22,24 C22,16 28,9 36,10 C38,14 36,19 32,22 C36,23 41,25 42,29 C38,32 33,31 30,29 C30,33 27,36 23,35 C20,33 21,30 22,29 C17,32 12,33 8,32Z', t.color)
    + `<path d="M24,25 C27,24 30,25 32,22" stroke="${INK}" stroke-width="0.9" fill="none"/>` + dot(27, 28, 0.9) + dot(30, 27, 0.9) + line(8, 31, 4, 33),
  orchid: (t) => S(petal(24, 22, -Math.PI / 2, 14, 7, 'pointed'), t.color) + S(petal(24, 22, -Math.PI / 2 - 1.9, 13, 7, 'pointed'), t.color)
    + S(petal(24, 22, -Math.PI / 2 + 1.9, 13, 7, 'pointed'), t.color) + S(petal(24, 22, -Math.PI / 2 - 0.85, 10, 8), t.color)
    + S(petal(24, 22, -Math.PI / 2 + 0.85, 10, 8), t.color)
    + S('M24,24 C32,26 34,36 28,40 C26,42 22,42 20,40 C14,36 16,26 24,24Z', t.color) + dot(22, 33, 1, '#5A1E6A') + dot(26, 31, 1, '#5A1E6A') + dot(24, 36, 1, '#5A1E6A'),
  trumpet: (t) => S('M19,42 L18,28 C14,24 12,16 14,10 C18,13 21,12 24,8 C27,12 30,13 34,10 C36,16 34,24 30,28 L29,42Z', t.color)
    + line(24, 8, 24, 30, 0.8) + line(19, 14, 21, 30, 0.8) + line(29, 14, 27, 30, 0.8),
  bell: (t) => S('M16,14 C16,10 32,10 32,14 L34,32 C34,36 37,38 38,40 L10,40 C11,38 14,36 14,32Z', t.color) + line(24, 6, 24, 12) + line(24, 40, 24, 44, 1),
  funnel: (t) => S('M22,42 L21,30 C14,28 8,20 10,12 C14,14 18,13 20,10 C22,12 26,12 28,10 C30,13 34,14 38,12 C40,20 34,28 27,30 L26,42Z', t.color)
    + line(24, 30, 18, 18, 0.9) + line(24, 30, 30, 18, 0.9) + dot(18, 18, 1.1) + dot(30, 18, 1.1) + dot(24, 16, 1.1),
  beak: (t) => S('M10,34 C10,24 18,16 28,16 C34,16 38,12 42,8 C40,16 38,22 32,26 C30,32 22,38 16,38 C12,38 10,36 10,34Z', t.color) + S('M14,34 C20,40 30,40 34,32 C30,30 22,32 18,32Z', t.color),
  grass: (t) => { let g = line(24, 44, 24, 8, 1.4); for (let i = 0; i < 5; i++) { const y = 12 + i * 6; g += S(`M24,${y} C${29 - i * 0.5},${y - 2} ${31 - i * 0.5},${y + 3} 24,${y + 5}Z`, t.color) + S(`M24,${y + 3} C${19 + i * 0.5},${y + 1} ${17 + i * 0.5},${y + 6} 24,${y + 8}Z`, t.color); } return g; },
  sedge: (t) => line(24, 44, 24, 16, 1.4) + S('M24,8 C29,10 29,18 24,20 C19,18 19,10 24,8Z', t.color) + S('M24,16 C33,14 36,20 30,24 C27,24 25,20 24,16Z', t.color) + S('M24,16 C15,14 12,20 18,24 C21,24 23,20 24,16Z', t.color) + line(24, 20, 36, 28, 1) + line(24, 20, 12, 28, 1),
  spike: (t) => { let g = line(24, 44, 24, 10, 1.3); for (let i = 0; i < 7; i++) { const y = 10 + i * 4; const w = 3 + Math.sin((i / 6) * Math.PI) * 3; g += `<ellipse cx="${24 - w / 2}" cy="${y}" rx="2.4" ry="2" fill="${t.color}" stroke="${INK}" stroke-width="0.9"/><ellipse cx="${24 + w / 2}" cy="${y + 2}" rx="2.4" ry="2" fill="${t.color}" stroke="${INK}" stroke-width="0.9"/>`; } return g; },
  raceme: (t) => { let g = line(24, 44, 24, 6, 1.3); for (let i = 0; i < 5; i++) { const y = 10 + i * 6.5; const s = i % 2 ? 1 : -1; const x = 24 + s * 8; g += line(24, y, x, y + 2, 1) + `<path d="M${x - 3},${y} C${x - 3},${y + 5} ${x + 3},${y + 5} ${x + 3},${y} C${x + 2},${y + 1.5} ${x + 1},${y - 1} ${x},${y + 0.5} C${x - 1},${y - 1} ${x - 2},${y + 1.5} ${x - 3},${y}Z" fill="${t.color}" stroke="${INK}" stroke-width="1"/>`; } return g; },
  whorl: (t) => { let g = line(24, 44, 24, 26, 1.4); for (let i = 0; i < 6; i++) g += S(petal(24, 26, -Math.PI / 2 + i * Math.PI / 3 + Math.PI / 6, 16, 8, 'pointed'), '#6FA25A'); for (let i = 0; i < 5; i++) g += line(24, 22, ...pt(24, 22, -Math.PI / 2 + i * 1.256, 8), 1); return g + `<circle cx="24" cy="22" r="3" fill="${t.color}" stroke="${INK}" stroke-width="1.1"/>`; },
  cyme: (t) => { let g = line(24, 44, 24, 26, 1.3) + line(24, 26, 15, 18, 1) + line(24, 26, 33, 18, 1) + line(24, 26, 24, 16, 1); for (const [x, y] of [[15, 16], [24, 13], [33, 16], [19, 10], [29, 10], [12, 12], [36, 12]]) g += `<circle cx="${x}" cy="${y}" r="3" fill="${t.color}" stroke="${INK}" stroke-width="0.9"/>`; return g; },
  rosette: (t) => { let g = ''; for (let i = 0; i < 8; i++) g += S(petal(24, 30, i * Math.PI / 4, 13, 9, 'round'), '#8DBF7A'); for (let i = 0; i < 5; i++) g += S(petal(24, 12, -Math.PI / 2 + i * 1.256, 7, 4, 'pointed'), t.color); return g + line(24, 18, 24, 26); },
  spur: (t) => S('M12,22 C12,14 20,10 26,12 C34,14 36,22 32,26 C28,30 20,32 16,30 C13,28 12,25 12,22Z', t.color) + S('M32,24 C38,26 42,30 44,36 C40,34 36,32 31,28Z', t.color) + S('M16,28 C14,34 18,40 24,38 C26,34 22,30 20,29Z', t.color) + line(24, 6, 24, 12),
  spathe: (t) => S('M24,6 C34,10 36,24 30,36 L24,44 L18,36 C12,24 14,10 24,6Z', t.color) + S('M24,14 C27,16 27,30 24,34 C21,30 21,16 24,14Z', '#4A3A2A'),
  cyathium: (t) => { let g = ''; for (let i = 0; i < 4; i++) g += `<ellipse cx="${pt(24, 24, i * Math.PI / 2, 7)[0]}" cy="${pt(24, 24, i * Math.PI / 2, 7)[1]}" rx="4" ry="3" fill="${t.color}" stroke="${INK}" stroke-width="1"/>`; return S(petal(24, 24, -Math.PI / 2, 18, 18), '#B9D08A') + g + dot(24, 24, 2.4); },
  cone: (t) => { let g = S('M24,6 C34,12 34,34 24,42 C14,34 14,12 24,6Z', t.color); for (let i = 0; i < 6; i++) { const y = 12 + i * 5; g += `<path d="M${17 + i * 0.2},${y} Q24,${y + 4} ${31 - i * 0.2},${y}" stroke="${INK}" stroke-width="1" fill="none"/>`; } return g; },
  aril: (t) => S(petal(24, 30, -Math.PI / 2 - 0.6, 18, 4, 'pointed'), '#3F6B45') + S(petal(24, 30, -Math.PI / 2 + 0.6, 18, 4, 'pointed'), '#3F6B45') + `<circle cx="24" cy="32" r="7" fill="${t.color}" stroke="${INK}" stroke-width="1.2"/>` + dot(24, 32, 2.6, '#2E2A1E'),
  catkin: (t) => { let g = line(14, 8, 22, 12, 1.2); for (let i = 0; i < 8; i++) g += `<ellipse cx="${22 + i * 0.9}" cy="${13 + i * 3.6}" rx="3.6" ry="2.2" fill="${t.color}" stroke="${INK}" stroke-width="0.9"/>`; return g; },
  frond: (t) => { let g = `<path d="M24,44 C24,30 26,18 30,6" stroke="${INK}" stroke-width="1.4" fill="none"/>`; for (let i = 0; i < 7; i++) { const y = 38 - i * 4.6; const x = 24 + i * 0.85; const w = 11 - i * 1.3; g += S(`M${x},${y} C${x - w * 0.6},${y - 3} ${x - w},${y - 1} ${x - w},${y + 1} C${x - w * 0.6},${y + 1} ${x - 2},${y + 1} ${x},${y}Z`, t.color) + S(`M${x},${y} C${x + w * 0.6},${y - 4} ${x + w},${y - 3} ${x + w},${y - 1} C${x + w * 0.6},${y} ${x + 2},${y} ${x},${y}Z`, t.color); } return g; },
  clubmoss: (t) => { let g = line(24, 44, 24, 18, 1.4); for (let i = 0; i < 8; i++) { const y = 42 - i * 3; g += line(24, y, 20, y - 3, 1) + line(24, y, 28, y - 3, 1); } return g + `<rect x="21" y="6" width="6" height="12" rx="3" fill="${t.color}" stroke="${INK}" stroke-width="1.1"/>`; },
  moss: (t) => { let g = ''; for (const x of [14, 20, 26, 32]) { g += line(x, 44, x + 1, 26, 1.2); for (let i = 0; i < 4; i++) g += line(x + 0.5, 40 - i * 4, x - 3, 38 - i * 4, 0.9) + line(x + 0.5, 40 - i * 4, x + 4, 38 - i * 4, 0.9); g += line(x + 1, 26, x + 3, 12, 0.9) + `<ellipse cx="${x + 3}" cy="10" rx="1.6" ry="3" fill="${t.color}" stroke="${INK}" stroke-width="0.9" transform="rotate(20 ${x + 3} 10)"/>`; } return g; },
  lichen: (t) => S('M10,30 C8,22 14,14 20,16 C22,8 32,8 34,16 C42,16 42,26 36,30 C38,38 28,42 24,36 C18,42 8,38 10,30Z', t.color) + `<circle cx="20" cy="24" r="2.4" fill="#7A5A2A"/><circle cx="29" cy="20" r="2" fill="#7A5A2A"/><circle cx="28" cy="30" r="2.2" fill="#7A5A2A"/>`,
  mushroom: (t) => S('M8,24 C8,12 40,12 40,24 C40,27 8,27 8,24Z', t.color) + S('M20,26 L19,42 C22,44 26,44 29,42 L28,26Z', '#F3EBDD') + line(12, 25.5, 36, 25.5, 0.8),
  club: (t) => S('M21,44 L22,20 C20,12 22,6 24,6 C26,6 28,12 26,20 L27,44Z', t.color) + `<ellipse cx="24" cy="44" rx="7" ry="2" fill="#C9B89A" stroke="${INK}" stroke-width="1"/>`,
};

function hashHue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }

// Returns an SVG string. size in px.
export function familyIcon(family, size = 40) {
  const t = familyTraits(family);
  const color = t?.color || `hsl(${hashHue(family || '?')},35%,62%)`;
  const id = `fi${hashHue((family || '') + size)}${Math.random().toString(36).slice(2, 6)}`;
  const glyph = t ? (RECIPES[t.type] || RECIPES.radial)({ ...t, color })
    : S('M24,6 C38,12 40,30 24,42 C8,30 10,12 24,6Z', color) + line(24, 10, 24, 44, 1.1)
      + `<text x="24" y="28" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-size="12" font-style="italic" fill="${INK}">${(family || '?').slice(0, 1)}</text>`;
  return `<svg class="ficon" width="${size}" height="${size}" viewBox="0 0 48 48" role="img" aria-label="${family || 'Unknown family'}">
    <defs><radialGradient id="${id}" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="${color}" stop-opacity=".30"/><stop offset="1" stop-color="${color}" stop-opacity=".08"/></radialGradient></defs>
    <rect x="0.5" y="0.5" width="47" height="47" rx="13" fill="url(#${id})"/>
    <g transform="translate(4.8 4.8) scale(.8)">${glyph}</g></svg>`;
}
