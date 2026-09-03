// Balloon Brush
// The page hides a poster: an upright rectangle tiled edge to edge with
// rounded blobs that fit each other perfectly (pipes with bends, blocks, the
// odd circle), each with a crisp coloured rim and a soft glow fading into
// the paper, neighbours never sharing a colour. Draw a line and, when you
// let go, the blobs it passed through burst out of the stroke one after
// another along it, a beat apart, each fat and saturated, then keep
// bleeding outward slowly, blurred and soft while wet, and dry into the
// crisp poster shapes. Only what your lines
// touched appears, so the poster stays incomplete until your strokes have
// covered it.
//
// Blobs are polyominoes on a grid. Each one's outline is traced from its
// cells, corners (convex and concave) are rounded with circular arcs, and
// the result is a Path2D. A blob is painted by clipping to that path, filling
// with paper and stroking the path with a stack of widening, lightening
// strokes so the glow is opaque and stays inside the shape. The print is
// imperfect: each layer of the stack sits a hair off centre, the rim is a
// soft band that fades out past the edge rather than a hard line, the body
// carries an uneven wash, and ink specks are scattered inside and around it.

const PAPER = [255, 255, 255];
const INK = [70, 66, 60];        // the pencil line you draw
const PALETTE = {
  red:    [236, 82, 58],
  blue:   [56, 118, 208],
  green:  [64, 148, 84],
  yellow: [241, 190, 56],
  pink:   [242, 158, 192],
};
const COLOR_KEYS = Object.keys(PALETTE);

const LINE_W = 2;        // weight of the pencil line
const CELL = 44;         // grid cell (px) at size 1; blobs are built from cells
const RES = 3;           // px between resampled line points
const EDGE = 1.7;        // px, inset of the glow from the edge
const BAND = 0.25;       // depth of the glow inside the rim, as a fraction of a cell
const CORNER = 0.7;      // corner radius as a fraction of a cell (clamped by the blob's legs)
const BURST = 160;       // ms for the ink to burst out of the stroke
const DRY = 1500;        // ms for the wet, blurred ink to finish bleeding and dry crisp
const BLUR = 6;          // px of blur on the wet ink at the moment of the burst
const WET = 0.8;         // how much wider the glow is while the ink is wet
const JITTER = 0.7;      // px each layer of the glow stack may sit off centre
const RIM = [[12, 0.05], [8, 0.1], [5, 0.2], [3, 0.42], [1.6, 0.85]];  // [width, alpha] of the soft rim, straddling the edge
const SPECKS = 3;        // ink specks per cell of area, inside the blob and in the margin around it alike
const SPECK_REACH = 0.45; // width of that margin, as a fraction of a cell
const WASH = 2;          // soft uneven patches per cell
const STAGGER = 110;     // ms between one blob's burst and the next one's along the line

// blob kinds when the poster is dealt, and how often each is tried
const SHAPES = [['block', 3], ['pipe', 5], ['dot', 1]];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const BRUSH = {
  name: 'Balloon Brush',
  swatch: true,
  help: [
    ['drag', 'draw a line; the blobs under it soak in when you let go'],
    ['1-5 / 0', 'force red, blue, green, yellow, pink / poster colours'],
    ['[ ]', 'cell size (re-deals)   r re-deal the poster'],
    ['space', 'auto-fill   e eraser   c clear'],
    ['s', 'save PNG   h hide this'],
  ],
};

let paint;               // blobs that have finished soaking in
let paperCol, inkCol;
let bs = 1;              // cell size multiplier
let colorLock = null;    // a PALETTE key forced onto revealed blobs, or null
let eraser = false;

// the hidden poster
let c, ox, oy, cols, rows;   // cell size (px) and grid placement
let cells;               // Int32Array: region id per cell
let regions = [];        // { id, members, col, path, corners, texture, revealed, shown }
let rims = {};           // per colour key: stroke colours from paper (wide) to ink (rim)
let layers = 12;

let st = null;           // current stroke state
let pops = [];           // blobs soaking in, in the order they were reached

function setup() {
  createCanvas(windowWidth, windowHeight);
  strokeCap(ROUND);
  strokeJoin(ROUND);
  paperCol = color(...PAPER);
  inkCol = color(...INK);
  paint = makeLayer();
  deal();
  // index.html?auto starts with a page that paints itself; add &color=<name>
  // to force one colour
  const params = new URLSearchParams(location.search);
  if (COLOR_KEYS.includes(params.get('color'))) colorLock = params.get('color');
  buildHUD(BRUSH);
  updateHUD();
  if (params.has('auto')) autoFill();
}

