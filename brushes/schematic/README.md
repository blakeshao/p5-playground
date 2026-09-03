# Schematic Brush

A p5.js brush that drafts randomized technical schematics along each stroke,
black ink on a white page, annotated only with random numbers. Two drafting
languages are mixed:

- **patch** — modular-synth patch diagrams: crosshair pins, rounded modules,
  stacked sequencer cells, hubs, sweeping bezier patch cables, loop-backs to
  earlier nodes, little port clusters and chart insets.
- **cad** — site-plan drafting: callout bubbles on leaders, section-marker
  diamonds, dimension lines with extension lines and tick slashes, nested
  bowl contours, hatching, numbered arrows and leader notes.

Nodes are snapped to an invisible drafting grid at intervals along the
stroke and wired to the previous node. Every number is placed clear of the
numbers and node bodies already on the page: it is nudged through a few
nearby spots and dropped if none is free. Everything is drawn in like a pen
plotter: lines extend at a fixed pen speed and numbers type themselves out.

The ink is wet. Every line keeps its true geometry but its weight swells
and thins along its length, and it bleeds into the paper: layered, uneven
wicking that fades outward, short fibers drawn sideways along the grain,
and grains of pigment caught just off the line. Ink pools where the pen
lands and lifts, with lobed bleed around the pool, and sometimes drips. Blots have ragged
outlines, numbers bleed into the paper, and most stamps throw specks.

## Run

Open `index.html` at the repo root and pick Schematic Brush, or open
`index.html?brush=schematic` directly.

- `&auto` starts with a page that drafts itself.
- `&style=patch`, `&style=cad` or `&style=mixed` presets the style.
- `&mirror` turns on mirroring.

## Controls

| Key / action | Effect |
| --- | --- |
| drag | draft nodes, wiring and annotations along the stroke |
| click | a single node with a number and an annotation |
| `1` `2` `3` | lock style to patch / cad / mixed |
| `0` | random style per stroke |
| `[` `]` | brush size down / up |
| `-` `=` | density down / up |
| `m` | mirror every stamp across the page centre |
| `space` | auto-fill the page |
| `e` | toggle eraser |
| `c` | clear everything |
| `r` | clear and pick a new grid module (spacing and scale) |
| `s` | save PNG |
| `h` | hide / show the help panel |

## Tweaking

Everything in `sketch.js` is built from `u`, the grid module. `PATCH_NODES`
and `CAD_NODES` weight which node kinds are chosen per style, `num`,
`smallNum` and `refNum` generate the annotations, and `W` sets the line
weights. `decorate` holds the per-node probabilities for each annotation,
and `PEN_SPEED` / `CHAR_MS` control how fast marks draw in. `INK` holds the
wet-ink character: resample step, sideways wobble (0 keeps lines straight),
blot raggedness, bleed reach and alpha, fiber and grain density, and the
chances of pooling, blobs, drips and specks. `txt` does the
collision-aware placement against `boxes`; `txtRaw` skips it for numbers
that sit inside a bubble or marker.

Marks are recorded through `ink` (polylines, optionally dashed or filled),
`txt` and `blot`, then `commit` schedules them one after another like a
single pen and `renderStamp` reveals them at the current progress.
