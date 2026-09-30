import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";
import { extractText, closeOcr } from "../src/extract.mjs";
import { findSoffice } from "../src/convert.mjs";
import { redact, findLeaks, anonymizeSubmission, isWeakOcr, OCR_MIN_CONFIDENCE } from "../src/anonymize.mjs";
import { parseUpload } from "../src/validate.mjs";

const roster = JSON.parse(await readFile(new URL("fixtures/roster.json", import.meta.url)));
const noSoffice = !(await findSoffice()) && "LibreOffice not installed";
const fixture = (name) => readFile(new URL(`fixtures/${name}`, import.meta.url));

after(closeOcr);

// Every fixture names Grace Kim and classmate Jordan Alvarez; none of them may survive redaction.
const assertRedactsCleanly = (text) => assert.deepEqual(findLeaks(redact(text, roster), roster), []);

test("pptx: slides in order, notes labeled, names redacted", async () => {
  const { text, ocrConfidence } = await extractText(await fixture("deck.pptx"), "deck.pptx");
  assert.equal(ocrConfidence, null);
  assert.match(text, /^Slide 1:\nCar-Free Downtowns\nBy Grace Kim/);
  assert.match(text, /Slide 2:[\s\S]*Notes:\nCredit Jordan Alvarez/);
  assert.match(text, /Slide 3:\nConclusion/);
  assertRedactsCleanly(text);
});

test("pptx: order comes from presentation.xml, and slide furniture is dropped", async () => {
  const zip = await JSZip.loadAsync(await fixture("deck.pptx"));
  // Show slide 3 first, and add a slide-number placeholder to it.
  const pres = await zip.file("ppt/presentation.xml").async("string");
  const ids = pres.match(/<p:sldId [^>]*\/>/g);
  zip.file("ppt/presentation.xml", pres.replace(ids.join(""), [ids[2], ids[0], ids[1]].join("")));
  const slide = await zip.file("ppt/slides/slide3.xml").async("string");
  const sldNum = '<p:sp><p:nvSpPr><p:cNvPr id="99" name="n"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>' +
    "<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>SLIDENUM 42</a:t></a:r></a:p></p:txBody></p:sp>";
  zip.file("ppt/slides/slide3.xml", slide.replace("</p:spTree>", `${sldNum}</p:spTree>`));

  const { text } = await extractText(await zip.generateAsync({ type: "nodebuffer" }), "deck.pptx");
  assert.match(text, /^Slide 1:\nConclusion/);
  assert.match(text, /Slide 2:\nCar-Free Downtowns/);
  assert.doesNotMatch(text, /SLIDENUM/);
});

test("pptx: metadata (author) is not extracted", async () => {
  const zip = await JSZip.loadAsync(await fixture("deck.pptx"));
  zip.file("docProps/core.xml", '<cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:creator>Maya Chen</dc:creator></cp:coreProperties>');
  const { text } = await extractText(await zip.generateAsync({ type: "nodebuffer" }), "deck.pptx");
  assert.doesNotMatch(text, /Maya/);
});

test("legacy .ppt and .doc go through LibreOffice", { skip: noSoffice }, async () => {
  const ppt = (await extractText(await fixture("deck.ppt"), "deck.ppt")).text;
  assert.match(ppt, /Slide 2:[\s\S]*Notes:\nCredit Jordan Alvarez/);
  assertRedactsCleanly(ppt);
  const doc = (await extractText(await fixture("essay.doc"), "essay.doc")).text;
  assert.match(doc, /Pedestrian streets bring life back/);
  assertRedactsCleanly(doc);
});

test("text PDF is read without OCR or page markers", async () => {
  const { text, ocrConfidence } = await extractText(await fixture("essay.pdf"), "essay.pdf");
  assert.equal(ocrConfidence, null);
  assert.match(text, /Pedestrian streets/);
  assert.doesNotMatch(text, /-- \d+ of \d+ --/);
  assertRedactsCleanly(text);
});

