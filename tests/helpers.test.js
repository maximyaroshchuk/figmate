// Pure-logic checks for the h.* helpers in plugin/code.js, run against a
// stubbed figma global:
//
//     node tests/helpers.test.js
//
// The high-value targets are the ones Figma gets silently wrong when
// mishandled: hex channel conversion, and the property-write ORDER inside
// h.frame() — auto-layout settings applied before layoutMode just vanish.
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "plugin", "code.js"), "utf8");

// Every property write on a stub frame lands here, in order.
const writes = [];

function stubFrame() {
  const target = {
    _children: [],
    width: 100,
    height: 100,
    appendChild(child) {
      writes.push("appendChild");
      this._children.push(child);
    },
    resize(w, h) {
      writes.push("resize");
      this.width = w;
      this.height = h;
    },
  };
  return new Proxy(target, {
    set(obj, key, value) {
      if (typeof value !== "function") writes.push(String(key));
      obj[key] = value;
      return true;
    },
  });
}

const figmaStub = {
  showUI() {},
  ui: { onmessage: null, postMessage() {} },
  createFrame: stubFrame,
  currentPage: { selection: [] },
  variables: {},
};

// code.js targets the plugin sandbox; evaluate it with the stub in scope and
// pull out the HELPERS namespace it defines.
const h = new Function("figma", "__html__", source + "\nreturn HELPERS;")(figmaStub, "");

let failures = 0;
function expect(label, actual, wanted) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(wanted);
  const passed = got === want;
  if (!passed) failures++;
  console.log((passed ? "  ok  " : " FAIL ") + label + (passed ? "" : "\n         got " + got + "\n         want " + want));
}

// h.hex — the 0..255 -> 0..1 conversion everyone hand-rolls wrong.
expect("hex #ffffff", h.hex("#ffffff"), { r: 1, g: 1, b: 1 });
expect("hex without #", h.hex("000000"), { r: 0, g: 0, b: 0 });
expect("hex #f00 shorthand", h.hex("#f00"), { r: 1, g: 0, b: 0 });
expect("hex #808080", h.hex("#808080"), { r: 128 / 255, g: 128 / 255, b: 128 / 255 });

let rejected = false;
try {
  h.hex("#12");
} catch (err) {
  rejected = /expected #RGB/.test(err.message);
}
expect("hex rejects malformed input", rejected, true);

// h.solid
expect("solid paint list", h.solid("#ff0000"), [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }]);
expect("solid with opacity", h.solid("#ff0000", 0.5), [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 0.5 }]);

// h.frame — Figma's required write order and the hug defaults.
writes.length = 0;
const parent = stubFrame();
const card = h.frame(parent, {
  name: "Card",
  layout: "V",
  spacing: 16,
  padding: [24, 12],
  radius: 8,
  fill: "#ffffff",
  align: { primary: "CENTER", counter: "MIN" },
});
const at = (key) => writes.indexOf(key);
expect("appendChild precedes layoutMode", at("appendChild") < at("layoutMode"), true);
expect("layoutMode precedes sizing modes", at("layoutMode") < at("primaryAxisSizingMode"), true);
expect("sizing modes precede itemSpacing", at("primaryAxisSizingMode") < at("itemSpacing"), true);
expect("unsized frame hugs both axes", [card.primaryAxisSizingMode, card.counterAxisSizingMode], ["AUTO", "AUTO"]);
expect("padding [v,h] shorthand", [card.paddingTop, card.paddingRight, card.paddingBottom, card.paddingLeft], [24, 12, 24, 12]);
expect("layout V expands to VERTICAL", card.layoutMode, "VERTICAL");
expect("fill accepts hex", card.fills, [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]);
expect("align settings applied", [card.primaryAxisAlignItems, card.counterAxisAlignItems], ["CENTER", "MIN"]);

// A pinned axis must stay FIXED, and resize must come after layoutMode.
writes.length = 0;
const pinned = h.frame(parent, { layout: "H", w: 320 });
expect("pinned width is not hugged", pinned.primaryAxisSizingMode, undefined);
expect("unpinned height still hugs", pinned.counterAxisSizingMode, "AUTO");
expect("resize comes after layoutMode", writes.indexOf("layoutMode") < writes.indexOf("resize"), true);

// Numeric padding shorthand.
const padded = h.frame(parent, { layout: "V", padding: 20 });
expect("numeric padding on all sides", [padded.paddingTop, padded.paddingRight], [20, 20]);

// h.sel maps selection nodes to plain data.
figmaStub.currentPage.selection = [
  { id: "1:2", name: "Btn", type: "FRAME", width: 100, height: 40 },
];
expect("sel maps the selection", h.sel(), [
  { id: "1:2", name: "Btn", type: "FRAME", w: 100, h: 40 },
]);

// h.spec — measured spacing, background detection, readable colors and fonts.
(async () => {
  const specContainer = {
    id: "9:1",
    name: "Panel",
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 120 },
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
    cornerRadius: 8,
    children: [
      {
        id: "9:2",
        name: "BG",
        type: "RECTANGLE",
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 120 },
        fills: [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9 } }],
      },
      {
        id: "9:3",
        name: "Title",
        type: "TEXT",
        absoluteBoundingBox: { x: 16, y: 16, width: 80, height: 20 },
        characters: "Hi",
        fontName: { family: "Inter", style: "Medium" },
        fontSize: 14,
        lineHeight: { unit: "PIXELS", value: 20 },
        letterSpacing: { value: 0 },
        fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
        textAlignHorizontal: "LEFT",
      },
      {
        id: "9:4",
        name: "Body",
        type: "RECTANGLE",
        absoluteBoundingBox: { x: 16, y: 60, width: 80, height: 20 },
        fills: [{ type: "SOLID", color: { r: 0.2, g: 0.5, b: 1 }, opacity: 0.5 }],
      },
    ],
  };

  const spec = await h.spec(specContainer);
  const has = (needle) => spec.includes(needle);

  expect("spec: measured insets from children", has("~pad:T16 R104 B40 L16"), true);
  expect("spec: measured vertical gap", has("~gapY:24"), true);
  expect("spec: full-cover child marked bg", has("BG [RECTANGLE] 9:2 200×120 @(0,0) (bg)"), true);
  expect("spec: container fill as hex", has("fill:#ffffff"), true);
  expect("spec: radius", has("r:8"), true);
  expect("spec: full text content", has('text:"Hi"'), true);
  expect("spec: font with size/line-height", has("font:Inter Medium 14/20"), true);
  expect("spec: paint opacity notation", has("#3380ff@0.5"), true);

  // Auto-layout facts come straight from the API, in readable form.
  const auto = h.frame(null, { layout: "V", spacing: 16, padding: [24, 12] });
  auto.id = "9:9";
  auto.name = "Stack";
  auto.type = "FRAME";
  const autoSpec = await h.spec(auto);
  expect("spec: auto-layout line", autoSpec.includes("layout:V gap:16 pad:24,12 w:hug h:hug"), true);

  console.log(failures ? "\n" + failures + " FAILED" : "\nall helper checks passed");
  process.exit(failures ? 1 : 0);
})();
