# Purpose
A mock Blackboard Grade Center that lists each student's first name, last name, email, student ID, time submitted and grade. A grading agent built on the Claude Agent SDK suggests grades, which the teacher reviews and approves in the dashboard. An assignment has a rubric (qualities judged across the whole submission), an answer key (questions with expected answers and, optionally, a required method of work), or both.

# Core Invariant: the agent never sees student identifiers
The grading agent receives only `{ token, text }`.
- Only `src/vault.mjs` reads the roster, submissions and grades.
- `src/grader-agent.mjs` must never import `vault.mjs`.
- Only `toAgentPayload()` in `src/anonymize.mjs` builds what the agent receives. Add fields to its allowlist only; never pass whole records.
- Tokens come from `crypto.randomUUID()` for each run and are never derived from the student ID. The token → student map lives only in server memory.
- Submissions are converted to plain text, and every roster person's full name, first name, last name, email, email local part and student ID is redacted. The roster includes the teacher (`role: "teacher"`, no student ID), so the teacher's name and email are redacted too, and a "Professor:"/"Instructor:"/"Teacher:" label's value goes like "Name:". Document metadata (author, title) and comments are never extracted. Names and email local parts are redacted before the generic email pattern, tolerating OCR splits ("grace. kim@…"). Adjacent redactions on a line merge into one `[REDACTED]`, so the agent can't count a name's words. Matching is looser where identifiers cluster:
  - **Form labels:** the value after "Name:", "Student ID:", "Email:", "Author:", "By:" or "Submitted by:" is redacted whatever it says (nicknames, misspellings). The label must start the line or follow a form separator (`|`, `;`, `,`, 2+ spaces), so "Its name: Pearl Street" survives. A label alone on its line takes a short next line.
  - **Zones:** the header block (short lines, 7 words or fewer, before the first long one, up to 6), the signature block (short lines at the end, up to 3), and any line of 3 words or fewer (headings, running headers like "Kin 2", captions). There, any word in any case within `tier(name)` edits of a roster name is redacted (2 edits for names of 5+ letters, else 1), and so is a byline's value ("By Jordie A."). This catches "Mava Chan", "Aisha Muhammad" and "Grace\nKin" in a header. Accepted trade-off: a short line can lose a word close to a name ("page" ~ "Patel", "May" ~ "Maya" in a date).
  - **Author:** `redact`/`findLeaks` take `{ author: studentId }` (server-side only; never sent to the agent). Anywhere in the text, the author's initials with dots ("M.C.") and any capitalized mid-sentence word within `tier` edits of the author's name are redacted ("As Llam O'Brlen argued"); month and weekday names are exempt. Accepted trade-off: "Lima" goes in Liam's essay.
  - **Initials:** a capital letter with a dot next to a redaction goes with it ("G. [REDACTED]", "[REDACTED] O.B.").

OCR misreads are handled in these ways:
  - **Pairs:** two same-line words form a name when one is exactly a student's first or last name, after folding OCR confusions (rn→m, 1→l, 0→o), and the other is within one letter of that same student's other name part. This covers "Jordon Alvarez", "maya chan", "Mohammad, Aisha", "Grace Kin" and "Grace Km"; one edit includes swapped letters ("Jordna"). Both words must share casing, and a misread surname written first needs a comma, so "When Maya" and "Maya then" survive. All-lowercase pairs count only in first-last order with an exact first name, so "a page turner will" survives. Accepted trade-off: "Trace Kim" loses "Trace".
  - **Folded names:** a capitalized word that folds to a roster name is redacted ("Kirn", "0'Brien").
  - **Email domains:** any variant of a roster email domain is redacted along with the local part attached to it, whether joined by "@", " at ", "(at)", glued on, or a dotted name before it. Variants: "dot" or spaces for dots, OCR misreads (rn/m, cl/d, 0/o, 5/s, 1/l/i). So "grace.kirn at stateu dot edu" and "gracekirnstateu.eclu" go whole. `findLeaks` independently flags the domain's letters surviving anywhere, even spread over words ("state u edu").
  - **Neighbors:** on the same line as a redaction, a word right before it that is exactly a roster name is redacted ("grace [REDACTED]" from an OCR-split email). So is a capitalized word right after it within `tier` edits of a roster surname ("[REDACTED] Muhammad").
  - `findLeaks` also fails closed on:
    - full names run together ("PhotobyMayaChen")
    - a long surname with a word glued on either end ("Alvarezand", "JorddrAlvarez")
    - student IDs with OCR letter-for-digit swaps ("8OO123405", "8001Z34OS")
    - a lowercase "last first" name ("chen maya"), which `redact` leaves alone as possible prose
  - `findLeaks` applies the same zone and author checks to what's left, so anything close to a name there fails closed.
  - Known limits (not caught), all in body prose about a classmate (not the author):
    - a lone misspelled name that doesn't fold to a roster name ("As Alvarex argued")
    - a name with both parts misread ("Mava Chan" mid-paragraph)
    - a name split across lines by OCR inside a paragraph
