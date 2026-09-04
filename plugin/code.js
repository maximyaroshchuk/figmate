// Figmate Bridge — plugin main thread.
//
// The UI iframe owns the WebSocket to the bridge/worker; this side owns the
// document. Messages flow in as { exec, id, code }, the code runs against the
// Figma API with the `h` helper namespace in scope, and result/error/log
// messages flow back out. Persisted server/token config lives here too, since
// clientStorage is only reachable from the main thread.

figma.showUI(__html__, { width: 240, height: 32, title: "Figmate Bridge" });

const STORAGE_KEY = "figmate.config";

// Responses above this size die at the worker's ~1MB cap with an opaque
// error; failing early with advice is kinder.
const RESULT_BYTE_LIMIT = 900000;

// ─── crossing the plugin/UI boundary ─────────────────────────────────────────

// Figma nodes expose everything through prototype getters, so JSON.stringify
// flattens them to "{}". Detect node-shaped values and summarize them instead.
function isNodeLike(value) {
  return !!value
    && typeof value === "object"
    && typeof value.id === "string"
    && typeof value.type === "string"
    && typeof value.name === "string";
}

function nodeSummary(node) {
  const summary = { id: node.id, name: node.name, type: node.type };
  if (typeof node.width === "number") {
    summary.w = Math.round(node.width);
    summary.h = Math.round(node.height);
  }
  return summary;
}

// Results are postMessage'd to the UI and then JSON-encoded for the wire, so
// anything cyclic or host-object-backed has to be flattened first.
function toPlainValue(value) {
  if (value === undefined) return null;
  if (isNodeLike(value)) return nodeSummary(value);
  if (Array.isArray(value)) {
    return value.map((item) => (isNodeLike(item) ? nodeSummary(item) : toPlainValue(item)));
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    try {
      return String(value);
    } catch (err2) {
      return null;
    }
  }
}

// Human-readable form of an exec result. When the script returned nothing,
// its printed output is the next best answer; failing that, a plain marker.
function toDisplayText(value, logLines) {
  try {
    if (value !== undefined) {
      if (typeof value === "string") return value;
      return JSON.stringify(toPlainValue(value), null, 2);
    }
  } catch (err) {
    // Unserializable value — fall through to the log lines.
  }
  return logLines.length ? logLines.join("\n") : "Done";
}

// ─── small pure utilities behind the helpers ─────────────────────────────────

// "#RRGGBB", "RRGGBB" or "#RGB" -> Figma's {r,g,b} with 0..1 channels.
function parseHex(input) {
  let hex = String(input).trim();
  if (hex[0] === "#") hex = hex.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    hex = hex.replace(/./g, (ch) => ch + ch);
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error("h.hex: expected #RGB or #RRGGBB, got " + JSON.stringify(input));
  }
  const channel = (offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return { r: channel(0), g: channel(2), b: channel(4) };
}

// Figma's 0..1 {r,g,b} -> "#rrggbb".
function rgbToHex(color) {
  const byte = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return "#" + byte(color.r) + byte(color.g) + byte(color.b);
}

// Padding shorthand: 12 | [vertical, horizontal] | {top,right,bottom,left}.
function normalizePadding(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return { top: value, right: value, bottom: value, left: value };
  }
  if (Array.isArray(value)) {
    const vertical = value[0];
    const horizontal = value.length > 1 ? value[1] : value[0];
    return { top: vertical, right: horizontal, bottom: vertical, left: horizontal };
  }
  return {
    top: value.top || 0,
    right: value.right || 0,
    bottom: value.bottom || 0,
    left: value.left || 0,
  };
}

// node.fills / node.strokes come back frozen, and figma.mixed is a symbol.
// Returns a mutable deep copy, or throws with the caller's name in the text.
function clonePaintList(node, prop, caller) {
  const paints = node[prop];
  if (typeof paints === "symbol") {
    throw new Error(
      caller + ": '" + node.name + "' has mixed " + prop +
      "; set the paint per-range, or unify " + prop + " on the node first"
    );
  }
  if (!Array.isArray(paints)) {
    throw new Error(caller + ": '" + node.name + "' has no " + prop);
  }
  return JSON.parse(JSON.stringify(paints));
}

