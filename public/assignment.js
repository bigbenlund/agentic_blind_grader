let dirty = false;

// datetime-local works in local time without a zone; convert to and from the stored ISO string.
const toLocalInput = (iso) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function criterionRow({ criterion = "", maxPoints = 10, description = "" } = {}) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td data-label="Criterion"><input class="c-name" maxlength="60" required></td>
    <td data-label="Max points"><input class="c-points" type="number" min="1" max="1000" step="1" required></td>
    <td data-label="What earns the points"><textarea class="c-desc" rows="2" maxlength="500" required></textarea></td>
    <td><button type="button" class="secondary small c-remove">Remove</button></td>`;
  tr.querySelector(".c-name").value = criterion;
  tr.querySelector(".c-points").value = maxPoints;
  tr.querySelector(".c-desc").value = description;
  return tr;
}

function questionRow({ question = "", maxPoints = 5, answer = "", method = "" } = {}) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td data-label="Question"><textarea class="q-question" rows="2" maxlength="1000" required></textarea></td>
    <td data-label="Max points"><input class="q-points" type="number" min="1" max="1000" step="1" required></td>
    <td data-label="Expected answer"><textarea class="q-answer" rows="2" maxlength="2000" required></textarea></td>
    <td data-label="Required method (optional)"><textarea class="q-method" rows="2" maxlength="2000"></textarea></td>
    <td><button type="button" class="secondary small c-remove">Remove</button></td>`;
  tr.querySelector(".q-question").value = question;
  tr.querySelector(".q-points").value = maxPoints;
  tr.querySelector(".q-answer").value = answer;
  tr.querySelector(".q-method").value = method;
  return tr;
}

// Rubric plus answer key; at least one row must remain across both.
function updateTotal() {
  const points = [...document.querySelectorAll(".c-points, .q-points")].map((i) => Number(i.value) || 0);
  $("total").textContent = `· ${points.reduce((a, b) => a + b, 0)} points total`;
  document.querySelectorAll(".c-remove").forEach((b) => (b.disabled = points.length === 1));
}

function fill(a) {
  $("title").value = a.title;
  $("prompt").value = a.prompt;
  $("deadline").value = toLocalInput(a.deadline);
  $("criteria").replaceChildren(...a.rubric.map(criterionRow));
  $("questions").replaceChildren(...(a.answerKey ?? []).map(questionRow));
  updateTotal();
  dirty = false;
}

function collect() {
  const deadline = new Date($("deadline").value);
  return {
    title: $("title").value,
    prompt: $("prompt").value,
    deadline: Number.isNaN(deadline.getTime()) ? "" : deadline.toISOString(),
    rubric: [...$("criteria").children].map((tr) => ({
      criterion: tr.querySelector(".c-name").value,
      maxPoints: tr.querySelector(".c-points").value,
      description: tr.querySelector(".c-desc").value,
    })),
    answerKey: [...$("questions").children].map((tr) => ({
      question: tr.querySelector(".q-question").value,
      maxPoints: tr.querySelector(".q-points").value,
      answer: tr.querySelector(".q-answer").value,
      method: tr.querySelector(".q-method").value,
    })),
  };
}

async function save(e) {
  e.preventDefault();
  showMessage(null);
  $("saved").hidden = true;
  $("save").disabled = true;
  try {
    const { assignment, outdated } = await api("/api/assignment", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collect()),
    });
    fill(assignment);
    $("saved").hidden = false;
    $("saved").innerHTML = `Saved. ${outdated} existing grade${outdated === 1 ? " is" : "s are"} now marked outdated.
      <a href="/">Back to Grade Center</a> to regrade.`;
  } catch (err) {
    showMessage(err.message);
  } finally {
    $("save").disabled = false;
  }
}

$("form").addEventListener("click", (e) => {
  if (!e.target.classList.contains("c-remove")) return;
  e.target.closest("tr").remove();
  dirty = true;
  updateTotal();
});
const addRow = (tbody, row, focus) => {
  tbody.append(row);
  dirty = true;
  updateTotal();
  row.querySelector(focus).focus();
};
$("add").addEventListener("click", () => addRow($("criteria"), criterionRow(), ".c-name"));
$("add-question").addEventListener("click", () => addRow($("questions"), questionRow(), ".q-question"));
$("form").addEventListener("input", () => {
  dirty = true;
  updateTotal();
});
$("form").addEventListener("submit", save);
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

api("/api/assignment").then(fill, (err) => showMessage(err.message));
