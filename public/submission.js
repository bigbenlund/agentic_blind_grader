const studentId = new URLSearchParams(location.search).get("id");
let data;
let pollTimer = null;

function renderGrading() {
  const g = data.grade;
  const totalPoints = g.totalPoints ?? data.assignment.totalPoints;
  if (data.status === "grading") return '<p class="muted">The agent is grading this submission…</p>';
  if (!data.submission) return '<p class="muted">Nothing submitted.</p>';

  const stale = data.stale ? `<p class="notice">Graded before the assignment was last edited.
    Regrade to apply the current rubric and instructions.</p>` : "";
  const reason = g.reason ? `<p class="message">${esc(g.reason)}</p>` : "";
  const results = g.rubric ? `${renderResults(g)}
    <p>Grade: <strong>${g.score} / ${totalPoints}</strong></p>
    <h3>Feedback</h3><p class="feedback">${esc(g.feedback)}</p>
    <p class="muted small-text">Graded ${esc(fmtTime(g.gradedAt))} by ${esc(g.model ?? "agent")}
      ${g.approvedAt ? ` · Approved ${esc(fmtTime(g.approvedAt))}` : ""}</p>` : "";

  const canApprove = ["pending", "manual", "error"].includes(data.status);
  const approve = canApprove ? `
    <div class="actions">
      <label>Score <input id="override" type="number" min="0" max="${totalPoints}" placeholder="${g.score ?? ""}"></label>
      <button id="approve">Approve as final</button>
    </div>` : "";

  const empty = !g.rubric && !g.reason ? '<p class="muted">Not graded yet.</p>' : "";
  return stale + reason + results + empty + approve;
}

function render() {
  const { student, submission, status } = data;
  const name = `${student.firstName} ${student.lastName}`;
  document.title = `${name} · Submission`;
  $("name").textContent = name;
  $("crumb-name").textContent = name;
  $("meta").textContent = `${student.email} · ID ${student.studentId} · ${data.assignment.title}`;
  $("status").innerHTML = chip(status) + (data.stale && status !== "grading" ? ` ${STALE_CHIP}` : "");

  $("file").innerHTML = submission
    ? `${esc(submission.file)} · submitted ${esc(fmtTime(submission.submittedAt))}`
    : "";
  renderSubmission($("essay"), submission, studentId);

  $("grading").innerHTML = renderGrading();
  $("approve")?.addEventListener("click", approve);

  $("grade").hidden = !submission;
  $("grade").disabled = status === "grading";
  $("grade").textContent = status === "grading" ? "Grading…" : data.grade.gradedAt ? "Regrade with agent" : "Grade with agent";

  $("agent-panel").hidden = !data.agentView;
  $("agent-view").textContent = data.agentView ? JSON.stringify(data.agentView, null, 2) : "";

  clearTimeout(pollTimer);
  if (status === "grading") pollTimer = setTimeout(load, POLL_MS);
}

async function load() {
  try {
    data = await api(`/api/submission/${encodeURIComponent(studentId)}`);
    render();
  } catch (err) {
    showMessage(err.message);
  }
}

async function grade() {
  if (data.status === "final" && !confirm("This grade is final. Regrade it and reset it to pending review?")) return;
  showMessage(null);
  const request = api(`/api/grade/${encodeURIComponent(studentId)}`, { method: "POST" });
  data.status = "grading";
  render();
  try {
    await request;
  } catch (err) {
    showMessage(err.message);
  }
  load();
}

async function approve() {
  try {
    await api(`/api/approve/${encodeURIComponent(studentId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ score: $("override").value }),
    });
    load();
  } catch (err) {
    showMessage(err.message);
  }
}

$("grade").addEventListener("click", grade);
load();