// A variable reference in scripts can be a Variable instance, a local
// "VariableID:x:y" id, or a published library key. Try them in that order;
// null means nothing matched anywhere.
async function lookupVariable(ref) {
  if (ref == null) return null;
  if (typeof ref !== "string") return ref;

  if (ref.startsWith("VariableID:")) {
    return await figma.variables.getVariableByIdAsync(ref);
  }

  // getVariableByIdAsync throws on strings that aren't well-formed ids —
  // exactly what a library key looks like — so the miss must be swallowed
  // for the import fallback to ever run.
  try {
    const local = await figma.variables.getVariableByIdAsync(ref);
    if (local) return local;
  } catch (err) {
    // Not a local id — fall through to the library import.
  }

  try {
    return await figma.variables.importVariableByKeyAsync(ref);
  } catch (err) {
    return null;
  }
}

// Every font used by a text node, mixed ranges included.
function fontsOfText(node) {
  if (typeof node.fontName !== "symbol") return [node.fontName];
  if (typeof node.getRangeAllFontNames === "function" && node.characters.length) {
    return node.getRangeAllFontNames(0, node.characters.length);
  }
  return [];
}

// ─── h.spec: implementation-ready subtree specification ──────────────────────
//
// One node per line-group: a header with geometry, then `· `-prefixed detail
// lines. The goal is that paddings, gaps, colors, fonts and component variants
// read directly off the text — including containers WITHOUT auto-layout, where
// spacing is measured from child geometry and marked with `~`.

// Collapse top/right/bottom/left to the shortest readable form.
function formatPadding(top, right, bottom, left) {
  if (top === right && right === bottom && bottom === left) return String(top);
  if (top === bottom && left === right) return top + "," + left;
  return "T" + top + " R" + right + " B" + bottom + " L" + left;
}

function formatLineHeight(value) {
  if (!value || typeof value !== "object") return "";
  if (value.unit === "PIXELS") return "/" + Math.round(value.value);
  if (value.unit === "PERCENT") return "/" + Math.round(value.value) + "%";
  return "";
}

function formatLetterSpacing(value) {
  if (!value || typeof value !== "object" || !value.value) return "";
  return " ls:" + value.value + (value.unit === "PERCENT" ? "%" : "");
}

