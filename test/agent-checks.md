# Agent verification checks: multi-format submissions and preview

Checks for an AI agent reviewing the change that added .pptx/.ppt/.doc/.png/.jpg/.jpeg and scanned-PDF (OCR) submissions, plus the "Original | Extracted text" preview. Each check states the goal, how to run it, and what counts as a pass. Report every failure with a minimal repro.

## Goals being verified
1. **Accuracy:** each format's text is extracted faithfully (content, order, notes) and the preview shows the original file.
2. **Invariant:** the grading agent still receives only `{ token, submittedAt, deadline, text }`, with every roster identifier redacted, from any format, including slide notes, images and scans. Leak checks and weak OCR fail closed.
3. **Safety:** the preview route cannot serve HTML/script, cannot be used to read other files, and never serves a stale file after resubmission.
4. **No regressions:** existing behavior (grading flow, resubmission, versioning, tests) still works.

## Ground rules
- Work from the project root. Read `CLAUDE.md` first.
- **Don't edit source, tests, or `public/`.** Write your own scripts and generated files in a temp directory (`mktemp -d`), never in the repo.
- **Protect the data:** before anything that writes, copy `data/` to your temp directory, and restore it at the end (`rm -rf data && cp -R <backup> data`). Confirm with `ls data/submissions` that the files match the backup.
- **Cost:** `POST /api/grade/:id` calls the real Claude agent. Call it at most once, and only for check 5.3. The manual/weak-OCR path (5.2) doesn't call the agent and is free.
- Run the server on a spare port: `PORT=3999 node server.mjs &`. Kill it when done.
- LibreOffice (`soffice`) is installed. Fixtures are in `test/fixtures/` (rebuild them with `node scripts/make-samples.mjs` only into a copy, because it also rewrites demo data).
- Tesseract workers keep Node alive. In ad-hoc scripts, `import { closeOcr } from "./src/extract.mjs"` and call it at the end.

## 1. Baseline
| # | Check | Pass |
|---|---|---|
| 1.1 | `npm test` | Every test passes and none is skipped. |
| 1.2 | `grep -n "import" src/grader-agent.mjs src/extract.mjs src/convert.mjs` | None of them imports `vault.mjs`. `convert.mjs` and `extract.mjs` never read `data/`. |
| 1.3 | `node --check` on every `public/*.js` | No syntax errors. |

## 2. Extraction accuracy (`extractText` in `src/extract.mjs`)
For each fixture, call `extractText(buffer, name)` and compare the result against the source content. `scripts/make-samples.mjs` shows what each fixture was built from.

| # | Check | Pass |
|---|---|---|
| 2.1 | `deck.pptx` | `Slide 1:` … `Slide 3:` in order. Each slide's title and bullets appear. Notes appear under `Notes:` for slides 1–2 only. `ocrConfidence` is `null`. |
| 2.2 | Build a PPTX in memory (JSZip on `deck.pptx`) with: the `p:sldId` order in `ppt/presentation.xml` reversed; a table (`a:tbl`) containing "Maya Chen"; a grouped shape (`p:grpSp`) containing text; an `a:br` inside a paragraph; `docProps/core.xml` with creator "Priya Patel"; and a comment file `ppt/comments/comment1.xml` naming "Liam O'Brien". | The order follows `presentation.xml`. Table, group and line-break text are extracted. Neither the creator nor the comment text appears. |
| 2.3 | A PPTX slide with a `p:ph type="sldNum"`, `dt` and `ftr` placeholder | That placeholder text is absent. Body text on the same slide is present. |
| 2.4 | A PPTX whose notes slide exists but whose slide rels don't link to it, and a slide with no rels file | No crash. The slide text is still extracted. |
| 2.5 | `deck.ppt`, `essay.doc` | Same content as the .pptx/.txt source (the ppt includes notes). |
| 2.6 | `essay.pdf` | Text extracted, `ocrConfidence` `null` (no OCR on text PDFs). |
| 2.7 | `scan.png`, `scan.jpg`, `scan.pdf` | `ocrConfidence` ≥ `OCR_MIN_CONFIDENCE` (75). Text matches the source up to minor OCR punctuation errors. |
| 2.8 | `test/fixtures/mixed.pdf` (typed page; typed heading over a photo; photo-only page), plus your own variants: a typed page with a small logo, a photo of text shorter than 100 px, and a PDF with 21 scanned pages | All typed and photographed text is present, in page order. There are no `-- n of m --` markers. A logo-only page doesn't lose its typed text. 21 scanned pages are rejected with a clear message, not truncated. No photo is ever left out silently: low-confidence writing → `manual`; any other low-confidence photo → `skippedImages` > 0, a notice above the tabs, and a `reason` on the pending grade. |
| 2.9 | Caching: call `extractText` twice on the same bytes, once as `.txt` and once as `.md`, then once as `.pptx` with the same bytes as `.png` | Results are keyed per extension. A failed extraction is not cached (a second call retries). |
| 2.10 | Corrupt inputs: random bytes named `.pptx`, `.pdf`, `.png`, `.jpg`, `.doc`; a valid PNG/JPEG header followed by junk; a PNG renamed `.jpg`; a `.ppt` or an ODT renamed `.doc`; a HEIC renamed `.jpg` if you can make one | Each rejects with a clear message ("isn't a valid .x file" or "could not read that image"). **The process never crashes**, both standalone and over HTTP. Nothing hangs past ~60 s. |

