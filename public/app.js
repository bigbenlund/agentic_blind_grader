let data;
let pollTimer = null;

function render() {
  const { assignment, rows, studentView: v } = data;
  $("student-view").hidden = !v;
  if (v) {
    $("student-view").href = `student.html?id=${encodeURIComponent(v.studentId)}`;
    $("student-view").textContent = `Student view: ${v.firstName} ${v.lastName}`;
  }
  $("title").textContent = assignment.title;
  $("due").textContent = `Due ${fmtTime(assignment.deadline)} · ${assignment.totalPoints} points`;

  $("rows").innerHTML = rows.map((r) => {
    const score = r.grade.score ?? null;
    const graded = r.grade.gradedAt || r.status === "final";
    const button = r.status === "missing" ? ""
      : `<button class="secondary small" data-grade="${esc(r.studentId)}" ${r.status === "grading" ? "disabled" : ""}>
          ${graded ? "Regrade" : "Grade"}</button>`;
    return `<tr data-id="${esc(r.studentId)}" class="${r.status === "missing" ? "" : "clickable"}">
      <td>${esc(r.lastName)}</td><td>${esc(r.firstName)}</td><td>${esc(r.email)}</td>
      <td class="num">${esc(r.studentId)}</td>
      <td>${r.submittedAt ? esc(fmtTime(r.submittedAt)) : "—"}</td>
      <td class="num">${score === null ? "—" : `${score} / ${r.grade.totalPoints ?? assignment.totalPoints}`}</td>
      <td class="status-cell">${chip(r.status)} ${r.stale && r.status !== "grading" ? STALE_CHIP : ""}</td>
      <td>${button}</td>
    </tr>`;
  }).join("");

  const outdated = rows.filter((r) => r.stale && r.status !== "grading").length;
  $("outdated").hidden = !outdated;
  $("outdated").textContent = `${outdated} grade${outdated === 1 ? " was" : "s were"} made before the assignment was last edited. ` +
    "Grade all refreshes the non-final ones; use Regrade on a row for final grades.";

  const busy = rows.some((r) => r.status === "grading");
  $("grade-all").disabled = busy;
  $("grade-all").textContent = busy ? "Grading…" : "Grade all with agent";
  // Keep refreshing while anything is grading so rows update as each essay finishes.
  clearTimeout(pollTimer);
  if (busy) pollTimer = setTimeout(load, POLL_MS);
}

async function load() {
  try {
    data = await api("/api/gradebook");
    render();
  } catch (err) {
    showMessage(err.message);
  }
}

async function grade(studentId) {
  showMessage(null);
  const row = data.rows.find((r) => r.studentId === studentId);
  if (studentId && row.status === "final" && !confirm("This grade is final. Regrade it and reset it to pending review?")) {
    return;
  }
  const request = api(`/api/grade/${studentId ?? ""}`, { method: "POST" });
  if (studentId) {
    row.status = "grading";
    render();
  }
  try {
    data = await request;
    render();
    if (data.queued === 0) showMessage("Nothing to grade: every submission is final.");
  } catch (err) {
    showMessage(err.message);
    load();
  }
}

$("rows").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-grade]");
  if (button) return grade(button.dataset.grade);
  const tr = e.target.closest("tr.clickable");
  if (tr) location.href = `submission.html?id=${encodeURIComponent(tr.dataset.id)}`;
});
$("grade-all").addEventListener("click", () => grade());
load();
