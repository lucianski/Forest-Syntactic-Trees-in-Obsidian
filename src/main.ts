/* =====================================================================
 *  Obsidian Forest — render LaTeX `forest`-style syntactic trees inline
 *  ---------------------------------------------------------------------
 *  Architecture
 *  ------------
 *   1.  Parser     — recursive-descent over forest's bracket syntax,
 *                    supporting options (key / key=value, braced values),
 *                    the `for tree={...}` propagator, and post-tree
 *                    \draw arrows used for movement.
 *   2.  Layout     — tidy-tree layout (Reingold–Tilford style) with
 *                    per-subtree contour merging, per-parent sibling and
 *                    level separation, optional `tier=` alignment.
 *   3.  Renderer   — emits SVG.  Each node label is rendered through
 *                    Obsidian's MathJax (renderMath) so that X', X⁰,
 *                    subscripts, primes and any inline LaTeX work.
 *   4.  Registration — a single Markdown code-block processor for the
 *                    ```forest fence.
 *  ===================================================================== */

import {
  App,
  MarkdownRenderChild,
  Plugin,
  PluginSettingTab,
  Setting,
  finishRenderMath,
  renderMath,
} from "obsidian";

/** Build identifier — also written into every rendered SVG as
 *  `data-forest-version`, so you can verify in dev-tools that the bundle
 *  Obsidian is actually running is the one you think it is. */
const FOREST_VERSION = "1.2.5";

/* ===================================================================== *
 *  Settings                                                              *
 * ===================================================================== */

interface ForestSettings {
  levelSep: number;        // vertical gap between tree levels (px)
  siblingSep: number;      // minimum horizontal gap between siblings (px)
  subtreeSep: number;      // minimum gap between sibling subtrees (px)
  nodeHPad: number;        // horizontal padding around node label
  nodeVPad: number;        // vertical padding around node label
  fontSize: number;        // base label font size
  edgeStrokeWidth: number; // line width for edges
  drawNodes: boolean;      // draw node bounding boxes by default
  defaultParentAnchor: "south" | "center";
  defaultChildAnchor: "north" | "center";
}

const DEFAULT_SETTINGS: ForestSettings = {
  // Defaults tuned to match typical TikzJax-rendered tree sizes:
  //   ~10pt text, ~1cm level distance, tight sibling gap, slim strokes.
  // All can be increased in the settings tab if you want airier trees.
  levelSep: 32,
  siblingSep: 6,
  subtreeSep: 14,
  nodeHPad: 4,
  nodeVPad: 1.5,
  fontSize: 11,
  edgeStrokeWidth: 0.65,
  drawNodes: false,
  defaultParentAnchor: "south",
  defaultChildAnchor: "north",
};

/* ===================================================================== *
 *  Parser                                                                *
 * ===================================================================== */

interface FNode {
  content: string;                // raw label source (may contain $..$)
  options: Record<string, string | true>;
  children: FNode[];
  // resolved after layout
  x?: number;                     // centre x
  y?: number;                     // centre y (vertical centre of label)
  w?: number;                     // label width
  h?: number;                     // label height
  prelim?: number;
  modifier?: number;
  parent?: FNode;
  depth?: number;
}

interface DrawArrow {
  from: string;
  to: string;
  style: string;                  // "->", "->>", etc.
  bend?: string;                  // e.g. "out=south west,in=south"
  label?: string;                 // text on midway label, if any
}

interface ForestAST {
  root: FNode;
  arrows: DrawArrow[];
}

class ForestParser {
  private src: string;
  private pos = 0;

  constructor(src: string) {
    // strip \begin{forest} / \end{forest} wrappers if present
    this.src = src
      .replace(/\\begin\s*\{forest\}/g, "")
      .replace(/\\end\s*\{forest\}/g, "")
      .trim();
  }

  parse(): ForestAST {
    this.skipWS();
    // optional preamble keys before the first `[` — apply to root
    const preamble = this.tryParsePreamble();

    if (this.peek() !== "[") {
      throw new Error("Forest: expected '[' at start of tree");
    }
    const root = this.parseNode();
    if (preamble) {
      for (const [k, v] of Object.entries(preamble)) {
        if (root.options[k] === undefined) root.options[k] = v;
      }
    }

    // post-tree: \draw arrows and trailing whitespace
    const arrows: DrawArrow[] = [];
    this.skipWS();
    while (this.pos < this.src.length) {
      const arrow = this.tryParseDraw();
      if (arrow) {
        arrows.push(arrow);
        this.skipWS();
        continue;
      }
      // unknown trailing token — stop quietly to be forgiving
      break;
    }
    return { root, arrows };
  }

  /* ----- core parse routines ----- */

  private parseNode(): FNode {
    this.expect("[");
    // content: text up to ',' (options), '[' (children), or ']' (close)
    const content = this.readBalanced(/[,[\]]/).trim();
    const options: Record<string, string | true> = {};

    // options block
    if (this.peek() === ",") {
      this.pos++; // consume ,
      this.parseOptionList(options);
    }

    const children: FNode[] = [];
    this.skipWS();
    while (this.peek() === "[") {
      const child = this.parseNode();
      child.parent = undefined; // set during layout pass
      children.push(child);
      this.skipWS();
    }
    this.expect("]");
    return { content, options, children };
  }

  /** Parses comma-separated options into `out`. Stops at `[` or `]`. */
  private parseOptionList(out: Record<string, string | true>): void {
    while (true) {
      this.skipWS();
      const c = this.peek();
      if (c === "[" || c === "]" || c === "") return;
      // read key
      const key = this.readBalanced(/[,=[\]]/).trim();
      let value: string | true = true;
      this.skipWS();
      if (this.peek() === "=") {
        this.pos++;
        this.skipWS();
        value = this.readOptionValue();
      }
      if (key) out[key] = value;
      this.skipWS();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      return;
    }
  }

  /** Reads an option value: either a brace-delimited block or up to comma/bracket. */
  private readOptionValue(): string {
    this.skipWS();
    if (this.peek() === "{") {
      return this.readBraceGroup();
    }
    return this.readBalanced(/[,[\]]/).trim();
  }

