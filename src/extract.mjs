// Turns an uploaded file into plain text. Drops document metadata (author, title), styles, and comments.
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { createRequire } from "node:module";
import mammoth from "mammoth";
import { DOMParser } from "@xmldom/xmldom";
import { PDFParse } from "pdf-parse";
import { createWorker } from "tesseract.js";
import { loadImage, createCanvas } from "@napi-rs/canvas";
import { convert, loadZip, ReadError } from "./convert.mjs";

export { ReadError };

const OCR_MAX_IMAGES = 20; // scanned pages plus distinct embedded images
const MIN_CHARS_PER_PAGE = 20; // a PDF page with less text than this is treated as a scan
const MIN_IMAGE_PX = 100; // embedded images no longer than this on both sides (icons, bullets) are never OCR'd
const MIN_IMAGE_WORDS = 2; // an image that reads as fewer words may be decoration (a logo)...
const MAX_LOGO_PX = 400; // ...but only if it is this small or repeats; a large one may be writing OCR couldn't see
// OCR below this mean confidence may have misread a name past redaction, so it is never sent to the agent.
export const OCR_MIN_CONFIDENCE = 75;
const CACHE_SIZE = 50;
// Decoding needs 4 bytes a pixel, so a small file declaring a huge image could exhaust memory. 50 MP fits phone photos.
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_PDF_PAGES = 100;
const SCAN_SCALE = 2;

// File signatures, checked before any parser or LibreOffice sees the bytes.
const startsWith = (buffer, hex) => buffer.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
const isImage = (b) => startsWith(b, "89504e470d0a1a0a") || startsWith(b, "ffd8ff"); // PNG or JPEG, whatever the extension says
const isOle = (b, stream) => startsWith(b, "d0cf11e0a1b11ae1") && b.includes(Buffer.from(stream, "utf16le"));
const CHECKS = {
  ".pdf": (b) => b.subarray(0, 1024).includes("%PDF-"), // the spec allows leading bytes before the header
  ".png": isImage, ".jpg": isImage, ".jpeg": isImage,
  ".docx": (b) => startsWith(b, "504b0304"), ".pptx": (b) => startsWith(b, "504b0304"),
  // Word and PowerPoint share the OLE container; the stream name tells them apart. RTF saved as .doc is common.
  // HTML saved as .doc is refused: LibreOffice may fetch images it links to.
  ".doc": (b) => isOle(b, "WordDocument") || startsWith(b, Buffer.from("{\\rtf").toString("hex")),
  ".ppt": (b) => isOle(b, "PowerPoint Document"),
};

function checkSignature(buffer, ext) {
  if (!CHECKS[ext]?.(buffer)) throw new ReadError(`that isn't a valid ${ext} file`);
}

// Pixel size from a PNG or JPEG header, read without decoding the image. null when there is none.
function imageSize(b) {
  if (startsWith(b, "89504e470d0a1a0a")) {
    return b.length >= 24 && b.toString("latin1", 12, 16) === "IHDR" ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  }
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) i++; // fill byte
    else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }; // start of frame
    } else i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

const tooLarge = ({ width, height }) => width * height > MAX_IMAGE_PIXELS;

function checkImage(buffer) {
  const size = imageSize(buffer);
  if (!size) throw new ReadError("could not read that image");
  if (tooLarge(size)) throw new ReadError("that image is too large; resize it to under 50 megapixels");
}

// PPTX placeholders that hold slide furniture, not content.
const SKIP_PLACEHOLDERS = new Set(["sldNum", "dt", "hdr", "ftr", "sldImg"]);

const xml = async (zip, path) => {
  const file = path && zip.file(path);
  return file && new DOMParser().parseFromString(await file.async("string"), "text/xml");
};
const rels = async (zip, path) => {
  const doc = await xml(zip, path);
  return doc ? [...doc.getElementsByTagName("Relationship")] : [];
};
const resolve = (base, target) => new URL(target, `file:///${base}`).pathname.slice(1);

function isSkippedPlaceholder(el) {
  for (let n = el; n; n = n.parentNode) {
    if (n.nodeName !== "p:sp") continue;
    const ph = n.getElementsByTagName("p:ph")[0];
    return Boolean(ph && SKIP_PLACEHOLDERS.has(ph.getAttribute("type")));
  }
  return false;
}

