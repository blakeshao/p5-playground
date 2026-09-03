// Score Brush
// A p5.js brush that lays down a ribbon of five staff lines along the stroke
// and paints randomized "graphic score" snippets onto it: dots that melt into
// tapered rods, rods that swell into dots, zig-zag melodies, thick bars that
// thin out into hairlines, stemmed notes, chords, tall tapered arches with a
// drop at the tip, hooks, fans, parentheses, spirals, blobs and swipes.
//
// Snippets are recorded as primitives (dots, variable-width paths, blobs) and
// then animated: each grows out from the point where it was stamped, paths
// advancing with a liquid drop at their tip, dots swelling up as the drop
// arrives. Finished snippets are baked into the paint layer.

const PALETTE = {
  black:  '#1b1b1b',
  red:    '#e2242b',
  blue:   '#2a4fa8',
  green:  '#1d9a47',
  yellow: '#f4d500',
};
const COLOR_KEYS = ['black', 'red', 'blue', 'green', 'yellow'];
const COLOR_WEIGHTS = { black: 4, red: 2, blue: 1.6, green: 1.4, yellow: 1.3 };

// Snippet generators and how often each one is chosen.
const SNIPPETS = [
  ['chain',   20],
  ['cluster', 16],
  ['zigzag',  10],
  ['swell',    8],
  ['bar',     10],
  ['stem',     9],
  ['chord',    6],
  ['arch',     7],
  ['hook',     6],
  ['fan',      4],
  ['parens',   4],
  ['spiral',   3],
  ['cross',    3],
  ['blob',     4],
  ['swipe',    4],
];

const SMOOTH_A = 0.07;       // first follower: fraction of the gap to the cursor closed per substep
const SMOOTH_B = 0.07;       // second follower: fraction of the gap to the first closed per substep
const SMOOTH_HEADING = 0.08; // how quickly the ribbon heading may turn

const TWIST_THRESHOLD = 0.018; // rad per px of travel; turns faster than this twist the ribbon
const TWIST_GAIN = 1.5;       // how much roll a fast turn adds per radian of heading change
const TWIST_RELAX = 0.015;    // per px of travel, how quickly the ribbon settles flat again

const GROW_SPEED = 0.16;   // px per ms that liquid spreads out from the stamp point
const DOT_MS = 320;        // how long a dot takes to swell up

const BRUSH = {
  name: 'Score Brush',
  swatch: true,
  help: [
    ['drag', 'lay staff lines + snippets along the stroke'],
    ['1–5 / 0', 'black, red, blue, green, yellow / random'],
    ['[ ]', 'brush size   - = density'],
    ['space', 'auto-fill page   e eraser'],
    ['g', 'hide staff   c clear   r new staff'],
    ['s', 'save PNG   h hide this'],
  ],
};

let staffLayer;         // ribbon of staff lines laid down by the brush
let paint;              // finished brush marks
let u = 9;              // staff line spacing (the unit everything is built from)
let bs = 1;             // brush size multiplier
let density = 1;        // snippets per unit of drag distance
let colorLock = null;   // one of COLOR_KEYS, or null for random
let eraser = false;
let showStaff = true;

let st = null;          // current stroke state
let active = [];        // snippets still growing
let ribbonQueue = [];   // staff segments scheduled for later (auto-fill)
let autoDelay = 0;      // ms offset applied to everything created (auto-fill)
let rec = null;         // primitive list being recorded by the snip* functions

function setup() {
  createCanvas(windowWidth, windowHeight);
  staffLayer = makeLayer();
  paint = makeLayer();
  buildHUD(BRUSH);
  updateHUD();
  // open index.html?auto to start with a page that writes itself
  if (new URLSearchParams(location.search).has('auto')) autoFill();
}

function makeLayer() {
  const g = createGraphics(width, height);
  g.strokeCap(ROUND);
  g.strokeJoin(ROUND);
  return g;
}

function windowResized() {
  const oldStaff = staffLayer, oldPaint = paint;
  resizeCanvas(windowWidth, windowHeight);
  staffLayer = makeLayer(); staffLayer.image(oldStaff, 0, 0);
  paint = makeLayer();      paint.image(oldPaint, 0, 0);
}

function draw() {
  const now = millis();
  advanceStroke();
  flushRibbonQueue(now);

  // bake finished snippets into the paint layer first, so nothing flickers
  const keep = [];
  for (const s of active) {
    if (now >= s.t0 + s.end) renderSnippet(s, paint, Infinity);
    else keep.push(s);
  }
  active = keep;

  background(247);
  if (showStaff) image(staffLayer, 0, 0);
  image(paint, 0, 0);
  for (const s of active) renderSnippet(s, window, now);
  drawBrushCursor();
}