  /** Reads `{...}` returning the *inside* of the braces. */
  private readBraceGroup(): string {
    if (this.peek() !== "{") throw new Error("Forest: expected '{'");
    this.pos++; // skip {
    let depth = 1;
    let out = "";
    while (this.pos < this.src.length && depth > 0) {
      const ch = this.src[this.pos];
      if (ch === "{") {
        depth++;
        out += ch;
        this.pos++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          this.pos++;
          break;
        }
        out += ch;
        this.pos++;
      } else if (ch === "\\" && this.pos + 1 < this.src.length) {
        // keep escaped chars verbatim
        out += ch + this.src[this.pos + 1];
        this.pos += 2;
      } else {
        out += ch;
        this.pos++;
      }
    }
    return out;
  }

  /** Reads characters until one of the stop chars (in regex class), respecting
   *  brace nesting and `$...$` math segments — so commas / brackets inside
   *  TeX math or braces don't terminate.                                       */
  private readBalanced(stop: RegExp): string {
    let out = "";
    let inMath = false;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (!inMath && ch === "{") {
        const grp = this.readBraceGroup();
        out += "{" + grp + "}";
        continue;
      }
      if (ch === "$") {
        inMath = !inMath;
        out += ch;
        this.pos++;
        continue;
      }
      if (!inMath && stop.test(ch)) break;
      if (ch === "\\" && this.pos + 1 < this.src.length) {
        out += ch + this.src[this.pos + 1];
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos++;
    }
    return out;
  }

  /** Optional preamble: `key=val, key2={...} [tree]` */
  private tryParsePreamble(): Record<string, string | true> | null {
    const save = this.pos;
    this.skipWS();
    if (this.peek() === "[") return null;
    const opts: Record<string, string | true> = {};
    this.parseOptionList(opts);
    if (Object.keys(opts).length === 0) {
      this.pos = save;
      return null;
    }
    return opts;
  }

  /** Recognises a small subset of TikZ:
   *      \draw[->] (a) to[bend left] (b);
   *      \draw[->,dotted] (a) to (b);
   *      \draw[->] (a) to[bend right=20] node[midway,above]{trace} (b);
   */
  private tryParseDraw(): DrawArrow | null {
    const save = this.pos;
    this.skipWS();
    if (!this.src.startsWith("\\draw", this.pos)) return null;
    this.pos += "\\draw".length;
    this.skipWS();
    let style = "->";
    if (this.peek() === "[") {
      const opt = this.readBraceLike("[", "]");
      style = opt;
    }
    this.skipWS();
    if (this.peek() !== "(") {
      this.pos = save;
      return null;
    }
    const from = this.readBraceLike("(", ")");
    this.skipWS();
    // accept "to" (curved) OR "--" (straight), like TikZ/TikZJax
    let isStraight = false;
    if (this.src.startsWith("to", this.pos)) {
      this.pos += 2;
    } else if (this.src.startsWith("--", this.pos)) {
      this.pos += 2;
      isStraight = true;
    } else {
      this.pos = save;
      return null;
    }
    let bend: string | undefined;
    let label: string | undefined;
    this.skipWS();
    if (this.peek() === "[") bend = this.readBraceLike("[", "]");
    this.skipWS();
    // optional `node[...]{label}` between `to` and the second `(`
    if (this.src.startsWith("node", this.pos)) {
      this.pos += 4;
      this.skipWS();
      if (this.peek() === "[") this.readBraceLike("[", "]"); // ignore options
      this.skipWS();
      if (this.peek() === "{") label = this.readBraceGroup();
      this.skipWS();
    }
    if (this.peek() !== "(") {
      this.pos = save;
      return null;
    }
    const to = this.readBraceLike("(", ")");
    this.skipWS();
    if (this.peek() === ";") this.pos++;
    return {
      from: from.trim(),
      to: to.trim(),
      style,
      bend: isStraight ? "straight" : bend,
      label,
    };
  }

  private readBraceLike(open: string, close: string): string {
    if (this.src[this.pos] !== open) return "";
    this.pos++;
    let depth = 1;
    let out = "";
    while (this.pos < this.src.length && depth > 0) {
      const ch = this.src[this.pos];
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          this.pos++;
          return out;
        }
      }
      out += ch;
      this.pos++;
    }
    return out;
  }

  /* ----- low-level helpers ----- */

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private expect(c: string): void {
    if (this.src[this.pos] !== c) {
      throw new Error(
        `Forest parse error: expected '${c}' at position ${this.pos}, got '${this.src[this.pos] ?? "EOF"}'`,
      );
    }
    this.pos++;
  }

  private skipWS(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
      this.pos++;
    }
  }
}

/* ===================================================================== *
 *  Option resolution: spread `for tree={...}` to descendants             *
 * ===================================================================== */

function resolveInheritance(node: FNode, inherited: Record<string, string | true> = {}): void {
  // merge inherited under current (current wins)
  for (const [k, v] of Object.entries(inherited)) {
    if (node.options[k] === undefined) node.options[k] = v;
  }
  // build inherited set for children
  let childInherit: Record<string, string | true> = { ...inherited };
  if (typeof node.options["for tree"] === "string") {
    const sub: Record<string, string | true> = {};
    const inner = node.options["for tree"];
    // re-parse the inner option list
    const parser = new ForestParser("[," + inner + "]");
    try {
      const ast = parser.parse();
      Object.assign(sub, ast.root.options);
    } catch {
      /* ignore — best-effort */
    }
    // current node also receives `for tree` keys
    for (const [k, v] of Object.entries(sub)) {
      if (node.options[k] === undefined) node.options[k] = v;
    }
    childInherit = { ...childInherit, ...sub };
  }
  // `for descendants` — applies only to descendants, not self
  let descInherit = { ...childInherit };
  if (typeof node.options["for descendants"] === "string") {
    const sub: Record<string, string | true> = {};
    const parser = new ForestParser("[," + node.options["for descendants"] + "]");
    try {
      const ast = parser.parse();
      Object.assign(sub, ast.root.options);
    } catch {
      /* ignore */
    }
    descInherit = { ...descInherit, ...sub };
  }
  for (const child of node.children) {
    child.parent = node;
    resolveInheritance(child, descInherit);
  }
}

/* ===================================================================== *
 *  Label measurement & MathJax rendering                                 *
 * ===================================================================== */

/** Renders a node label to an HTMLElement and measures it. Mixes plain text
 *  with `$...$` math segments rendered via Obsidian's renderMath().          */
async function renderLabel(
  raw: string,
  fontSize: number,
): Promise<{ el: HTMLElement; w: number; h: number }> {
  const wrap = activeDocument.createElement("span");
  wrap.className = "forest-label";
  wrap.setCssProps({ "--forest-label-font-size": `${fontSize}px` });

  // split on $...$ pairs, including $$...$$
  const segments: { text: string; math: boolean; display: boolean }[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith("$$", i)) {
      const end = raw.indexOf("$$", i + 2);
      if (end === -1) {
        segments.push({ text: raw.slice(i), math: false, display: false });
        break;
      }
      segments.push({ text: raw.slice(i + 2, end), math: true, display: true });
      i = end + 2;
    } else if (raw[i] === "$") {
      const end = raw.indexOf("$", i + 1);
      if (end === -1) {
        segments.push({ text: raw.slice(i), math: false, display: false });
        break;
      }
      segments.push({ text: raw.slice(i + 1, end), math: true, display: false });
      i = end + 1;
    } else {
      let j = i;
      while (j < raw.length && raw[j] !== "$") j++;
      segments.push({ text: raw.slice(i, j), math: false, display: false });
      i = j;
    }
  }

  for (const seg of segments) {
    if (seg.math) {
      const node = renderMath(seg.text, seg.display);
      wrap.appendChild(node);
    } else {
      // unescape forest's brace-protection
      const text = seg.text.replace(/\\\\/g, "\\");
      wrap.appendChild(activeDocument.createTextNode(text));
    }
  }

  // attach off-screen to measure
  const measureBox = activeDocument.createElement("div");
  measureBox.classList.add("forest-measure-box");
  measureBox.appendChild(wrap);
  activeDocument.body.appendChild(measureBox);
  await finishRenderMath();

  const rect = wrap.getBoundingClientRect();
  const w = Math.max(8, Math.ceil(rect.width));
  const h = Math.max(fontSize, Math.ceil(rect.height));
  activeDocument.body.removeChild(measureBox);

  return { el: wrap, w, h };
}

