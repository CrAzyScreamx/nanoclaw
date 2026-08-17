#!/usr/bin/env python3
"""Emit the shopping-list print sheet, with both font sets embedded as data: URIs.

THIS SCRIPT IS THE SOURCE OF TRUTH FOR ../list-template.html — it reproduces
that file byte for byte. The two therefore only ever change together: edit the
HTML literal below, rebuild, commit both. Editing the .html on its own is
silently undone by the next rebuild, which is exactly how the original this was
ported from ended up with a generator a rewrite behind the sheet it produced.

    Rebuild:  python3 build_template.py ../list-template.html

The container image has NO Hebrew-capable font (verified: `fc-list :lang=he`
is empty), and network egress at print time goes through the OneCLI proxy, so
a Google Fonts <link> is not dependable. Embedding makes the sheet render
identically in-container, on the host, and in the user's browser. Both font
sets ship in the one file because one sheet serves every locale pack.

The six .woff2 files beside this script are IBM Plex subsets under SIL
OFL-1.1, whose full text is in OFL.txt here — the licence requires it to be
distributed with the fonts, and the rest of this repo is MIT, so the copy is
not optional. The generated sheet embeds those same fonts, which is why the
@font-face block below carries the copyright notice as a human-readable
header (OFL-1.1 §2 allows exactly that in place of a bundled text file).

The sheet is direction-neutral: `dir` and `lang` come from the injected
payload and every alignment in the stylesheet is logical (`start` / `end`), so
the same file prints a right-to-left and a left-to-right list — a physically
right-aligned masthead would typeset an LTR sheet against the wrong margin.
The `lang="en" dir="ltr"` on <html>, the <title> and the DEMO list are only
what a browser shows when the file is opened directly; every string a user
actually sees comes from tools/locales/<tag>.json by way of lib/printable.ts,
so no localised text belongs in this script.

Styling follows the reference sheet the user supplied. Palette and geometry
were measured off that PDF rather than eyeballed:

    #234B42  titles, category names        band height   5.1mm
    #3F6F63  accent bar, top rule          row pitch     6.2mm
    #7FA89C  marks, subtitle               accent bar    0.9mm
    #EEF3F1  category band fill            content width 177.8mm
    #DFE4E2  row rules

Every one of those type sizes and vertical measurements is written as
`reference-value * var(--scale)`, so the whole sheet resizes from the single
`--scale` number in :root — which is what lets the fit loop at the foot of the
page step one number down until the list fits a page. The measurements above
stay legible in the source at their reference values; only the multiplier
moves. Strokes, page margins and sheet padding deliberately do NOT scale —
they are page furniture, not type.
"""
import base64, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "list-template.html")


def u(name):
    with open(os.path.join(HERE, name), "rb") as fh:
        return "data:font/woff2;base64," + base64.b64encode(fh.read()).decode()


FACES = f"""
  /* IBM Plex Sans Hebrew + IBM Plex Mono, embedded so the sheet needs no
     network and no container font packages.
     Copyright (c) 2017 IBM Corp. with Reserved Font Name "Plex", licensed
     under SIL OFL-1.1 — full text in _template-src/OFL.txt. This notice
     travels with the fonts because they are embedded in this file. */
  @font-face{{font-family:"IBM Plex Sans Hebrew";font-style:normal;font-weight:400;font-display:block;
    src:url({u('he400.woff2')}) format("woff2");unicode-range:U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F;}}
  @font-face{{font-family:"IBM Plex Sans Hebrew";font-style:normal;font-weight:600;font-display:block;
    src:url({u('he600.woff2')}) format("woff2");unicode-range:U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F;}}
  @font-face{{font-family:"IBM Plex Sans Hebrew";font-style:normal;font-weight:400;font-display:block;
    src:url({u('lat400.woff2')}) format("woff2");}}
  @font-face{{font-family:"IBM Plex Sans Hebrew";font-style:normal;font-weight:600;font-display:block;
    src:url({u('lat600.woff2')}) format("woff2");}}
  @font-face{{font-family:"IBM Plex Mono";font-style:normal;font-weight:400;font-display:block;
    src:url({u('mono400.woff2')}) format("woff2");}}
  @font-face{{font-family:"IBM Plex Mono";font-style:normal;font-weight:600;font-display:block;
    src:url({u('mono600.woff2')}) format("woff2");}}
"""