function makeLayer() {
  const g = createGraphics(width, height);
  g.strokeCap(ROUND);
  g.strokeJoin(ROUND);
  return g;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  paint = makeLayer();
  deal();
  updateHUD();
}

function draw() {
  const now = millis();
  advanceStroke();

  // bake finished blobs into the paint layer, only from the front of the
  // queue so a blob never slips underneath one that popped after it
  let done = 0;
  while (done < pops.length && now >= pops[done].t0 + pops[done].dur) {
    paintBlob(pops[done].rg, paint.drawingContext, pops[done].col, 1);
    done++;
  }
  if (done) pops = pops.slice(done);

  background(paperCol);
  image(paint, 0, 0);
  for (const p of pops) {
    if (now < p.t0) continue;
    soakBlob(p, drawingContext, now);
  }
  drawLive();
  drawBrushCursor();
}

// ---------------------------------------------------------------- poster

// Lays the grid out as an upright rectangle centred on the page and deals it
// into blobs: blocks of w x h cells, pipes that walk in straight legs with
// right-angle turns, and single-cell dots. Leftover single cells mostly join
// a neighbour. Colours are assigned so no two touching blobs share one.
function deal() {
  c = CELL * bs;
  const margin = min(width, height) * 0.07;
  cols = max(2, floor((width - 2 * margin) / c));
  rows = max(2, floor((height - 2 * margin) / c));
  ox = (width - cols * c) / 2;
  oy = (height - rows * c) / 2;

  cells = new Int32Array(cols * rows).fill(-1);
  regions = [];
  pops = [];
  paint.clear();

  const order = shuffle([...Array(cols * rows).keys()]);
  for (const idx of order) {
    if (cells[idx] >= 0) continue;
    const i = idx % cols, j = (idx - i) / cols;
    let kind = weightedPick(SHAPES), members = null;
    if (kind === 'block') {
      let w = pick([1, 2, 2, 3, 3, 4]), h = pick([1, 2, 2, 3, 4]);
      for (let tries = 0; tries < 8 && !members; tries++) {
        const x0 = i - floor(random(w)), y0 = j - floor(random(h));
        if (blockFree(x0, y0, w, h)) {
          members = [];
          for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) members.push(y * cols + x);
        } else if (random() < 0.5) w = max(1, w - 1);
        else h = max(1, h - 1);
      }
      if (members && members.length === 1) members = null;
      if (!members) kind = 'pipe';
    }
    if (kind === 'pipe') {
      members = [idx];
      let ci = i, cj = j, dir = pick(DIRS);
      const legs = floor(random(1, 4));
      for (let l = 0; l < legs; l++) {
        const n = floor(random(1, 5));
        for (let s = 0; s < n; s++) {
          const ni = ci + dir[0], nj = cj + dir[1];
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) break;
          const k = nj * cols + ni;
          if (cells[k] >= 0 || members.includes(k)) break;
          ci = ni; cj = nj;
          members.push(k);
        }
        dir = random() < 0.5 ? [dir[1], dir[0]] : [-dir[1], -dir[0]];
      }
    }
    if (!members) members = [idx];
    claim(members);
  }

  // most stray single cells join a neighbour so the poster is not all dots
  for (const rg of regions) {
    if (rg.members.length !== 1 || random() < 0.3) continue;
    const near = neighbours(rg.members[0]).map(k => cells[k]).filter(id => id !== rg.id);
    if (!near.length) continue;
    const host = regions[pick(near)];
    host.members.push(rg.members[0]);
    cells[rg.members[0]] = host.id;
    rg.members = [];
  }
  regions = regions.filter(rg => rg.members.length);
  regions.forEach((rg, k) => { rg.id = k; for (const m of rg.members) cells[m] = k; });

  // colour: greedy, in random order, never matching a touching blob
  for (const rg of shuffle(regions.slice())) {
    const used = new Set();
    for (const m of rg.members) for (const k of neighbours(m)) {
      const other = regions[cells[k]];
      if (other !== rg && other.col) used.add(other.col);
    }
    const free = COLOR_KEYS.filter(k => !used.has(k));
    rg.col = free.length ? pick(free) : pick(COLOR_KEYS);
  }

  for (const rg of regions) {
    const loops = outline(rg.members);
    rg.path = roundedPath(loops, c * CORNER);
    rg.corners = loops.flat().map(([i, j]) => [ox + i * c, oy + j * c]);
    rg.jit = [];
    for (let k = 0; k <= 30; k++) rg.jit.push([random(-JITTER, JITTER), random(-JITTER, JITTER)]);
    rg.wash = [];
    for (const idx of rg.members) {
      const i = idx % cols, j = (idx - i) / cols;
      for (let k = 0; k < WASH; k++) {
        rg.wash.push([ox + (i + random()) * c, oy + (j + random()) * c, c * random(0.25, 0.6), random(0.03, 0.08)]);
      }
    }
    // specks: one uniform scatter over the blob and the margin around it,
    // so the density is the same either side of the edge
    rg.specks = [];
    const m = c * SPECK_REACH;
    const xs = rg.corners.map(q => q[0]), ys = rg.corners.map(q => q[1]);
    const x0 = min(...xs) - m, y0 = min(...ys) - m, x1 = max(...xs) + m, y1 = max(...ys) + m;
    const n = round(SPECKS * (x1 - x0) * (y1 - y0) / (c * c));
    for (let k = 0; k < n; k++) {
      const x = random(x0, x1), y = random(y0, y1);
      if (nearBlob(rg, x, y, m)) rg.specks.push([x, y, random(0.4, 1.5), random(0.1, 0.4)]);
    }
    rg.revealed = false;
    rg.shown = null;
  }

  // glow: stroke colours from the widest (paper) to the rim (ink)
  const band = c * BAND;
  layers = constrain(round(band / 1.1), 8, 30);
  for (const key of COLOR_KEYS) {
    rims[key] = [];
    for (let k = 0; k <= layers; k++) {
      const u = k === 0 ? 0 : (k - 1) / (layers - 1);
      const mix = k === 0 ? 0 : 0.3 + 0.7 * (1 - pow(1 - u, 1.8));
      rims[key].push(css(PALETTE[key].map((v, q) => v + (PAPER[q] - v) * mix)));
    }
  }
}