/* ===================================================================== *
 *  Layout — Reingold-Tilford / Walker tidy-tree, with tier support       *
 * ===================================================================== */

class Layout {
  constructor(private settings: ForestSettings) {}

  /** Mutates the tree, setting x, y, w, h on every node. */
  async layout(
    root: FNode,
    measure: (n: FNode) => Promise<{ w: number; h: number }>,
  ): Promise<void> {
    const all: FNode[] = [];
    this.walk(root, 0, undefined, all);
    // measure each node
    for (const n of all) {
      const { w, h } = await measure(n);
      n.w = w + 2 * this.settings.nodeHPad;
      n.h = h + 2 * this.settings.nodeVPad;
    }
    // Y assignment: walk top-down so each node's y is computed from its
    // parent's y plus the parent's local `l sep` (level separation) if set,
    // otherwise the global default. This lets users override level spacing
    // on any node, not just the root.
    const assignY = (n: FNode) => {
      if (!n.parent) {
        n.y = (n.h ?? 0) / 2; // root: top edge at y=0
      } else {
        const local = parseDim(n.parent.options["l sep"]);
        const ls = local !== null ? local : this.settings.levelSep;
        n.y = (n.parent.y ?? 0) + ls;
      }
      for (const c of n.children) assignY(c);
    };
    assignY(root);
    // tidy-tree X assignment
    this.firstWalk(root);
    this.secondWalk(root, -(root.prelim ?? 0));
    // tier alignment — group nodes with same `tier` and push them to the deepest y
    const tiers = new Map<string, FNode[]>();
    for (const n of all) {
      const t = n.options["tier"];
      if (typeof t === "string" && t) {
        if (!tiers.has(t)) tiers.set(t, []);
        tiers.get(t)!.push(n);
      }
    }
    for (const group of tiers.values()) {
      const maxY = Math.max(...group.map((n) => n.y ?? 0));
      for (const n of group) n.y = maxY;
    }
    // normalise so root x is at 0 and shift all rightward
    const minX = Math.min(...all.map((n) => (n.x ?? 0) - (n.w ?? 0) / 2));
    const dx = -minX + 4;
    for (const n of all) n.x = (n.x ?? 0) + dx;
  }

  private walk(n: FNode, depth: number, parent: FNode | undefined, all: FNode[]): void {
    n.depth = depth;
    n.parent = parent;
    n.prelim = 0;
    n.modifier = 0;
    all.push(n);
    for (const c of n.children) this.walk(c, depth + 1, n, all);
  }

  /** First walk: assign preliminary x, modifier per Walker's algorithm (simplified). */
  private firstWalk(n: FNode): void {
    if (n.children.length === 0) {
      const sibIdx = this.siblingIndex(n);
      if (sibIdx > 0) {
        const prev = n.parent!.children[sibIdx - 1];
        n.prelim = (prev.prelim ?? 0) + this.nodeSep(prev, n);
      } else {
        n.prelim = 0;
      }
      return;
    }
    for (const c of n.children) this.firstWalk(c);
    // shift later subtrees so their contours don't overlap earlier siblings
    for (let i = 1; i < n.children.length; i++) {
      this.resolveOverlap(n.children, i);
    }
    const first = n.children[0];
    const last = n.children[n.children.length - 1];
    const mid = ((first.prelim ?? 0) + (last.prelim ?? 0)) / 2;
    const sibIdx = this.siblingIndex(n);
    if (sibIdx > 0) {
      const prev = n.parent!.children[sibIdx - 1];
      n.prelim = (prev.prelim ?? 0) + this.nodeSep(prev, n);
      n.modifier = (n.prelim ?? 0) - mid;
    } else {
      n.prelim = mid;
    }
  }

  /** Push children[i] (and its modifier) rightward until it clears children[i-1]. */
  private resolveOverlap(children: FNode[], i: number): void {
    const left = children[i - 1];
    const right = children[i];
    const leftContour = this.rightContour(left, 0);
    const rightContour = this.leftContour(right, 0);
    const n = Math.min(leftContour.length, rightContour.length);
    let shift = 0;
    for (let d = 0; d < n; d++) {
      const needed = leftContour[d] + this.subtreeSep(left, right) - rightContour[d];
      if (needed > shift) shift = needed;
    }
    if (shift > 0) {
      right.prelim = (right.prelim ?? 0) + shift;
      right.modifier = (right.modifier ?? 0) + shift;
    }
  }

  private rightContour(n: FNode, mod: number, out: number[] = [], depth = 0): number[] {
    const x = (n.prelim ?? 0) + mod + (n.w ?? 0) / 2;
    if (out[depth] === undefined || x > out[depth]) out[depth] = x;
    for (const c of n.children) this.rightContour(c, mod + (n.modifier ?? 0), out, depth + 1);
    return out;
  }

  private leftContour(n: FNode, mod: number, out: number[] = [], depth = 0): number[] {
    const x = (n.prelim ?? 0) + mod - (n.w ?? 0) / 2;
    if (out[depth] === undefined || x < out[depth]) out[depth] = x;
    for (const c of n.children) this.leftContour(c, mod + (n.modifier ?? 0), out, depth + 1);
    return out;
  }

  private secondWalk(n: FNode, m: number): void {
    n.x = (n.prelim ?? 0) + m;
    for (const c of n.children) this.secondWalk(c, m + (n.modifier ?? 0));
  }

  private siblingIndex(n: FNode): number {
    if (!n.parent) return 0;
    return n.parent.children.indexOf(n);
  }

  private nodeSep(a: FNode, b: FNode): number {
    // `s sep` on the parent controls the gap between its children.
    const parent = a.parent;
    let sibSep = this.settings.siblingSep;
    if (parent) {
      const local = parseDim(parent.options["s sep"]);
      if (local !== null) sibSep = local;
    }
    return (a.w ?? 0) / 2 + (b.w ?? 0) / 2 + sibSep;
  }

  private subtreeSep(a: FNode, _b: FNode): number {
    const parent = a.parent;
    if (parent) {
      const local = parseDim(parent.options["s sep"]);
      if (local !== null) return Math.max(local, this.settings.subtreeSep);
    }
    return this.settings.subtreeSep;
  }
}

/* ===================================================================== *
 *  SVG renderer                                                          *
 * ===================================================================== */

class Renderer {
  constructor(private settings: ForestSettings) {}