HTML = r"""<!DOCTYPE html>
<!--
  The shopping-list print sheet. `tools/lib/printable.ts` injects the list as
  window.__LIST__ just before </head> and renders this through headless
  Chromium; nothing here is edited per print.

  BOTH FONT SETS SHIP IN THIS ONE FILE, as data: URIs — the container image has
  no Hebrew-capable font (`fc-list :lang=he` is empty) and egress at print time
  goes through a proxy, so a webfont CDN is not dependable. The Hebrew faces are
  11 KB of the 112 KB total: not a saving worth a sheet full of empty boxes.

  DIRECTION COMES FROM THE PAYLOAD. The `dir` and `lang` attributes below are
  only what a browser sees when this file is opened on its own; the script at
  the foot of the page applies `L.dir` / `L.lang` from the injected list, so one
  template prints an RTL and an LTR language. For the same reason every
  alignment in the stylesheet is logical (`start` / `end`) rather than physical:
  a right-aligned masthead would typeset an LTR sheet against the wrong margin.

  GENERATED FILE — DO NOT HAND-EDIT. `_template-src/build_template.py` produces
  it, fonts and all, and reproduces it byte for byte, so a rebuild silently
  overwrites anything changed here. Edit the script instead, run
  `python3 build_template.py ../list-template.html`, and commit both.
-->
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shopping list</title>

<script>
/* ==========================================================================
   Fallback list — used ONLY when this file is opened directly in a browser.
   On a real print `lib/printable.ts` injects the list as window.__LIST__ ahead
   of the script at the foot of the page and none of this is read. There is no
   reason to edit it.

   Shape: { title, date, note, dir, lang,
            categories: [ { name, items: [ {name, qty, note} ] } ] }
   - "qty" may be an empty string when there is no quantity.
   - an item's "note" is the product qualifier ("5%", "250 g") and prints in
     parentheses beside the name. Do not confuse it with the list's own "note",
     which is a footer line for the whole sheet.
   ========================================================================== */
const DEMO = {
  title: "Shopping list",
  date:  "24.07.2026",
  note:  "",
  dir:   "ltr",
  lang:  "en-US",
  categories: [
    { name: "Produce", items: [
      { name: "Tomatoes", qty: "1 kg" },
      { name: "Cucumbers", qty: "1 kg" },
      { name: "Onions", qty: "3" },
      { name: "Lemons", qty: "4" },
      { name: "Parsley", qty: "bunch" }
    ]},
    { name: "Bakery", items: [
      { name: "Wholemeal bread", qty: "1" },
      { name: "Pitas", qty: "pack" }
    ]},
    { name: "Dairy, cheese & eggs", items: [
      { name: "Milk", qty: "2 l", note: "3%" },
      { name: "Cottage cheese", qty: "2", note: "5%" },
      { name: "Ski cheese", qty: "1", note: "250 g 5%" },
      { name: "Eggs L", qty: "tray" },
      { name: "Butter", qty: "200 g" }
    ]},
    { name: "Meat, poultry & fish", items: [
      { name: "Chicken breast", qty: "1.5 kg" },
      { name: "Salmon fillet", qty: "400 g" }
    ]},
    { name: "Pantry", items: [
      { name: "Olive oil", qty: "750 ml" },
      { name: "Pasta", qty: "2" },
      { name: "Tinned chickpeas", qty: "3" },
      { name: "Tahini", qty: "1" },
      { name: "Rice", qty: "1 kg" }
    ]},
    { name: "Frozen", items: [
      { name: "Peas", qty: "bag" },
      { name: "Ice cream", qty: "1" }
    ]},
    { name: "Household & cleaning", items: [
      { name: "Washing-up liquid", qty: "1" },
      { name: "Bin bags", qty: "roll" },
      { name: "Paper towels", qty: "2" }
    ]}
  ]
};
</script>

<style>
__FACES__
  :root{
    /* The one knob for how big the sheet prints. Body/item text is
       9.5pt * --scale, and every other size and vertical measurement below is
       its reference-sheet value * --scale, so the proportions hold at any
       setting. 1.58 puts normal text at 15pt; 1.263 is 12pt (the old size, and
       now the floor the fit loop will not go below); 1 restores the original
       reference sheet. The two-column list is what pays for the larger type —
       it roughly halves the height a given list occupies. */
    --scale:1.58;

    /* Weight of the sheet's ordinary text — item names, quantities,
       qualifiers, the date line. 600 is IBM Plex SemiBold: heavier than the
       400 this used to print at, but not a display bold. Only 400 and 600 are
       embedded, and an intermediate 500 is not an option — with no 500 face,
       CSS font matching resolves 500 down to 400 and nothing changes. 400
       restores the original text. */
    --wt:600;

    --deep:#234B42;   /* title, category names */
    --mid:#3F6F63;    /* accent bar, top rule, quantities */
    --soft:#7FA89C;   /* subtitle, category marks */
    --band:#EEF3F1;   /* category band fill */
    --rule:#DFE4E2;   /* row rules */
    --thin:#D8DDD9;   /* hairline under the top rule */
    --sans:"IBM Plex Sans Hebrew","IBM Plex Sans",system-ui,sans-serif;
    --mono:"IBM Plex Mono","IBM Plex Sans Hebrew",ui-monospace,monospace;
  }

  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:#d9d7d2;
    color:var(--deep);
    font-family:var(--sans);
    font-size:calc(9.5pt * var(--scale));
    font-weight:var(--wt);
    line-height:1.3;
    -webkit-print-color-adjust:exact;
    print-color-adjust:exact;
  }

  .sheet{
    width:210mm;min-height:297mm;
    margin:22px auto 40px;padding:12mm 16mm 16mm;
    background:#fff;
    box-shadow:0 2px 18px rgba(0,0,0,.22);
  }

  /* ---- masthead ---- */
  h1{
    font-family:var(--sans);font-weight:600;font-size:calc(20pt * var(--scale));
    color:var(--deep);letter-spacing:-.005em;
    margin:0;line-height:1.05;text-align:start;
  }
  .sub{
    font-size:calc(7.5pt * var(--scale));letter-spacing:.18em;color:var(--soft);
    text-align:start;margin:calc(1.4mm * var(--scale)) 0 0;
  }
  /* Two-weight rule, as on the reference: a 0.5mm stroke in the accent green
     with a hairline 0.5mm beneath it. The strokes themselves do not scale —
     only the space around them, so the rule stays a rule and not a bar. */
  .rule{border:0;border-top:.5mm solid var(--mid);margin:calc(3.4mm * var(--scale)) 0 0}
  .rule.thin{
    border-top:.25mm solid var(--thin);
    margin:calc(.5mm * var(--scale)) 0 calc(3.6mm * var(--scale));
  }

  /* ---- categories ---- */
  /* Two columns. A shopping list is a column of short rows, so half the sheet
     was white space at any readable size — flowing the categories into two
     columns buys back roughly half the height, which is what lets the type run
     larger without paginating. The browser fills the leading column first on
     its own, whichever direction the sheet is set in; no direction property is
     needed here.
     break-inside:avoid on .cat keeps a category whole in one column. */
  #list{
    column-count:2;
    column-gap:calc(6mm * var(--scale));
    column-rule:.25mm solid var(--rule);
  }
  /* A single category cannot be split across columns (break-inside:avoid), so
     two columns would put the whole list in the right one and leave the left
     half of the sheet blank. Set by the build script when there is nothing to
     balance. */
  #list.one-col{column-count:1;column-rule:0}

  .cat{break-inside:avoid;margin:0 0 calc(5mm * var(--scale))}
  .cat:last-child{margin-bottom:0}

  .catbar{
    background:var(--band);
    /* The reference sets a 0.9mm bar on the leading (right) edge of the band.
       border-inline-start keeps it on the right under dir=rtl. */
    border-inline-start:.9mm solid var(--mid);
    height:calc(5.1mm * var(--scale));
    display:flex;align-items:center;justify-content:space-between;
    padding:0 calc(2.5mm * var(--scale));
  }
  .catbar .nm{
    font-size:calc(8.8pt * var(--scale));font-weight:600;color:var(--deep);
    letter-spacing:-.005em;
  }
  .catbar .mk{display:flex;align-items:center;gap:calc(1.8mm * var(--scale))}
  /* CSS diamond rather than a dingbat glyph: the container image ships no
     symbol font, so a literal ✿ or ◆ would print as tofu. */
  .catbar .dia{
    width:calc(1.5mm * var(--scale));height:calc(1.5mm * var(--scale));
    background:var(--soft);transform:rotate(45deg);
  }
  .catbar .n{
    font-family:var(--mono);font-size:calc(7pt * var(--scale));color:var(--soft);
    letter-spacing:.04em;
  }

  /* ---- rows ---- */
  /* One grid per category, so every name in it starts at the same x whatever
     the longest quantity in that category is — a bare "2" and a "750 מ"ל"
     share the leading column instead of each row setting its own indent. */
  ul{
    list-style:none;margin:calc(2.6mm * var(--scale)) 0 0;padding:0;
    display:grid;grid-template-columns:max-content 1fr;
    column-gap:calc(2.4mm * var(--scale));
    /* Was a fixed height. A long qualifier has to be able to wrap onto a second
       line and push the row taller rather than run off the page — minmax keeps
       every ordinary row at exactly the old height and lets only those grow. */
    grid-auto-rows:minmax(calc(6.2mm * var(--scale)), auto);
  }
  li{display:contents}
  /* The quantity leads the row, in the slot the reference sheet gives the
     checkbox: "2 יין לקידוש". It sat at the far end of .ln before, which put
     it against the left margin under dir=rtl — visually detached from the item
     it belongs to. text-align:end keeps it flush against the name it counts
     even when a longer qty in the same category widens the column; min-width
     holds the column open for rows whose qty is "". */
  .qty{
    min-width:calc(4.5mm * var(--scale));text-align:end;
    font-family:var(--mono);font-size:calc(8.5pt * var(--scale));color:var(--mid);
    font-variant-numeric:tabular-nums;white-space:nowrap;
    /* keeps "2 ליטר" / "1.5 ק\"ג" intact across the bidi boundary */
    unicode-bidi:isolate;
  }
  /* The rule lives on this wrapper, not the row, so it stops short of the
     quantity exactly as it did of the checkbox on the reference sheet. */
  .ln{
    display:flex;flex-wrap:wrap;align-items:baseline;
    border-bottom:.25mm solid var(--rule);padding-bottom:calc(.6mm * var(--scale));
  }
  .name{color:var(--deep);font-size:calc(9.5pt * var(--scale))}
  /* The qualifier sits right after the name at the SAME size and now the SAME
     color — it is part of what you are looking for on the shelf ("250 גרם",
     "5%"), not an annotation about it, and set in soft green it read as fine
     print next to the name it qualifies. The parentheses are what separate it
     from the product name; nothing else needs to.
     isolate keeps "(250 גרם 5%)" intact — the parens and the digits are
     neutral/LTR characters between Hebrew, which is exactly what the bidi
     algorithm reorders if the run is not sealed. */
  .qual{
    margin-inline-start:calc(1.4mm * var(--scale));
    font-size:calc(9.5pt * var(--scale));color:var(--deep);
    unicode-bidi:isolate;
  }

  .note{
    font-size:calc(8.5pt * var(--scale));color:var(--soft);
    margin:calc(4mm * var(--scale)) 0 0;text-align:start;
  }

  /* ---- print ---- */
  @page{size:A4;margin:12mm 16mm 16mm}
  @media print{
    body{background:#fff}
    .sheet{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}
    .cat{break-inside:avoid}
  }
  @media (max-width:820px){
    .sheet{width:auto;padding:9mm}
  }
</style>
</head>
<body>

<div class="sheet" id="sheet">
  <h1 id="title"></h1>
  <p class="sub" id="sub"></p>
  <hr class="rule">
  <hr class="rule thin">

  <div id="list"></div>
  <p class="note" id="note" hidden></p>
</div>

<script>
(function(){
  // printable.ts injects window.__LIST__ ahead of this script; DEMO is the
  // fallback so the file still renders when opened directly.
  const L = (typeof window !== "undefined" && window.__LIST__) || DEMO || {};
  const cats = Array.isArray(L.categories) ? L.categories : [];

  // Direction and language come from the PAYLOAD, not from this file. The
  // locale pack decides them (`pack.dir`, `pack.tag`), so the same template
  // prints a right-to-left and a left-to-right sheet. Everything below is
  // written in logical properties (border-inline-start, text-align:start), so
  // this one attribute is all that has to change.
  if (L.dir === "rtl" || L.dir === "ltr") document.documentElement.setAttribute("dir", L.dir);
  if (typeof L.lang === "string" && L.lang) document.documentElement.setAttribute("lang", L.lang);

  document.getElementById("title").textContent = L.title || "Shopping list";

  // Subtitle is the date alone, in the reference's tracked line under the
  // title. `store` is still accepted in the data but deliberately not printed.
  const sub = document.getElementById("sub");
  if (L.date) sub.textContent = L.date;
  else sub.hidden = true;

  if (L.note) {
    const n = document.getElementById("note");
    n.textContent = L.note; n.hidden = false;
  }

  const wrap = document.getElementById("list");

  cats.forEach(function(cat){
    const items = Array.isArray(cat.items) ? cat.items : [];
    if (!items.length) return;

    const sec = document.createElement("section");
    sec.className = "cat";

    const bar = document.createElement("div");
    bar.className = "catbar";
    bar.innerHTML = '<span class="nm"></span><span class="mk"><span class="n"></span><span class="dia"></span></span>';
    bar.querySelector(".nm").textContent = cat.name || "";
    bar.querySelector(".n").textContent = items.length;
    sec.appendChild(bar);

    const ul = document.createElement("ul");
    items.forEach(function(it){
      const li = document.createElement("li");
      const qty = document.createElement("span"); qty.className = "qty"; qty.textContent = it.qty || "";
      const ln = document.createElement("span"); ln.className = "ln";
      const name = document.createElement("span"); name.className = "name"; name.textContent = it.name || "";
      ln.append(name);
      // Product qualifier ("5%", "250 גרם") — which product, not how many.
      // Parenthesised rather than run on after the name: unpunctuated it reads
      // as part of the product name on paper.
      if (it.note) {
        const qual = document.createElement("span");
        qual.className = "qual";
        qual.textContent = "(" + it.note + ")";
        ln.append(qual);
      }
      li.append(qty, ln);
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    wrap.appendChild(sec);
  });

  // Two columns need at least two categories to balance — see #list.one-col.
  if (wrap.children.length < 2) wrap.classList.add("one-col");

  /* ---- fit one page when it can ----------------------------------------
     Sorting into real supermarket aisles produces more, smaller categories
     than a human improvising four broad ones, and each category costs a band
     plus its gap. That pushed a 23-item list — one page before — onto a second
     page carrying six rows, which is a worse sheet to shop from.

     So measure the built sheet and step --scale down until it fits the A4 text
     block. A list that already fits keeps the full 15pt on the first pass and
     is untouched; a borderline one compacts a little; a genuinely long one
     still paginates rather than shrinking to nothing.

     The list is two columns now, so the height measured here is the taller of
     the two balanced columns, not the sum of the categories — which is exactly
     what should be compared against the page. FIT_MM is unchanged by that: it
     is a bound on the printed height of the block, whatever produced it.

     Measured element-to-element, NOT off .sheet: on screen .sheet carries
     min-height:297mm and its own padding, so its box always reports a full
     page and would make every list look like it fits.

     FIT_MM is NOT 297-12-16=269, the A4 text block. This measurement runs in
     screen media, and Chromium's print layout of the same sheet comes out
     taller — enough that a sheet measuring 269mm here paginates. The number
     below is empirical: on a 23-item / 7-category list, --scale 1.01 measured
     249.2mm and printed on one page, 1.02 measured 251.6mm and printed on two.
     248 sits just under that boundary. If the sheet's metrics change, re-derive
     it the same way — render at a few fixed scales, find where `pdfinfo` flips
     from 1 page to 2, and take the measurement just below the flip. Erring low
     costs slightly smaller type; erring high costs the extra page this is here
     to prevent. */
  const FIT_MM = 248;
  /* Floor is the old one-column default (12pt), not 1.0. Two columns halve the
     height a list needs, so a sheet that used to fit at 12pt in one column has
     room to spare in two — there is no reason to ever step below the size this
     sheet printed at before. A list long enough to still overflow at 12pt in
     two columns is one that paginated in one column too. */
  const FLOOR = 1.263;

  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;height:100mm";
  document.body.appendChild(probe);
  const pxPerMm = probe.getBoundingClientRect().height / 100;
  probe.remove();

  const head = document.getElementById("title");
  const noteEl = document.getElementById("note");
  const tail = noteEl.hidden ? wrap : noteEl;
  const contentMm = () =>
    (tail.getBoundingClientRect().bottom - head.getBoundingClientRect().top) / pxPerMm;

  const root = document.documentElement;
  const start = parseFloat(getComputedStyle(root).getPropertyValue("--scale")) || 1.58;
  // Steps down from the full size, and always tries FLOOR exactly before
  // giving up — otherwise the last scale tried is a hair above the floor and a
  // list that would have just fit at the floor paginates instead.
  for (let s = start; ; s = Math.max(FLOOR, s - 0.02)) {
    root.style.setProperty("--scale", s.toFixed(3));
    if (contentMm() <= FIT_MM || s <= FLOOR) break;
  }

  // printable.ts waits for this before printing, so a half-rendered sheet
  // can never reach the PDF.
  document.documentElement.setAttribute("data-ready", "1");
})();
</script>
</body>
</html>
"""

with open(OUT, "w", encoding="utf-8") as fh:
    fh.write(HTML.replace("__FACES__", FACES))
print(f"wrote {os.path.abspath(OUT)} ({os.path.getsize(OUT)} bytes)")