// ---------------------------------------------------------------- stroke

// The staff follows the brush: a smoothed point chases the mouse, and five
// lines are offset perpendicular to its heading. Snippets are stamped in the
// local frame of the stroke (x along it, y across it), so their dots sit on
// the ribbon's lines.

function beginStroke(x, y) {
  // tx/ty: the cursor. ax/ay: a first follower chasing the cursor.
  // x/y: a second follower chasing the first; this is the ribbon's path.
  st = { x, y, ax: x, ay: y, tx: x, ty: y, pressed: true, dx: 0, dy: 0, roll: 0, travel: 0, ends: null, len: 0 };
}

// Two chained followers each close a small fraction of their remaining
// distance per substep, so hand jitter is filtered out twice before the
// ribbon is drawn. Runs every frame while a stroke is live.
function advanceStroke() {
  if (!st) return;
  for (let k = 0; k < 6; k++) {
    st.ax += (st.tx - st.ax) * SMOOTH_A;
    st.ay += (st.ty - st.ay) * SMOOTH_A;
    const dx = st.ax - st.x, dy = st.ay - st.y;
    const d = sqrt(dx * dx + dy * dy);
    if (d < 0.4) continue;
    const step = min(d, max(1.2, d * SMOOTH_B));
    strokeTo(st.x + dx / d * step, st.y + dy / d * step);
  }
  if (!st.pressed && dist(st.x, st.y, st.tx, st.ty) < 0.8) endStroke();
}

function strokeTo(x, y) {
  if (!st) return;
  const dx = x - st.x, dy = y - st.y;
  const d = sqrt(dx * dx + dy * dy);
  if (d < 0.3) return;

  // smooth the heading as well, and note how fast it is turning
  let dAng = 0;
  if (st.dx === 0 && st.dy === 0) { st.dx = dx / d; st.dy = dy / d; }
  else {
    const prev = atan2(st.dy, st.dx);
    st.dx = lerp(st.dx, dx / d, SMOOTH_HEADING);
    st.dy = lerp(st.dy, dy / d, SMOOTH_HEADING);
    const m = sqrt(st.dx * st.dx + st.dy * st.dy) || 1;
    st.dx /= m; st.dy /= m;
    dAng = atan2(st.dy, st.dx) - prev;
    if (dAng > PI) dAng -= TWO_PI;
    if (dAng < -PI) dAng += TWO_PI;
  }
  const ang = atan2(st.dy, st.dx);

  // a fast turn rolls the ribbon over like a twisted strip; otherwise it
  // relaxes to the nearest flat orientation
  if (abs(dAng) / d > TWIST_THRESHOLD) {
    st.roll += dAng * TWIST_GAIN;
  } else {
    const flat = round(st.roll / PI) * PI;
    st.roll = lerp(st.roll, flat, min(1, d * TWIST_RELAX));
  }
  const squash = cos(st.roll); // projected width of the ribbon

  if (eraser) {
    for (const g of [paint, staffLayer]) {
      g.erase(); g.noStroke(); g.circle(x, y, u * 4 * bs); g.noErase();
    }
    st.x = x; st.y = y;
    return;
  }

  // extend the five staff lines
  const nx = -st.dy, ny = st.dx;
  const ends = [];
  for (let k = -2; k <= 2; k++) ends.push([x + nx * k * u * squash, y + ny * k * u * squash]);
  if (st.ends) {
    for (let k = 0; k < 5; k++) {
      ribbonSegment(st.ends[k][0], st.ends[k][1], ends[k][0], ends[k][1]);
    }
  }
  st.ends = ends;

  // stamp snippets at intervals along the path (not while the ribbon is
  // mid-twist, where its lines are bunched together)
  st.travel += d;
  st.len += d;
  const spacing = (u * 5.5 * bs) / density;
  if (abs(squash) < 0.8) st.travel = min(st.travel, spacing);
  else {
    while (st.travel >= spacing) {
      st.travel -= spacing;
      const li = pickLineIndex();
      stamp(x + nx * li * u, y + ny * li * u, ang, li);
    }
  }
  st.x = x; st.y = y;
}