- OCR text (images and scanned PDFs) with mean confidence below `OCR_MIN_CONFIDENCE`, or a PDF with a photographed passage that can't be read confidently, is not sent to the agent and is marked "Manual grading required". A misread name could slip past redaction, and writing the student submitted must not be silently left out. Any other PDF photo that can't be read is left out of the text but never silently: both submission views show a notice above the preview tabs, and the pending grade carries it as its reason.
- The leak check fails closed. If an identifier survives redaction, the submission is not sent to the agent and is marked "Manual grading required".
- The agent is locked down: `tools: []`, `allowedTools: []`, `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`, an empty scratch `cwd`, and a `canUseTool` that always denies. Its reply uses SDK structured output (`outputFormat` with a JSON schema built from the rubric); the SDK's internal `StructuredOutput` step doesn't go through `canUseTool`.
- The essay is wrapped in `<essay>` tags and treated as data, not instructions. `fenceEssay` stops the text from opening or closing those tags itself.
- The agent's output is checked before it is joined back to a student: the JSON is validated, each criterion's and question's points are capped at its maximum, and the feedback and comments are scanned for identifiers.
- There are no late penalties. The deadline is shown to students only.

# Answer key
- Each question has `question`, `maxPoints`, `answer` and an optional `method`. They go in the agent's system prompt with ids Q1, Q2, …; the agent returns per question `points`, `answer` (correct/incorrect/missing), `method` (correct/flawed/missing/n/a) and a comment. `parseGrade` forces `method` to "n/a" when the key has none.
- Students see only the questions and their points (`questions` in the student view), never the expected answers or methods.
- An assignment needs at least one rubric criterion or answer-key question.
- Agent grades start as "Pending review" and become final only after the teacher approves them. Students see a grade only once it is final.

# Roster
- `roster.html` (`GET/PUT /api/roster`) edits the teacher (name, email) and the students (name, email, student ID). `validateRoster` checks it: names are letters, spaces, apostrophes, periods and hyphens; emails are unique (teacher included); student IDs are 7-12 digits (shorter ones, with OCR lookalike letters, would match ordinary words) and unique.
- Each row carries the `originalId` it was loaded with. `vault.saveRoster` moves a re-IDed student's submission file (via a temporary name, so swapped IDs can't collide) and grade to the new ID, and deletes the submission, previews and grade of a removed student (the page confirms first).
- A roster save and grading exclude each other: the save is refused while anything is grading, and grading is refused while a save runs. `replaceSubmission` re-checks the roster inside the write queue, so an upload can't land for a student removed mid-upload.
- `studentView: true` on one student marks who the "Student view: <name>" switcher on the Grade Center opens. The student page's "Teacher view: <name>" shows the teacher. Both come from the roster, so edits rename them.
- `vault.studentsOf(roster)` / `teacherOf(roster)` split the roster; the Grade Center, student pages and grading use students only, redaction uses everyone.
- Tests use `test/fixtures/roster.json` and `test/fixtures/demo/` (copies of the demo submissions), never the live roster or submissions.

# Editing and resubmission
- The teacher can edit the title, instructions, deadline, rubric and answer key at any time (`assignment.html`, `PUT /api/assignment`). Each save bumps `assignment.version`.
- Each grade stores the `assignmentVersion` and `totalPoints` it was graded under. When the version no longer matches, the grade shows as "Outdated". Nothing regrades automatically.
- A grade is always shown out of its own `totalPoints`, not the current rubric's.
- A student resubmission replaces the file and clears that student's grade. It is refused while that essay is being graded.