  render(ast: ForestAST, labels: Map<FNode, HTMLElement>): SVGElement {
    const all: FNode[] = [];
    this.collect(ast.root, all);

    // build name -> node map for arrow targets (needed for bbox phase too)
    const named = new Map<string, FNode>();
    for (const n of all) {
      const nm = n.options["name"];
      if (typeof nm === "string") named.set(nm, n);
    }

    // ----- bounding-box calculation -----
    // Phase 1: node label boxes.
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    const expandX = (x: number) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    };
    const expandY = (y: number) => {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    for (const n of all) {
      if (n.options["phantom"]) continue;
      const x = n.x ?? 0,
        y = n.y ?? 0,
        w = n.w ?? 0,
        h = n.h ?? 0;
      expandX(x - w / 2);
      expandX(x + w / 2);
      expandY(y - h / 2);
      expandY(y + h / 2);
    }
    // Phase 2: roof bases (wider than the child label).
    for (const n of all) {
      for (const c of n.children) {
        if (n.options["phantom"] || c.options["phantom"]) continue;
        if (!(c.options["roof"] || c.options["triangle"])) continue;
        const labelW = c.w ?? 0;
        const baseW = Math.max(labelW + 20, 28);
        const cx = c.x ?? 0;
        expandX(cx - baseW / 2);
        expandX(cx + baseW / 2);
      }
    }
    // Phase 3: arrow control points + arrowhead clearance + labels.
    for (const a of ast.arrows) {
      const from = this.lookupNode(a.from, named, all);
      const to = this.lookupNode(a.to, named, all);
      if (!from || !to) continue;
      const geom = this.computeArrowGeometry(a, from, to);
      // bound by convex hull of all defining points (true for quadratic AND cubic)
      for (const pt of geom.points) {
        expandX(pt.x);
        expandY(pt.y);
      }
      // arrowhead clearance — ~10 px around the tip
      const tip = geom.points[geom.points.length - 1];
      expandX(tip.x - 10);
      expandX(tip.x + 10);
      expandY(tip.y - 10);
      expandY(tip.y + 10);
      if (a.label) {
        const apex = geom.kind === "cubic" ? geom.points[1] : geom.points[1];
        expandY(apex.y + 18);
      }
    }
    if (!isFinite(minX)) {
      minX = 0;
      maxX = 100;
      minY = 0;
      maxY = 100;
    }
    const pad = 12;
    minX -= pad;
    maxX += pad;
    minY -= pad;
    maxY += pad;

    const ns = "http://www.w3.org/2000/svg";
    const svg = activeDocument.createElementNS(ns, "svg");
    svg.setAttribute("xmlns", ns);
    const vbW = maxX - minX;
    const vbH = maxY - minY;
    svg.setAttribute("viewBox", `${minX} ${minY} ${vbW} ${vbH}`);
    // Explicit pixel dimensions equal to the viewBox so the SVG renders at
    // its NATURAL size (1 user unit = 1 px). Without these the SVG defaults
    // to 100% of its container width and the whole tree gets scaled up.
    // maxWidth:100% (in CSS) still lets us shrink if the container is too narrow.
    svg.setAttribute("width", String(vbW));
    svg.setAttribute("height", String(vbH));
    svg.setAttribute("class", "forest-svg");
    svg.setAttribute("data-forest-version", FOREST_VERSION);
    // Only the per-tree font size is dynamic; max-width, height:auto and the
    // currentColor anchor live in styles.css on `.forest-svg`.
    svg.setCssProps({ "--forest-svg-font-size": `${this.settings.fontSize}px` });

    // edges first (so they sit behind labels)
    const edgeGroup = activeDocument.createElementNS(ns, "g");
    edgeGroup.setAttribute("class", "forest-edges");
    edgeGroup.setAttribute("stroke", "currentColor");
    edgeGroup.setAttribute("fill", "none");
    edgeGroup.setAttribute("stroke-width", String(this.settings.edgeStrokeWidth));
    for (const n of all) {
      for (const c of n.children) {
        if (n.options["phantom"] || c.options["phantom"]) continue;
        const isRoof = !!(c.options["roof"] || c.options["triangle"]);
        if (isRoof) {
          // Linguistic phrasal triangle (forest's `\qroof` style).
          //   apex  = mother's south anchor
          //   base  = horizontal line just above the child label
          //   width = max(label_width + 2*pad, MIN_BASE_WIDTH)
          // The triangle attaches directly to the mother — no intermediate
          // vertical stub. With single-child layouts (the typical case)
          // mother.x = child.x, so the triangle is symmetric.
          const p1 = this.parentAnchor(n);
          const cBox = this.childBox(c);
          const labelW = cBox.right - cBox.left;
          const pad = 2;
          const minBaseWidth = 14;
          const baseW = Math.max(labelW + 2 * pad, minBaseWidth);
          const cx = c.x ?? 0;
          const baseY = cBox.top - 2;
          const leftX = cx - baseW / 2;
          const rightX = cx + baseW / 2;
          const path = activeDocument.createElementNS(ns, "path");
          path.setAttribute(
            "d",
            `M ${p1.x} ${p1.y} L ${leftX} ${baseY} L ${rightX} ${baseY} Z`,
          );
          path.setAttribute("class", "forest-edge forest-roof");
          path.setAttribute("stroke", "currentColor");
          path.setAttribute("fill", "none");
          edgeGroup.appendChild(path);
        } else {
          const p1 = this.parentAnchor(n);
          const p2 = this.childAnchor(c);
          const line = activeDocument.createElementNS(ns, "line");
          line.setAttribute("x1", String(p1.x));
          line.setAttribute("y1", String(p1.y));
          line.setAttribute("x2", String(p2.x));
          line.setAttribute("y2", String(p2.y));
          line.setAttribute("class", "forest-edge");
          edgeGroup.appendChild(line);
          // optional edge label (forest:  edge label={...})
          const elbl = c.options["edge label"];
          if (typeof elbl === "string") {
            const mx = (p1.x + p2.x) / 2;
            const my = (p1.y + p2.y) / 2;
            const text = activeDocument.createElementNS(ns, "text");
            text.setAttribute("x", String(mx + 4));
            text.setAttribute("y", String(my));
            text.setAttribute("class", "forest-edge-label");
            text.setAttribute("font-style", "italic");
            text.textContent = stripBraces(elbl);
            edgeGroup.appendChild(text);
          }
        }
      }
    }
    svg.appendChild(edgeGroup);

    // labels (foreignObject so MathJax can do its thing inside)
    const labelGroup = activeDocument.createElementNS(ns, "g");
    labelGroup.setAttribute("class", "forest-labels");
    for (const n of all) {
      if (n.options["phantom"]) continue;
      const x = n.x ?? 0,
        y = n.y ?? 0,
        w = n.w ?? 0,
        h = n.h ?? 0;
      // optional bounding box / surrounding shape — circle and rect compose:
      // when both `circle` (or alone) and `draw` (or the global `drawNodes`
      // toggle) are set, both shapes are drawn. The rect goes underneath
      // (filled to mask the label backdrop), and the circle/ellipse on top
      // with no fill so the rect's interior stays visible. This matches
      // users' expectation that the two options stack rather than override.
      //
      // Fill is controlled through CSS classes, NOT the `fill` presentation
      // attribute: a stylesheet rule (`.forest-node-shape { fill: … }`) always
      // beats a presentation attribute, so setting `fill="none"` inline would
      // be silently overridden — that was why circle+draw didn't compose.
      const wantsCircle = !!n.options["circle"];
      const wantsRect = this.settings.drawNodes || !!n.options["draw"];
      if (wantsRect) {
        const rect = this.makeRect(x - w / 2, y - h / 2, w, h, 4);
        rect.setAttribute("class", "forest-node-shape forest-node-rect");
        labelGroup.appendChild(rect);
      }
      if (wantsCircle) {
        // Circle for square-ish labels, ellipse for elongated ones.
        const padW = w / 2 + 3;
        const padH = h / 2 + 3;
        const shape =
          Math.abs(padW - padH) < 2
            ? this.makeCircle(x, y, Math.max(padW, padH))
            : this.makeEllipse(x, y, padW, padH);
        // When a rect already provides the filled backdrop, the circle must be
        // transparent so the rect's interior (and the label) stays visible;
        // the `forest-node-circle--overlay` modifier selects the no-fill rule.
        const overlay = wantsRect ? " forest-node-circle--overlay" : "";
        shape.setAttribute(
          "class",
          "forest-node-shape forest-node-circle" + overlay,
        );
        labelGroup.appendChild(shape);
      }
      const fo = activeDocument.createElementNS(ns, "foreignObject");
      fo.setAttribute("x", String(x - w / 2));
      fo.setAttribute("y", String(y - h / 2));
      fo.setAttribute("width", String(w));
      fo.setAttribute("height", String(h));
      const div = activeDocument.createElement("div");
      div.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
      div.className = "forest-label-wrap";
      div.setCssProps({
        "--forest-label-width": `${w}px`,
        "--forest-label-height": `${h}px`,
      });
      const node = labels.get(n);
      if (node) div.appendChild(node);
      fo.appendChild(div);
      labelGroup.appendChild(fo);
    }
    svg.appendChild(labelGroup);

    // movement arrows — drawn geometrically (no SVG markers; those are
    // fragile in embedded-SVG-inside-HTML contexts).
    const arrowGroup = activeDocument.createElementNS(ns, "g");
    arrowGroup.setAttribute("class", "forest-arrows");
    arrowGroup.setAttribute("stroke", "currentColor");
    arrowGroup.setAttribute("fill", "none");
    let warningY = (maxY ?? 0) - 6;
    for (const a of ast.arrows) {
      const from = this.lookupNode(a.from, named, all);
      const to = this.lookupNode(a.to, named, all);
      if (!from || !to) {
        // RENDER a visible warning, instead of silently failing.
        const missing: string[] = [];
        if (!from) missing.push(`from='${a.from}'`);
        if (!to) missing.push(`to='${a.to}'`);
        const msg = `⚠ \\draw target not found: ${missing.join(" ")}`;
        const t = activeDocument.createElementNS(ns, "text");
        t.setAttribute("x", String((minX ?? 0) + 6));
        t.setAttribute("y", String(warningY));
        t.setAttribute("fill", "var(--text-error, #c00)");
        t.setAttribute("font-size", "11");
        t.setAttribute("font-family", "monospace");
        t.textContent = msg;
        arrowGroup.appendChild(t);
        warningY -= 14;
        continue;
      }
      const geom = this.computeArrowGeometry(a, from, to);
      const p1 = geom.points[0];
      const p2 = geom.points[geom.points.length - 1];

      // Compute the tangent at the END of the curve (motion direction
      // arriving at p2) so we can orient the arrowhead. For any Bézier,
      // the tangent at t=1 points from the last control point to the
      // endpoint.
      const lastBefore = geom.points[geom.points.length - 2];
      const tdx0 = p2.x - lastBefore.x;
      const tdy0 = p2.y - lastBefore.y;
      const tlen0 = Math.hypot(tdx0, tdy0) || 1;
      const ux = tdx0 / tlen0;
      const uy = tdy0 / tlen0;

      // standoff between arrowhead tip and node boundary
      const standoff = 3;
      const tipX = p2.x - ux * standoff;
      const tipY = p2.y - uy * standoff;
      // TikZ `>` arrowhead: slim, taller than wide
      const headSize = 7;
      const headHalfW = 2.4;
      // pull the visible curve end back to the back of the arrowhead
      const lineEndX = tipX - ux * (headSize * 0.75);
      const lineEndY = tipY - uy * (headSize * 0.75);

      // Build path "d" — straight, quadratic, or cubic
      let pathD: string;
      if (geom.kind === "straight") {
        pathD = `M ${p1.x} ${p1.y} L ${lineEndX} ${lineEndY}`;
      } else if (geom.kind === "quadratic") {
        const c = geom.points[1];
        pathD = `M ${p1.x} ${p1.y} Q ${c.x} ${c.y} ${lineEndX} ${lineEndY}`;
      } else {
        // cubic — adjust C2 toward the new (shorter) endpoint so the curve
        // still ends along the same tangent
        const c1 = geom.points[1];
        const c2 = geom.points[2];
        // shorten by translating both the end and c2 toward the start by the
        // standoff+head amount in the curve's incoming-direction vector
        const shortenX = ux * (standoff + headSize * 0.75);
        const shortenY = uy * (standoff + headSize * 0.75);
        const c2x = c2.x - shortenX;
        const c2y = c2.y - shortenY;
        pathD = `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y} ${c2x} ${c2y} ${lineEndX} ${lineEndY}`;
      }

      const path = activeDocument.createElementNS(ns, "path");
      path.setAttribute("d", pathD);
      path.setAttribute("class", "forest-movement");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "0.9");
      if (a.style.includes("dotted")) path.setAttribute("stroke-dasharray", "1 2.5");
      else if (a.style.includes("dashed")) path.setAttribute("stroke-dasharray", "4 2.5");
      else if (a.style.includes("solid")) { /* no dash */ }
      else path.setAttribute("stroke-dasharray", "3.5 2.5"); // movement default
      arrowGroup.appendChild(path);

      // arrowhead — slim TikZ-style triangle with concave back
      const baseCX = tipX - ux * headSize;
      const baseCY = tipY - uy * headSize;
      const baseLX = baseCX - uy * headHalfW;
      const baseLY = baseCY + ux * headHalfW;
      const baseRX = baseCX + uy * headHalfW;
      const baseRY = baseCY - ux * headHalfW;
      const notch = headSize * 0.25;
      const notchX = baseCX + ux * notch;
      const notchY = baseCY + uy * notch;
      const head = activeDocument.createElementNS(ns, "path");
      head.setAttribute(
        "d",
        `M ${tipX} ${tipY} L ${baseLX} ${baseLY} L ${notchX} ${notchY} L ${baseRX} ${baseRY} Z`,
      );
      head.setAttribute("class", "forest-arrowhead");
      head.setAttribute("fill", "currentColor");
      head.setAttribute("stroke", "none");
      arrowGroup.appendChild(head);

      if (a.label) {
        // approximate the curve's t=0.5 point for label placement
        let lx: number, ly: number;
        if (geom.kind === "quadratic") {
          const c = geom.points[1];
          lx = 0.25 * p1.x + 0.5 * c.x + 0.25 * p2.x;
          ly = 0.25 * p1.y + 0.5 * c.y + 0.25 * p2.y;
        } else if (geom.kind === "cubic") {
          const c1 = geom.points[1], c2 = geom.points[2];
          lx = 0.125 * p1.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p2.x;
          ly = 0.125 * p1.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p2.y;
        } else {
          lx = (p1.x + p2.x) / 2;
          ly = (p1.y + p2.y) / 2;
        }
        const t = activeDocument.createElementNS(ns, "text");
        t.setAttribute("x", String(lx));
        t.setAttribute("y", String(ly + 12));
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("class", "forest-movement-label");
        t.setAttribute("font-style", "italic");
        t.textContent = stripBraces(a.label);
        arrowGroup.appendChild(t);
      }
    }
    svg.appendChild(arrowGroup);

