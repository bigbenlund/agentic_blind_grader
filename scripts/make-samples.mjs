// Builds test fixtures (test/fixtures/) and the demo submissions (sample-data/) in non-text formats.
// Needs LibreOffice. Run once: node scripts/make-samples.mjs
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { convert } from "../src/convert.mjs";

const root = new URL("../", import.meta.url);
const FIXTURES = new URL("test/fixtures/", root);
const SUBMISSIONS = new URL("sample-data/submissions/", root);
const escXml = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// Flat ODF presentation: slides of [title, body lines, notes]. LibreOffice converts it to .pptx/.ppt.
function fodp(slides) {
  const frame = (cls, y, h, lines) => `<draw:frame presentation:class="${cls}" svg:x="1.5cm" svg:y="${y}cm"
    svg:width="25cm" svg:height="${h}cm"><draw:text-box>${lines.map((l) => `<text:p>${escXml(l)}</text:p>`).join("")}</draw:text-box></draw:frame>`;
  const pages = slides.map(([title, body, notes], i) => `
    <draw:page draw:name="slide${i + 1}" draw:master-page-name="Default">
      ${frame("title", 1, 2.5, [title])}
      ${frame("outline", 4, 10, body)}
      ${notes ? `<presentation:notes>${frame("notes", 14, 10, [notes])}</presentation:notes>` : ""}
    </draw:page>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation"
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0">
  <office:automatic-styles>
    <style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout>
  </office:automatic-styles>
  <office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>
  <office:body><office:presentation>${pages}</office:presentation></office:body>
</office:document>`;
}

// Renders text as a scanned page. blur > 1 draws it small and scales it up, to get weak OCR.
function textImage(text, { width = 1400, font = 30, blur = 1 } = {}) {
  const measure = createCanvas(1, 1).getContext("2d");
  const size = font / blur;
  measure.font = `${size}px Georgia`;
  const lines = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line && measure.measureText(`${line} ${word}`).width > width / blur - 120 / blur) lines.push(line), (line = word);
      else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  const lineHeight = size * 1.5;
  const small = createCanvas(width / blur, lines.length * lineHeight + 120 / blur);
  const ctx = small.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, small.width, small.height);
  ctx.fillStyle = "#222";
  ctx.font = `${size}px Georgia`;
  lines.forEach((l, i) => ctx.fillText(l, 60 / blur, 60 / blur + (i + 0.8) * lineHeight));
  if (blur === 1) return small;

  const big = createCanvas(small.width * blur, small.height * blur);
  const bctx = big.getContext("2d");
  bctx.imageSmoothingEnabled = true;
  bctx.drawImage(small, 0, 0, big.width, big.height);
  return big;
}

async function write(dir, name, data) {
  await writeFile(new URL(name, dir), data);
  console.log(`wrote ${new URL(name, dir).pathname}`);
}

// --- test fixtures ---
await mkdir(FIXTURES, { recursive: true });
const essay = "Downtowns should be car-free. Written by Grace Kim (grace.kim@stateu.edu, ID 800123405).\n" +
  "Pedestrian streets bring life back to downtowns, and my classmate Jordan Alvarez agrees.";

const deck = fodp([
  ["Car-Free Downtowns", ["By Grace Kim", "ENG 101"], "Introduce myself and the thesis."],
  ["Why it works", ["Streets become places for people", "Local sales roughly double on festival weekends"],
    "Credit Jordan Alvarez for the interview idea."],
  ["Conclusion", ["Cities should ban private cars downtown"], ""],
]);
await write(FIXTURES, "deck.pptx", await convert(Buffer.from(deck), "fodp", "pptx"));
await write(FIXTURES, "deck.ppt", await convert(Buffer.from(deck), "fodp", "ppt"));
await write(FIXTURES, "essay.doc", await convert(Buffer.from(essay), "txt", "doc"));
await write(FIXTURES, "essay.pdf", await convert(Buffer.from(essay), "txt", "pdf"));
const scan = textImage(essay).toBuffer("image/png");
await write(FIXTURES, "scan.png", scan);
await write(FIXTURES, "scan.jpg", textImage(essay).toBuffer("image/jpeg", 90));
await write(FIXTURES, "scan.pdf", await convert(scan, "png", "pdf"));
await write(FIXTURES, "blurry.png", textImage(essay, { font: 24, blur: 6 }).toBuffer("image/png"));

// Typed page, then a typed heading over a photographed paragraph, then a photo-only page.
const photo = (text) => `<img width="600" src="data:image/png;base64,${textImage(text).toBuffer("image/png").toString("base64")}">`;
const mixed = `<html><body>
  <p>Page one is typed. Cities should ban private cars downtown because streets become places for people.</p>
  <p style="page-break-before: always">Appendix A, my handwritten field notes from the festival weekend:</p>
  ${photo("Field notes: vendors said sales roughly doubled. Maya Chen helped me count visitors.")}
  <p style="page-break-before: always"></p>${photo("Final page: the conclusion was photographed, not typed.")}
</body></html>`;
await write(FIXTURES, "mixed.pdf", await convert(Buffer.from(mixed), "html", "pdf"));