function claim(members) {
  const id = regions.length;
  for (const m of members) cells[m] = id;
  regions.push({ id, members, col: null });
}

function blockFree(x0, y0, w, h) {
  if (x0 < 0 || y0 < 0 || x0 + w > cols || y0 + h > rows) return false;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (cells[y * cols + x] >= 0) return false;
  return true;
}

function neighbours(k) {
  const i = k % cols, j = (k - i) / cols, out = [];
  for (const [dx, dy] of DIRS) {
    const x = i + dx, y = j + dy;
    if (x >= 0 && y >= 0 && x < cols && y < rows) out.push(y * cols + x);
  }
  return out;
}

// true when (x, y) is within m px of any cell of the blob
function nearBlob(rg, x, y, m) {
  for (const idx of rg.members) {
    const i = idx % cols, j = (idx - i) / cols;
    const cx = ox + i * c, cy = oy + j * c;
    const dx = max(cx - x, 0, x - cx - c), dy = max(cy - y, 0, y - cy - c);
    if (dx * dx + dy * dy <= m * m) return true;
  }
  return false;
}

function regionAt(x, y) {
  const i = floor((x - ox) / c), j = floor((y - oy) / c);
  if (i < 0 || j < 0 || i >= cols || j >= rows) return null;
  return regions[cells[j * cols + i]];
}