test("mixed PDF keeps typed pages and OCRs photographed ones, including a photo under a typed heading", async () => {
  const { text, ocrConfidence } = await extractText(await fixture("mixed.pdf"), "mixed.pdf");
  assert.ok(ocrConfidence >= OCR_MIN_CONFIDENCE, `confidence ${ocrConfidence}`);
  assert.match(text, /Page one is typed/);
  assert.match(text, /Appendix A[\s\S]*Field notes: vendors said sales/);
  assert.match(text, /conclusion was photographed/);
  assertRedactsCleanly(text);
});

for (const name of ["scan.png", "scan.jpg", "scan.pdf"]) {
  test(`${name} is read by OCR and the names in it are redacted`, async () => {
    const { text, ocrConfidence } = await extractText(await fixture(name), name);
    assert.ok(ocrConfidence >= OCR_MIN_CONFIDENCE, `confidence ${ocrConfidence}`);
    assert.match(text, /Pedestrian streets/);
    assertRedactsCleanly(text);
  });
}

test("low-confidence OCR is never sent to the agent", async () => {
  assert.equal(isWeakOcr(null), false);
  assert.equal(isWeakOcr(OCR_MIN_CONFIDENCE - 1), true);
  const result = await anonymizeSubmission({ buffer: await fixture("blurry.png"), file: "b.png" }, roster);
  assert.equal(result.payload, undefined);
  assert.match(result.manual, /low confidence/);
});