async function buildSpec(root, opts) {
  const options = opts || {};
  const maxDepth = options.maxDepth == null ? 7 : options.maxDepth;

  // Variable and style names are resolved once per id and cached, so a tree
  // bound to the same tokens doesn't trigger hundreds of lookups.
  const variableNames = new Map();
  const styleNames = new Map();

  async function variableName(id) {
    if (!id) return null;
    if (!variableNames.has(id)) {
      let name = null;
      try {
        const variable = await figma.variables.getVariableByIdAsync(id);
        name = variable ? variable.name : null;
      } catch (err) {
        name = null;
      }
      variableNames.set(id, name);
    }
    return variableNames.get(id);
  }

  async function styleName(id) {
    if (!id || typeof id === "symbol") return null;
    if (!styleNames.has(id)) {
      let name = null;
      try {
        const style = await figma.getStyleByIdAsync(id);
        name = style ? style.name : null;
      } catch (err) {
        name = null;
      }
      styleNames.set(id, name);
    }
    return styleNames.get(id);
  }

  // One paint -> "#367bf5 (Blue/500)" / "#000@0.4" / "linear(0%:#a, 100%:#b)".
  async function formatPaint(paint) {
    if (!paint) return null;
    let text;
    if (paint.type === "SOLID") {
      text = rgbToHex(paint.color);
      if (paint.opacity != null && paint.opacity < 1) {
        text += "@" + Math.round(paint.opacity * 100) / 100;
      }
      const boundColor = paint.boundVariables && paint.boundVariables.color;
      if (boundColor && boundColor.id) {
        const name = await variableName(boundColor.id);
        if (name) text += " (" + name + ")";
      }
    } else if (paint.type && paint.type.startsWith("GRADIENT_")) {
      const kind = paint.type.slice("GRADIENT_".length).toLowerCase();
      const stops = (paint.gradientStops || []).map((stop) => {
        let s = Math.round(stop.position * 100) + "%:" + rgbToHex(stop.color);
        if (stop.color.a != null && stop.color.a < 1) s += "@" + Math.round(stop.color.a * 100) / 100;
        return s;
      });
      text = kind + "(" + stops.join(", ") + ")";
    } else if (paint.type === "IMAGE") {
      text = "image(" + (paint.scaleMode || "").toLowerCase() + ")";
    } else {
      text = (paint.type || "paint").toLowerCase();
    }
    if (paint.visible === false) text = "hidden " + text;
    return text;
  }

  async function formatPaintList(node, prop, label, styleProp) {
    const paints = node[prop];
    if (typeof paints === "symbol") return label + ":mixed";
    if (!Array.isArray(paints) || !paints.length) return null;
    const parts = [];
    for (const paint of paints) parts.push(await formatPaint(paint));
    let text = label + ":" + (parts.length === 1 ? parts[0] : "[" + parts.join(" | ") + "]");
    const style = await styleName(node[styleProp]);
    if (style) text += " (style " + style + ")";
    return text;
  }

  function bbox(node) {
    return node.absoluteBoundingBox || null;
  }

  // A child that covers (almost) the whole container is a background layer:
  // it carries the surface color but must not distort the measured insets.
  function coversContainer(childBox, containerBox) {
    return childBox.width >= containerBox.width - 2
      && childBox.height >= containerBox.height - 2
      && Math.abs(childBox.x - containerBox.x) <= 2
      && Math.abs(childBox.y - containerBox.y) <= 2;
  }

  // Measured spacing for containers without auto-layout: child insets from the
  // container edges, plus the gaps along whichever axis the children stack on.
  function measuredSpacing(node) {
    const containerBox = bbox(node);
    if (!containerBox || !node.children) return { lines: [], background: new Set() };

    const background = new Set();
    const boxes = [];
    for (const child of node.children) {
      const childBox = bbox(child);
      if (!childBox || child.visible === false) continue;
      if (coversContainer(childBox, containerBox)) {
        background.add(child.id);
        continue;
      }
      boxes.push(childBox);
    }
    if (!boxes.length) return { lines: [], background };

    const lines = [];
    const top = Math.round(Math.min(...boxes.map((b) => b.y - containerBox.y)));
    const left = Math.round(Math.min(...boxes.map((b) => b.x - containerBox.x)));
    const right = Math.round(Math.min(...boxes.map((b) => containerBox.x + containerBox.width - (b.x + b.width))));
    const bottom = Math.round(Math.min(...boxes.map((b) => containerBox.y + containerBox.height - (b.y + b.height))));
    lines.push("~pad:" + formatPadding(top, right, bottom, left));

    if (boxes.length > 1) {
      const gapsAlong = (axis, size) => {
        const sorted = boxes.slice().sort((a, b) => a[axis] - b[axis]);
        const gaps = [];
        for (let i = 1; i < sorted.length; i++) {
          const gap = sorted[i][axis] - (sorted[i - 1][axis] + sorted[i - 1][size]);
          if (gap < -1) return null; // overlap — children don't stack on this axis
          gaps.push(Math.round(gap));
        }
        return gaps;
      };
      const horizontal = gapsAlong("x", "width");
      const vertical = gapsAlong("y", "height");
      const emit = (label, gaps) => {
        if (!gaps || !gaps.length) return;
        const uniform = gaps.every((g) => g === gaps[0]);
        lines.push(label + ":" + (uniform ? gaps[0] : gaps.join(", ")));
      };
      // When children stack cleanly on one axis only, that axis is the layout.
      if (horizontal && !vertical) emit("~gapX", horizontal);
      else if (vertical && !horizontal) emit("~gapY", vertical);
      else {
        emit("~gapX", horizontal);
        emit("~gapY", vertical);
      }
    }
    return { lines, background };
  }

  function autoLayoutLine(node) {
    if (!node.layoutMode || node.layoutMode === "NONE") return null;
    const parts = ["layout:" + node.layoutMode[0]];
    parts.push("gap:" + node.itemSpacing);
    if (node.layoutWrap === "WRAP") parts.push("wrap gapY:" + node.counterAxisSpacing);
    parts.push("pad:" + formatPadding(
      node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft,
    ));

    const sizing = (mode) => (mode === "AUTO" ? "hug" : "fixed");
    const primaryIsWidth = node.layoutMode === "HORIZONTAL";
    const w = sizing(primaryIsWidth ? node.primaryAxisSizingMode : node.counterAxisSizingMode);
    const hgt = sizing(primaryIsWidth ? node.counterAxisSizingMode : node.primaryAxisSizingMode);
    parts.push("w:" + w + " h:" + hgt);

    const align = [node.primaryAxisAlignItems, node.counterAxisAlignItems]
      .map((v) => (v || "MIN").toLowerCase());
    if (align[0] !== "min" || align[1] !== "min") parts.push("align:" + align.join(","));
    return parts.join(" ");
  }

  // How the node behaves inside ITS parent's auto-layout.
  function flexChildLine(node) {
    const parts = [];
    if (node.layoutGrow === 1) parts.push("grow:1");
    if (node.layoutAlign === "STRETCH") parts.push("self:stretch");
    if (node.layoutPositioning === "ABSOLUTE") parts.push("abs");
    return parts.length ? parts.join(" ") : null;
  }

  function radiusLine(node) {
    if (typeof node.cornerRadius === "number" && node.cornerRadius) {
      return "r:" + node.cornerRadius;
    }
    if (typeof node.cornerRadius === "symbol") {
      const corners = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
      if (corners.some((c) => c)) {
        return "r:TL" + corners[0] + " TR" + corners[1] + " BR" + corners[2] + " BL" + corners[3];
      }
    }
    return null;
  }

  async function strokeLine(node) {
    const painted = await formatPaintList(node, "strokes", "border", "strokeStyleId");
    if (!painted) return null;
    let weight;
    if (typeof node.strokeWeight === "number") {
      weight = node.strokeWeight;
    } else {
      weight = "T" + node.strokeTopWeight + " R" + node.strokeRightWeight
        + " B" + node.strokeBottomWeight + " L" + node.strokeLeftWeight;
    }
    let text = "border:" + weight + " " + painted.slice("border:".length);
    if (node.strokeAlign && node.strokeAlign !== "INSIDE") text += " " + node.strokeAlign.toLowerCase();
    if (node.dashPattern && node.dashPattern.length) text += " dash:" + node.dashPattern.join(",");
    return text;
  }

  async function effectLines(node) {
    if (!Array.isArray(node.effects) || !node.effects.length) return [];
    const lines = [];
    for (const effect of node.effects) {
      if (effect.visible === false) continue;
      if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
        let text = (effect.type === "INNER_SHADOW" ? "inner-shadow" : "shadow")
          + ":(" + effect.offset.x + "," + effect.offset.y + ")"
          + " blur:" + effect.radius;
        if (effect.spread) text += " spread:" + effect.spread;
        text += " " + rgbToHex(effect.color);
        if (effect.color.a != null && effect.color.a < 1) {
          text += "@" + Math.round(effect.color.a * 100) / 100;
        }
        lines.push(text);
      } else if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR") {
        lines.push(effect.type.toLowerCase().replace("_", "-") + ":" + effect.radius);
      }
    }
    const style = await styleName(node.effectStyleId);
    if (style && lines.length) lines[lines.length - 1] += " (style " + style + ")";
    return lines;
  }

  // Numeric properties bound to variables: "vars: itemSpacing→Space/8, …".
  async function boundVariablesLine(node) {
    const bound = node.boundVariables;
    if (!bound) return null;
    const parts = [];
    for (const prop of Object.keys(bound)) {
      if (prop === "fills" || prop === "strokes") continue; // shown next to the paint itself
      const alias = bound[prop];
      if (!alias || Array.isArray(alias) || !alias.id) continue;
      const name = await variableName(alias.id);
      if (name) parts.push(prop + "→" + name);
    }
    return parts.length ? "vars: " + parts.join(", ") : null;
  }

  async function textLines(node) {
    const lines = ["text:" + JSON.stringify(node.characters)];
    const mixed = typeof node.fontName === "symbol"
      || typeof node.fontSize === "symbol"
      || typeof node.fills === "symbol";

    if (!mixed) {
      let font = "font:" + node.fontName.family + " " + node.fontName.style
        + " " + node.fontSize + formatLineHeight(node.lineHeight)
        + formatLetterSpacing(node.letterSpacing);
      const fill = await formatPaintList(node, "fills", "color", "textStyleId");
      if (fill) font += " " + fill;
      lines.push(font);
    } else if (typeof node.getStyledTextSegments === "function") {
      const segments = node.getStyledTextSegments(
        ["fontName", "fontSize", "lineHeight", "letterSpacing", "fills"],
      );
      for (const seg of segments) {
        let line = "seg " + JSON.stringify(seg.characters)
          + " font:" + seg.fontName.family + " " + seg.fontName.style
          + " " + seg.fontSize + formatLineHeight(seg.lineHeight)
          + formatLetterSpacing(seg.letterSpacing);
        const solid = (seg.fills || []).find((p) => p.type === "SOLID");
        if (solid) line += " color:" + (await formatPaint(solid));
        lines.push(line);
      }
    }

    const extras = [];
    if (node.textAlignHorizontal && node.textAlignHorizontal !== "LEFT") {
      extras.push("align:" + node.textAlignHorizontal.toLowerCase());
    }
    if (node.textCase && node.textCase !== "ORIGINAL" && typeof node.textCase !== "symbol") {
      extras.push("case:" + node.textCase.toLowerCase());
    }
    if (node.textDecoration && node.textDecoration !== "NONE" && typeof node.textDecoration !== "symbol") {
      extras.push(node.textDecoration.toLowerCase());
    }
    if (node.textAutoResize && node.textAutoResize !== "NONE") {
      extras.push("resize:" + node.textAutoResize.toLowerCase().replace("_", "-"));
    }
    if (extras.length) lines.push(extras.join(" "));
    return lines;
  }

  async function instanceLabel(node) {
    if (node.type !== "INSTANCE" || typeof node.getMainComponentAsync !== "function") return null;
    try {
      const main = await node.getMainComponentAsync();
      if (!main) return null;
      const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.name : null;
      let label = set || main.name;
      const props = node.componentProperties || {};
      const values = Object.keys(props).map((key) => {
        const clean = key.split("#")[0];
        return clean + "=" + props[key].value;
      });
      if (values.length) label += " (" + values.join(", ") + ")";
      else if (set) label += " (" + main.name + ")";
      return label;
    } catch (err) {
      return null;
    }
  }

  const lines = [];

  async function visit(node, depth, parentBox, backgroundIds) {
    const indent = "  ".repeat(depth);

    // ── header: name, type (with component identity), geometry ──
    let type = node.type;
    const instance = await instanceLabel(node);
    if (instance) type = "INSTANCE → " + instance;

    let header = indent + node.name + " [" + type + "] " + node.id;
    const box = bbox(node);
    if (box) {
      header += " " + Math.round(box.width) + "×" + Math.round(box.height);
      if (parentBox) {
        header += " @(" + Math.round(box.x - parentBox.x) + "," + Math.round(box.y - parentBox.y) + ")";
      }
    }
    if (backgroundIds && backgroundIds.has(node.id)) header += " (bg)";
    if (node.visible === false) header += " HIDDEN";
    lines.push(header);

    // ── details ──
    const detail = [];
    const push = (line) => { if (line) detail.push(line); };

    push(flexChildLine(node));
    push(autoLayoutLine(node));

    let background = new Set();
    if ((!node.layoutMode || node.layoutMode === "NONE") && node.children && node.children.length) {
      const measured = measuredSpacing(node);
      background = measured.background;
      for (const line of measured.lines) push(line);
    }

    if (node.type !== "TEXT") {
      push(await formatPaintList(node, "fills", "fill", "fillStyleId"));
    }
    push(await strokeLine(node));
    push(radiusLine(node));
    for (const line of await effectLines(node)) push(line);
    if (node.opacity != null && node.opacity < 1) push("opacity:" + Math.round(node.opacity * 100) / 100);
    if (node.rotation) push("rotation:" + Math.round(node.rotation));
    push(await boundVariablesLine(node));

    if (node.type === "TEXT") {
      for (const line of await textLines(node)) push(line);
    }

    for (const line of detail) lines.push(indent + "  · " + line);

    // ── children ──
    if (node.children && node.children.length) {
      if (depth >= maxDepth) {
        lines.push(indent + "  … " + node.children.length
          + " children beyond maxDepth — request separately: "
          + node.children.slice(0, 10).map((c) => c.id).join(", ")
          + (node.children.length > 10 ? ", …" : ""));
        return;
      }
      for (const child of node.children) {
        await visit(child, depth + 1, box, background);
      }
    }
  }

  await visit(root, 0, root.parent ? bbox(root.parent) : null, null);
  return lines.join("\n");
}