function endStroke() {
  if (st && !eraser && st.len < 4) {
    // a plain click: a short horizontal patch of staff plus one snippet
    const x0 = st.x - u * 6 * bs, x1 = st.x + u * 6 * bs;
    for (let k = -2; k <= 2; k++) ribbonSegment(x0, st.y + k * u, x1, st.y + k * u);
    stamp(st.x, st.y, 0, 0);
  }
  st = null;
}

function ribbonSegment(x1, y1, x2, y2) {
  if (autoDelay > 0) { ribbonQueue.push([millis() + autoDelay, x1, y1, x2, y2]); return; }
  staffLayer.stroke(0, 150);
  staffLayer.strokeWeight(0.8);
  staffLayer.line(x1, y1, x2, y2);
}

function flushRibbonQueue(now) {
  if (!ribbonQueue.length) return;
  staffLayer.stroke(0, 150);
  staffLayer.strokeWeight(0.8);
  const rest = [];
  for (const q of ribbonQueue) {
    if (q[0] <= now) staffLayer.line(q[1], q[2], q[3], q[4]);
    else rest.push(q);
  }
  ribbonQueue = rest;
}

// which line (or space between lines) the snippet starts on; biased to the staff
function pickLineIndex() {
  const r = random();
  if (r < 0.7) return floor(random(-2, 3));
  return floor(random(-4, 5));
}

function mousePressed(e) {
  if (!onCanvas(e) || mouseY < 0 || mouseY > height) return;
  beginStroke(mouseX, mouseY);
}
function mouseDragged() { if (st) { st.tx = mouseX; st.ty = mouseY; } }
function mouseReleased() { if (st) st.pressed = false; }

// ---------------------------------------------------------------- stamping

// Record a snippet at world (x, y) with heading `ang`; `li` is the line index
// the point sits on. The snip* functions push primitives into `rec`, which
// are then scheduled to grow outward from the stamp point.
function stamp(x, y, ang, li) {
  const kind = weightedPick(SNIPPETS);
  const col = pickColor();
  const dir = random() < 0.6 ? -1 : 1; // mostly back over the ribbon just drawn
  const L = { li, dir, col };
  rec = [];
  switch (kind) {
    case 'chain':   snipChain(L); break;
    case 'cluster': snipCluster(L); break;
    case 'zigzag':  snipZigzag(L); break;
    case 'swell':   snipSwell(L); break;
    case 'bar':     snipBar(L); break;
    case 'stem':    snipStem(L); break;
    case 'chord':   snipChord(L); break;
    case 'arch':    snipArch(L); break;
    case 'hook':    snipHook(L); break;
    case 'fan':     snipFan(L); break;
    case 'parens':  snipParens(L); break;
    case 'spiral':  snipSpiral(L); break;
    case 'cross':   snipCross(L); break;
    case 'blob':    snipBlob(L); break;
    case 'swipe':   snipSwipe(L); break;
  }
  const prims = rec;
  rec = null;
  active.push(schedule(prims, x, y, ang));
}

// Give every primitive a start time and duration based on how far it is from
// the stamp point (the local origin), so the snippet spreads outward.
function schedule(prims, x, y, ang) {
  const speed = GROW_SPEED * random(0.75, 1.25);
  let end = 0;
  for (const p of prims) {
    if (p.k === 'dot') {
      p.start = dist(0, 0, p.x, p.y) / speed + random(0, 60);
      p.dur = DOT_MS * random(0.8, 1.3);
    } else if (p.k === 'path') {
      const a = p.pts[0], b = p.pts[p.pts.length - 1];
      if (dist(0, 0, b[0], b[1]) < dist(0, 0, a[0], a[1])) {
        p.pts.reverse();
        const w = p.wAt;
        p.wAt = t => w(1 - t);
      }
      p.len = pathLength(p.pts);
      p.start = dist(0, 0, p.pts[0][0], p.pts[0][1]) / speed;
      p.dur = max(160, p.len / speed);
    } else if (p.k === 'blob') {
      p.start = dist(0, 0, p.cx, p.cy) / speed;
      p.dur = 650;
    }
    end = max(end, p.start + p.dur);
  }
  return { x, y, ang, prims, t0: millis() + autoDelay, end };
}

function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return L;
}

// ---------------------------------------------------------------- rendering