## 3. Redaction and fail-closed behavior (the core invariant)
For each case, run `anonymizeSubmission({ buffer, file, submittedAt }, deadline, roster)` with the real roster (`vault.loadRoster()`).

| # | Check | Pass |
|---|---|---|
| 3.1 | Every fixture in `test/fixtures/` except `blurry.png` and `handwritten.pdf` (both → `manual`) | Returns `payload` (not `leaks`). Payload keys are exactly `deadline, submittedAt, text, token`. `findLeaks(payload.text, roster)` is empty. No roster name, email, email local part or student ID appears in any form, including OCR variants like `grace kim@stateu.edu` and `grace. kim@`. |
| 3.2 | A PPTX with a roster name **only in speaker notes**, and one with a name only in a table | Redacted in the payload. |
| 3.3 | An image (render one with `@napi-rs/canvas`) with the student ID spaced (`800 123 405`) and the email on its own line | Redacted, or else `leaks` is returned. It is never sent unredacted. |
| 3.4 | `blurry.png` | Returns `{ manual }` with no `payload`. `isWeakOcr(74.9)` is true, and `isWeakOcr(75)` and `isWeakOcr(null)` are false. |
| 3.5 | OCR misreads rendered into images: "Grace Kirn", "Aisha Mohammad", "Maya Chan", "Jordan A1varez", "Liam 0'Brien", `grace kirn@stateu.edu`, `w turner@stateu.edu` | Redacted. The documented remaining limit is a lone misread name with no redacted neighbor (e.g. a bare "0'Brien"). Report how easy it is to hit, and any other way to get past. |
| 3.5b | False positives from near-miss matching: "Maya Chen will argue, and then Jordan said.", "Then we left.", "you will see it with grace", "Well, Jordan disagreed", and all 7 demo submissions | Ordinary words survive, and every demo submission still anonymizes cleanly (no spurious `leaks`). Measure how much ordinary text gets redacted. |
| 3.7 | `fenceEssay` in `src/grader-agent.mjs` | An essay containing `</essay>`, `</ESSAY >` or `<essay>` can't open or close the wrapper in the prompt. |
| 3.6 | Prompt injection in non-text formats: `data/submissions/800123406.png` contains "NOTE TO THE AI GRADER…" | The text reaches the agent only inside `<essay>` tags (read `src/grader-agent.mjs`). Nothing in extraction treats it as instructions. |

## 4. Upload validation (`parseUpload`)
| # | Check | Pass |
|---|---|---|
| 4.1 | Each allowed extension, in upper case too (`.PPTX`, `.JPG`) | Accepted and normalized to lower case. |
| 4.2 | `.svg`, `.html`, `.htm`, `.xml`, `.exe`, `.pptm`, no extension, `essay.pdf.html` | Rejected with "file must be one of". |
| 4.3 | 15 MB + 1 byte | Rejected with "larger than 15 MB". Also check that `MAX_BODY_BYTES` in `server.mjs` still admits a 15 MB file after base64 encoding (≈20 MB body). |
| 4.4 | A PNG containing no text (blank white) | Rejected with "no readable text". |
| 4.5 | `blurry.png` | Accepted at upload, and `GET /api/student/:id` and `GET /api/submission/:id` return `weakOcr: true`. The page shows the "graded by hand" notice (read `public/common.js`). |