// Traces the boundary of a set of cells as clockwise loops of grid corners
// (a blob with a hole yields two loops). Edges between two cells of the blob
// cancel; the rest are chained start to end. Where two loops touch at a
// corner the tighter right turn is taken so they stay separate.
function outline(members) {
  const inside = new Set(members);
  const has = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows && inside.has(j * cols + i);
  const edges = new Map();
  const add = (a, b) => {
    const key = a[0] + ',' + a[1];
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push(b);
  };
  for (const m of members) {
    const i = m % cols, j = (m - i) / cols;
    if (!has(i, j - 1)) add([i, j], [i + 1, j]);
    if (!has(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
    if (!has(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
    if (!has(i - 1, j)) add([i, j + 1], [i, j]);
  }
  const loops = [];
  for (const [key, list] of edges) {
    while (list.length) {
      const start = key.split(',').map(Number);
      const loop = [];
      let cur = start, dir = null;
      do {
        loop.push(cur);
        const outs = edges.get(cur[0] + ',' + cur[1]);
        let q = 0;
        if (dir && outs.length > 1) {
          for (let k = 0; k < outs.length; k++) {
            const d = [outs[k][0] - cur[0], outs[k][1] - cur[1]];
            if (dir[0] * d[1] - dir[1] * d[0] > 0) { q = k; break; }
          }
        }
        const next = outs.splice(q, 1)[0];
        dir = [next[0] - cur[0], next[1] - cur[1]];
        cur = next;
      } while (cur[0] !== start[0] || cur[1] !== start[1]);
      loops.push(corners(loop));
    }
  }
  return loops;
}

// keeps only the vertices of a loop where the direction changes
function corners(loop) {
  const n = loop.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n], b = loop[i], d = loop[(i + 1) % n];
    if ((b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]) !== 0) out.push(b);
  }
  return out;
}

// a Path2D of the loops with every corner rounded by up to R px, limited to
// half of the adjoining legs so a one-cell-wide pipe gets a semicircular end
function roundedPath(loops, R) {
  const path = new Path2D();
  for (const L of loops) {
    const P = L.map(([i, j]) => [ox + i * c, oy + j * c]);
    const n = P.length;
    path.moveTo((P[n - 1][0] + P[0][0]) / 2, (P[n - 1][1] + P[0][1]) / 2);
    for (let k = 0; k < n; k++) {
      const a = P[(k - 1 + n) % n], v = P[k], b = P[(k + 1) % n];
      const r = min(R, dist(a[0], a[1], v[0], v[1]) / 2, dist(v[0], v[1], b[0], b[1]) / 2);
      path.arcTo(v[0], v[1], b[0], b[1], r);
    }
    path.closePath();
  }
  return path;
}

// Paints a whole blob: clip to the shape, fill with paper, lay the uneven
// wash and stroke the outline with the glow stack (widest and lightest
// first, each layer nudged a hair off centre); then, unclipped, draw the
// soft rim as a band straddling the edge that fades outward, and scatter
// the specks inside and around it. spread widens the glow (wet ink); 1 is
// the dry blob. Unclipped, the glow spills past the edge as wet ink does.
function paintBlob(rg, ctx, colKey, spread, clipped = true) {
  const base = ctx.globalAlpha;
  const tint = PALETTE[colKey], dark = tint.map(v => v * 0.55);
  ctx.save();
  if (clipped) ctx.clip(rg.path, 'evenodd');
  ctx.fillStyle = css(PAPER);
  ctx.fill(rg.path, 'evenodd');
  for (const [x, y, r, a] of rg.wash) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${tint.join(',')},${a})`);
    g.addColorStop(1, `rgba(${tint.join(',')},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.lineJoin = 'round';
  const band = c * BAND * spread, stack = rims[colKey];
  for (let k = layers; k >= 1; k--) {
    ctx.save();
    ctx.translate(rg.jit[k][0], rg.jit[k][1]);
    ctx.lineWidth = 2 * (EDGE + band * k / layers);
    ctx.strokeStyle = stack[k];
    ctx.stroke(rg.path);
    ctx.restore();
  }
  ctx.restore();
  // the rim: no hard line, a band centred on the edge that fades outward
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = css(tint);
  for (const [w, a] of RIM) {
    ctx.globalAlpha = base * a;
    ctx.lineWidth = w;
    ctx.stroke(rg.path);
  }
  ctx.fillStyle = css(dark);
  for (const [x, y, r, a] of rg.specks) {
    ctx.globalAlpha = base * a;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TWO_PI);
    ctx.fill();
  }
  ctx.restore();
}