test("corrupt or mislabeled files are rejected without crashing the process", async () => {
  const junk = Buffer.alloc(4096, 7);
  const cases = [
    ["x.png", Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), junk]), /could not read that image/],
    ["x.jpg", Buffer.concat([Buffer.from("ffd8ff", "hex"), junk]), /could not read that image/],
    ["x.png", junk, /isn't a valid \.png/],
    ["x.doc", junk, /isn't a valid \.doc/],
    ["deck.doc", await fixture("deck.ppt"), /isn't a valid \.doc/],
    ["x.pdf", junk, /isn't a valid \.pdf/],
  ];
  for (const [name, buffer, message] of cases) {
    await assert.rejects(parseUpload({ fileName: name, fileBase64: buffer.toString("base64") }), message, name);
  }
});

test("real-world variants still pass the signature check", async () => {
  const pdf = Buffer.concat([Buffer.from("\ufeff\r\n"), await fixture("essay.pdf")]); // BOM + CRLF before %PDF-
  assert.match((await extractText(pdf, "bom.pdf")).text, /Pedestrian streets/);
  assert.ok((await extractText(await fixture("scan.png"), "photo.jpg")).ocrConfidence >= OCR_MIN_CONFIDENCE); // PNG named .jpg
});

test("RTF saved as .doc is read", { skip: noSoffice }, async () => {
  assert.equal((await extractText(Buffer.from("{\\rtf1 Hello from RTF}"), "essay.doc")).text, "Hello from RTF");
  await assert.rejects(parseUpload({ fileName: "x.doc", fileBase64: Buffer.from("<html><img src='http://x/y.png'></html>").toString("base64") }),
    /isn't a valid \.doc/);
});

test("a typed PDF with a logo keeps its exact text and needs no OCR", async () => {
  const { text, ocrConfidence } = await extractText(await fixture("logo.pdf"), "logo.pdf");
  assert.equal(ocrConfidence, null);
  assert.equal(text, "Cities should ban private cars downtown because streets become places for people.");
});

test("a noisy photo in a typed PDF is left out with a note; a short caption is kept", async () => {
  const buffer = await fixture("photo.pdf");
  const { text, ocrConfidence, unreadableImages, skippedImages } = await extractText(buffer, "photo.pdf");
  assert.ok(ocrConfidence >= OCR_MIN_CONFIDENCE, `confidence ${ocrConfidence}`);
  assert.match(text, /^Cities should ban private cars downtown because streets become places for people\.\nCars out, people in\./);
  assert.equal(unreadableImages, 0); // noise, not writing: no reason to grade by hand
  assert.equal(skippedImages, 1); // but the teacher is told it was left out
  const result = await anonymizeSubmission({ buffer, file: "p.pdf" }, roster);
  assert.ok(result.payload);
  assert.match(result.note, /1 image\(s\) couldn't be read/);
});

test("a photographed paragraph that can't be read confidently sends the essay to manual grading", async () => {
  const buffer = await fixture("handwritten.pdf");
  const { unreadableImages } = await extractText(buffer, "handwritten.pdf");
  assert.equal(unreadableImages, 1);
  const result = await anonymizeSubmission({ buffer, file: "h.pdf" }, roster);
  assert.equal(result.payload, undefined);
  assert.match(result.manual, /photographed passage/);
  assert.equal(isWeakOcr(null, 1), true);
});

test("a repeated logo counts once toward the OCR cap", async () => {
  const { text, ocrConfidence } = await extractText(await fixture("report21.pdf"), "report21.pdf");
  assert.equal(ocrConfidence, null);
  assert.match(text, /Page 21: streets become places/);
});

test("concurrent conversions right after startup all find LibreOffice", { skip: noSoffice }, async () => {
  // A fresh process, since this one has already located soffice.
  const script = `import { convert } from ${JSON.stringify(new URL("../src/convert.mjs", import.meta.url).href)};
    const r = await Promise.allSettled([1, 2, 3, 4].map(() => convert(Buffer.from("hi"), "txt", "docx")));
    console.log(r.filter((x) => x.status === "fulfilled").length);`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 120_000 });
  assert.equal(stdout.trim(), "4");
});

test("pptx: a slide reference with no target is skipped", async () => {
  const zip = await JSZip.loadAsync(await fixture("deck.pptx"));
  const pres = await zip.file("ppt/presentation.xml").async("string");
  zip.file("ppt/presentation.xml", pres.replace("<p:sldIdLst>", '<p:sldIdLst><p:sldId id="999" r:id="rIdMissing"/>'));
  const { text } = await extractText(await zip.generateAsync({ type: "nodebuffer" }), "deck.pptx");
  assert.match(text, /^Slide 1:\nCar-Free Downtowns/);
});

test("parseUpload accepts the new types and rejects risky ones", async () => {
  for (const name of ["deck.pptx", "essay.pdf", "scan.png", "scan.jpg"]) {
    const fileBase64 = (await fixture(name)).toString("base64");
    assert.equal((await parseUpload({ fileName: name.toUpperCase(), fileBase64 })).ext, name.slice(name.lastIndexOf(".")));
  }
  await assert.rejects(parseUpload({ fileName: "x.svg", fileBase64: "PHN2Zy8+" }), /file must be one of/);
  await assert.rejects(parseUpload({ fileName: "x.html", fileBase64: "PGI+" }), /file must be one of/);
  await assert.rejects(parseUpload({ fileName: "x.pptx", fileBase64: "bm90IGEgemlw" }), /isn.t a valid \.pptx/);
});

// A minimal PDF of blank pages (no xref; pdf.js rebuilds it).
function blankPdf(count, [w, h] = [612, 792]) {
  const pages = Array.from({ length: count }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] >> endobj`);
  const kids = pages.map((_, i) => `${i + 3} 0 R`).join(" ");
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
    `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${count} >> endobj\n${pages.join("\n")}\ntrailer << /Root 1 0 R >>\n%%EOF`);
}

test("small files that would expand to exhaust memory are refused before decoding", async () => {
  const ihdr = Buffer.from("89504e470d0a1a0a0000000d4948445200004e2000004e20", "hex"); // PNG header claiming 20000 x 20000
  await assert.rejects(extractText(Buffer.concat([ihdr, Buffer.alloc(64)]), "huge.png"), /too large/);

  const zip = new JSZip();
  zip.file("word/document.xml", Buffer.alloc(101 * 1024 * 1024, 32));
  const bomb = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  assert.ok(bomb.length < 1024 * 1024);
  await assert.rejects(extractText(bomb, "bomb.docx"), /expands to more than 100 MB/);

  await assert.rejects(extractText(blankPdf(101), "long.pdf"), /at most 100 pages/);
  await assert.rejects(extractText(blankPdf(1, [14400, 14400]), "poster.pdf"), /too large to read/);
});