// ─── the `h` namespace handed to every exec ──────────────────────────────────

// Built per exec so nothing about a running script leaks into another one:
// onmessage handlers are not awaited, so execs can interleave freely.
function buildHelpers() {
  return {
    // Bind the fill paint at `idx` to a color variable (instance, id, or key).
    async bF(node, idx, varOrId) {
      const variable = await lookupVariable(varOrId);
      if (!variable) throw new Error("h.bF: variable not found: " + varOrId);
      const fills = clonePaintList(node, "fills", "h.bF");
      if (!fills[idx]) throw new Error("h.bF: '" + node.name + "' has no fill at index " + idx);
      fills[idx] = figma.variables.setBoundVariableForPaint(fills[idx], "color", variable);
      node.fills = fills;
      return variable;
    },

    // Same as bF, for the stroke paint list.
    async bS(node, idx, varOrId) {
      const variable = await lookupVariable(varOrId);
      if (!variable) throw new Error("h.bS: variable not found: " + varOrId);
      const strokes = clonePaintList(node, "strokes", "h.bS");
      if (!strokes[idx]) throw new Error("h.bS: '" + node.name + "' has no stroke at index " + idx);
      strokes[idx] = figma.variables.setBoundVariableForPaint(strokes[idx], "color", variable);
      node.strokes = strokes;
      return variable;
    },

    // Bind a numeric property (corner radius, padding, itemSpacing, width…).
    async bN(node, prop, varOrId) {
      const variable = await lookupVariable(varOrId);
      if (!variable) throw new Error("h.bN: variable not found: " + varOrId);
      node.setBoundVariable(prop, variable);
      return variable;
    },

    // First / all descendants whose name matches exactly.
    findByName(root, name) {
      return root.findOne((node) => node.name === name);
    },
    findAllByName(root, name) {
      return root.findAll((node) => node.name === name);
    },

    // Indented one-line-per-node dump of a subtree — the quick overview.
    dumpTree(node, opts) {
      const options = opts || {};
      const maxDepth = options.maxDepth == null ? 99 : options.maxDepth;
      const showSize = options.showSize !== false;
      const showText = options.showText !== false;
      const showLayout = options.showLayout === true;

      const lines = [];
      const visit = (current, depth) => {
        if (depth > maxDepth) return;
        let line = "  ".repeat(depth) + current.name + " [" + current.type + "] " + current.id;
        if (showSize && current.width !== undefined) {
          line += " " + Math.round(current.width) + "×" + Math.round(current.height);
        }
        if (showLayout && current.layoutMode && current.layoutMode !== "NONE") {
          line += " {" + current.layoutMode[0]
            + " gap:" + current.itemSpacing
            + " pad:" + current.paddingTop + "," + current.paddingRight
            + "," + current.paddingBottom + "," + current.paddingLeft
            + " " + current.primaryAxisSizingMode + "/" + current.counterAxisSizingMode + "}";
        }
        if (showText && current.type === "TEXT") {
          line += ' "' + current.characters + '"';
        }
        lines.push(line);
        if (current.children) {
          for (const child of current.children) visit(child, depth + 1);
        }
      };
      visit(node, 0);
      return lines.join("\n");
    },

    // Full implementation-ready spec of a subtree: measured paddings and gaps
    // (auto-layout or not), every paint with variable/style names, per-corner
    // radii, effects, full text with fonts, component variants.
    async spec(node, opts) {
      return await buildSpec(node, opts);
    },

    // Load every distinct font under `root`, then run the callback.
    // Mixed-font nodes are covered too via their per-range fonts.
    async withFonts(root, asyncFn) {
      const textNodes = root.findAll
        ? root.findAll((node) => node.type === "TEXT")
        : (root.type === "TEXT" ? [root] : []);

      const loaded = new Set();
      const fonts = [];
      for (const text of textNodes) {
        for (const font of fontsOfText(text)) {
          const key = font.family + "|" + font.style;
          if (!loaded.has(key)) {
            loaded.add(key);
            fonts.push(font);
          }
        }
      }
      await Promise.all(fonts.map((font) => figma.loadFontAsync(font)));
      return await asyncFn();
    },

    // Replace a text node's characters. Loads every font the node uses, so
    // mixed-font texts work too (they collapse to the first range's font).
    async setText(node, text) {
      const fonts = fontsOfText(node);
      if (!fonts.length) {
        throw new Error("h.setText: could not resolve fonts of '" + node.name + "'");
      }
      await Promise.all(fonts.map((font) => figma.loadFontAsync(font)));
      node.characters = text;
    },

    // Clone a node and park the copy beside the original.
    cloneNext(node, opts) {
      const options = opts || {};
      const gap = options.gap == null ? 100 : options.gap;
      const copy = node.clone();
      node.parent.appendChild(copy);

      const placements = {
        right: [node.x + node.width + gap, node.y],
        left: [node.x - node.width - gap, node.y],
        down: [node.x, node.y + node.height + gap],
        up: [node.x, node.y - node.height - gap],
      };
      const spot = placements[options.direction || "right"];
      if (spot) {
        copy.x = spot[0];
        copy.y = spot[1];
      }
      if (options.name) copy.name = options.name;
      return copy;
    },

    // Switch an instance's variant properties.
    async variant(instance, props) {
      await instance.setProperties(props);
      return instance;
    },

    // Which variants exist for an instance, component, or component set:
    // current name, property groups, and every sibling variant name.
    async variantsOf(target) {
      if (target.type === "COMPONENT_SET") {
        return {
          current: null,
          groups: target.variantGroupProperties,
          all: target.children.map((child) => child.name),
        };
      }
      let main = null;
      if (target.type === "COMPONENT") {
        main = target;
      } else if (typeof target.getMainComponentAsync === "function") {
        main = await target.getMainComponentAsync();
      }
      if (!main) return null;
      const parent = main.parent;
      if (parent && parent.type === "COMPONENT_SET") {
        return {
          current: main.name,
          groups: parent.variantGroupProperties,
          all: parent.children.map((child) => child.name),
        };
      }
      return { current: main.name, groups: null, all: null };
    },

    // The user's current selection as plain data — turns "this one here"
    // into ids a script can act on.
    sel() {
      return figma.currentPage.selection.map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        w: node.width,
        h: node.height,
        chars: node.type === "TEXT" ? node.characters : undefined,
      }));
    },

    // Hex string -> {r,g,b} in 0..1.
    hex(value) {
      return parseHex(value);
    },

    // Ready-to-assign paint list: node.fills = h.solid("#1a2b3c").
    solid(value, opacity) {
      const paint = { type: "SOLID", color: parseHex(value) };
      if (opacity != null) paint.opacity = opacity;
      return [paint];
    },

    // Create a frame with auto-layout, applying properties in the only order
    // Figma honors: attach to the tree, then layoutMode, then size, then
    // sizing modes, then spacing/align/padding. Other orders silently fail.
    frame(parent, opts) {
      const options = opts || {};
      const frame = figma.createFrame();
      if (parent) parent.appendChild(frame);

      if (options.name) frame.name = options.name;

      if (options.layout) {
        const mode = String(options.layout).toUpperCase();
        frame.layoutMode = mode === "V" ? "VERTICAL" : mode === "H" ? "HORIZONTAL" : mode;
      }

      if (options.w != null || options.h != null) {
        frame.resize(
          options.w == null ? frame.width : options.w,
          options.h == null ? frame.height : options.h,
        );
      }

      if (frame.layoutMode && frame.layoutMode !== "NONE") {
        // Axes the caller didn't pin to a number hug their content by default.
        if (options.hug !== false) {
          const primaryIsWidth = frame.layoutMode === "HORIZONTAL";
          const primaryPinned = primaryIsWidth ? options.w != null : options.h != null;
          const counterPinned = primaryIsWidth ? options.h != null : options.w != null;
          if (!primaryPinned) frame.primaryAxisSizingMode = "AUTO";
          if (!counterPinned) frame.counterAxisSizingMode = "AUTO";
        }
        if (options.spacing != null) frame.itemSpacing = options.spacing;
        if (options.align) {
          if (options.align.primary) frame.primaryAxisAlignItems = options.align.primary;
          if (options.align.counter) frame.counterAxisAlignItems = options.align.counter;
        }
        const padding = normalizePadding(options.padding);
        if (padding) {
          frame.paddingTop = padding.top;
          frame.paddingRight = padding.right;
          frame.paddingBottom = padding.bottom;
          frame.paddingLeft = padding.left;
        }
      }

      if (options.fill != null) {
        frame.fills = options.fill === false ? [] : this.solid(options.fill);
      }
      if (options.radius != null) frame.cornerRadius = options.radius;
      return frame;
    },

    // Node by id, with the aliases "page" and "sel" so scripts can name
    // "what I'm looking at" without hunting for an id first.
    async resolve(idOrAlias) {
      if (idOrAlias === "page") return figma.currentPage;
      if (idOrAlias === "sel") {
        const selection = figma.currentPage.selection;
        if (!selection.length) throw new Error("nothing selected in Figma");
        return selection[0];
      }
      return await figma.getNodeByIdAsync(idOrAlias);
    },

    // Thin async accessors.
    async node(id) {
      return await figma.getNodeByIdAsync(id);
    },
    async var_(idOrKey) {
      return await lookupVariable(idOrKey);
    },
    async importComp(key) {
      return await figma.importComponentByKeyAsync(key);
    },
    async importVar(key) {
      return await figma.variables.importVariableByKeyAsync(key);
    },
  };
}