// A blob soaking in, in two beats. Burst: within BURST ms the whole blob
// appears at once, fat, blurred and spilling past its edges. Bleed: over
// DRY ms the blur and the spill fade and the crisp clipped blob takes over
// underneath. Both the wet and the dry image are drawn from offscreen
// canvases.
function soakBlob(pop, ctx, now) {
  const t = now - pop.t0;
  if (t >= pop.dur) { paintBlob(pop.rg, ctx, pop.col, 1); return; }
  const dry = 1 - pow(1 - constrain((t - BURST) / DRY, 0, 1), 2);
  const spread = 1 + WET * (1 - dry);
  const fade = 1 - pow(1 - constrain(t / BURST, 0, 1), 3);

  // the wet ink, drawn unclipped into the blob's own offscreen canvas so the
  // blur costs one pass per band rather than one per stroke
  let wetImage = null;
  if (dry < 1) {
    const off = pop.off, pd = pixelDensity();
    const octx = off.getContext('2d');
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, off.width, off.height);
    octx.setTransform(pd, 0, 0, pd, -pop.bx * pd, -pop.by * pd);
    octx.globalAlpha = 1;
    paintBlob(pop.rg, octx, pop.col, spread, false);
    wetImage = off;
  }

  // the dry blob, rendered once into its own canvas
  if (dry > 0 && !pop.dryImage) {
    const off = pop.off.cloneNode(), pd = pixelDensity();
    const octx = off.getContext('2d');
    octx.setTransform(pd, 0, 0, pd, -pop.bx * pd, -pop.by * pd);
    paintBlob(pop.rg, octx, pop.col, 1);
    pop.dryImage = off;
  }

  ctx.save();
  if (dry > 0) {
    ctx.globalAlpha = fade * dry;
    ctx.drawImage(pop.dryImage, pop.bx, pop.by, pop.bw, pop.bh);
  }
  if (wetImage) {
    ctx.globalAlpha = fade * (1 - dry);
    const blur = BLUR * (1 - dry);
    if (blur > 0.3 && 'filter' in ctx) ctx.filter = `blur(${blur.toFixed(2)}px)`;
    ctx.drawImage(wetImage, pop.bx, pop.by, pop.bw, pop.bh);
    ctx.filter = 'none';
  }
  ctx.restore();
}

// ---------------------------------------------------------------- stroke

function beginStroke(x, y) {
  st = { x, y, tx: x, ty: y, pressed: true, raw: [[x, y]] };
}

// A follower chases the cursor, closing a fraction of the gap per substep, so
// hand jitter is filtered out of the recorded line.
function advanceStroke() {
  if (!st) return;
  for (let k = 0; k < 4; k++) {
    const dx = st.tx - st.x, dy = st.ty - st.y;
    const d = sqrt(dx * dx + dy * dy);
    if (d < 0.4) break;
    const step = min(d, max(1.5, d * 0.18));
    strokeTo(st.x + dx / d * step, st.y + dy / d * step);
  }
  if (!st.pressed && dist(st.x, st.y, st.tx, st.ty) < 0.8) endStroke();
}

function strokeTo(x, y) {
  st.x = x; st.y = y;
  if (eraser) { erase(x, y); return; }
  const last = st.raw[st.raw.length - 1];
  if (dist(last[0], last[1], x, y) >= 2) st.raw.push([x, y]);
}

function endStroke() {
  const s = st;
  st = null;
  if (eraser) return;
  const pts = s.raw.length > 1 ? chaikin(chaikin(s.raw)) : [s.raw[0], [s.raw[0][0] + 0.5, s.raw[0][1]]];
  addLine(resample(pts, RES), millis());
}

// Schedules every blob a line passes through to burst, in the order the
// line first reached them, STAGGER ms apart from t0. The line itself is not
// kept. Blobs already showing are skipped.
function addLine(pts, t0) {
  let k = 0;
  for (const [x, y] of pts) {
    const rg = regionAt(x, y);
    if (!rg || rg.revealed) continue;
    rg.revealed = true;
    rg.shown = colorLock || rg.col;
    const pop = { rg, col: rg.shown, t0: t0 + k * STAGGER, dur: BURST + DRY };
    k++;
    pops.push(pop);
    // an offscreen canvas around the blob for its wet, unclipped image
    const pad = c * BAND * (1 + WET) + BLUR * 3 + c * SPECK_REACH + 8;
    const xs = pop.rg.corners.map(q => q[0]), ys = pop.rg.corners.map(q => q[1]);
    pop.bx = min(...xs) - pad; pop.by = min(...ys) - pad;
    pop.bw = max(...xs) - min(...xs) + pad * 2; pop.bh = max(...ys) - min(...ys) + pad * 2;
    pop.off = document.createElement('canvas');
    pop.off.width = ceil(pop.bw * pixelDensity());
    pop.off.height = ceil(pop.bh * pixelDensity());
  }
  updateHUD();
}

// un-reveals the blob under the eraser and repaints the rest
function erase(x, y) {
  const rg = regionAt(x, y);
  if (!rg || !rg.revealed || pops.some(p => p.rg === rg)) return;
  rg.revealed = false;
  rg.shown = null;
  paint.clear();
  for (const other of regions) {
    if (other.revealed && !pops.some(p => p.rg === other)) paintBlob(other, paint.drawingContext, other.shown, 1);
  }
  updateHUD();
}

