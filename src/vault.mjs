// The only module that reads student identifiers. Never import this from grader-agent.mjs.
import { createHash } from "node:crypto";
import { readFile, writeFile, unlink, mkdir, readdir, rename, cp, access } from "node:fs/promises";
import { extname } from "node:path";
import { convert } from "./convert.mjs";

const DATA = new URL("../data/", import.meta.url);
const SAMPLE = new URL("../sample-data/", import.meta.url);

// data/ is not in git (it holds real student data). On first run, start from the fictional class in sample-data/.
export async function ensureData() {
  if (await access(new URL("roster.json", DATA)).then(() => true, () => false)) return;
  await cp(SAMPLE, DATA, { recursive: true, errorOnExist: true, force: false });
}

const readJson = async (name) => JSON.parse(await readFile(new URL(name, DATA), "utf8"));
const writeJson = (name, value) => writeFile(new URL(name, DATA), JSON.stringify(value, null, 2));

// Everyone whose identifiers are redacted: the students and the teacher (role "teacher", no student ID).
export const loadRoster = () => readJson("roster.json");
export const studentsOf = (roster) => roster.filter((p) => p.role !== "teacher");
export const teacherOf = (roster) => roster.find((p) => p.role === "teacher") ?? null;
export const loadSubmissions = () => readJson("submissions.json");

export async function loadAssignment() {
  const assignment = await readJson("assignment.json");
  return { version: 1, answerKey: [], ...assignment };
}

const submissionUrl = (file) => new URL(`submissions/${file}`, DATA);
export const readSubmissionFile = (file) => readFile(submissionUrl(file));

export const PREVIEW_TYPES = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".docx": "application/pdf", ".doc": "application/pdf", ".pptx": "application/pdf", ".ppt": "application/pdf",
};
const PREVIEWS = new URL("previews/", DATA);
const previewPrefix = (file) => `${file.slice(0, -extname(file).length)}-`;

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex").slice(0, 16);

// The original file as the browser can show it. Office files are rendered to PDF once and cached,
// named by content hash so a resubmission never serves the previous preview.
export async function readPreview(file) {
  const ext = extname(file).toLowerCase();
  const type = PREVIEW_TYPES[ext];
  if (!type) return null;
  const buffer = await readSubmissionFile(file);
  if (type !== "application/pdf" || ext === ".pdf") return { buffer, type };

  const hash = sha(buffer);
  const cached = new URL(`${previewPrefix(file)}${hash}.pdf`, PREVIEWS);
  try {
    return { buffer: await readFile(cached), type };
  } catch {
    const pdf = await convert(buffer, ext.slice(1), "pdf");
    // Queued with replaceSubmission: if the student resubmitted during the conversion, don't cache the old file.
    await queued(async () => {
      const current = await readSubmissionFile(file).catch(() => null);
      if (!current || sha(current) !== hash) return;
      await mkdir(PREVIEWS, { recursive: true });
      await writeFile(cached, pdf);
    });
    return { buffer: pdf, type };
  }
}

async function deletePreviews(file) {
  const names = await readdir(PREVIEWS).catch(() => []);
  await Promise.all(names.filter((n) => n.startsWith(previewPrefix(file)))
    .map((n) => unlink(new URL(n, PREVIEWS)).catch(() => {})));
}

export async function loadGrades() {
  try {
    return await readJson("grades.json");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

// All writes are queued so concurrent grading, approvals, edits, and submissions never overwrite each other.
let writes = Promise.resolve();
function queued(fn) {
  const run = writes.then(fn);
  writes = run.catch(() => {});
  return run;
}

export function updateGrade(studentId, update) {
  return queued(async () => {
    const grades = await loadGrades();
    const next = update(grades[studentId]);
    if (next === undefined) delete grades[studentId];
    else grades[studentId] = next;
    await writeJson("grades.json", grades);
    return next;
  });
}

// Bumps the version so grades made under the previous rubric/instructions show as outdated.
export function saveAssignment(fields) {
  return queued(async () => {
    const { version } = await loadAssignment();
    const assignment = { ...fields, version: version + 1 };
    await writeJson("assignment.json", assignment);
    return assignment;
  });
}

// Replaces a student's submission (file + record) and clears their grade, like a Blackboard resubmission.
export function replaceSubmission(studentId, ext, buffer, submittedAt) {
  return queued(async () => {
    // Checked inside the queue: a roster save may have removed or re-IDed this student while the upload was read.
    if (!studentsOf(await loadRoster()).some((s) => s.studentId === studentId)) throw new Error("unknown student");
    const subs = await loadSubmissions();
    const previous = subs.find((s) => s.studentId === studentId);
    const file = `${studentId}${ext}`;
    await writeFile(new URL(`submissions/${file}`, DATA), buffer);
    if (previous && previous.file !== file) await unlink(new URL(`submissions/${previous.file}`, DATA)).catch(() => {});
    if (previous) await deletePreviews(previous.file);

    const record = { studentId, file, submittedAt };
    await writeJson("submissions.json", [...subs.filter((s) => s.studentId !== studentId), record]);

    const grades = await loadGrades();
    delete grades[studentId];
    await writeJson("grades.json", grades);
    return record;
  });
}

// Saves an edited roster from validateRoster. Each student's originalId says which existing student the row was
// (null for a new one). A changed ID carries that student's submission file and grade along; a student left off
// the roster takes their submission, previews and grade with them.
export function saveRoster({ teacher, students }) {
  return queued(async () => {
    const [subs, grades] = [await loadSubmissions(), await loadGrades()];
    const newId = new Map(students.filter((s) => s.originalId).map((s) => [s.originalId, s.studentId]));
    const kept = [];
    const moves = [];
    for (const sub of subs) {
      const to = newId.get(sub.studentId);
      if (to !== sub.studentId) await deletePreviews(sub.file);
      if (!to) {
        await unlink(submissionUrl(sub.file)).catch(() => {});
        continue;
      }
      if (to === sub.studentId) {
        kept.push(sub);
        continue;
      }
      // Two steps through a temporary name, so swapping two students' IDs can't overwrite a file.
      const file = `${to}${extname(sub.file)}`;
      await rename(submissionUrl(sub.file), submissionUrl(`${sub.file}.moving`));
      moves.push([`${sub.file}.moving`, file]);
      kept.push({ ...sub, studentId: to, file });
    }
    for (const [from, to] of moves) await rename(submissionUrl(from), submissionUrl(to));

    const nextGrades = Object.fromEntries(Object.entries(grades)
      .filter(([id]) => newId.has(id)).map(([id, grade]) => [newId.get(id), grade]));
    const roster = [teacher, ...students.map(({ originalId, studentView, ...s }) => (studentView ? { ...s, studentView } : s))];
    await writeJson("submissions.json", kept);
    await writeJson("grades.json", nextGrades);
    await writeJson("roster.json", roster);
    return roster;
  });
}
