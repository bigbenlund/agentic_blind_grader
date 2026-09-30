# Blind Essay Grader

A mock Grade Center where Claude agents suggest grades for student submissions without ever seeing who wrote them, based on a rubric/answer key. An agent is spawned for each assignment, respectively. All PII is redacted before an agent sees an assignment, and the teacher must review and approves every grade.

## Setup

Requires Node 20+ and LibreOffice (`brew install --cask libreoffice`).

```sh
npm install
npm start        # http://localhost:3000
npm test
```

On first run, `data/` is created from the fictional class in `sample-data/`. `data/` is git-ignored because it holds real student data once you use the app.

## Claude access

Grading runs through the Claude Agent SDK, which uses whatever Claude credentials are on your machine: your Claude Code login or an `ANTHROPIC_API_KEY` environment variable. No credentials are stored in this repo, and everyone who runs it uses their own.

## Security

- **Local use only.** There is no login. The server listens on 127.0.0.1 and refuses requests from other sites (Host and Origin checks). Don't expose it to a network or the internet.
- Uploads are untrusted: file signatures are checked, and there are limits on decompressed size, image size and page count. On macOS, LibreOffice runs in a sandbox with no network access. On other systems, legacy `.doc`/`.ppt` files are refused.

See `CLAUDE.md` for the full design, including how redaction works.