// the line as it is being drawn
function drawLive() {
  if (!st || eraser) return;
  const pts = st.raw;
  if (pts.length < 2) { noStroke(); fill(inkCol); circle(pts[0][0], pts[0][1], LINE_W * 2); return; }
  noFill();
  stroke(inkCol);
  strokeWeight(LINE_W);
  beginShape();
  for (const p of pts) vertex(p[0], p[1]);
  endShape();
}

// ---------------------------------------------------------------- paths

function chaikin(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function resample(pts, step) {
  const out = [pts[0].slice()];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    let ax = pts[i - 1][0], ay = pts[i - 1][1];
    const bx = pts[i][0], by = pts[i][1];
    let d = dist(ax, ay, bx, by);
    while (d > 0 && carry + d >= step) {
      const t = (step - carry) / d;
      ax += (bx - ax) * t; ay += (by - ay) * t;
      out.push([ax, ay]);
      d = dist(ax, ay, bx, by);
      carry = 0;
    }
    carry += d;
  }
  const last = pts[pts.length - 1], end = out[out.length - 1];
  if (out.length === 1 || dist(last[0], last[1], end[0], end[1]) > 0.3) out.push(last.slice());
  return out;
}

// ---------------------------------------------------------------- auto-fill

// a handful of wandering lines, their blobs cascading one line after another
function autoFill() {
  const count = round((cols * rows) / 60) + 2;
  let t0 = millis() + 300;
  for (let i = 0; i < count; i++) {
    const before = pops.length;
    addLine(resample(randomCurve(), RES), t0);
    t0 += (pops.length - before) * STAGGER + 500;
  }
}

// a curve steered by noise inside the poster, turned back at its edges
function randomCurve() {
  const x0 = ox + c, x1 = ox + cols * c - c, y0 = oy + c, y1 = oy + rows * c - c;
  let x = random(x0, x1), y = random(y0, y1);
  let h = random(TWO_PI);
  const seed = random(1000);
  const n = floor(random(40, 160));
  const pts = [[x, y]];
  for (let i = 0; i < n; i++) {
    h += (noise(seed + i * 0.06) - 0.5) * 0.5;
    x += cos(h) * 4; y += sin(h) * 4;
    if (x < x0 || x > x1 || y < y0 || y > y1) {
      h += HALF_PI;
      x = constrain(x, x0, x1); y = constrain(y, y0, y1);
    }
    pts.push([x, y]);
  }
  return chaikin(pts);
}

// ---------------------------------------------------------------- input, hud

function mousePressed(e) {
  if (!onCanvas(e) || mouseY < 0 || mouseY > height) return;
  beginStroke(mouseX, mouseY);
  if (eraser) erase(mouseX, mouseY);
}
function mouseDragged() { if (st) { st.tx = mouseX; st.ty = mouseY; } }
function mouseReleased() { if (st) st.pressed = false; }

function keyPressed() {
  const n = parseInt(key, 10);
  if (n >= 1 && n <= COLOR_KEYS.length) colorLock = COLOR_KEYS[n - 1];
  else if (key === '0') colorLock = null;
  else if (key === '[') { bs = max(0.4, bs / 1.25); deal(); }
  else if (key === ']') { bs = min(3, bs * 1.25); deal(); }
  else if (key === 'r' || key === 'R') deal();
  else if (key === ' ') { autoFill(); updateHUD(); return false; }
  else if (key === 'e' || key === 'E') eraser = !eraser;
  else if (key === 'c' || key === 'C') clearAll();
  else if (key === 's' || key === 'S') saveCanvas('balloon-brush', 'png');
  else if (key === 'h' || key === 'H') toggleHUD();
  updateHUD();
}

function clearAll() {
  st = null;
  pops = [];
  for (const rg of regions) { rg.revealed = false; rg.shown = null; }
  paint.clear();
}

function updateHUD() {
  const shown = regions.filter(rg => rg.revealed).length;
  setStatus(
    `colour: ${colorLock || 'poster'}  cell: ${round(c)}px  blobs: ${shown}/${regions.length}` +
    (eraser ? '  [ERASER]' : ''));
  const sw = document.getElementById('swatch');
  if (sw) sw.style.background = css(colorLock ? PALETTE[colorLock] : INK);
}

function css(rgb) { return `rgb(${rgb.map(v => round(v)).join(',')})`; }
function pick(a) { return a[floor(random(a.length))]; }
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = floor(random(i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function weightedPick(pairs) {
  let total = 0;
  for (const [, w] of pairs) total += w;
  let r = random(total);
  for (const [v, w] of pairs) { if ((r -= w) < 0) return v; }
  return pairs[pairs.length - 1][0];
}
