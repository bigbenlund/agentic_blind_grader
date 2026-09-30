import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateAssignment, validateRoster, parseUpload, MAX_UPLOAD_BYTES } from "../src/validate.mjs";
import { parseGrade } from "../src/grader-agent.mjs";
import { closeOcr } from "../src/extract.mjs";

after(closeOcr);

// Fixed input so these tests don't depend on the live, teacher-editable assignment.
const valid = () => ({
  title: "Essay 1",
  prompt: "Argue a position.",
  deadline: "2026-09-21T03:59:00Z",
  rubric: [
    { criterion: "Thesis", maxPoints: 20, description: "Clear position." },
    { criterion: "Evidence", maxPoints: 30, description: "Specific support." },
  ],
});

test("accepts the current assignment and normalizes types", () => {
  const input = valid();
  input.title = "  New title  ";
  input.rubric[0].maxPoints = "25";
  const out = validateAssignment(input);
  assert.equal(out.title, "New title");
  assert.deepEqual(out.answerKey, []);
  assert.equal(out.rubric[0].maxPoints, 25);
  assert.equal(out.version, undefined, "version is set by the vault, not the browser");
});

test("rejects bad assignment edits", () => {
  const cases = [
    [(a) => (a.title = " "), /title is required/],
    [(a) => (a.prompt = ""), /instructions is required/],
    [(a) => (a.deadline = "not a date"), /deadline is invalid/],
    [(a) => (a.rubric = []), /at least one rubric criterion or answer key question/],
    [(a) => (a.rubric[1].criterion = a.rubric[0].criterion.toUpperCase()), /duplicate criterion/],
    [(a) => (a.rubric[0].maxPoints = 2.5), /whole number/],
    [(a) => (a.rubric[0].maxPoints = 0), /whole number/],
    [(a) => (a.rubric[0].description = ""), /description is required/],
    [(a) => (a.answerKey = [{ question: "Q", maxPoints: 5, answer: "" }]), /question 1 answer is required/],
    [(a) => (a.answerKey = [{ question: "Q", maxPoints: 0, answer: "4" }]), /whole number/],
  ];
  for (const [mutate, error] of cases) {
    const input = valid();
    mutate(input);
    assert.throws(() => validateAssignment(input), error);
  }
});

test("an answer key can replace the rubric; method is optional", () => {
  const input = { ...valid(), rubric: [], answerKey: [{ question: " 2x + 3 = 11 ", maxPoints: "5", answer: "x = 4" }] };
  const out = validateAssignment(input);
  assert.deepEqual(out.rubric, []);
  assert.deepEqual(out.answerKey, [{ question: "2x + 3 = 11", maxPoints: 5, answer: "x = 4", method: "" }]);
});

test("grading follows an edited rubric", () => {
  const rubric = [{ criterion: "Voice", maxPoints: 40, description: "x" }, { criterion: "Clarity", maxPoints: 10, description: "y" }];
  const reply = JSON.stringify({
    rubric: [{ criterion: "Voice", points: 50, comment: "a" }, { criterion: "Clarity", points: 7, comment: "b" }],
    feedback: "ok",
  });
  assert.equal(parseGrade(reply, rubric).rawScore, 47);
});

test("accepts pasted text as .txt", async () => {
  const { ext, buffer } = await parseUpload({ text: "  My essay.  " });
  assert.equal(ext, ".txt");
  assert.equal(buffer.toString(), "My essay.");
});

test("accepts a real .docx upload", async () => {
  const fileBase64 = (await readFile(new URL("fixtures/demo/800123403.docx", import.meta.url))).toString("base64");
  assert.equal((await parseUpload({ fileName: "Essay.DOCX", fileBase64 })).ext, ".docx");
});