// One line per <a:p>, with <a:br> as a line break inside it.
function shapeText(doc) {
  if (!doc) return "";
  const lines = [];
  for (const p of doc.getElementsByTagName("a:p")) {
    if (isSkippedPlaceholder(p)) continue;
    let line = "";
    const walk = (n) => {
      for (const c of n.childNodes ?? []) {
        if (c.nodeName === "a:t") line += c.textContent;
        else if (c.nodeName === "a:br") line += "\n";
        else walk(c);
      }
    };
    walk(p);
    if (line.trim()) lines.push(line);
  }
  return lines.join("\n");
}

// Slides in presentation order, each followed by its speaker notes.
async function extractPptx(buffer) {
  const zip = await loadZip(buffer);
  const presentation = await xml(zip, "ppt/presentation.xml");
  if (!presentation) throw new ReadError("that isn't a valid .pptx file");
  const targets = new Map((await rels(zip, "ppt/_rels/presentation.xml.rels"))
    .map((r) => [r.getAttribute("Id"), resolve("ppt/", r.getAttribute("Target"))]));

  const slides = [];
  const pictures = [];
  for (const id of presentation.getElementsByTagName("p:sldId")) {
    const path = targets.get(id.getAttribute("r:id"));
    if (!path) continue; // dangling slide reference
    const slideRels = await rels(zip, `ppt/slides/_rels/${path.split("/").pop()}.rels`);
    const notesRel = slideRels.find((r) => r.getAttribute("Type")?.endsWith("/notesSlide"));
    const text = shapeText(await xml(zip, path));
    const notes = notesRel ? shapeText(await xml(zip, resolve("ppt/slides/", notesRel.getAttribute("Target")))) : "";
    for (const r of imageRels(slideRels)) pictures.push([resolve("ppt/slides/", r.getAttribute("Target")), slides.length]);
    slides.push([`Slide ${slides.length + 1}:`, text, notes && `Notes:\n${notes}`].filter(Boolean).join("\n"));
  }
  const read = await officeImages(zip, pictures);
  for (const r of read) if (r.verdict === "kept") slides[r.place] += `\n${r.text.trim()}`;
  return { text: slides.join("\n\n"), ...imageCounts(read) };
}

// Embedded (not linked) pictures in a slide or document.
const imageRels = (list) => list.filter((r) => r.getAttribute("Type")?.endsWith("/image") && r.getAttribute("TargetMode") !== "External");

// OCRs pictures in a .docx/.pptx like photos in a PDF. [path, place] pairs; only PNG and JPEG are read
// (vector drawings and charts carry no photographed writing). Over OCR_MAX_IMAGES, the rest are skipped.
async function officeImages(zip, pictures) {
  const images = new Map();
  for (const [path, place] of pictures) {
    const data = await zip.file(path)?.async("nodebuffer");
    const size = data && isImage(data) && imageSize(data);
    if (!size) continue;
    // Too large to decode safely: counted as skipped, so the teacher sees a notice.
    addImage(images, { data, ...size, skip: tooLarge(size) }, place);
  }
  return readImages(images, OCR_MAX_IMAGES);
}

function imageCounts(read) {
  const kept = read.filter((r) => r.verdict === "kept");
  return {
    ocrConfidence: kept.length ? Math.min(...kept.map((r) => r.confidence)) : null,
    unreadableImages: count(read, "unreadable"),
    skippedImages: count(read, "skipped"),
  };
}

async function extractDocx(buffer) {
  const zip = await loadZip(buffer); // before mammoth, which unzips the whole file
  const { value } = await mammoth.extractRawText({ buffer });
  const pictures = imageRels(await rels(zip, "word/_rels/document.xml.rels"))
    .map((r) => [resolve("word/", r.getAttribute("Target")), "end"]);
  const read = await officeImages(zip, pictures);
  const extra = read.filter((r) => r.verdict === "kept").map((r) => r.text.trim());
  return { text: [value, ...extra].join("\n\n"), ...imageCounts(read) };
}

let worker;
function ocrWorker() {
  const { langPath } = createRequire(import.meta.url)("@tesseract.js-data/eng");
  // errorHandler: without it tesseract rethrows image errors outside the job promise and crashes the process.
  worker ??= createWorker("eng", 1, { langPath, gzip: true, cacheMethod: "none", errorHandler: () => {} })
    .catch((err) => {
      worker = undefined;
      throw err;
    });
  return worker;
}

