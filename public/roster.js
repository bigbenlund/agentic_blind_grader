let dirty = false;
let removed = []; // saved students taken off the roster since the last save

// originalId ties the row to the saved student, so the server can move their submission if the ID changes.
function studentRow({ studentId = "", firstName = "", lastName = "", email = "", studentView = false, hasSubmission = false } = {}) {
  const tr = document.createElement("tr");
  tr.dataset.originalId = studentId;
  tr.dataset.hasSubmission = hasSubmission;
  tr.innerHTML = `
    <td data-label="First name"><input class="s-first" maxlength="60" required></td>
    <td data-label="Last name"><input class="s-last" maxlength="60" required></td>
    <td data-label="Email"><input class="s-email" type="email" maxlength="254" required></td>
    <td data-label="Student ID"><input class="s-id" inputmode="numeric" maxlength="12" required></td>
    <td data-label="Student view"><input class="s-view" type="radio" name="student-view" aria-label="Open in student view"></td>
    <td><button type="button" class="secondary small s-remove">Remove</button></td>`;
  tr.querySelector(".s-first").value = firstName;
  tr.querySelector(".s-last").value = lastName;
  tr.querySelector(".s-email").value = email;
  tr.querySelector(".s-id").value = studentId;
  tr.querySelector(".s-view").checked = studentView;
  return tr;
}

function updateCount() {
  const n = $("students").children.length;
  $("count").textContent = `· ${n} student${n === 1 ? "" : "s"}`;
  document.querySelectorAll(".s-remove").forEach((b) => (b.disabled = n === 1));
}

function fill({ teacher, students }) {
  $("t-first").value = teacher?.firstName ?? "";
  $("t-last").value = teacher?.lastName ?? "";
  $("t-email").value = teacher?.email ?? "";
  $("students").replaceChildren(...students.map(studentRow));
  removed = [];
  updateCount();
  dirty = false;
}

function collect() {
  return {
    teacher: { firstName: $("t-first").value, lastName: $("t-last").value, email: $("t-email").value },
    students: [...$("students").children].map((tr) => ({
      originalId: tr.dataset.originalId || null,
      firstName: tr.querySelector(".s-first").value,
      lastName: tr.querySelector(".s-last").value,
      email: tr.querySelector(".s-email").value,
      studentId: tr.querySelector(".s-id").value.trim(),
      studentView: tr.querySelector(".s-view").checked,
    })),
  };
}

async function save(e) {
  e.preventDefault();
  showMessage(null);
  $("saved").hidden = true;
  const losing = removed.filter((r) => r.hasSubmission);
  if (losing.length && !confirm(`Removing ${losing.map((r) => r.name).join(", ")} deletes their submission and grade. Continue?`)) return;
  $("save").disabled = true;
  try {
    fill(await api("/api/roster", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collect()),
    }));
    $("saved").hidden = false;
    $("saved").innerHTML = 'Saved. <a href="/">Back to Grade Center</a>';
  } catch (err) {
    showMessage(err.message);
  } finally {
    $("save").disabled = false;
  }
}

$("students").addEventListener("click", (e) => {
  if (!e.target.classList.contains("s-remove")) return;
  const tr = e.target.closest("tr");
  if (tr.dataset.originalId) {
    removed.push({
      name: `${tr.querySelector(".s-first").value} ${tr.querySelector(".s-last").value}`.trim(),
      hasSubmission: tr.dataset.hasSubmission === "true",
    });
  }
  tr.remove();
  dirty = true;
  updateCount();
});
$("add").addEventListener("click", () => {
  $("students").append(studentRow());
  dirty = true;
  updateCount();
  $("students").lastElementChild.querySelector(".s-first").focus();
});
$("form").addEventListener("input", () => (dirty = true));
$("form").addEventListener("submit", save);
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

api("/api/roster").then(fill, (err) => showMessage(err.message));
