// LibreOffice wrapper: converts bytes between document formats. Never sees the roster.
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import JSZip from "jszip";

const CANDIDATES = ["soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"];
const MAX_RUNNING = 2; // each soffice run is a heavy process; more requests wait their turn
const TIMEOUT_MS = 60_000;

// A file problem whose message is safe to show the student.
export class ReadError extends Error {}

let running = 0;
const waiting = [];
async function limited(fn) {
  if (running < MAX_RUNNING) running++;
  else await new Promise((resolve) => waiting.push(resolve)); // the finishing run hands over its slot
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

// Runs soffice in its own process group and SIGKILLs the whole group when done or on timeout,
// so a hung soffice.bin (or a helper holding stdio open) can't keep a slot past the timeout.
function run(bin, args, { timeout = TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: "ignore", cwd });
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {} // already gone
    };
    const timer = setTimeout(() => {
      killGroup();
      reject(new Error("LibreOffice timed out"));
    }, timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      killGroup();
      if (code === 0) resolve();
      else reject(new Error(`LibreOffice exited with code ${code}`));
    });
  });
}

// Resolves the soffice binary once; null when LibreOffice isn't installed.
// The promise is cached, so concurrent first callers all wait for the same check.
// A failed check is retried on the next call, so installing LibreOffice doesn't need a server restart.
let soffice;
export function findSoffice() {
  soffice ??= (async () => {
    for (const bin of CANDIDATES) {
      try {
        await run(bin, ["--version"], { timeout: 30_000 });
        return bin;
      } catch {}
    }
    soffice = undefined;
    return null;
  })();
  return soffice;
}

const MAX_ZIP_ENTRIES = 5000;
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const STORED = "\x00\x00"; // JSZip's magic for an uncompressed entry

// Loads a .docx/.pptx after inflating every entry with a byte cap, so a zip bomb is refused before any parser
// (JSZip, mammoth, LibreOffice) expands it. The sizes a zip declares can lie, so the real output is counted.
export async function loadZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.values(zip.files).filter((f) => !f.dir);
  if (files.length > MAX_ZIP_ENTRIES) throw new ReadError("that file has too many parts");
  let total = 0;
  for (const { _data: d } of files) {
    if (!d?.compressedContent) throw new ReadError("that file couldn't be checked"); // fail closed if JSZip changes
    try {
      total += d.compression.magic === STORED ? d.compressedContent.length
        : inflateRawSync(d.compressedContent, { maxOutputLength: MAX_UNZIPPED_BYTES - total + 1 }).length;
    } catch (err) {
      if (err.code === "ERR_BUFFER_TOO_LARGE") total = Infinity;
      else throw new ReadError("that file is damaged");
    }
    if (total > MAX_UNZIPPED_BYTES) throw new ReadError("that file expands to more than 100 MB");
  }
  return zip;
}

// Linked (not embedded) images, templates and OLE objects make LibreOffice read other files or URLs:
// a .docx linking file:///…/data/submissions/<other student> would show that file in its preview.
// Hyperlinks are kept; they are never fetched.
export async function stripLinks(buffer) {
  const zip = await loadZip(buffer);
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || !/\.(rels|xml)$/.test(path)) continue;
    const xml = await file.async("string");
    const out = xml
      .replace(/<Relationship\b[^>]*TargetMode="External"[^>]*\/>/g, (r) => (/Type="[^"]*\/hyperlink"/.test(r) ? r : ""))
      .replace(/\b(INCLUDEPICTURE|INCLUDETEXT)\b/g, "REMOVED"); // Word fields that pull in files
    if (out !== xml) zip.file(path, out);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

// macOS: LibreOffice runs with no network and can't read home dirs, /tmp, volumes or other conversions,
// so a link that survives stripLinks still can't reach another student's file.
const SANDBOX = "/usr/bin/sandbox-exec";
const hasSandbox = access(SANDBOX).then(() => true, () => false);
const sandboxProfile = (dir) => `(version 1)(allow default)
  (deny network-outbound (remote ip))
  (deny file-read* file-write* (subpath "/Users") (subpath "/private/tmp") (subpath "/Volumes")
    (regex #"^/private/var/folders/.*/convert-"))
  (allow file-read* file-write* (subpath ${JSON.stringify(dir)}))`;

// ext and toExt without the dot, e.g. convert(buf, "doc", "docx").
export async function convert(buffer, ext, toExt) {
  const bin = await findSoffice();
  if (!bin) throw new ReadError(`the server can't read .${ext} files (LibreOffice is not installed)`);
  // .doc/.ppt (and RTF) reach LibreOffice before stripLinks can run, so only the sandbox keeps their links from
  // reading files or URLs. Without it (anything but macOS), refuse them.
  if ((ext === "doc" || ext === "ppt") && !(await hasSandbox)) {
    throw new ReadError(`.${ext} files can't be read on this server; save it as .${ext}x or PDF`);
  }
  // Legacy files go through .docx/.pptx first, so their links are stripped too.
  if ((ext === "doc" || ext === "ppt") && toExt === "pdf") return convert(await convert(buffer, ext, `${ext}x`), `${ext}x`, "pdf");
  if (ext === "docx" || ext === "pptx") buffer = await stripLinks(buffer);
  return limited(() => convertWith(bin, buffer, ext, toExt));
}

async function convertWith(bin, buffer, ext, toExt) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "convert-")));
  try {
    await writeFile(join(dir, `in.${ext}`), buffer);
    // A profile per call so parallel conversions don't lock each other out.
    const profile = pathToFileURL(join(dir, "profile")).href;
    const args = [`-env:UserInstallation=${profile}`, "--headless", "--convert-to", toExt, "--outdir", dir, join(dir, `in.${ext}`)];
    await ((await hasSandbox)
      ? run(SANDBOX, ["-p", sandboxProfile(dir), bin, ...args], { cwd: dir })
      : run(bin, args, { cwd: dir }));
    return await readFile(join(dir, `in.${toExt}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