function easeOutBack(q) {
  const c1 = 1.4, c3 = c1 + 1;
  return 1 + c3 * pow(q - 1, 3) + c1 * pow(q - 1, 2);
}
function easeInOutQuad(q) { return q < 0.5 ? 2 * q * q : 1 - pow(-2 * q + 2, 2) / 2; }
function smoothstep(a, b, x) { const t = constrain((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

function renderSnippet(s, g, now) {
  g.push();
  g.translate(s.x, s.y);
  g.rotate(s.ang);
  for (const p of s.prims) {
    const q = now === Infinity ? 1 : constrain((now - s.t0 - p.start) / p.dur, 0, 1);
    if (q <= 0) continue;
    if (p.k === 'dot') {
      drawDot(g, p.x, p.y, p.d * (q >= 1 ? 1 : easeOutBack(q)), p.col);
    } else if (p.k === 'path') {
      if (q >= 1) drawVarStroke(g, p.pts, p.wAt, p.col);
      else drawGrowingPath(g, p, q);
    } else if (p.k === 'blob') {
      drawBlob(g, p, q >= 1 ? 1 : easeOutBack(q));
    }
  }
  g.pop();
}

function drawDot(g, x, y, d, col) {
  if (d <= 0) return;
  g.noStroke();
  g.fill(col);
  g.circle(x, y, d);
}

// The path revealed up to progress `q`, with a liquid drop at the leading
// edge that shrinks away as the path arrives at its end.
function drawGrowingPath(g, p, q) {
  const prog = easeInOutQuad(q);
  const n = p.pts.length;
  const f = prog * (n - 1);
  const i = floor(f);
  const frac = f - i;
  const sub = p.pts.slice(0, i + 1);
  if (i < n - 1) {
    const a = p.pts[i], b = p.pts[i + 1];
    sub.push([lerp(a[0], b[0], frac), lerp(a[1], b[1], frac)]);
  }
  if (sub.length < 2) {
    drawDot(g, p.pts[0][0], p.pts[0][1], p.wAt(0), p.col);
    return;
  }
  const tipD = max(p.wAt(prog) * 1.8, u * 0.7 * bs) * (1 - smoothstep(0.7, 1, q));
  const melt = u * 0.9 * bs;
  const wAt = tt => {
    const t = tt * prog;
    const base = p.wAt(t);
    const dTip = (prog - t) * p.len;
    return max(base, tipD * exp(-pow(dTip / melt, 2)));
  };
  drawVarStroke(g, sub, wAt, p.col);
}

// A variable-width stroke: `pts` is a dense polyline, `wAt(t)` gives the
// width at parameter t in [0, 1]. Rendered as a filled polygon so widths can
// swell into dots and melt down into hairlines.
function drawVarStroke(g, pts, wAt, col) {
  const n = pts.length;
  if (n < 2) return;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[max(0, i - 1)], p1 = pts[min(n - 1, i + 1)];
    let tx = p1[0] - p0[0], ty = p1[1] - p0[1];
    const m = sqrt(tx * tx + ty * ty) || 1;
    tx /= m; ty /= m;
    const hw = max(0.35, wAt(i / (n - 1)) / 2);
    left.push([pts[i][0] - ty * hw, pts[i][1] + tx * hw]);
    right.push([pts[i][0] + ty * hw, pts[i][1] - tx * hw]);
  }
  g.fill(col);
  g.stroke(col);
  g.strokeWeight(0.6);
  g.beginShape();
  for (const p of left) g.vertex(p[0], p[1]);
  for (let i = n - 1; i >= 0; i--) g.vertex(right[i][0], right[i][1]);
  g.endShape(CLOSE);
  // round the ends
  g.noStroke();
  g.circle(pts[0][0], pts[0][1], max(0.7, wAt(0)));
  g.circle(pts[n - 1][0], pts[n - 1][1], max(0.7, wAt(1)));
}

function drawBlob(g, p, scale) {
  if (scale <= 0) return;
  g.noStroke();
  g.fill(p.col);
  g.push();
  g.translate(p.cx, p.cy);
  g.scale(scale);
  g.beginShape();
  for (const v of p.pts) g.curveVertex(v[0], v[1]);
  g.endShape();
  g.pop();
}

// ---------------------------------------------------------------- auto fill

function autoFill() {
  const base = millis();
  const writeMs = 6000; // how long the page takes to write itself
  const rowH = u * 9;
  let row = 0;
  for (let y0 = rowH * 0.6; y0 < height; y0 += rowH, row++) {
    let x = random(-u * 4, u * 20), y = y0 + random(-u * 2, u * 2);
    const xEnd = width - random(0, u * 25);
    let a = random() < 0.5 ? 0 : random(-0.6, 0.6);
    const seed = random(1000);
    beginStroke(x, y);
    let i = 0;
    while (x < xEnd && i < 2000) {
      a = lerp(a, (noise(seed + i * 0.02) - 0.5) * 0.9, 0.08);
      x += cos(a) * 6; y += sin(a) * 6;
      autoDelay = (x / width) * writeMs + row * 90 + (millis() - base);
      strokeTo(x, y);
      i++;
    }
    endStroke();
  }
  // a few free-form strokes on top
  for (let s = 0; s < 3; s++) {
    let x = random(width), y = random(height), a = random(TWO_PI);
    const seed = random(1000);
    beginStroke(x, y);
    for (let i = 0; i < 120; i++) {
      a += (noise(seed + i * 0.05) - 0.5) * 0.2;
      x += cos(a) * 6; y += sin(a) * 6;
      if (x < 0 || x > width || y < 0 || y > height) break;
      autoDelay = writeMs * 0.3 + (i / 120) * writeMs * 0.7;
      strokeTo(x, y);
    }
    endStroke();
  }
  autoDelay = 0;
}

// ---------------------------------------------------------------- helpers

function weightedPick(pairs) {
  let total = 0;
  for (const p of pairs) total += p[1];
  let r = random(total);
  for (const p of pairs) {
    r -= p[1];
    if (r < 0) return p[0];
  }
  return pairs[pairs.length - 1][0];
}

function pickColor() {
  if (colorLock) return PALETTE[colorLock];
  return PALETTE[weightedPick(COLOR_KEYS.map(k => [k, COLOR_WEIGHTS[k]]))];
}

function dotD()  { return u * 1.25 * bs; }
function thinW() { return max(1.2, u * 0.2 * bs); }
function hairW() { return max(0.9, u * 0.1 * bs); }

// recorders used by the snippet functions
function dot(x, y, col, d = dotD()) { rec.push({ k: 'dot', x, y, d, col }); }
function path(pts, wAt, col) { if (pts.length > 1) rec.push({ k: 'path', pts, wAt, col }); }

function samplePath(fn, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(fn(i / n));
  return pts;
}

function bezierPts(x1, y1, cx1, cy1, cx2, cy2, x2, y2, n = 40) {
  return samplePath(t => [
    bezierPoint(x1, cx1, cx2, x2, t),
    bezierPoint(y1, cy1, cy2, y2, t),
  ], n);
}

// width profile: a body width `w` that melts out of a dot of diameter d1 at
// the start and into a dot of diameter d2 at the end. `k` is the melt length
// as a fraction of the path.
function meltProfile(w, d1, d2, k = 0.25) {
  return t => {
    let v = w;
    if (d1 > 0) v = max(v, w + (d1 * 0.9 - w) * exp(-pow(t / k, 1.6) * 4));
    if (d2 > 0) v = max(v, w + (d2 * 0.9 - w) * exp(-pow((1 - t) / k, 1.6) * 4));
    return v;
  };
}

// straight rod between two dots, melting out of each of them
function rod(x1, y1, x2, y2, col, d1 = dotD(), d2 = dotD(), w = thinW()) {
  const L = dist(x1, y1, x2, y2);
  if (L < 0.5) return;
  const k = constrain((u * 1.6 * bs) / L, 0.08, 0.5);
  const pts = samplePath(t => [lerp(x1, x2, t), lerp(y1, y2, t)], max(10, floor(L / 2)));
  path(pts, meltProfile(w, d1, d2, k), col);
}

// y of staff line k in the local frame
function ly(L, k) { return (constrain(k, -5, 5) - L.li) * u; }

// ---------------------------------------------------------------- snippets

// Dots along one line, joined by rods that melt out of them.
function snipChain(L) {
  const yy = ly(L, L.li);
  const n = floor(random(2, 7));
  const step = u * random(2.2, 4.2) * bs;
  const multi = random() < 0.3;
  const pts = [];
  for (let k = 0; k < n; k++) pts.push([L.dir * k * step, yy, random() < 0.2 ? dotD() * random(0.6, 0.85) : dotD()]);
  for (let k = 0; k < n - 1; k++) {
    rod(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], multi ? PALETTE.black : L.col, pts[k][2], pts[k + 1][2]);
  }
  for (const p of pts) dot(p[0], p[1], multi ? pickColor() : L.col, p[2]);
  // occasionally the chain trails off into a hairline
  if (random() < 0.25) {
    const last = pts[n - 1];
    rod(last[0], last[1], last[0] + L.dir * u * random(3, 8) * bs, last[1], L.col, last[2], 0, hairW());
  }
}

// Loose dots on nearby lines.
function snipCluster(L) {
  const n = floor(random(2, 6));
  const multi = random() < 0.5;
  let cx = 0;
  for (let k = 0; k < n; k++) {
    const li = L.li + floor(random(-2, 3));
    const size = random() < 0.15 ? dotD() * 0.55 : dotD();
    dot(cx, ly(L, li), multi ? pickColor() : L.col, size);
    cx += L.dir * u * random(1.6, 3.2) * bs;
  }
}

// A melody: dots jumping between lines, joined by melting rods.
function snipZigzag(L) {
  let li = L.li;
  const n = floor(random(3, 8));
  const pts = [];
  let cx = 0;
  for (let k = 0; k < n; k++) {
    pts.push([cx, ly(L, li)]);
    li = constrain(li + floor(random(1, 4)) * (random() < 0.5 ? -1 : 1), -5, 5);
    cx += L.dir * u * random(1.5, 3) * bs;
  }
  for (let k = 0; k < n - 1; k++) rod(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], L.col);
  for (const p of pts) dot(p[0], p[1], L.col);
}

