// Checks untrusted input from the browser before it is saved.
import { extname } from "node:path";
import { extractText, ReadError } from "./extract.mjs";

export const UPLOAD_TYPES = [".txt", ".md", ".docx", ".doc", ".pdf", ".pptx", ".ppt", ".png", ".jpg", ".jpeg"];
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function text(value, name, max, { required = true } = {}) {
  const s = typeof value === "string" ? value.trim() : "";
  if (required && !s) throw new Error(`${name} is required`);
  if (s.length > max) throw new Error(`${name} must be at most ${max} characters`);
  return s;
}

function int(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function validateAssignment(input = {}) {
  const deadline = new Date(input.deadline);
  if (typeof input.deadline !== "string" || Number.isNaN(deadline.getTime())) throw new Error("deadline is invalid");

  const rubric = Array.isArray(input.rubric) ? input.rubric : [];
  const answerKey = Array.isArray(input.answerKey) ? input.answerKey : [];
  if (rubric.length > 20) throw new Error("rubric can have at most 20 criteria");
  if (answerKey.length > 50) throw new Error("answer key can have at most 50 questions");
  if (!rubric.length && !answerKey.length) throw new Error("add at least one rubric criterion or answer key question");

  const seen = new Set();
  const criteria = rubric.map((c, i) => {
    const criterion = text(c?.criterion, `criterion ${i + 1} name`, 60);
    if (seen.has(criterion.toLowerCase())) throw new Error(`duplicate criterion: ${criterion}`);
    seen.add(criterion.toLowerCase());
    return {
      criterion,
      maxPoints: int(c?.maxPoints, `${criterion} max points`, 1, 1000),
      description: text(c?.description, `${criterion} description`, 500),
    };
  });

  const questions = answerKey.map((q, i) => ({
    question: text(q?.question, `question ${i + 1}`, 1000),
    maxPoints: int(q?.maxPoints, `question ${i + 1} max points`, 1, 1000),
    answer: text(q?.answer, `question ${i + 1} answer`, 2000),
    method: text(q?.method, `question ${i + 1} method`, 2000, { required: false }),
  }));

  return {
    title: text(input.title, "title", 200),
    prompt: text(input.prompt, "instructions", 5000),
    deadline: deadline.toISOString(),
    rubric: criteria,
    answerKey: questions,
  };
}

const NAME = /^\p{L}[\p{L}\p{M}'’. -]*$/u;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function person(p, label) {
  const firstName = text(p?.firstName, `${label} first name`, 60);
  const lastName = text(p?.lastName, `${label} last name`, 60);
  for (const name of [firstName, lastName]) {
    if (!NAME.test(name)) throw new Error(`${label}: names can only have letters, spaces, apostrophes, periods and hyphens`);
  }
  const email = text(p?.email, `${label} email`, 254).toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`${label} email is invalid`);
  return { firstName, lastName, email };
}

// The teacher and students from the roster editor. existingIds are the saved student IDs; each row's originalId
// must be one of them (or empty for a new student) and appear once, so data moves to exactly one student.
export function validateRoster(input = {}, existingIds = []) {
  const teacher = { role: "teacher", ...person(input.teacher, "teacher") };
  const rows = Array.isArray(input.students) ? input.students : [];
  if (rows.length < 1 || rows.length > 500) throw new Error("the roster needs 1 to 500 students");
  const ids = new Set();
  const emails = new Set([teacher.email]);
  const originals = new Set();
  const students = rows.map((row, i) => {
    const label = `student ${i + 1}`;
    const p = person(row, label);
    // 7+ digits: shorter IDs, with OCR lookalike letters allowed, would match ordinary words ("Bools" for 80015).
    const studentId = text(row?.studentId, `${label} student ID`, 12);
    if (!/^\d{7,12}$/.test(studentId)) throw new Error(`${label} student ID must be 7 to 12 digits`);
    if (ids.has(studentId)) throw new Error(`duplicate student ID: ${studentId}`);
    if (emails.has(p.email)) throw new Error(`duplicate email: ${p.email}`);
    ids.add(studentId);
    emails.add(p.email);
    const originalId = row?.originalId ? String(row.originalId) : null;
    if (originalId && (!existingIds.includes(originalId) || originals.has(originalId))) {
      throw new Error(`${label} doesn't match a saved student; reload the page`);
    }
    originals.add(originalId);
    return { originalId, studentId, ...p, studentView: row?.studentView === true };
  });
  // Exactly one student opens from the "Student view" switcher.
  const chosen = Math.max(0, students.findIndex((s) => s.studentView));
  students.forEach((s, i) => (s.studentView = i === chosen));
  return { teacher, students };
}

// A student submission is either pasted text or an uploaded file sent as base64.
export async function parseUpload({ text: pasted, fileName, fileBase64 } = {}) {
  let ext, buffer;
  if (typeof pasted === "string" && pasted.trim()) {
    ext = ".txt";
    buffer = Buffer.from(pasted.trim(), "utf8");
  } else if (typeof fileName === "string" && typeof fileBase64 === "string") {
    ext = extname(fileName).toLowerCase();
    if (!UPLOAD_TYPES.includes(ext)) throw new Error(`file must be one of ${UPLOAD_TYPES.join(", ")}`);
    buffer = Buffer.from(fileBase64, "base64");
  } else {
    throw new Error("paste your essay or choose a file");
  }
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);

  let extracted;
  try {
    ({ text: extracted } = await extractText(buffer, `upload${ext}`));
  } catch (err) {
    throw new Error(err instanceof ReadError ? err.message : "could not read that file");
  }
  if (!extracted) throw new Error("the submission has no readable text (if it's a scan, try a clearer image)");
  return { ext, buffer };
}