    return svg;
  }

  /** Resolves a `\draw` ref like "spec" / "spec.south" / "VP" to a node.
   *  Tries `name=` registrations first, then content-text match.            */
  private lookupNode(
    ref: string,
    named: Map<string, FNode>,
    all: FNode[],
  ): FNode | undefined {
    const baseName = ref.includes(".") ? ref.slice(0, ref.indexOf(".")) : ref;
    const key = baseName.trim();
    const byName = named.get(key);
    if (byName) return byName;
    // content fallback: exact match on raw content
    return all.find((n) => n.content === key);
  }

  /** Central place that decides what curve type to draw and where its
   *  control points sit. Used by both the bbox phase (so the viewBox
   *  contains the curve) and the actual rendering, ensuring they agree.
   *
   *  Rules:
   *  - `--` (parsed as bend="straight") → straight line, two points.
   *  - `to[out=A,in=B]` → cubic Bézier with TikZ-style explicit angles.
   *  - `to` with either endpoint anchored (`.south`, `.east`, etc.) → cubic
   *      Bézier with tangents derived from the anchor outward directions.
   *      An unanchored endpoint uses the smart-default direction. This is
   *      what makes `(a.east) to (b.west)` leave/arrive horizontally.
   *  - `to[bend left|right]` with no anchors → quadratic with perpendicular
   *      bend (the v1.0.4 behavior, preserved).
   *  - `to` with neither anchors nor bend → quadratic that droops below
   *      the tree (linguistic-movement default).                              */
  private computeArrowGeometry(
    a: DrawArrow,
    from: FNode,
    to: FNode,
  ): {
    kind: "straight" | "quadratic" | "cubic";
    points: { x: number; y: number }[];
  } {
    const pa = this.resolveEndpoint(a.from, from, to);
    const pb = this.resolveEndpoint(a.to, to, from);
    const bend = this.parseBend(a.bend);

    if ("amount" in bend && bend.kind === "straight") {
      return { kind: "straight", points: [{ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }] };
    }

    // Choose curve type
    const useCubic =
      pa.explicit || pb.explicit || ("kind" in bend && bend.kind === "angles");

    if (useCubic) {
      let pxa = pa.x, pya = pa.y, txa = pa.tx, tya = pa.ty;
      let pxb = pb.x, pyb = pb.y, txb = pb.tx, tyb = pb.ty;

      if ("kind" in bend && bend.kind === "angles") {
        // TikZ semantics: `out=A` controls BOTH the attachment point on the
        // node boundary AND the tangent direction. The attachment is the
        // ray-from-center-at-angle-A intersected with the node's bounding
        // rectangle. So `out=south` attaches at the south boundary point and
        // the curve leaves heading south. This makes out=/in= a complete
        // substitute for `.anchor` direction parameters.
        const ba = this.boundaryAtAngle(from, bend.outDeg);
        const bb = this.boundaryAtAngle(to, bend.inDeg);
        pxa = ba.x; pya = ba.y; txa = ba.tx; tya = ba.ty;
        pxb = bb.x; pyb = bb.y; txb = bb.tx; tyb = bb.ty;
      }
      const dist = Math.hypot(pxb - pxa, pyb - pya);
      const looseness = "looseness" in bend ? bend.looseness : 1;
      const L = Math.max(16, dist * 0.45) * looseness;
      const c1 = { x: pxa + txa * L, y: pya + tya * L };
      const c2 = { x: pxb + txb * L, y: pyb + tyb * L };
      return {
        kind: "cubic",
        points: [{ x: pxa, y: pya }, c1, c2, { x: pxb, y: pyb }],
      };
    }

    // No explicit anchors and no explicit angles — keep the v1.0.4
    // quadratic-bend / droop behavior.
    let cx: number, cy: number;
    if (bend.kind === "droop") {
      const dxL = pb.x - pa.x;
      const droop = Math.max(18, Math.abs(dxL) * 0.3);
      cx = (pa.x + pb.x) / 2;
      cy = Math.max(pa.y, pb.y) + droop;
    } else {
      // bend left / bend right
      const dxL = pb.x - pa.x;
      const dyL = pb.y - pa.y;
      const L = Math.hypot(dxL, dyL) || 1;
      const sign = (bend as { kind: "left" | "right" }).kind === "left" ? -1 : 1;
      const perpX = (-dyL / L) * sign;
      const perpY = (dxL / L) * sign;
      const amt = (bend as { amount: number }).amount;
      const offset = (amt / 30) * Math.max(35, L * 0.4);
      cx = (pa.x + pb.x) / 2 + perpX * offset;
      cy = (pa.y + pb.y) / 2 + perpY * offset;
    }
    return {
      kind: "quadratic",
      points: [{ x: pa.x, y: pa.y }, { x: cx, y: cy }, { x: pb.x, y: pb.y }],
    };
  }

  /** Computes the intersection of a ray from the node's centre at the given
   *  angle (TikZ convention: 0°=east, 90°=north) with the node's bounding
   *  rectangle. Returns the attachment point and the outward unit vector at
   *  that point — used by `out=/in=` to make the angle determine BOTH where
   *  the curve attaches AND its tangent there, matching strict TikZ.        */
  private boundaryAtAngle(
    n: FNode,
    angleDeg: number,
  ): { x: number; y: number; tx: number; ty: number } {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const hw = (n.w ?? 0) / 2;
    const hh = (n.h ?? 0) / 2;
    const rad = (angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = -Math.sin(rad); // screen y is inverted
    if (hw <= 0 || hh <= 0) return { x, y, tx: dx, ty: dy };
    // Find smallest positive t such that (x + t*dx, y + t*dy) hits a side
    let t = Infinity;
    if (dx > 1e-9) t = Math.min(t, hw / dx);
    if (dx < -1e-9) t = Math.min(t, -hw / dx);
    if (dy > 1e-9) t = Math.min(t, hh / dy);
    if (dy < -1e-9) t = Math.min(t, -hh / dy);
    if (!isFinite(t)) t = Math.min(hw, hh);
    return { x: x + t * dx, y: y + t * dy, tx: dx, ty: dy };
  }

  /** Resolves an endpoint reference like "spec", "spec.south", "spec.north east"
   *  to a position on the node boundary and the outward direction at that
   *  point. The outward direction is used by the cubic-Bézier renderer to
   *  enforce TikZ's `to` tangent rule:
   *
   *    `(a.east) to (b.west)`  ⇒  curve leaves a tangent to east,
   *                                arrives at b tangent to west
   *
   *  When no anchor is given, the renderer picks the side of the node
   *  facing `other`, returning `explicit=false` so the curve drawer knows
   *  this was a guess (and can fall back to the older quadratic-droop path
   *  for backwards-compatible movement-arrow look).                          */
  private resolveEndpoint(
    ref: string,
    n: FNode,
    other: FNode,
  ): { x: number; y: number; tx: number; ty: number; explicit: boolean } {
    const dot = ref.indexOf(".");
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const halfW = (n.w ?? 0) / 2;
    const halfH = (n.h ?? 0) / 2;
    if (dot === -1) {
      // smart default — choose the side facing `other`
      const ox = other.x ?? 0;
      const oy = other.y ?? 0;
      const dx = ox - x;
      const dy = oy - y;
      if (Math.abs(dy) > Math.abs(dx) * 0.5) {
        const south = dy >= 0;
        return {
          x,
          y: south ? y + halfH : y - halfH,
          tx: 0,
          ty: south ? 1 : -1,
          explicit: false,
        };
      } else {
        const east = dx >= 0;
        return {
          x: east ? x + halfW : x - halfW,
          y,
          tx: east ? 1 : -1,
          ty: 0,
          explicit: false,
        };
      }
    }
    const anchor = ref.slice(dot + 1).trim().toLowerCase();
    const s = Math.SQRT1_2; // 1/√2 — for the diagonal anchors
    switch (anchor) {
      case "north":      return { x,            y: y - halfH, tx: 0,  ty: -1, explicit: true };
      case "south":      return { x,            y: y + halfH, tx: 0,  ty: 1,  explicit: true };
      case "east":       return { x: x + halfW, y,            tx: 1,  ty: 0,  explicit: true };
      case "west":       return { x: x - halfW, y,            tx: -1, ty: 0,  explicit: true };
      case "north east": return { x: x + halfW, y: y - halfH, tx: s,  ty: -s, explicit: true };
      case "north west": return { x: x - halfW, y: y - halfH, tx: -s, ty: -s, explicit: true };
      case "south east": return { x: x + halfW, y: y + halfH, tx: s,  ty: s,  explicit: true };
      case "south west": return { x: x - halfW, y: y + halfH, tx: -s, ty: s,  explicit: true };
      case "center":     return { x,            y,            tx: 0,  ty: 0,  explicit: true };
      default:           return { x,            y: y + halfH, tx: 0,  ty: 1,  explicit: true };
    }
  }

  /** Parses the option block of a TikZ `to[…]` / `edge[…]` operator.
   *
   *  Supported syntax (matches the `forest` / TikZ surface form):
   *
   *    bend left[=N]           # curve to the left of the line, optional angle
   *    bend right[=N]
   *    out=<angle|direction>   # outgoing tangent
   *    in=<angle|direction>    # incoming tangent
   *    looseness=N             # scales control-point distance (default 1)
   *
   *  `<direction>` may be any of TikZ's compass names: north, south, east,
   *  west, north east, north west, south east, south west — converted to
   *  the standard polar convention (0°=east, 90°=north, 180°=west, 270°=south).
   *
   *  Options are comma-separated; whitespace around `=` is tolerated. The
   *  special string "straight" is what we inject internally for `--` paths. */
  private parseBend(spec: string | undefined):
    | { kind: "left" | "right" | "droop" | "straight"; amount: number; looseness: number }
    | { kind: "angles"; outDeg: number; inDeg: number; looseness: number } {
    if (!spec) return { kind: "droop", amount: 30, looseness: 1 };
    if (spec === "straight") return { kind: "straight", amount: 0, looseness: 1 };

    // Split into comma-separated options, then into key=value pairs.
    const opts: Record<string, string> = {};
    for (const raw of spec.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq === -1) {
        opts[part.toLowerCase()] = "";
      } else {
        opts[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
      }
    }

    // Compass direction → TikZ-convention angle. Whitespace is normalised
    // so "south  west", "south west", "Southwest" all map to 225°.
    const dirAngle: Record<string, number> = {
      "east": 0,
      "north east": 45,
      "northeast": 45,
      "north": 90,
      "north west": 135,
      "northwest": 135,
      "west": 180,
      "south west": 225,
      "southwest": 225,
      "south": 270,
      "south east": 315,
      "southeast": 315,
    };
    const toAngle = (s: string): number | null => {
      if (!s) return null;
      const k = s.trim().toLowerCase().replace(/\s+/g, " ");
      if (k in dirAngle) return dirAngle[k];
      const n = parseFloat(k);
      return Number.isFinite(n) ? n : null;
    };

    const loose = opts["looseness"] ? parseFloat(opts["looseness"]) : 1;
    const looseness = Number.isFinite(loose) && loose > 0 ? loose : 1;

    // Helper: extract bend rotation in degrees if a `bend left[=N]` or
    // `bend right[=N]` option is present. Positive return = CCW (leftward).
    const bendRotation = (): number => {
      for (const k of Object.keys(opts)) {
        const m = /^bend\s+(left|right)$/.exec(k);
        if (m) {
          const amt = opts[k] ? parseFloat(opts[k]) : 30;
          if (!Number.isFinite(amt)) return 0;
          return m[1] === "left" ? amt : -amt;
        }
      }
      return 0;
    };

    // Explicit angles via out=/in=. When `bend left/right` is ALSO given,
    // it rotates both tangents — `bend left=N` adds N° CCW to `out` and
    // subtracts N° from `in`, so the curve bows further to the left of the
    // overall path direction. This matches what TikZ does when both are
    // present.
    if ("out" in opts || "in" in opts) {
      const outA = toAngle(opts["out"] || "");
      const inA = toAngle(opts["in"] || "");
      if (outA !== null || inA !== null) {
        const rot = bendRotation();
        return {
          kind: "angles",
          outDeg: (outA !== null ? outA : 0) + rot,
          inDeg:  (inA  !== null ? inA  : 180) - rot,
          looseness,
        };
      }
    }

    // bend left[=N] / bend right[=N] (no out/in)
    for (const k of Object.keys(opts)) {
      const m = /^bend\s+(left|right)$/.exec(k);
      if (m) {
        const dir = m[1] as "left" | "right";
        const amtStr = opts[k];
        const amt = amtStr ? parseFloat(amtStr) : 30;
        return {
          kind: dir,
          amount: Number.isFinite(amt) ? amt : 30,
          looseness,
        };
      }
    }

    return { kind: "droop", amount: 30, looseness };
  }

  private collect(n: FNode, out: FNode[]): void {
    out.push(n);
    for (const c of n.children) this.collect(c, out);
  }

  private parentAnchor(n: FNode): { x: number; y: number } {
    const anchor = (n.options["parent anchor"] as string) ?? this.settings.defaultParentAnchor;
    const y = anchor === "south" ? (n.y ?? 0) + (n.h ?? 0) / 2 : (n.y ?? 0);
    return { x: n.x ?? 0, y };
  }

  private childAnchor(n: FNode): { x: number; y: number } {
    const anchor = (n.options["child anchor"] as string) ?? this.settings.defaultChildAnchor;
    const y = anchor === "north" ? (n.y ?? 0) - (n.h ?? 0) / 2 : (n.y ?? 0);
    return { x: n.x ?? 0, y };
  }

  private childBox(n: FNode) {
    return {
      left: (n.x ?? 0) - (n.w ?? 0) / 2,
      right: (n.x ?? 0) + (n.w ?? 0) / 2,
      top: (n.y ?? 0) - (n.h ?? 0) / 2,
      bottom: (n.y ?? 0) + (n.h ?? 0) / 2,
    };
  }

  private makeRect(x: number, y: number, w: number, h: number, r: number): SVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const rect = activeDocument.createElementNS(ns, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", String(r));
    return rect;
  }

  private makeCircle(cx: number, cy: number, r: number): SVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const c = activeDocument.createElementNS(ns, "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", String(cy));
    c.setAttribute("r", String(r));
    return c;
  }

  private makeEllipse(cx: number, cy: number, rx: number, ry: number): SVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const e = activeDocument.createElementNS(ns, "ellipse");
    e.setAttribute("cx", String(cx));
    e.setAttribute("cy", String(cy));
    e.setAttribute("rx", String(rx));
    e.setAttribute("ry", String(ry));
    return e;
  }
}