// The OCR worker keeps the process alive; tests call this when done.
export async function closeOcr() {
  if (worker) await (await worker).terminate();
  worker = undefined;
}

// Text and confidence (0-100) of each image.
async function ocr(images) {
  const w = await ocrWorker();
  const results = [];
  for (const image of images) {
    try {
      const { text, confidence } = (await w.recognize(Buffer.from(image))).data;
      results.push({ text, confidence });
    } catch {
      throw new ReadError("could not read that image");
    }
  }
  return results;
}

const wordCount = (text) => (text.match(/[\p{L}\p{N}]{2,}/gu) ?? []).length;
// Looks like sentences rather than noise: 10+ real words (3+ letters), at least half of all tokens.
function looksLikeWriting(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const words = tokens.filter((t) => /^[\p{L}'’]{3,}[.,;:!?]?$/u.test(t)).length;
  return words >= 10 && words >= tokens.length / 2;
}

// A rendered page with (almost) no ink.
async function isBlank(png) {
  const img = await loadImage(Buffer.from(png));
  const ctx = createCanvas(img.width, img.height).getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] < 480) ink++;
  return ink < (data.length / 4) * 0.002;
}

// Embedded images, deduplicated: { data, width, height, uses, place } where place says where the text goes.
function addImage(images, { data, width, height, skip = false }, place) {
  if (Math.max(width, height) <= MIN_IMAGE_PX) return;
  const key = createHash("sha256").update(data).digest("hex");
  const seen = images.get(key);
  if (seen) seen.uses++;
  else images.set(key, { data, width, height, uses: 1, place, skip });
}

// OCRs embedded images (up to cap; the rest are "skipped") and judges each on its own:
// - "kept": read at or above OCR_MIN_CONFIDENCE with 2+ words
// - "dropped": under 2 words and small or repeated (a logo)
// - "unreadable": below OCR_MIN_CONFIDENCE and reads like writing (a photographed paragraph) → manual grading
// - "skipped": anything else (a street photo, a chart, writing too garbled to tell) → a notice
async function readImages(images, cap = Infinity) {
  const list = [...images.values()];
  const toRead = list.filter((i) => !i.skip).slice(0, cap);
  const results = new Map((await ocr(toRead.map((i) => i.data))).map((r, i) => [toRead[i], r]));
  return list.map((img) => {
    const r = results.get(img);
    if (!r) return { ...img, verdict: "skipped" };
    const words = wordCount(r.text);
    const verdict = words >= MIN_IMAGE_WORDS && r.confidence >= OCR_MIN_CONFIDENCE ? "kept"
      : words < MIN_IMAGE_WORDS && (img.uses > 1 || Math.max(img.width, img.height) <= MAX_LOGO_PX) ? "dropped"
      : looksLikeWriting(r.text) ? "unreadable" : "skipped";
    return { ...img, ...r, verdict };
  });
}

const count = (read, verdict) => read.filter((r) => r.verdict === verdict).length;

const lowerWords = (text) => new Set(text.toLowerCase().match(/\p{L}{3,}/gu) ?? []);
// An image holding the same words as its page's text layer: a scan with the scanner's own OCR underneath.
function sameWords(a, b) {
  const [x, y] = [lowerWords(a), lowerWords(b)];
  if (x.size < 10 || y.size < 10) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= 0.6 * x.size && shared >= 0.6 * y.size;
}