// A typed essay with a decorative logo, which must not be OCR'd into the text or lower its confidence.
const logo = createCanvas(300, 300);
const lctx = logo.getContext("2d");
lctx.fillStyle = "#2a6";
lctx.beginPath();
lctx.arc(150, 150, 120, 0, 2 * Math.PI);
lctx.fill();
const withLogo = `<html><body><img width="150" src="data:image/png;base64,${logo.toBuffer("image/png").toString("base64")}">
  <p>Cities should ban private cars downtown because streets become places for people.</p></body></html>`;
await write(FIXTURES, "logo.pdf", await convert(Buffer.from(withLogo), "html", "pdf"));

// A typed essay with a noisy photo (no writing) and a short handwritten caption.
const noise = createCanvas(800, 500);
const nctx = noise.getContext("2d");
for (let i = 0; i < 4000; i++) {
  nctx.fillStyle = `hsl(${(i * 37) % 360}, 60%, ${20 + (i % 60)}%)`;
  nctx.fillRect((i * 97) % 800, (i * 53) % 500, 12 + (i % 30), 12 + (i % 20));
}
const withPhoto = `<html><body><p>Cities should ban private cars downtown because streets become places for people.</p>
  <img width="400" src="data:image/png;base64,${noise.toBuffer("image/png").toString("base64")}">
  ${photo("Cars out, people in.")}</body></html>`;
await write(FIXTURES, "photo.pdf", await convert(Buffer.from(withPhoto), "html", "pdf"));

// A typed heading over a photographed paragraph that OCR reads almost right but below 75%: must go to manual.
const draft = textImage("My handwritten draft argues that downtown streets should belong to people. On festival weekends " +
  "the main street fills with families and vendors, and local shops say sales roughly double.", { blur: 4.5 });
await write(FIXTURES, "handwritten.pdf", await convert(Buffer.from(`<html><body>
  <p>Essay 1: Car-free downtowns. My handwritten draft is photographed below.</p>
  <img width="600" src="data:image/png;base64,${draft.toBuffer("image/png").toString("base64")}"></body></html>`), "html", "pdf"));

// A 21-page typed report with the same logo on every page: one distinct image, so within the OCR cap.
const pagesWithLogo = Array.from({ length: 21 }, (_, i) =>
  `<p style="page-break-before: always"><img width="120" src="data:image/png;base64,${logo.toBuffer("image/png").toString("base64")}"></p>
   <p>Page ${i + 1}: streets become places for people when cars leave the downtown core.</p>`).join("");
await write(FIXTURES, "report21.pdf", await convert(Buffer.from(`<html><body>${pagesWithLogo}</body></html>`), "html", "pdf"));

// --- demo submissions: same essays, new formats. Skips students already converted. ---
const DEMO = { "800123404": ".pdf", "800123405": ".pptx", "800123406": ".png" };
const demoText = async (id) => (await readFile(new URL(`${id}.txt`, SUBMISSIONS), "utf8").catch(() => null))?.trim();

async function demoFile(id, text) {
  if (id === "800123404") return convert(Buffer.from(text), "txt", "pdf");
  if (id === "800123406") return textImage(text).toBuffer("image/png");
  // A deck: one slide per paragraph, with the full paragraph in the speaker notes.
  const [title, ...paras] = text.split(/\n\s*\n/);
  const sentences = (p) => p.match(/[^.!?]+[.!?]+/g)?.map((x) => x.trim()) ?? [p];
  return convert(Buffer.from(fodp([
    [title, [sentences(paras[0])[0]], paras[0]],
    ...paras.slice(1).map((p, i) => [`Point ${i + 1}`, sentences(p).slice(0, 2), p]),
  ])), "fodp", "pptx");
}

const converted = [];
for (const [id, ext] of Object.entries(DEMO)) {
  const text = await demoText(id);
  if (!text) continue;
  await write(SUBMISSIONS, `${id}${ext}`, await demoFile(id, text));
  await unlink(new URL(`${id}.txt`, SUBMISSIONS));
  converted.push(id);
}

if (converted.length) {
  const subsUrl = new URL("sample-data/submissions.json", root);
  const subs = JSON.parse(await readFile(subsUrl, "utf8"))
    .map((s) => (converted.includes(s.studentId) ? { ...s, file: `${s.studentId}${DEMO[s.studentId]}` } : s));
  await writeFile(subsUrl, `[\n${subs.map((s) => `  { "studentId": "${s.studentId}", "file": "${s.file}", "submittedAt": "${s.submittedAt}" }`).join(",\n")}\n]\n`);
  console.log(`updated sample-data/submissions.json for ${converted.join(", ")}`);
}
