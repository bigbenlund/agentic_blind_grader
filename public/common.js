// Helpers shared by the Grade Center and submission pages.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const POLL_MS = 2000;

const STATUS_LABEL = {
  missing: "No submission",
  ungraded: "Needs grading",
  grading: "Grading…",
  pending: "Pending review",
  final: "Final",
  manual: "Manual grading required",
  error: "Agent error",
};

const chip = (status) => `<span class="chip ${status}">${STATUS_LABEL[status]}</span>`;
const STALE_CHIP = '<span class="chip stale" title="Graded before the assignment was last edited">Outdated</span>';

// Answer-key verdicts shown as chips: green when right, red when wrong, grey when not attempted.
const VERDICT_CLASS = { correct: "final", incorrect: "manual", flawed: "manual", missing: "" };
const verdict = (label, value) => value && value !== "n/a"
  ? `<span class="chip ${VERDICT_CLASS[value] ?? ""}">${label}: ${esc(value)}</span>` : "";

// Scored rubric criteria and answer-key questions from a grade.
function renderResults(g) {
  const rubric = g.rubric?.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Criterion</th><th>Points</th><th>Comment</th></tr></thead>
      <tbody>${g.rubric.map((r) => `<tr><td>${esc(r.criterion)}</td>
        <td class="num">${r.points}&nbsp;/&nbsp;${r.maxPoints}</td><td>${esc(r.comment)}</td></tr>`).join("")}</tbody>
    </table></div>` : "";
  const answers = g.answers?.length ? `
    <h3>Answer key</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Question</th><th>Points</th><th>Check</th><th>Comment</th></tr></thead>
      <tbody>${g.answers.map((a) => `<tr><td>${esc(a.question)}</td>
        <td class="num">${a.points}&nbsp;/&nbsp;${a.maxPoints}</td>
        <td class="status-cell">${verdict("Answer", a.answer)} ${verdict("Work", a.method)}</td>
        <td>${esc(a.comment)}</td></tr>`).join("")}</tbody>
    </table></div>` : "";
  return rubric + answers;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

function showMessage(text) {
  $("message").hidden = !text;
  $("message").textContent = text ?? "";
  if (text) $("message").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Submission pane: the original file (PDF viewer or image) with a tab for the text the grader works from.
// Re-renders only when the submission changes, so polling doesn't reload the preview or reset the tab.
async function renderSubmission(el, submission, studentId) {
  const key = submission ? `${submission.file}|${submission.submittedAt}` : "";
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  if (el.dataset.url) URL.revokeObjectURL(el.dataset.url);
  delete el.dataset.url;
  if (!submission) return (el.innerHTML = "");

  // Shown above the tabs, so it's seen whichever tab is open.
  const skipped = submission.skippedImages
    ? `<p class="notice">${submission.skippedImages} image(s) couldn't be read and are left out of the extracted text. Check the original.</p>` : "";
  const notice = submission.textError ? `<p class="message">Could not read this file: ${esc(submission.textError)}</p>`
    : submission.weakOcr ? '<p class="notice">Part of this file was hard to read, so it will be graded by hand rather than by the agent.</p>'
    : skipped + (submission.ocr ? '<p class="muted small-text">Some text was read by OCR. Check it against the original.</p>' : "");
  const text = submission.textError ? "" : `<article class="essay">${esc(submission.text)}</article>`;
  if (!submission.preview) return (el.innerHTML = notice + text);

  el.innerHTML = `${notice}
    <div class="tabs" role="tablist">
      <button type="button" class="tab active" data-view="original" role="tab">Original</button>
      <button type="button" class="tab" data-view="text" role="tab">Extracted text</button>
    </div>
    <div data-view-pane="original"><p class="muted">Loading preview…</p></div>
    <div data-view-pane="text" hidden>${text}</div>`;
  const show = (view) => {
    el.querySelectorAll("[data-view]").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    el.querySelectorAll("[data-view-pane]").forEach((p) => (p.hidden = p.dataset.viewPane !== view));
  };
  el.querySelectorAll("[data-view]").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));

  const pane = el.querySelector('[data-view-pane="original"]');
  try {
    const res = await fetch(`/api/preview/${encodeURIComponent(studentId)}`);
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
    const blob = await res.blob();
    if (el.dataset.key !== key) return; // a newer submission rendered meanwhile
    const url = (el.dataset.url = URL.createObjectURL(blob));
    pane.innerHTML = submission.preview === "image"
      ? `<img class="preview-img" src="${url}" alt="Original submission">`
      : `<iframe class="preview-frame" src="${url}" title="Original submission"></iframe>`;
  } catch (err) {
    if (el.dataset.key !== key) return;
    pane.innerHTML = `<p class="message">${esc(err.message)}</p>`;
    show("text");
  }
}
