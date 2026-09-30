const studentId = new URLSearchParams(location.search).get("id");
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const STUDENT_STATUS = {
  not_submitted: ["missing", "Not submitted"],
  submitted: ["pending", "Submitted · awaiting grade"],
  graded: ["final", "Graded"],
};
let data;
let mode = "text";

const countWords = (s) => (s.trim().match(/\S+/g) ?? []).length;

function renderGrade(g) {
  return `
    <p class="big-score">${g.score} / ${g.totalPoints}</p>
    ${renderResults(g)}
    ${g.feedback ? `<h3>Feedback</h3><p class="feedback">${esc(g.feedback)}</p>` : ""}
    <p class="muted small-text">Released ${esc(fmtTime(g.approvedAt))}</p>`;
}

function render() {
  const { student, assignment: a, submission, status, grade } = data;
  document.title = `${a.title} · ${student.firstName} ${student.lastName}`;
  $("who").textContent = `Signed in as ${student.firstName} ${student.lastName} (student)`;
  if (data.teacher) $("teacher-view").textContent = `Teacher view: ${data.teacher.firstName} ${data.teacher.lastName}`;
  $("title").textContent = a.title;
  $("due").textContent = `Due ${fmtTime(a.deadline)} · ${a.totalPoints} points`;
  const [cls, label] = STUDENT_STATUS[status];
  $("status").innerHTML = `<span class="chip ${cls}">${label}</span>`;

  $("prompt").textContent = a.prompt;
  $("rubric-section").hidden = !a.rubric.length;
  $("rubric").innerHTML = a.rubric.map((c) => `<tr><td>${esc(c.criterion)}</td>
    <td class="num">${c.maxPoints}</td><td>${esc(c.description)}</td></tr>`).join("");
  $("questions-section").hidden = !a.questions.length;
  $("questions").innerHTML = a.questions.map((q) => `<tr><td class="prewrap">${esc(q.question)}</td>
    <td class="num">${q.maxPoints}</td></tr>`).join("");

  $("grade-panel").hidden = !grade;
  if (grade) $("grade").innerHTML = renderGrade(grade);

  $("submission-panel").hidden = !submission;
  if (submission) {
    $("submitted-meta").textContent = `Submitted ${fmtTime(submission.submittedAt)}`;
  }
  renderSubmission($("essay"), submission, studentId);

  $("form-title").textContent = submission ? "Resubmit" : "Submit your work";
  $("submit").textContent = submission ? "Resubmit" : "Submit";
}

function setMode(next) {
  mode = next;
  document.querySelectorAll("#form .tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== mode));
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("could not read that file"));
    reader.readAsDataURL(file);
  });
}

async function buildBody() {
  if (mode === "text") {
    const text = $("text").value;
    if (!text.trim()) throw new Error("Write or paste your submission first.");
    return { text };
  }
  const file = $("upload").files[0];
  if (!file) throw new Error("Choose a file first.");
  if (file.size > MAX_FILE_BYTES) throw new Error("File is larger than 15 MB.");
  return { fileName: file.name, fileBase64: await readFileBase64(file) };
}

async function submit(e) {
  e.preventDefault();
  showMessage(null);
  if (data.submission && !confirm("Resubmitting replaces your current submission and clears any grade. Continue?")) return;
  $("submit").disabled = true;
  try {
    const body = await buildBody();
    data = await api(`/api/student/${encodeURIComponent(studentId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    $("form").reset();
    $("word-count").textContent = "";
    render();
    $("submission-panel").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    showMessage(err.message);
  } finally {
    $("submit").disabled = false;
  }
}

document.querySelectorAll("#form .tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
$("text").addEventListener("input", () => {
  const n = countWords($("text").value);
  $("word-count").textContent = n ? `${n} words` : "";
});
$("form").addEventListener("submit", submit);

api(`/api/student/${encodeURIComponent(studentId)}`).then((body) => {
  data = body;
  render();
}, (err) => showMessage(err.message));