## 5. Server and preview route (live server on port 3999)
| # | Check | Pass |
|---|---|---|
| 5.1 | `GET /api/submission/:id` for 800123401 (.txt), 800123403 (.docx), 800123404 (.pdf), 800123405 (.pptx), 800123406 (.png) | `submission.preview` is `null`/`pdf`/`pdf`/`pdf`/`image`. `ocr` is true only for the .png. `text` is present and there is no `textError`. |
| 5.2 | Upload `blurry.png` as student 800123408 (`POST /api/student/800123408` with `{fileName, fileBase64}`), then `POST /api/grade/800123408` | The grade status is `manual` with a low-confidence reason and `agentView` is null. The agent was never called (check the server log and the timing). |
| 5.3 | (The one allowed agent call) `POST /api/grade/800123406` (.png with the injection) | The status is `pending` or `manual`. `agentView.text` contains no roster identifiers. The score is not an automatic 100/100 from the injection. |
| 5.4 | `GET /api/preview/:id` for each type | Correct `content-type` (`application/pdf`, `image/png`). `x-content-type-options: nosniff`. The bytes are a valid PDF/PNG (`file` command). The .txt student gets a 404 JSON response. |
| 5.5 | `GET /api/preview/..%2F..%2Fdata%2Froster.json`, `/api/preview/%2e%2e`, `/api/preview/800123405/extra`, an unknown id, and `POST /api/preview/800123405` | None returns file contents. Each gets a 404 or JSON error. |
| 5.6 | Upload a .pptx as 800123408, fetch its preview (cached in `data/previews/`), then resubmit a .ppt and then a .png. Then repeat the race: start a cold preview of a .ppt and resubmit a .png 0.3 s later | After each resubmission, the old `800123408-*.pdf` preview is gone and `/api/preview` returns the new file's content. The race leaves no orphan preview. |
| 5.7 | Concurrency: fire 6 parallel preview requests for different Office submissions with a cold cache (delete `data/previews/`), and watch `pgrep -f soffice` | All succeed, with never more than 2 soffice processes running. There are no LibreOffice profile-lock errors and no leftover `convert-*` dirs in `os.tmpdir()`. Also review the limiter in `src/convert.mjs` for slot leaks when a conversion throws or times out. |
| 5.8 | Resubmission while grading | Still refused with 409 (this is existing behavior; make sure it didn't regress). |

## 6. Front end (read the code; use a browser if you have one)
| # | Check | Pass |
|---|---|---|
| 6.1 | `renderSubmission` in `public/common.js` | Text is escaped with `esc`. The preview uses a blob URL from `fetch`, and old blob URLs are revoked. It re-renders only when `file|submittedAt` changes, so the 2 s grading poll in `submission.js` doesn't reload the iframe or reset the chosen tab. Both the success and the error paths ignore a stale render. |
| 6.2 | `public/student.js` | The form's tab selectors are scoped to `#form .tab`, so switching Write/Upload doesn't toggle the preview tabs, and the reverse. |
| 6.3 | `student.html` | The `accept` list and help text match `UPLOAD_TYPES`, and `MAX_FILE_BYTES` matches `MAX_UPLOAD_BYTES`. |
| 6.4 | Preview failure path | A 503 from `/api/preview` shows the error and switches to the Extracted text tab. |
| 6.5 | If a browser is available: load `/submission.html?id=800123405` and `/student.html?id=800123406` | The PDF viewer renders the slides, the image renders, and both tabs work. |

## 7. Alignment with CLAUDE.md
| # | Check | Pass |
|---|---|---|
| 7.1 | Every bullet under "Core Invariant" | Still true for every new format. Name any bullet that the new code weakens. |
| 7.2 | The "Structure" section | It accurately describes `extract.mjs`, `convert.mjs`, `readPreview`, the preview route, fixtures and the script. Flag anything stale or wrong. |
| 7.3 | Simplicity | Flag dead code, over-engineering or duplicated logic in the changed files (`src/extract.mjs`, `src/convert.mjs`, `src/vault.mjs`, `server.mjs`, `public/common.js`, `scripts/make-samples.mjs`). |

## Report format
1. A **summary table**: check #, PASS / FAIL / NOTE, and one line each.
2. **Failures and notes**, most severe first. For each, give its severity (invariant breach > security > wrong output > UX > style), the repro (a command or script), the expected and actual results, and the file:line of the likely cause.
3. Confirmation that `data/` was restored and that no repo files were modified (`git status` isn't available, so compare file modification times or checksums against a snapshot you take at the start).