// One continuous rod whose width swells into dots along its length.
function snipSwell(L) {
  const yy = ly(L, L.li);
  const len = u * random(6, 18) * bs;
  const bumps = [];
  const nb = floor(random(2, 6));
  for (let i = 0; i < nb; i++) bumps.push([random(0.05, 0.95), random(0.7, 1.15)]);
  const w = thinW() * random(0.9, 1.6);
  const wAt = t => {
    let v = w;
    for (const [c, s] of bumps) v = max(v, dotD() * s * exp(-pow((t - c) * len / (u * 0.9 * bs), 2)));
    return v;
  };
  path(samplePath(t => [L.dir * t * len, yy], 80), wAt, L.col);
}

// Thick rounded bars, sometimes stacked, sometimes thinning out into a hairline.
function snipBar(L) {
  const count = random() < 0.35 ? floor(random(2, 4)) : 1;
  for (let k = 0; k < count; k++) {
    const yy = ly(L, L.li + k * 2);
    const len = u * random(3, 12) * bs;
    const w = u * random(1.1, 1.7) * bs;
    const c = k === 0 ? L.col : pickColor();
    const ox = random(-u * 2, u * 2) * bs;
    if (random() < 0.4) {
      // bar that melts into a long thin tail
      const tail = u * random(4, 12) * bs;
      const pts = samplePath(t => [ox + L.dir * t * (len + tail), yy], 60);
      const split = len / (len + tail);
      path(pts, t => t < split ? w : max(hairW(), w * pow(1 - (t - split) / (1 - split), 1.8)), c);
    } else {
      path(samplePath(t => [ox + L.dir * t * len, yy], 30), () => w, c);
    }
  }
}