function stripBraces(s: string): string {
  let out = s.trim();
  while (out.startsWith("{") && out.endsWith("}")) out = out.slice(1, -1).trim();
  return out;
}

/* ===================================================================== *
 *  Glue: source string -> SVG element                                    *
 * ===================================================================== */

/** Parses a forest/TeX dimension string ("10pt", "5mm", "0.5cm", "12em",
 *  bare "15" = px) into a pixel value. Returns null on unrecognised input.
 *  Conversions are at 96 dpi: 1pt ≈ 1.333 px, 1cm ≈ 37.795 px, etc.        */
function parseDim(raw: string | true | undefined): number | null {
  if (typeof raw !== "string") return null;
  const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*(pt|pc|cm|mm|bp|em|ex|in|px)?\s*$/.exec(raw);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = (m[2] || "px").toLowerCase();
  switch (u) {
    case "pt": return (v * 4) / 3;
    case "pc": return v * 16;
    case "bp": return (v * 96) / 72;
    case "cm": return v * 37.7953;
    case "mm": return v * 3.77953;
    case "in": return v * 96;
    case "em": return v * 13;
    case "ex": return v * 6;
    case "px":
    default:   return v;
  }
}

/** Pulls forest-style size options (`s sep`, `l sep`, `inner sep`, plus the
 *  `+=` increment forms) out of a node's option set or its `for tree={…}`
 *  propagator. Returns a partial settings patch.                            */