// Default instance for direct use (tests, console); execs get their own.
const HELPERS = buildHelpers();

// ─── messages from the UI iframe ─────────────────────────────────────────────

async function pushConfig() {
  const saved = (await figma.clientStorage.getAsync(STORAGE_KEY)) || {};
  figma.ui.postMessage({
    type: "config",
    server: saved.server || "",
    token: saved.token || "",
  });
}

async function runExec(msg) {
  const { id, code } = msg;

  const logLines = [];
  const print = (...args) => {
    const text = args
      .map((arg) => (typeof arg === "object" && arg !== null
        ? JSON.stringify(toPlainValue(arg), null, 2)
        : String(arg)))
      .join(" ");
    logLines.push(text);
    figma.ui.postMessage({ type: "log", id, text });
  };

  try {
    const script = new Function(
      "figma", "print", "h",
      "return (async () => { " + code + " })();",
    );
    const result = await script(figma, print, buildHelpers());

    const text = toDisplayText(result, logLines);
    const value = toPlainValue(result);
    const approxSize = text.length + JSON.stringify(value).length;
    if (approxSize > RESULT_BYTE_LIMIT) {
      figma.ui.postMessage({
        type: "error",
        id,
        text: "result too large (~" + Math.round(approxSize / 1024)
          + "KB) — lower maxDepth or request child subtrees separately",
        stack: null,
      });
      return;
    }

    figma.ui.postMessage({ type: "result", id, text, value });
  } catch (err) {
    figma.ui.postMessage({
      type: "error",
      id,
      text: (err && err.message) || String(err),
      stack: (err && err.stack) || null,
    });
  }
}

figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "get-config":
      await pushConfig();
      return;
    case "set-config":
      await figma.clientStorage.setAsync(STORAGE_KEY, {
        server: msg.server || "",
        token: msg.token || "",
      });
      await pushConfig();
      return;
    case "ui-size":
      figma.ui.resize(msg.w, msg.h);
      return;
    case "exec":
      await runExec(msg);
      return;
    default:
      // Unknown message — nothing to do.
  }
};