// Typed text is read exactly. A page with almost no text is a scan: it is rendered and OCR'd whole
// (a blank page is skipped). On a typed page, each embedded image is OCR'd and judged by readImages, and kept
// text is added after the page's text, so typed text is never replaced by an OCR guess. The exception is a
// searchable scan (an image repeating its page's text layer): that layer came from the scanner's OCR, so the
// page takes our own OCR of the image instead and is judged by its confidence. ocrConfidence is the lowest of
// any OCR'd page or image, so one badly read page can't hide behind clean ones.
async function extractPdf(buffer) {
  // maxImageSize: pdf.js leaves out larger images instead of decoding them. No eval: fonts are never compiled to code.
  const parser = new PDFParse({ data: new Uint8Array(buffer), maxImageSize: MAX_IMAGE_PIXELS, isEvalSupported: false });
  try {
    const { total } = await parser.getInfo();
    if (total > MAX_PDF_PAGES) throw new ReadError(`a PDF can have at most ${MAX_PDF_PAGES} pages`);
    const { pages } = await parser.getText();
    const scanned = pages.filter((p) => p.text.replace(/\s/g, "").length < MIN_CHARS_PER_PAGE).map((p) => p.num);
    const typed = pages.filter((p) => !scanned.includes(p.num)).map((p) => p.num);
    const { pages: withImages } = typed.length
      ? await parser.getImage({ partial: typed, imageThreshold: 0, imageDataUrl: false })
      : { pages: [] };
    const images = new Map();
    for (const p of withImages) for (const img of p.images) addImage(images, img, p.pageNumber);
    if (scanned.length + images.size > OCR_MAX_IMAGES) {
      throw new ReadError(`a PDF can have at most ${OCR_MAX_IMAGES} scanned pages and different images`);
    }

    const pageText = new Map(pages.map((p) => [p.num, p.text.trim()]));
    const confidences = [];
    if (scanned.length) {
      const { pages: sizes } = await parser.getInfo({ partial: scanned, parsePageInfo: true });
      if (sizes.some((p) => tooLarge({ width: p.width * SCAN_SCALE, height: p.height * SCAN_SCALE }))) {
        throw new ReadError("a scanned page in that PDF is too large to read");
      }
    }
    const shots = scanned.length ? (await parser.getScreenshot({ partial: scanned, scale: SCAN_SCALE, imageDataUrl: false })).pages : [];
    const shotResults = await ocr(shots.map((s) => s.data));
    for (const [i, s] of shots.entries()) {
      const r = shotResults[i];
      if (!wordCount(r.text) && (await isBlank(s.data))) continue;
      pageText.set(s.pageNumber, r.text.trim());
      confidences.push(r.confidence);
    }

    const read = await readImages(images);
    for (const r of read) {
      const page = pageText.get(r.place);
      if (r.text && sameWords(page, r.text)) {
        pageText.set(r.place, r.text.trim());
        confidences.push(r.confidence);
        r.verdict = "scan";
      } else if (r.verdict === "kept") {
        pageText.set(r.place, `${page}\n${r.text.trim()}`);
        confidences.push(r.confidence);
      }
    }

    return {
      text: pages.map((p) => pageText.get(p.num)).join("\n\n"),
      ocrConfidence: confidences.length ? Math.min(...confidences) : null,
      unreadableImages: count(read, "unreadable"),
      skippedImages: count(read, "skipped"),
    };
  } finally {
    await parser.destroy();
  }
}

async function extract(buffer, ext) {
  if (ext !== ".txt" && ext !== ".md") checkSignature(buffer, ext);
  switch (ext) {
    case ".txt": case ".md": return { text: buffer.toString("utf8") };
    case ".docx": return extractDocx(buffer);
    case ".doc": return extract(await convert(buffer, "doc", "docx"), ".docx");
    case ".pptx": return extractPptx(buffer);
    case ".ppt": return extract(await convert(buffer, "ppt", "pptx"), ".pptx");
    case ".pdf": return extractPdf(buffer);
    case ".png": case ".jpg": case ".jpeg": {
      checkImage(buffer);
      const [{ text, confidence }] = await ocr([buffer]);
      return { text, ocrConfidence: confidence };
    }
    default: throw new ReadError(`unsupported file type: ${ext}`);
  }
}

// OCR and LibreOffice are slow, and the submission page polls, so results are cached by content.
const cache = new Map();

// Returns { text, ocrConfidence, unreadableImages, skippedImages }. ocrConfidence is null unless some text came from OCR.
// unreadableImages counts PDF photos of writing that couldn't be read confidently; skippedImages counts other
// PDF photos that couldn't be read. Both are left out of text.
export function extractText(buffer, filename) {
  const ext = extname(filename).toLowerCase();
  const key = createHash("sha256").update(buffer).update(ext).digest("hex");
  if (!cache.has(key)) {
    const result = extract(buffer, ext).then(({ text, ocrConfidence = null, unreadableImages = 0, skippedImages = 0 }) => Object.freeze({
      text: text.normalize("NFKC").replace(/[\u00AD\u200B-\u200D\uFEFF]/g, "").replace(/\r\n?/g, "\n")
        .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2") // rejoin words hyphenated at a line end ("Mo-\nhammed")
        .replace(/\n{3,}/g, "\n\n").trim(),
      ocrConfidence,
      unreadableImages,
      skippedImages,
    }));
    result.catch(() => cache.delete(key));
    cache.set(key, result);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}