function extractSizeOverrides(
  opts: Record<string, string | true>,
  base: ForestSettings,
): Partial<ForestSettings> {
  const out: Partial<ForestSettings> = {};
  const tryDim = (key: string, set: (v: number) => void, base: number) => {
    if (typeof opts[key] === "string") {
      const v = parseDim(opts[key]);
      if (v !== null) set(v);
    }
    const incKey = key + "+";
    if (typeof opts[incKey] === "string") {
      const v = parseDim(opts[incKey]);
      if (v !== null) set(base + v);
    }
  };
  tryDim("s sep", (v) => (out.siblingSep = v), base.siblingSep);
  tryDim("l sep", (v) => (out.levelSep = v), base.levelSep);
  tryDim("s sep+", (v) => (out.siblingSep = base.siblingSep + v), base.siblingSep);
  tryDim("l sep+", (v) => (out.levelSep = base.levelSep + v), base.levelSep);
  if (typeof opts["inner sep"] === "string") {
    const v = parseDim(opts["inner sep"]);
    if (v !== null) {
      out.nodeHPad = v;
      out.nodeVPad = v;
    }
  }
  if (typeof opts["inner xsep"] === "string") {
    const v = parseDim(opts["inner xsep"]);
    if (v !== null) out.nodeHPad = v;
  }
  if (typeof opts["inner ysep"] === "string") {
    const v = parseDim(opts["inner ysep"]);
    if (v !== null) out.nodeVPad = v;
  }
  if (typeof opts["font size"] === "string") {
    const v = parseDim(opts["font size"]);
    if (v !== null) out.fontSize = v;
  }
  return out;
}