# Structure
- `server.mjs`: plain `node:http` server with the API routes plus the static files in `public/`. `GET /api/preview/:id` sends the original file with a content type from a fixed table (PDF or image, never HTML) and `nosniff`. There is no login, so the server listens on 127.0.0.1 only. Every request needs a `localhost`/`127.0.0.1` Host (stops DNS rebinding), an API request with an `Origin` must come from that host (stops CSRF), and a request body must be `application/json`. Error responses carry only the app's own messages (`HttpError`, `ReadError`, plain `Error`); system errors, which name local paths, become a generic one.
- `src/vault.mjs`: the data that contains student identifiers (`data/roster.json`, `data/submissions.json`, `data/submissions/`, `data/grades.json`, `data/assignment.json`). `data/` is not in git; `ensureData()` copies the fictional class in `sample-data/` there on first run. All writes (`updateGrade`, `saveAssignment`, `replaceSubmission`) share one queue, so they save one at a time. `readPreview` serves the original for the browser: PDFs and images as they are, and Office files rendered to PDF and cached in `data/previews/`. The cache write goes through the same queue and is skipped if the student resubmitted during the conversion.
- `src/validate.mjs`: `validateAssignment` and `parseUpload`, which check browser input before it is saved
- `src/extract.mjs`: `extractText(buffer, filename)` → `{ text, ocrConfidence, unreadableImages, skippedImages }` for .txt/.md/.docx/.doc/.pdf/.pptx/.ppt/.png/.jpg/.jpeg. It checks each file's signature first, so corrupt or mislabeled files are rejected before any parser or LibreOffice sees them. The checks: `%PDF-` in the first 1 KB; PNG or JPEG for any image extension; a zip for .docx/.pptx; for .doc/.ppt, the Word vs PowerPoint stream (RTF is also accepted as .doc, HTML is not). PPTX text is slide by slide in presentation order, with speaker notes labeled. Images are OCR'd with tesseract.js (English data loaded from disk). In PDFs, typed text is always read exactly. A page with under 20 characters of text is a scan and is OCR'd whole. On a typed page, each embedded image over 100 px is OCR'd separately and its text added after the page's text. Images that read as fewer than 2 words (logos) are dropped. Each image is judged on its own. One at or above `OCR_MIN_CONFIDENCE` is added. One below it that reads like writing (10+ real words, at least half the tokens) counts in `unreadableImages`, which sends the essay to "Manual grading required" rather than grading it without that writing. Any other one below it (a street photo, a chart, or writing too garbled to tell) is left out and counted in `skippedImages`, which the teacher sees as a notice. Identical images are read once. At most 20 scanned pages plus distinct photos are allowed. `ReadError` messages are safe to show students. Results are cached (and frozen) by content hash. Limits against small files that expand to exhaust memory: an image over 50 MP (size read from the PNG/JPEG header, before decoding) is refused, or skipped with a notice inside a .docx/.pptx; a PDF over 100 pages, or with a scanned page over 50 MP at render scale, is refused; pdf.js leaves out larger embedded images and never compiles fonts with eval.
- `src/convert.mjs`: LibreOffice (`soffice`) wrapper. It converts .doc/.ppt for extraction and Office files to PDF for preview. `loadZip` inflates every .docx/.pptx entry with a real byte cap (100 MB total, 5000 entries; declared sizes can lie) before JSZip, mammoth or LibreOffice expands it. .doc/.ppt reach LibreOffice before `stripLinks`, so without the macOS sandbox they are refused. At most 2 conversions run at once; the rest wait. Each run has its own process group, which is SIGKILLed after 60 s, so a hung LibreOffice can't hold a slot. LibreOffice is a required system dependency (`brew install --cask libreoffice`).
- `src/anonymize.mjs`: `redact`, `findLeaks`, `toAgentPayload`, `anonymizeSubmission({ buffer, file, studentId }, roster)`, `isWeakOcr` (and re-exports `extractText` and `OCR_MIN_CONFIDENCE` from extract.mjs). Everything roster-derived is built once per roster by `build()` and cached: combined regexes (one pass per pattern kind, not per student) and hash indexes (a deletion index for fuzzy names, term-prefix sets for `findLeaks`), so cost per essay stays flat as the class grows (~4 ms for 8 or 300 students). Expensive patterns run only after a cheap check (a domain or "@" is present). Student text is untrusted, so every step must stay linear on hostile input: email and domain patterns start only at the start of a run, fuzzy lookups skip words longer than any name + 2, and the neighbor rule is one walk each way rather than a loop. A test covers each case that used to be quadratic or run out of memory. The submission views flag weak OCR so the student and teacher know it will be graded by hand.
- `src/grader-agent.mjs`: `gradeEssay(payload, { prompt, rubric, answerKey })`. Always runs on Sonnet (`GRADER_MODEL = "claude-sonnet-5"`, no env override); it throws if the result reports any other model. Each essay gets its own fresh, unsaved agent session.
- `public/` (teacher pages):
  - `index.html`: the Grade Center table, with Grade / Regrade on each row. "Grade all" skips final grades.
  - `submission.html`: the essay, rubric results, feedback, and what the agent saw.
  - `assignment.html`: the editor for the instructions, rubric and answer key.
  - `roster.html`: the roster editor (see Roster).
- `public/student.html?id=<studentId>`: the student page (linked from the "Student view" switcher). A "Teacher view: <name>" button in the top right returns to the Grade Center. It shows the instructions, rubric and answer-key questions, lets the student paste text or upload a file (text, Word, PDF, PowerPoint, or a photo/scan, up to 15 MB), and shows the grade once it is approved.
- Both submission views show an "Original | Extracted text" toggle (`renderSubmission` in `public/common.js`) and render grades with `renderResults`.
- `test/`: `node:test` tests for anonymization, extraction per format, output checks, and input validation. Tests use fixed fixtures (`test/fixtures/`) rather than the live, editable assignment, roster and submissions.
- `sample-data/`: the fictional class `data/` is seeded from. Never put real student data here.
- `scripts/make-samples.mjs`: regenerates `test/fixtures/` and converts three `sample-data/` submissions to .pdf/.pptx/.png.

# Commands
- `npm start`: run the dashboard
- `npm test`: run all tests
- `node scripts/make-samples.mjs`: rebuild fixtures (needs LibreOffice)

# Code Structure/Format
Write simple, concise code. Comment sparingly but clearly, and only when needed.



minize the load on an orchestrator agent. 
deterministic logic for failures / monitoring