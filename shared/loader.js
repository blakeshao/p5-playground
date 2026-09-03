// Brush picker. Reads ?brush=<name> from the URL (default: the first entry),
// fills the <select>, and loads that brush's sketch. Switching brushes reloads
// the page with the new name so the chosen sketch owns p5's global mode.
// Other URL params (e.g. ?auto) are passed through to the sketch.

const BRUSHES = [
  ['score', 'Score Brush'],
  ['schematic', 'Schematic Brush'],
  ['balloon', 'Balloon Brush'],
];

(function loadBrush() {
  const params = new URLSearchParams(location.search);
  const known = BRUSHES.map(b => b[0]);
  const name = known.includes(params.get('brush')) ? params.get('brush') : known[0];

  const sel = document.getElementById('brush');
  for (const [key, title] of BRUSHES) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = title;
    sel.appendChild(opt);
  }
  sel.value = name;
  sel.addEventListener('change', () => {
    params.set('brush', sel.value);
    location.search = params.toString();
  });

  // written synchronously so the sketch is parsed before p5 starts on load
  document.write(`<script src="brushes/${name}/sketch.js"><\/script>`);
})();