/** Computes effective settings for one tree by overlaying root-level options
 *  (and the `for tree={…}` group within them) onto the user's global settings. */
function effectiveSettings(root: FNode, base: ForestSettings): ForestSettings {
  let patch: Partial<ForestSettings> = extractSizeOverrides(root.options, base);
  if (typeof root.options["for tree"] === "string") {
    try {
      // re-parse the inner option list using the same parser
      const inner = new ForestParser("[," + root.options["for tree"] + "]").parse();
      patch = { ...patch, ...extractSizeOverrides(inner.root.options, base) };
    } catch {
      /* ignore */
    }
  }
  return { ...base, ...patch };
}

async function buildTree(source: string, settings: ForestSettings): Promise<HTMLElement> {
  const parser = new ForestParser(source);
  let ast: ForestAST;
  try {
    ast = parser.parse();
  } catch (err) {
    const div = activeDocument.createElement("div");
    div.addClass("forest-error");
    const message = err instanceof Error ? err.message : String(err);
    div.setText("Forest parse error: " + message);
    return div;
  }

  resolveInheritance(ast.root);

  // Apply forest-style per-tree size overrides (`s sep=10pt`, `l sep=20pt`,
  // `inner sep=2pt`, in root options or `for tree={…}`).
  const effSettings = effectiveSettings(ast.root, settings);

  // Render and measure labels first
  const labels = new Map<FNode, HTMLElement>();
  const sizes = new Map<FNode, { w: number; h: number }>();
  const measure = async (n: FNode) => {
    if (sizes.has(n)) return sizes.get(n)!;
    const raw = n.content || (n.options["phantom"] ? "" : "");
    const { el, w, h } = await renderLabel(raw, effSettings.fontSize);
    labels.set(n, el);
    const size = n.options["phantom"] ? { w: 0, h: 0 } : { w, h };
    sizes.set(n, size);
    return size;
  };

  const layout = new Layout(effSettings);
  await layout.layout(ast.root, measure);

  const renderer = new Renderer(effSettings);
  const svg = renderer.render(ast, labels);

  const container = activeDocument.createElement("div");
  container.addClass("forest-container");
  container.appendChild(svg);
  return container;
}

/* ===================================================================== *
 *  Render child wrapping (so MathJax inside labels is cleaned up nicely) *
 * ===================================================================== */

class ForestRenderChild extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private source: string,
    private settings: ForestSettings,
  ) {
    super(containerEl);
  }

  async onload() {
    const tree = await buildTree(this.source, this.settings);
    this.containerEl.empty();
    this.containerEl.appendChild(tree);
  }
}

/* ===================================================================== *
 *  Plugin                                                                *
 * ===================================================================== */

export default class ForestPlugin extends Plugin {
  settings!: ForestSettings;

  async onload() {
    await this.loadSettings();

    // ```forest fenced code blocks are the sole entry point.
    this.registerMarkdownCodeBlockProcessor("forest", async (src, el, ctx) => {
      const child = new ForestRenderChild(el, src, this.settings);
      ctx.addChild(child);
    });

    this.addSettingTab(new ForestSettingTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/* ===================================================================== *
 *  Settings tab                                                          *
 * ===================================================================== */

class ForestSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ForestPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Tree appearance").setHeading();

    const num = (
      name: string,
      desc: string,
      key: keyof ForestSettings,
      min: number,
      max: number,
      step = 1,
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addSlider((s) =>
          s
            .setLimits(min, max, step)
            .setValue(this.plugin.settings[key] as number)
            .setDynamicTooltip()
            .onChange(async (v) => {
              (this.plugin.settings[key] as number) = v;
              await this.plugin.saveSettings();
            }),
        );
    };

    num("Level separation", "Vertical gap between levels (px).", "levelSep", 20, 120);
    num("Sibling separation", "Horizontal gap between siblings (px).", "siblingSep", 0, 60);
    num("Subtree separation", "Minimum gap between sibling subtrees (px).", "subtreeSep", 0, 80);
    num("Label font size", "Base font size of node labels (px).", "fontSize", 8, 28);
    num("Edge stroke width", "Stroke width of tree edges (px).", "edgeStrokeWidth", 1, 4);

    new Setting(containerEl)
      .setName("Draw bounding boxes")
      .setDesc("Outline every node by default. Per-node `draw` option always overrides.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.drawNodes).onChange(async (v) => {
          this.plugin.settings.drawNodes = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