// Note head with a stem melting out of it, capped by a dot, a flag, or nothing.
function snipStem(L) {
  const yy = ly(L, L.li);
  const up = random() < 0.5 ? -1 : 1;
  const len = u * random(3, 8) * bs;
  const ey = yy + up * len;
  const r = random();
  const capD = r < 0.4 ? dotD() * random(0.5, 1) : 0;
  rod(0, yy, 0, ey, L.col, dotD(), capD);
  dot(0, yy, L.col);
  if (capD > 0) dot(0, ey, random() < 0.3 ? pickColor() : L.col, capD);
  else if (r < 0.65) {
    const fl = u * random(1.5, 3) * bs;
    rod(0, ey, L.dir * fl, ey - up * fl * 0.6, L.col, u * 0.8 * bs, 0, hairW());
  }
}

// Vertical stack of dots, sometimes joined by a rod.
function snipChord(L) {
  const n = floor(random(2, 5));
  const gap = random() < 0.5 ? 1 : 2;
  const multi = random() < 0.4;
  const top = ly(L, L.li), bottom = ly(L, L.li + (n - 1) * gap);
  if (random() < 0.5) rod(0, top, 0, bottom, L.col);
  for (let k = 0; k < n; k++) dot(0, ly(L, L.li + k * gap), multi ? pickColor() : L.col);
}

