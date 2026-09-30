import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import * as vault from "./src/vault.mjs";
import { anonymizeSubmission, extractText, findLeaks, isWeakOcr } from "./src/anonymize.mjs";
import { ReadError } from "./src/extract.mjs";
import { gradeEssay } from "./src/grader-agent.mjs";
import { validateAssignment, validateRoster, parseUpload, MAX_UPLOAD_BYTES } from "./src/validate.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = "127.0.0.1"; // there is no login, so only this machine may connect
const PUBLIC_DIR = new URL("./public/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const CONCURRENCY = 3;
const MAX_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 64 * 1024; // base64 upload plus JSON overhead

const inProgress = new Set(); // studentIds currently being graded
let rosterSaving = false; // a roster save may move or delete submissions, so grading waits for it
const checkNotSaving = () => {
  if (rosterSaving) throw new HttpError(409, "the roster is being saved; try again in a moment");
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Our own messages are safe to show. System errors (ENOENT …) name local paths, and bugs name internals.
const isSafe = (err) => err instanceof HttpError || err instanceof ReadError || (err.constructor === Error && !err.code);
const safeMessage = (err) => (isSafe(err) ? err.message : "something went wrong on the server");

// Only pages this server sent may call the API. The Host check stops DNS rebinding; the Origin check stops another
// site from sending requests from the teacher's browser (CSRF). A request with no Origin is not from a browser page.
function checkRequest(req) {
  const hosts = [`localhost:${server.address().port}`, `127.0.0.1:${server.address().port}`];
  if (!hosts.includes(req.headers.host)) throw new HttpError(403, "unknown host");
  const { origin } = req.headers;
  if (origin && !hosts.some((h) => origin === `http://${h}`)) throw new HttpError(403, "cross-site request refused");
}

const sumPoints = (items = []) => items.reduce((sum, c) => sum + c.maxPoints, 0);
const totalPointsOf = (assignment) => sumPoints(assignment.rubric) + sumPoints(assignment.answerKey);
// Points a grade is out of: what it was graded against, not the current rubric.
// Grades from before totalPoints was stored fall back to their own rubric breakdown.
function gradeTotal(grade, assignment) {
  if (grade?.totalPoints) return grade.totalPoints;
  if (grade?.rubric) return sumPoints(grade.rubric) + sumPoints(grade.answers);
  return totalPointsOf(assignment);
}
const withTotal = (grade, assignment) => (grade?.status ? { ...grade, totalPoints: gradeTotal(grade, assignment) } : grade ?? {});

// A grade is outdated when the assignment was edited after it was graded.
const isStale = (grade, assignment) => Boolean(grade?.rubric) && (grade.assignmentVersion ?? 1) !== assignment.version;

async function gradeOne(sub, assignment, roster) {
  const buffer = await vault.readSubmissionFile(sub.file);
  const { payload, leaks, manual, note } = await anonymizeSubmission({ buffer, file: sub.file, studentId: sub.studentId }, roster);
  if (manual) return { status: "manual", reason: manual };
  if (leaks) {
    const kinds = [...new Set(leaks.map((l) => l.kind))].join(", ");
    return { status: "manual", reason: `Identifiers survived redaction (${kinds}); not sent to the agent.` };
  }

  const graded = await gradeEssay(payload, { prompt: assignment.prompt, rubric: assignment.rubric, answerKey: assignment.answerKey });
  const output = [graded.feedback, ...graded.rubric, ...graded.answers].map((r) => r.comment ?? r).join("\n");
  if (findLeaks(output, roster, { firstNames: false }).length) {
    return { status: "manual", reason: "Agent output contained a student identifier.", agentView: payload };
  }

  return { status: "pending", ...graded, score: graded.rawScore, agentView: payload, ...(note && { reason: note }) };
}

const loadAll = () => Promise.all([
  vault.loadRoster(), vault.loadAssignment(), vault.loadSubmissions(), vault.loadGrades(),
]);

async function gradeAndSave(sub, assignment, roster) {
  try {
    let grade;
    try {
      grade = await gradeOne(sub, assignment, roster);
    } catch (err) {
      console.error(`grading failed: ${err.message}`); // message only; never log identifiers
      grade = { status: "error", reason: err.message };
    }
    await vault.updateGrade(sub.studentId, () => ({
      ...grade,
      assignmentVersion: assignment.version,
      totalPoints: totalPointsOf(assignment),
      gradedAt: new Date().toISOString(),
    }));
  } finally {
    inProgress.delete(sub.studentId); // only after saving, so the row never flashes its old status
  }
}

// Grades every submission that isn't final (or already being graded). Runs in the background.
async function gradeAll() {
  const [roster, assignment, subs, grades] = await loadAll();
  checkNotSaving();
  const enrolled = new Set(vault.studentsOf(roster).map((s) => s.studentId));
  // Shuffle so the order the agent sees submissions carries no roster information.
  const queue = subs
    .filter((s) => enrolled.has(s.studentId) && grades[s.studentId]?.status !== "final" && !inProgress.has(s.studentId))
    .sort(() => Math.random() - 0.5);
  queue.forEach((s) => inProgress.add(s.studentId));

  const worker = async () => {
    for (let sub; (sub = queue.shift()); ) await gradeAndSave(sub, assignment, roster);
  };
  const count = queue.length;
  Promise.all(Array.from({ length: CONCURRENCY }, worker)).catch((err) => console.error(`batch failed: ${err.message}`));
  return count;
}

// Grades one submission on request, including a final one (the teacher asked explicitly).
async function gradeSingle(studentId) {
  const [roster, assignment, subs] = await loadAll();
  const sub = subs.find((s) => s.studentId === studentId);
  if (!sub) throw new HttpError(404, "no submission for this student");
  if (inProgress.has(studentId)) throw new HttpError(409, "already being graded");
  checkNotSaving();
  inProgress.add(studentId);
  await gradeAndSave(sub, assignment, roster);
}

const statusOf = (sub, grade, studentId) =>
  !sub ? "missing" : inProgress.has(studentId) ? "grading" : grade?.status ?? "ungraded";

const assignmentSummary = (assignment) => ({
  title: assignment.title,
  deadline: assignment.deadline,
  totalPoints: totalPointsOf(assignment),
  version: assignment.version,
});

const nameOf = (p) => p && { firstName: p.firstName, lastName: p.lastName };

async function gradebook() {
  const [roster, assignment, subs, grades] = await loadAll();
  const subById = new Map(subs.map((s) => [s.studentId, s]));
  const students = vault.studentsOf(roster);
  const rows = students.map(({ studentView, ...student }) => {
    const sub = subById.get(student.studentId);
    const { agentView, ...grade } = withTotal(grades[student.studentId], assignment);
    return {
      ...student,
      submittedAt: sub?.submittedAt ?? null,
      status: statusOf(sub, grades[student.studentId], student.studentId),
      stale: isStale(grade, assignment),
      grade,
    };
  });
  const viewAs = students.find((s) => s.studentView) ?? students[0];
  return {
    assignment: assignmentSummary(assignment),
    rows,
    // Who the "Student view" switcher opens, by name, so a roster edit renames it.
    studentView: viewAs && { studentId: viewAs.studentId, ...nameOf(viewAs) },
  };
}

// "pdf" or "image" when the original can be shown in the browser; null for plain text.
function previewKind(file) {
  const type = vault.PREVIEW_TYPES[extname(file).toLowerCase()];
  return type ? (type.startsWith("image/") ? "image" : "pdf") : null;
}

async function readText(file) {
  try {
    const { text, ocrConfidence, unreadableImages, skippedImages } = await extractText(await vault.readSubmissionFile(file), file);
    return { text, ocr: ocrConfidence !== null, weakOcr: isWeakOcr(ocrConfidence, unreadableImages), skippedImages };
  } catch (err) {
    return { text: null, textError: safeMessage(err) };
  }
}

// Sends the original file for the preview pane. The type comes from our own table, never from the upload.
async function sendPreview(res, studentId) {
  const sub = (await vault.loadSubmissions()).find((s) => s.studentId === studentId);
  if (!sub) throw new HttpError(404, "no submission for this student");
  let preview;
  try {
    preview = await vault.readPreview(sub.file);
  } catch (err) {
    throw new HttpError(503, `preview unavailable: ${safeMessage(err)}`);
  }
  if (!preview) throw new HttpError(404, "this file type has no preview");
  res.writeHead(200, {
    "content-type": preview.type,
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(preview.buffer);
}

async function findStudent(studentId) {
  const [roster, assignment, subs, grades] = await loadAll();
  const student = vault.studentsOf(roster).find((s) => s.studentId === studentId);
  if (!student) throw new HttpError(404, "unknown student");
  const sub = subs.find((s) => s.studentId === studentId);
  const submission = sub && {
    file: sub.file,
    submittedAt: sub.submittedAt,
    preview: previewKind(sub.file),
    ...(await readText(sub.file)),
  };
  return { student, teacher: vault.teacherOf(roster), assignment, sub, submission, grade: grades[studentId] };
}

// Teacher-facing detail: the original (unredacted) essay plus the grade and exactly what the agent saw.
async function submissionDetail(studentId) {
  const { student, assignment, sub, submission, grade: stored } = await findStudent(studentId);
  const { agentView = null, ...grade } = withTotal(stored, assignment);
  return {
    assignment: assignmentSummary(assignment),
    student,
    submission,
    status: statusOf(sub, stored, studentId),
    stale: isStale(grade, assignment),
    grade,
    agentView,
  };
}

// Student-facing view: their own submission and, only once the teacher approves it, their grade.
async function studentView(studentId) {
  const { student, teacher, assignment, submission, grade } = await findStudent(studentId);
  const final = grade?.status === "final";
  return {
    student: nameOf(student),
    teacher: nameOf(teacher),
    assignment: {
      title: assignment.title,
      prompt: assignment.prompt,
      deadline: assignment.deadline,
      rubric: assignment.rubric,
      // Questions only: expected answers and methods never reach the student.
      questions: assignment.answerKey.map(({ question, maxPoints }) => ({ question, maxPoints })),
      totalPoints: totalPointsOf(assignment),
    },
    submission,
    status: !submission ? "not_submitted" : final ? "graded" : "submitted",
    grade: final ? {
      score: grade.score,
      totalPoints: gradeTotal(grade, assignment),
      rubric: grade.rubric ?? null,
      feedback: grade.feedback ?? null,
      answers: grade.answers ?? null,
      approvedAt: grade.approvedAt,
    } : null,
  };
}

async function submitAsStudent(studentId, body) {
  const roster = await vault.loadRoster();
  if (!vault.studentsOf(roster).some((s) => s.studentId === studentId)) throw new HttpError(404, "unknown student");
  if (inProgress.has(studentId)) throw new HttpError(409, "your previous submission is being graded; try again in a moment");
  const { ext, buffer } = await parseUpload(body);
  await vault.replaceSubmission(studentId, ext, buffer, new Date().toISOString());
}

async function approve(studentId, override) {
  const assignment = await vault.loadAssignment();
  await vault.updateGrade(studentId, (grade) => {
    if (!grade || !["pending", "manual", "error"].includes(grade.status)) throw new Error("nothing to approve");
    const max = gradeTotal(grade, assignment);
    const score = override ?? grade.score;
    if (!Number.isFinite(score) || score < 0 || score > max) throw new Error(`score must be 0-${max}`);
    return { ...grade, status: "final", score: Math.round(score), approvedAt: new Date().toISOString() };
  });
}

async function updateAssignment(body) {
  const [assignment, grades] = await Promise.all([vault.saveAssignment(validateAssignment(body)), vault.loadGrades()]);
  const outdated = Object.values(grades).filter((g) => isStale(g, assignment)).length;
  return { assignment: { ...assignment, totalPoints: totalPointsOf(assignment) }, outdated };
}

async function rosterView() {
  const [roster, subs] = await Promise.all([vault.loadRoster(), vault.loadSubmissions()]);
  const submitted = new Set(subs.map((s) => s.studentId));
  return {
    teacher: vault.teacherOf(roster),
    students: vault.studentsOf(roster).map((s) => ({ ...s, hasSubmission: submitted.has(s.studentId) })),
  };
}

async function updateRoster(body) {
  const existing = vault.studentsOf(await vault.loadRoster()).map((s) => s.studentId);
  const roster = validateRoster(body, existing);
  // Checked and set with no await in between, so grading can't start in the gap (see checkNotSaving).
  if (inProgress.size) throw new HttpError(409, "wait for grading to finish before editing the roster");
  rosterSaving = true;
  try {
    await vault.saveRoster(roster);
  } finally {
    rosterSaving = false;
  }
  return rosterView();
}

async function readBody(req) {
  // A cross-site form or no-cors fetch can't send this type without a CORS preflight.
  if (!req.headers["content-type"]?.startsWith("application/json") && req.headers["content-length"] !== "0") {
    throw new HttpError(415, "send JSON");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request is too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleApi(req, action, id) {
  const route = `${req.method} ${action}${id ? "/:id" : ""}`;
  switch (route) {
    case "GET gradebook":
      return gradebook();
    case "POST grade": {
      const queued = await gradeAll(); // queue first so the returned rows already show "grading"
      return { ...(await gradebook()), queued };
    }
    case "POST grade/:id":
      await gradeSingle(id);
      return gradebook();
    case "POST approve/:id": {
      const { score } = await readBody(req);
      await approve(id, score === undefined || score === "" ? undefined : Number(score));
      return { ok: true };
    }
    case "GET submission/:id":
      return submissionDetail(id);
    case "GET assignment": {
      const assignment = await vault.loadAssignment();
      return { ...assignment, totalPoints: totalPointsOf(assignment) };
    }
    case "PUT assignment":
      return updateAssignment(await readBody(req));
    case "GET roster":
      return rosterView();
    case "PUT roster":
      return updateRoster(await readBody(req));
    case "GET student/:id":
      return studentView(id);
    case "POST student/:id":
      await submitAsStudent(id, await readBody(req));
      return studentView(id);
    default:
      throw new HttpError(404, "not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    checkRequest(req);
  } catch (err) {
    return sendJson(res, err.status, { error: err.message });
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const [, api, action, id, extra] = url.pathname.split("/");

  if (api === "api") {
    try {
      if (extra !== undefined) throw new HttpError(404, "not found");
      if (req.method === "GET" && action === "preview" && id) return await sendPreview(res, decodeURIComponent(id));
      return sendJson(res, 200, await handleApi(req, action, id && decodeURIComponent(id)));
    } catch (err) {
      if (!isSafe(err)) console.error(`request failed: ${err.code ?? err.name}`); // not the message: it may name a student's file
      return sendJson(res, isSafe(err) ? err.status ?? 400 : 500, { error: safeMessage(err) });
    }
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const body = await readFile(join(PUBLIC_DIR, file.replace(/\.\.+/g, "")));
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await vault.ensureData();
  server.listen(PORT, HOST, () => console.log(`Grade Center at http://localhost:${PORT}`));
}