test("rejects bad uploads", async () => {
  await assert.rejects(parseUpload({}), /paste your essay or choose a file/);
  await assert.rejects(parseUpload({ text: "   " }), /paste your essay or choose a file/);
  await assert.rejects(parseUpload({ fileName: "essay.exe", fileBase64: "AA==" }), /file must be one of/);
  await assert.rejects(parseUpload({ fileName: "essay.docx", fileBase64: "bm90IGEgZG9jeA==" }), /isn.t a valid \.docx/);
  await assert.rejects(parseUpload({ fileName: "essay.txt", fileBase64: "ICAg" }), /no readable text/);
  const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 97).toString("base64");
  await assert.rejects(parseUpload({ fileName: "essay.txt", fileBase64: big }), /larger than 15 MB/);
});

test("parseGrade accepts the structured-output object", () => {
  const rubric = [{ criterion: "Voice", maxPoints: 40, description: "x" }];
  const graded = parseGrade({ rubric: [{ criterion: "Voice", points: 31, comment: "a" }], feedback: "ok" }, rubric);
  assert.equal(graded.rawScore, 31);
  assert.throws(() => parseGrade(null, rubric), /no grade/);
});

test("parseGrade scores answer-key questions by id and normalizes verdicts", () => {
  const key = [
    { question: "Solve 2x + 3 = 11", maxPoints: 5, answer: "x = 4", method: "Isolate x" },
    { question: "Capital of France", maxPoints: 2, answer: "Paris", method: "" },
  ];
  const graded = parseGrade({
    answers: [
      { question: "Q1", points: 9, answer: "correct", method: "flawed", comment: "a" },
      { question: "Q2", points: 2, answer: "correct", method: "correct", comment: "b" },
    ],
    feedback: "ok",
  }, [], key);
  assert.equal(graded.rawScore, 7);
  assert.deepEqual(graded.answers.map((a) => [a.question, a.points, a.answer, a.method]),
    [["Solve 2x + 3 = 11", 5, "correct", "flawed"], ["Capital of France", 2, "correct", "n/a"]]);
  assert.throws(() => parseGrade({ answers: [], feedback: "ok" }, [], key), /missing score for Q1/);
});

const rosterInput = () => ({
  teacher: { firstName: "Elena", lastName: "Reyes", email: "EReyes@StateU.edu" },
  students: [
    { originalId: "800123401", studentId: "800123401", firstName: "Maya", lastName: "Chen", email: "maya.chen@stateu.edu" },
    { originalId: null, studentId: "800123499", firstName: "Liam", lastName: "O'Brien-Park", email: "lobp@stateu.edu", studentView: true },
  ],
});

test("validateRoster normalizes the roster and picks one student view", () => {
  const out = validateRoster(rosterInput(), ["800123401", "800123402"]);
  assert.deepEqual(out.teacher, { role: "teacher", firstName: "Elena", lastName: "Reyes", email: "ereyes@stateu.edu" });
  assert.deepEqual(out.students.map((s) => [s.originalId, s.studentId, s.studentView]),
    [["800123401", "800123401", false], [null, "800123499", true]]);
  const noView = rosterInput();
  noView.students[1].studentView = false;
  assert.equal(validateRoster(noView, ["800123401"]).students[0].studentView, true); // defaults to the first
});

test("validateRoster rejects bad rosters", () => {
  const cases = [
    [(r) => (r.teacher.email = "not an email"), /teacher email is invalid/],
    [(r) => (r.students = []), /1 to 500 students/],
    [(r) => (r.students[1].studentId = "800123401"), /duplicate student ID/],
    [(r) => (r.students[1].email = "ereyes@stateu.edu"), /duplicate email/], // the teacher's
    [(r) => (r.students[1].studentId = "80015"), /7 to 12 digits/],
    [(r) => (r.students[0].firstName = "Maya, Chen"), /names can only have/],
    [(r) => (r.students[1].originalId = "999999999"), /doesn't match a saved student/],
    [(r) => (r.students[1].originalId = "800123401"), /doesn't match a saved student/], // claimed twice
  ];
  for (const [mutate, error] of cases) {
    const input = rosterInput();
    mutate(input);
    assert.throws(() => validateRoster(input, ["800123401"]), error);
  }
});