// Tall tapered arch: rises from a dot, thins across the top, and comes down
// to a small drop (or nothing) on the other side.
function snipArch(L) {
  const y0 = ly(L, L.li);
  const span = u * random(3, 12) * bs * L.dir;
  const rise = u * random(5, 16) * bs * (random() < 0.7 ? -1 : 1);
  const y1 = y0 + random(-u * 3, u * 3) * bs;
  const pts = bezierPts(0, y0, span * 0.05, y0 + rise * 1.25, span * 0.95, y1 + rise * 1.25, span, y1, 60);
  const d0 = dotD() * random(0.8, 1.1);
  const d1 = random() < 0.7 ? dotD() * random(0.35, 0.7) : 0;
  path(pts, meltProfile(hairW() * random(1, 1.6), d0, d1, 0.2), L.col);
  dot(0, y0, L.col, d0);
  if (d1 > 0) dot(span, y1, L.col, d1);
}

// A hook: dot with a tail that drops and curls, ending in a tiny drop.
function snipHook(L) {
  const y0 = ly(L, L.li);
  const down = random() < 0.6 ? 1 : -1;
  const h = u * random(4, 10) * bs;
  const w = u * random(1.5, 4) * bs * L.dir;
  const pts = bezierPts(0, y0, 0, y0 + down * h * 0.9, w * 0.2, y0 + down * h * 1.1, w, y0 + down * h * 0.8, 50);
  const dTip = dotD() * random(0.3, 0.55);
  path(pts, meltProfile(hairW() * random(1, 1.5), dotD(), dTip, 0.3), L.col);
  dot(0, y0, L.col);
  dot(w, y0 + down * h * 0.8, L.col, dTip);
}

// A dot with several hairline curves fanning out to smaller dots.
function snipFan(L) {
  const y0 = ly(L, L.li);
  const n = floor(random(2, 4));
  dot(0, y0, L.col);
  for (let i = 0; i < n; i++) {
    const len = u * random(6, 16) * bs;
    const a = random(-0.9, 0.9) + (L.dir < 0 ? PI : 0);
    const bend = u * random(-5, 5) * bs;
    const ex = cos(a) * len, ey = y0 + sin(a) * len;
    const nx = -sin(a), ny = cos(a);
    const pts = bezierPts(0, y0, ex * 0.4 + nx * bend, y0 + (ey - y0) * 0.4 + ny * bend, ex * 0.75, ey - (ey - y0) * 0.25, ex, ey, 40);
    const d1 = dotD() * random(0.35, 0.7);
    path(pts, meltProfile(hairW(), dotD(), d1, 0.25), L.col);
    dot(ex, ey, random() < 0.3 ? pickColor() : L.col, d1);
  }
}

// Two facing arcs like a pair of parentheses, with a small dot between.
function snipParens(L) {
  const y0 = ly(L, L.li);
  const h = u * random(4, 12) * bs;
  const gap = u * random(2, 6) * bs;
  const bow = u * random(1, 3) * bs;
  const horizontal = random() < 0.5;
  const w = hairW() * random(1, 1.4);
  const prof = t => w + (w * 1.6) * sin(t * PI);
  for (const s of [-1, 1]) {
    let pts;
    if (horizontal) {
      pts = bezierPts(-h / 2, y0 + s * gap / 2, -h / 6, y0 + s * (gap / 2 + bow), h / 6, y0 + s * (gap / 2 + bow), h / 2, y0 + s * gap / 2, 40);
    } else {
      pts = bezierPts(s * gap / 2, y0 - h / 2, s * (gap / 2 + bow), y0 - h / 6, s * (gap / 2 + bow), y0 + h / 6, s * gap / 2, y0 + h / 2, 40);
    }
    path(pts, prof, L.col);
  }
  if (random() < 0.7) dot(0, y0, random() < 0.4 ? pickColor() : L.col, dotD() * random(0.5, 1));
}

// A spiral that unwinds from a dot, thinning as it goes.
function snipSpiral(L) {
  const y0 = ly(L, L.li);
  const turns = random(1.2, 2.5);
  const rMax = u * random(2, 5) * bs;
  const cw = random() < 0.5 ? 1 : -1;
  const a0 = random(TWO_PI);
  const pts = samplePath(t => {
    const a = a0 + cw * t * turns * TWO_PI;
    const r = rMax * pow(t, 0.8);
    return [cos(a) * r, y0 + sin(a) * r];
  }, 90);
  // the dot sits at the outer end, the line thins toward the centre
  pts.reverse();
  path(pts, meltProfile(hairW(), dotD(), dotD() * 0.3, 0.2), L.col);
  dot(pts[0][0], pts[0][1], L.col);
}

