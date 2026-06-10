# Syntactic Trees in Forest

Render LaTeX **`forest`**-style syntactic trees inline in Obsidian notes.
Node labels go through Obsidian's MathJax pipeline, so primes (`X$'$`),
superscripts (`X$^0$`), subscripts and arbitrary inline math just work.

The plugin focuses on the subset of `forest` that linguists actually use for
syntactic trees: bracket syntax, per-node options, the `for tree` propagator,
edge labels, triangle (roof) phrases, and `\draw`-style movement arrows
between named nodes.

---

## Usage

Trees live in fenced **`forest`** code blocks:

````markdown
```forest
[CP
  [DP, name=who [who]]
  [C$'$
    [C [did]]
    [TP
      [DP [Mary]]
      [T$'$
        [T [see]]
        [VP, name=tr, roof [$t_i$]]]]]]
\draw[->] (who) to[out=south, in=south] (tr);
```
````

The plugin processes the source as `forest`-package syntax and emits an
inline SVG. Labels are MathJax-rendered, so anything between `$…$` typesets
properly.

---

## Bracket syntax

Every node sits in `[ … ]`. Children are nested directly:

```
[Parent [Child1] [Child2 [Grandchild]]]
```

To put a literal `[`, `]`, `,`, or `=` into a label, brace-protect that
chunk: `[{a, b}]`.

### Per-node options

A comma after the node content introduces a comma-separated option list:

```
[VP, draw, name=verb, tier=word]
```

| Option              | Effect                                                                    |
| ------------------- | ------------------------------------------------------------------------- |
| `name=<id>`         | Names the node so movement arrows can target it                            |
| `tier=<tier>`       | Aligns all nodes sharing a tier name to the same horizontal line          |
| `roof` / `triangle` | Draws a triangle from the parent down to this node (phrasal shorthand)     |
| `draw`              | Outlines the node with a rectangle                                        |
| `circle`            | Outlines the node with a circle                                           |
| `phantom`           | Reserves layout space but draws nothing — useful for alignment            |
| `parent anchor=south\|center` | Where the edge leaving this node downward attaches              |
| `child anchor=north\|center`  | Where the edge entering this node from above attaches           |
| `edge label={...}`  | Italic label on the edge between this node and its parent                 |

### Inheritance: `for tree` and `for descendants`

Apply options to a node *and* all its descendants:

```
[CP, for tree={parent anchor=south, child anchor=north}
  [DP] [C$'$ [C] [TP]]]
```

`for descendants={...}` does the same but excludes the node itself.

### Math in labels

Anything between `$…$` in a node label is rendered with MathJax:

| You type         | You get   |
| ---------------- | --------- |
| `X$'$`           | X′        |
| `X$^0$`          | X⁰        |
| `t$_i$`          | tᵢ        |
| `$\overline{X}$` | X̄         |

---

## Sizing trees and nodes

Forest's TeX-dimension size options can sit on any node — root or interior —
and apply locally:

| Option            | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `s sep=X`         | Sibling separation among **this node's children**         |
| `l sep=X`         | Level separation between **this node and its children**   |
| `s sep+=X`        | Add to the global sibling separation                     |
| `l sep+=X`        | Add to the global level separation                       |
| `inner sep=X`     | Padding inside each node label                           |
| `inner xsep=X`    | Horizontal-only padding                                  |
| `inner ysep=X`    | Vertical-only padding                                    |
| `font size=X`     | Label font size                                          |

`X` is a TeX dimension: `pt`, `pc`, `bp`, `cm`, `mm`, `em`, `ex`, `in`, `px`,
or a bare number (= pixels). 1 pt ≈ 1.333 px, 1 cm ≈ 37.8 px at 96 dpi.

Local overrides on inner nodes only affect that node's children:

```forest
[VP                              ← root spacing default
  [DP [Mary]]
  [V$'$, s sep=18pt, l sep=28pt  ← V's subtree breathes out, rest stays tight
    [V [saw]]
    [DP [John]]]]
```

To apply to a whole subtree, use the propagator:

```forest
[CP
  [DP]
  [C$'$
    [C]
    [TP, for tree={l sep=22pt, s sep=14pt}
      [DP] [T$'$ [T] [VP]]]]]
```

---

## Movement arrows

After the tree, you can add `\draw` commands between nodes:

```
[CP
  [DP, name=moved [who]]
  [C$'$ [C] [TP [DP [Mary]] [T$'$ [T] [VP [V [saw]] [DP, name=trace [$t_i$]]]]]]
]
\draw[->] (moved) to (trace);
\draw[->, dashed] (a) to[bend left=45] (b);
\draw[->, dotted] (a) to node{move} (b);
\draw[->, solid] (a) -- (b);
```

Recognised within each `\draw`:

| Token                 | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `\draw[-> …]`         | Style block. Recognises `dashed`, `dotted`, `solid` (default is dashed)  |
| `(name)`              | Reference a node by its `name=` option **or** by its content text         |
| `to[…]`               | Curved arrow with option block (see below)                                |
| `to`                  | Default: drape below the tree                                             |
| `--`                  | Straight line (TikZ syntax)                                              |
| `node{label}`         | Italic label placed near the arrow's apex                                |

### Direction control: `to[out=A, in=B]`

Per TikZ semantics, `out=A` and `in=B` set both the **attachment point** on
the node boundary AND the **tangent direction** there. The attachment is the
intersection of the ray from the node's centre at angle A with the node's
bounding box. So `out=south` attaches at the south boundary and the curve
leaves heading south.

You can use compass names or polar angles
(0°=east, 90°=north, 180°=west, 270°=south):

```
\draw[->] (a) to[out=south,      in=south]      (b);
\draw[->] (a) to[out=south west, in=south]      (b);
\draw[->] (a) to[out=east,       in=west]       (b);
\draw[->] (a) to[out=270,        in=180]        (b);
\draw[->] (a) to[out=south east, in=north west, looseness=1.4] (b);
```

Compass-name → angle:
`east`=0°, `north east`=45°, `north`=90°, `north west`=135°,
`west`=180°, `south west`=225°, `south`=270°, `south east`=315°.

Whitespace inside compound names is tolerated. An optional `looseness=N`
(default 1) scales how strongly the tangent is enforced — higher values
exaggerate the curve.

### Bend modifiers

`bend left=N` and `bend right=N` rotate the tangent angles. Combined with
`out`/`in`, they add N° CCW to `out` and subtract N° from `in` (for `bend
left`), bowing the curve further to that side of the path direction:

```
\draw[->] (a) to[out=south, in=east]                 (b);   ← baseline
\draw[->] (a) to[out=south, in=east, bend left=20]   (b);   ← bows more left
\draw[->] (a) to[out=south, in=east, bend right=20]  (b);   ← bows more right
```

Used alone (without `out`/`in`), `bend left=N` / `bend right=N` produce a
quadratic curve bowing to that side of the direct line.

### Anchor shorthand: `(name.south)`

For simple cases you can also pin an endpoint to a named anchor directly:
`(name.south)`, `(name.east)`, `(name.north west)`, etc. This is shorthand
that pins the attachment point and uses the corresponding outward tangent
direction. The full TikZ list is supported:

`north`, `south`, `east`, `west`, `north east`, `north west`, `south east`,
`south west`, `center`.

When you give neither an anchor nor `out=/in=`, the renderer auto-picks the
side of each node facing the other endpoint.

### Arrowheads

Drawn geometrically as filled triangles oriented along the curve's tangent
at the endpoint — no dependence on SVG `<marker>` definitions, which makes
them robust across themes and embedded-SVG quirks. Style mimics TikZ's
default `>` (slim, slightly concave back).

---

## Settings

A settings tab exposes the global visual defaults: level separation, sibling
separation, subtree separation, label font size, edge stroke width, and a
toggle to outline every node by default. Per-tree options (above) override
these locally.

---

## Styling

The default look is aligned with TikzJax-rendered TikZ output (Computer-
Modern-style serif text, thin crisp lines, refined arrow tips). Customize
further with a CSS snippet targeting any of:

| Selector                | What it controls                                       |
| ----------------------- | ------------------------------------------------------ |
| `.forest-svg`           | The root SVG. Set `font-family`, `color`, `font-size`  |
| `.forest-label-wrap`    | Wrapper around each node label                         |
| `.forest-edges`         | Group containing all tree edges                        |
| `.forest-edge`          | Each individual tree edge (line or roof)               |
| `.forest-roof`          | The triangle of a `roof`/`triangle` node               |
| `.forest-arrows`        | Group containing all movement arrows                   |
| `.forest-movement`      | Each arrow's curve (the line, not the head)            |
| `.forest-arrowhead`     | The filled triangle at the arrow tip                   |
| `.forest-edge-label`    | Italic label next to a tree edge                       |
| `.forest-movement-label`| Italic label near an arrow's apex                      |
| `.forest-node-shape`    | The bounding box drawn around `draw`/`circle` nodes    |

All strokes and fills resolve through `currentColor`, set from
`color: var(--text-normal)` on the SVG. So one rule recolors everything:

```css
.forest-svg { color: #003366; font-family: "EB Garamond", serif; }
```

Dark mode is automatic because `--text-normal` flips with the theme.

---

## Installation

1. Download `main.js`, `manifest.json`, `styles.css` from the release.
2. Drop them into `<your-vault>/.obsidian/plugins/obsidian-forest/`.
3. Reload plugins in Obsidian settings, then enable **Forest Syntactic
   Trees**.

To build from source:

```sh
npm install
npm run build
```

---

## What this plugin is *not*

It is not a complete port of the `forest` LaTeX package. `forest` is a
TikZ/PGF DSL with conditionals, dynamic trees, aggregate functions, custom
handlers, externalization, etc. — none of which is sensible to reimplement
in JavaScript. This plugin covers the slice syntacticians reach for daily:
bracket trees, primes and bars in labels, triangles, named nodes, movement
arrows, and TikZ-style direction control via `out=/in=` and `bend`.

## Verifying which version is running

Every rendered SVG carries a `data-forest-version` attribute (visible in
dev tools), and the plugin logs `[forest] plugin loaded — v<version>` on
load. If a feature isn't behaving as documented, check these first to
confirm the bundle on disk is the one Obsidian actually loaded.

## License

GNU AGPL 3.0.
