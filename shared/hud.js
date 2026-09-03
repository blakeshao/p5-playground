// Shared page chrome for every brush.
//
// A brush declares `const BRUSH = { name, swatch, help }` where `help` is a
// list of [keys, effect] pairs, and calls buildHUD() from setup(). It then
// writes its live state into #status with setStatus(), and may colour
// #swatch if it declared `swatch: true`.

function buildHUD(brush) {
  const help = document.getElementById('help');
  const swatch = document.getElementById('swatch');
  if (!help) return;
  help.innerHTML = '';
  for (const [keys, effect] of brush.help) {
    const row = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = keys;
    row.appendChild(b);
    row.appendChild(document.createTextNode(effect));
    help.appendChild(row);
  }
  document.title = `${brush.name} — p5.js`;
  if (swatch) swatch.classList.toggle('hidden', !brush.swatch);
}

function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function toggleHUD() {
  document.getElementById('hud').classList.toggle('hidden');
}

// True when a mouse event landed on the sketch canvas rather than on the
// picker or help panel, so UI clicks do not start strokes.
function onCanvas(e) {
  return !e || !e.target || e.target.tagName === 'CANVAS';
}

// The brush cursor, shared by every brush: one plain black dot, the same size
// whatever the brush, the mode, or the brush-size setting.
const CURSOR_DOT = 5;

function drawBrushCursor() {
  if (mouseX < 0 || mouseY < 0 || mouseX > width || mouseY > height) return;
  noStroke();
  fill(0);
  circle(mouseX, mouseY, CURSOR_DOT);
}