// A cross of melting rods radiating from a centre dot.
function snipCross(L) {
  const y0 = ly(L, L.li);
  const arms = floor(random(3, 5));
  const a0 = random() < 0.6 ? 0 : random(PI);
  dot(0, y0, L.col, dotD() * 1.1);
  for (let i = 0; i < arms; i++) {
    const a = a0 + i * TWO_PI / arms + random(-0.15, 0.15);
    const len = u * random(2.5, 7) * bs;
    const d1 = random() < 0.7 ? dotD() * random(0.5, 1) : 0;
    rod(0, y0, cos(a) * len, y0 + sin(a) * len, L.col, dotD() * 1.1, d1, thinW() * random(0.8, 1.4));
    if (d1 > 0) dot(cos(a) * len, y0 + sin(a) * len, L.col, d1);
  }
}

// An organic ink blob, sometimes trailing a rod to a small dot.
function snipBlob(L) {
  const y0 = ly(L, L.li);
  const base = u * random(1.4, 3) * bs;
  const stretch = random(1, 2.2);
  const seed = random(1000);
  const rot = random(-0.5, 0.5);
  const steps = 28;
  const pts = [];
  for (let k = 0; k <= steps + 3; k++) {
    const t = (k % steps) / steps * TWO_PI;
    const r = base * (0.7 + 0.6 * noise(seed + cos(t) * 1.3, seed + sin(t) * 1.3));
    const px = cos(t) * r * stretch, py = sin(t) * r;
    pts.push([px * cos(rot) - py * sin(rot), px * sin(rot) + py * cos(rot)]);
  }
  rec.push({ k: 'blob', pts, cx: 0, cy: y0, col: L.col });
  if (random() < 0.45) {
    const a = random(TWO_PI);
    const len = u * random(4, 10) * bs;
    const d1 = dotD() * random(0.4, 0.8);
    rod(0, y0, cos(a) * len, y0 + sin(a) * len, L.col, base * 1.6, d1);
    dot(cos(a) * len, y0 + sin(a) * len, L.col, d1);
  }
}

// A thick painterly swipe that thins out toward its end.
function snipSwipe(L) {
  const y0 = ly(L, L.li);
  const len = u * random(5, 14) * bs;
  const w = u * random(0.9, 1.6) * bs;
  const a = random(-0.6, 0.6) + (L.dir < 0 ? PI : 0);
  const nx = -sin(a), ny = cos(a);
  const wobble = u * random(-4, 4) * bs;
  const x2 = cos(a) * len, y2 = y0 + sin(a) * len;
  const pts = bezierPts(
    0, y0,
    cos(a) * len * 0.33 + nx * wobble, y0 + sin(a) * len * 0.33 + ny * wobble,
    cos(a) * len * 0.66 - nx * wobble * 0.5, y0 + sin(a) * len * 0.66 - ny * wobble * 0.5,
    x2, y2, 50);
  const taper = random() < 0.6;
  path(pts, t => taper ? max(hairW(), w * pow(1 - t, 1.3)) : w, L.col);
}

// ---------------------------------------------------------------- UI

function clearAll() {
  paint.clear();
  staffLayer.clear();
  active = [];
  ribbonQueue = [];
}

function keyPressed() {
  if (key >= '1' && key <= '5') colorLock = COLOR_KEYS[int(key) - 1];
  else if (key === '0') colorLock = null;
  else if (key === '[') bs = max(0.4, bs / 1.2);
  else if (key === ']') bs = min(4, bs * 1.2);
  else if (key === '-') density = max(0.25, density / 1.4);
  else if (key === '=' || key === '+') density = min(6, density * 1.4);
  else if (key === ' ') { autoFill(); updateHUD(); return false; }
  else if (key === 'e' || key === 'E') eraser = !eraser;
  else if (key === 'g' || key === 'G') showStaff = !showStaff;
  else if (key === 'c' || key === 'C') clearAll();
  else if (key === 'r' || key === 'R') { clearAll(); u = floor(random(7, 13)); }
  else if (key === 's' || key === 'S') saveCanvas('score-brush', 'png');
  else if (key === 'h' || key === 'H') toggleHUD();
  updateHUD();
}

function updateHUD() {
  const sw = document.getElementById('swatch');
  if (sw) {
    sw.style.background = colorLock
      ? PALETTE[colorLock]
      : 'conic-gradient(#1b1b1b, #e2242b, #2a4fa8, #1d9a47, #f4d500, #1b1b1b)';
  }
  setStatus(
    `color: ${colorLock || 'random'}  size: ${bs.toFixed(2)}  density: ${density.toFixed(2)}` +
    (eraser ? '  [ERASER]' : ''));
}
