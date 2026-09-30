// Turns a submission into the only thing the grading agent is allowed to see.
import { randomUUID } from "node:crypto";
import { extractText, OCR_MIN_CONFIDENCE } from "./extract.mjs";

export { extractText, OCR_MIN_CONFIDENCE };
export const REDACTED = "[REDACTED]";
const R = "\\[REDACTED\\]";
// The local part may already be "[REDACTED]" when a name pattern matched it first.
// Starts only where a run of local-part characters starts, so each run is scanned once, not once per character.
const EMAIL = /(?<![\p{L}\p{N}._%+\-\]])(?:\[REDACTED\]|[\p{L}\p{N}._%+-])+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const ID_LIKE = /(?<!\d)\d(?:[ .-]?\d){6,9}(?!\d)/g;
const TAIL = /\[REDACTED\][\p{L}\p{N}]+/gu; // the misread tail of an ID or name ("[REDACTED]b6")

// Text that can't be trusted (weak OCR) or is missing writing the student submitted (an unreadable photo).
export const isWeakOcr = (ocrConfidence, unreadableImages = 0) =>
  unreadableImages > 0 || (ocrConfidence !== null && ocrConfidence < OCR_MIN_CONFIDENCE);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalize = (s) =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ");
const squeeze = (s) => normalize(s).replace(/\s+/g, "");
// Folds common OCR confusions so "Kirn" compares as "Kim" and "A1varez" as "Alvarez".
// Memoized: an essay repeats the same words, and every rule folds them.
const folds = new Map();
function ocrFold(s) {
  let f = folds.get(s);
  if (f === undefined) {
    if (folds.size > 50000) folds.clear();
    f = squeeze(s).replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d").replace(/1/g, "l").replace(/0/g, "o").replace(/5/g, "s");
    folds.set(s, f);
  }
  return f;
}

const SEP = "[\\s.,_-]*"; // OCR and typing variants between name parts: "Grace Kim", "grace. kim", "Kim,Grace"
const bounded = (body, flags) => new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);
const apostrophes = (s) => s.replace(/'/g, "['’\\s]?"); // OCR may read the apostrophe as a space: "O Brien"
// Alternatives longest first, so "Maya Chen" wins over "Maya" at the same spot.
const union = (bodies) => `(?:${[...new Set(bodies)].sort((a, b) => b.length - a.length).join("|")})`;

// Name tolerant of spacing and straight/curly/missing apostrophes.
const nameBody = (name) => name.split(/[\s,]+/).map((p) => apostrophes(escape(p))).join(SEP);

// Email local part ("wturner", "grace.kim") that OCR may have split anywhere ("w turner", "grace. kim"),
// or spelled out ("grace dot kim").
const localBody = (local) => local.split(/[._-]+/)
  .map((seg) => [...seg].map(escape).join("[\\s.]?")).join(`(?:${SEP}|\\s*[([]?dot[)\\]]?\\s*)`);

// Characters OCR reads in place of each digit ("8OO1Z34b5").
const DIGIT_LOOKALIKES = { 0: "0OoDQ", 1: "1Ili|!", 2: "2Zz", 5: "5Ss", 6: "6bG", 8: "8B", 9: "9gq" };
// A roster student ID with any separators ("800,123,405", "(800) 123-405", "800|123]405") and OCR lookalikes.
const idBody = (id) => [...id].map((d) => `[${escape(DIGIT_LOOKALIKES[d] ?? d)}]`).join("[^\\p{L}\\p{N}\\n]{0,3}");

// Letters OCR commonly misreads in a domain ("stateu.eclu", "5tateu.edu").
const DOMAIN_LOOKALIKES = { m: "(?:m|rn)", d: "(?:d|cl)", w: "(?:w|vv)", l: "[l1i|]", i: "[il1|]", o: "[o0]", s: "[s5]" };
const LOCAL_WORD = "[\\p{L}\\p{N}_%+\\-\\[\\]]+";
const LOCAL = `${LOCAL_WORD}(?:(?:\\.\\s?|\\s+dot\\s+)${LOCAL_WORD})*`; // "grace.kirn", "grace. kirn", "maya dot chn"
const domainBody = (domain) => domain.toLowerCase().split(".")
  .map((label) => [...label].map((c) => DOMAIN_LOOKALIKES[c] ?? escape(c)).join(" ?"))
  .join("(?:\\s*(?:[.,]|[([]?dot[)\\]]?)\\s*|\\s+)");
// Whatever local part is attached to a school domain: by "@", "(at)", " at ", glued on, or a dotted name before it.
const DOMAIN_LOCAL = `(?:${LOCAL}(?:\\s*(?:@|[([]at[)\\]])\\s*|\\s+at\\s+)|${LOCAL_WORD}(?:(?:\\.\\s?|\\s+dot\\s+)${LOCAL_WORD})+\\s+|${LOCAL}[._]?|@\\s*)?`;

const fullNames = ({ firstName: f, lastName: l }) => [`${f} ${l}`, `${l}, ${f}`, `${l} ${f}`];
const localPart = (s) => s.email.split("@")[0];

// Optimal string alignment distance: insertions, deletions, substitutions, and swaps of adjacent letters ("Jordna").
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
// How far a word may be from a name and still count, where looser matching applies: longer names allow more.
const tier = (name) => (name.length >= 5 ? 2 : 1);
// The length check first: it's free, and it keeps a huge token out of the O(n·m) table.
const closeTo = (word, name) => Math.abs(word.length - name.length) <= tier(name) && editDistance(word, name) <= tier(name);

// Every string reachable by deleting up to `depth` letters. Two words within k edits share one (SymSpell),
// so fuzzy lookups are a few hash probes instead of a comparison against every roster name.
function deletions(word, depth) {
  const out = new Set([word]);
  let frontier = [word];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const w of frontier) {
      for (let i = 0; i < w.length; i++) {
        const v = w.slice(0, i) + w.slice(i + 1);
        if (!out.has(v)) out.add(v), next.push(v);
      }
    }
    frontier = next;
  }
  return out;
}

const addTo = (map, key, value) => (map.get(key) ?? map.set(key, []).get(key)).push(value);
const lengths = (map) => [...new Set([...map.keys()].map((k) => k.length))];

// Everything redact and findLeaks look up, built once per roster (students and the teacher, who has no student ID): combined patterns (one pass over the text per
// kind, not one per student) and hash indexes, so the cost per submission barely grows with class size.
function build(roster) {
  const parts = roster.flatMap((s) => [s.firstName, s.lastName]);
  const domains = [...new Set(roster.map((s) => s.email.split("@")[1].toLowerCase()))];
  const m = {
    fullAny: bounded(union(roster.map((s) => nameBody(`${s.firstName} ${s.lastName}`))), "giu"),
    comma: bounded(union(roster.map((s) => `${apostrophes(escape(s.lastName))}[\\s.]*,[\\s.]*${apostrophes(escape(s.firstName))}`)), "giu"),
    // "Last First" without a comma only when capitalized: lowercase it is ordinary prose ("a page turner will").
    lastFirst: bounded(union(roster.flatMap((s) => [`${s.lastName} ${s.firstName}`, `${s.lastName} ${s.firstName}`.toUpperCase()])
      .map(nameBody)), "gu"),
    local: bounded(union(roster.map((s) => localBody(localPart(s)))), "giu"),
    ids: new RegExp(`(?<!\\p{N})${union(roster.filter((s) => s.studentId).map((s) => idBody(s.studentId)))}(?!\\p{N})`, "gu"),
    // Starts only at the start of a run (not mid-word), for the same reason as EMAIL.
    domain: new RegExp(`(?<![\\p{L}\\p{N}_%+\\-\\[\\].@])${DOMAIN_LOCAL}${union(domains.map(domainBody))}`, "giu"),
    domainOnly: new RegExp(union(domains.map(domainBody)), "iu"), // cheap check before the full pattern
    bare: bounded(union(parts.flatMap((n) => [n, n.toUpperCase()]).map(nameBody)), "gu"),
    foldedDomains: domains.map((d) => ocrFold(d.replace(/\./g, ""))),
    names: new Set(parts.map(ocrFold)),
    surnames: new Set(roster.map((s) => ocrFold(s.lastName))),
    byPart: new Map(), // folded name part → [first, last] of each student who has it
    fuzzy: new Map(), // deletion variant → folded names
    owners: new Map(), // folded name → studentIds ("teacher" for the teacher)
    authors: new Map(),
    // findLeaks lookups, on normalize()d text
    anyTerms: new Map(), // any case: full names, emails, local parts
    capTerms: new Map(), // capitalized only: bare first and last names
    locals: new Map(), idSet: new Map(), merged: new Map(), longSurnames: new Map(),
  };
  for (const s of roster) {
    const id = s.studentId ?? "teacher";
    const [f, l] = [ocrFold(s.firstName), ocrFold(s.lastName)];
    addTo(m.byPart, f, [f, l]);
    if (l !== f) addTo(m.byPart, l, [f, l]);
    for (const n of [f, l]) {
      addTo(m.owners, n, id);
      for (const v of deletions(n, tier(n))) addTo(m.fuzzy, v, n);
    }
    const [F, L] = [s.firstName[0].toUpperCase(), s.lastName[0].toUpperCase()];
    if (s.studentId) m.authors.set(id, { parts: [f, l], initials: new RegExp(`(?<![\\p{L}])${escape(F)}\\.\\s?${escape(L)}\\.`, "gu") });

    for (const v of [s.email, localPart(s)]) addTo(m.anyTerms, normalize(v).trim(), { id, kind: "email" });
    for (const v of fullNames(s)) addTo(m.anyTerms, normalize(v).trim(), { id, kind: "name" });
    addTo(m.capTerms, normalize(s.firstName).trim(), { id, kind: "name", first: true });
    addTo(m.capTerms, normalize(s.lastName).trim(), { id, kind: "name" });
    if (squeeze(localPart(s)).length >= 5) addTo(m.locals, squeeze(localPart(s)), id);
    if (s.studentId) addTo(m.idSet, s.studentId, id);
    for (const n of [s.firstName + s.lastName, s.lastName + s.firstName]) if (squeeze(n).length >= 7) addTo(m.merged, squeeze(n), id);
    if (squeeze(s.lastName).length >= 6) addTo(m.longSurnames, squeeze(s.lastName), id);
  }
  for (const [k, v] of m.fuzzy) m.fuzzy.set(k, [...new Set(v)]);
  // Every leading run of words in a term ("grace", "grace kim", …) and every leading slice of a local part,
  // so scans extend a run only while it can still become a term.
  m.termPrefixes = new Set([...m.anyTerms.keys(), ...m.capTerms.keys()]
    .flatMap((t) => t.split(" ").map((_, i, words) => words.slice(0, i + 1).join(" "))));
  m.localPrefixes = new Set([...m.locals.keys()].flatMap((k) => [...k].map((_, i) => k.slice(0, i + 1))));
  // Run-together names indexed by their first 3 letters, so each text position costs one lookup.
  m.mergedByHead = new Map();
  for (const k of m.merged.keys()) addTo(m.mergedByHead, k.slice(0, 3), k);
  m.idLengths = lengths(m.idSet);
  m.maxNameLen = Math.max(0, ...[...m.names].map((n) => n.length));
  m.surnameLengths = lengths(m.longSurnames);
  return m;
}

const compiled = new Map();
function compile(roster) {
  const key = roster.map((s) => [s.studentId, s.firstName, s.lastName, s.email].join("\u0000")).join("\u0001");
  if (!compiled.has(key)) {
    compiled.set(key, build(roster));
    if (compiled.size > 8) compiled.delete(compiled.keys().next().value);
  }
  return compiled.get(key);
}

// Folded roster names within tier(name) edits of a word.
function nearNames(m, word) {
  const w = ocrFold(word);
  // A word more than 2 letters longer than every name can't be within 2 edits; skipping it also keeps a huge
  // token (OCR noise, a pasted blob) from generating millions of deletion variants.
  if (w.length < 2 || w.length > m.maxNameLen + 2) return [];
  const hits = new Set();
  for (const v of deletions(w, 2)) for (const n of m.fuzzy.get(v) ?? []) hits.add(n);
  return [...hits].filter((n) => editDistance(w, n) <= tier(n));
}

const WORD = /[\p{L}\p{N}'’]+/gu;
const startsUpper = (w) => /^[\p{Lu}\p{N}]/u.test(w);
const close = (word, name) => word === name || (name.length >= 4 && editDistance(word, name) <= 1);
// In a pair the other word already matched exactly, so a 3-letter name may be one letter off too ("Grace Kin", "Grace Km").
const closeInPair = (word, name) => close(word, name) || (name.length === 3 && word.length >= 2 && editDistance(word, name) <= 1);

// Replaces the given [start, end) ranges of text with REDACTED.
function redactRanges(text, ranges) {
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + REDACTED + text.slice(end);
  return text;
}

// A form label ("Name:", "Student ID:", "Email:", "By:", "Professor:") at a line start or after a separator in a form row
// ("Name: … | ID: …"). The value is an identifier whatever it says, so nicknames and misspellings go too.
// A label alone on its line ("Name:") takes a short next line as its value.
const LABEL = new RegExp("((?:^|[|;,][ \\t]*|[ \\t]{2,})[-–—•*]?[ \\t]*" +
  "(?:(?:student\\s+)?(?:name|id(?:\\s*(?:number|no\\.?|#))?|e-?mail)|student|author|(?:submitted|written|prepared)\\s+by|by|" +
  "instructor|professor|teacher|prof\\.?)" +
  "[ \\t]*:[ \\t]*)([^\\n]*)", "iu");
const countWords = (line) => (line.match(/[\p{L}\p{N}]+/gu) ?? []).length;

function redactLabels(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(LABEL);
    if (!match) continue;
    if (match[2].trim()) lines[i] = lines[i].slice(0, match.index) + match[1] + REDACTED;
    else if (i + 1 < lines.length && lines[i + 1].trim() && countWords(lines[i + 1]) <= 4) lines[++i] = REDACTED;
  }
  return lines.join("\n");
}

// Two adjacent words on one line are a name when one is exactly a roster student's first or last name
// (after OCR folding) and the other is within one letter of that same student's other name part:
// "Jordon Alvarez", "maya chan", "Kim, Grase", "Mohammad, Aisha". Both words must share casing, so
// "Maya then said" is safe, and a misread surname before the first name needs the comma that order is
// written with, so "When Maya" is safe. "Then Jordan" never matches: "Then" isn't close to "Alvarez".
// All-lowercase pairs are ordinary prose far more often ("page turner will", "chen may"), so they only count
// in first-last order with an exact first name: "maya chan", "grace kirn".
function redactPairs(text, m) {
  const words = [...text.matchAll(WORD)];
  const ranges = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const [a, b] = [words[i], words[i + 1]];
    const [fa, fb] = [ocrFold(a[0]), ocrFold(b[0])];
    const candidates = [...(m.byPart.get(fa) ?? []), ...(m.byPart.get(fb) ?? [])];
    if (!candidates.length) continue;
    const gap = text.slice(a.index + a[0].length, b.index);
    const comma = /^[ \t]*,[ \t]*$/.test(gap);
    if ((!comma && !/^[ \t]+$/.test(gap)) || startsUpper(a[0]) !== startsUpper(b[0])) continue;
    const upper = startsUpper(a[0]);
    const isPair = candidates.some(([f, l]) => upper
      ? (!comma && fa === f && closeInPair(fb, l)) || (!comma && closeInPair(fa, f) && fb === l) ||
        (fa === l && closeInPair(fb, f)) || (comma && closeInPair(fa, l) && fb === f)
      : !comma && fa === f && closeInPair(fb, l));
    if (isPair) ranges.push([a.index, b.index + b[0].length]), i++;
  }
  return redactRanges(text, ranges);
}

// A capitalized word that is a roster name once OCR confusions are folded: "Kirn", "0'Brien", "A1varez".
const redactFoldedNames = (text, m) => text.replace(WORD, (w) => (startsUpper(w) && m.names.has(ocrFold(w)) ? REDACTED : w));

// Lines where identifiers cluster and prose is rare: the header block (short lines before the first long one,
// up to 6), the signature block (short lines at the end, up to 3), and any line of 3 words or fewer (headings,
// running headers like "Kim 2", captions). A wrongly redacted word there costs the grade almost nothing.
function zoneLines(lines) {
  const zone = new Set();
  const run = (order, cap) => {
    let n = 0;
    for (const i of order) {
      if (!lines[i].trim()) continue;
      if (countWords(lines[i]) > 7 || n++ >= cap) break;
      zone.add(i);
    }
  };
  run([...lines.keys()], 6);
  run([...lines.keys()].reverse(), 3);
  lines.forEach((line, i) => countWords(line) <= 3 && zone.add(i));
  return zone;
}

const BYLINE = /^([ \t]*(?:(?:submitted|written|prepared)\s+)?by\s+)(\S.*)$/iu;
// In zones: a byline's value, and any word, in any case, within tier(name) edits of a roster name
// ("Mava Chan", "Aisha Muhammad", "Grace\nKin", "Jordie Alvarex").
function redactZones(text, m) {
  const lines = text.split("\n");
  const zone = zoneLines(lines);
  return lines.map((line, i) => (!zone.has(i) ? line : line.replace(BYLINE, `$1${REDACTED}`)
    .replace(WORD, (w) => (w !== "REDACTED" && nearNames(m, w).length ? REDACTED : w)))).join("\n");
}

// A capitalized word mid-sentence (not after . ! ? : or at a line start, where ordinary words are capitalized).
const MID_CAP = /(?<=[\p{L}\p{N},;)'’”"][ \t]+)\p{Lu}[\p{L}\p{N}'’]*/gu;
const CALENDAR = new Set(["may", "june", "july", "march", "april", "august", "monday", "friday", "sunday"]);

// The author's own name is the likeliest identifier, so it gets looser matching everywhere: their initials
// ("M.C.") and a capitalized mid-sentence word within tier(name) edits of their name ("As Llam O'Brlen argued").
function redactAuthor(text, m, author) {
  const a = author && m.authors.get(author);
  if (!a) return text;
  return text.replace(a.initials, REDACTED).replace(MID_CAP, (w) => {
    const f = ocrFold(w);
    return !CALENDAR.has(f) && a.parts.some((n) => closeTo(f, n)) ? REDACTED : w;
  });
}

const NEIGHBOR = /\[REDACTED\]|\p{Lu}\.|[\p{L}\p{N}'’]+/gu; // a redaction, an initial ("G."), or a word
const isInitial = (t) => /^\p{Lu}\.$/u.test(t);

// Backstop next to a redaction, on the same line: a word right before it that is exactly a roster name
// ("grace [REDACTED]" from an OCR-split email), a capitalized word right after it close to a roster surname
// ("[REDACTED] Chan", "[REDACTED] Muhammad"), and initials on either side ("G. [REDACTED]", "[REDACTED] O.B.").
// A name header followed by "When cars leave…" on the next line is left alone.
// One walk right to left extends redactions leftward and one left to right extends them rightward, so a chain
// ("A. B. grace [REDACTED]") goes in a single pass. Neither walk can create work for the other: a new redaction
// on the left sits next to the one that caused it, and so does one on the right.
function redactNeighbors(text, m) {
  return text.split("\n").map((line) => {
    const toks = [...line.matchAll(NEIGHBOR)].map((t) => ({ text: t[0], start: t.index, end: t.index + t[0].length }));
    const gap = (i) => line.slice(toks[i].end, toks[i + 1].start);
    const redacted = (t) => t.hit || t.text === REDACTED;
    for (let i = toks.length - 2; i >= 0; i--) {
      const t = toks[i];
      if (!redacted(toks[i + 1]) || redacted(t)) continue;
      t.hit = isInitial(t.text)
        ? /^[ \t]*$/.test(gap(i)) && !/[\p{L}\p{N}.]$/u.test(line.slice(0, t.start)) // not "U.S."
        : /^[ \t,]+$/.test(gap(i)) && m.names.has(ocrFold(t.text));
    }
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (!redacted(toks[i - 1]) || redacted(t)) continue;
      t.hit = isInitial(t.text)
        ? /^[ \t]*$/.test(gap(i - 1))
        : /^[ \t,]+$/.test(gap(i - 1)) && startsUpper(t.text) && nearNames(m, t.text).some((n) => m.surnames.has(n));
    }
    return redactRanges(line, toks.filter((t) => t.hit).map((t) => [t.start, t.end]));
  }).join("\n");
}

// Redacts every roster student's identifiers (not just the author's: essays mention classmates).
// Full names match in any case; a bare first/last name only when capitalized, so "you will" survives for "Will".
// Names and email local parts go first, so an OCR-split email ("grace kim@…") loses both halves.
// author (a studentId) gets looser matching of their own name; see redactAuthor.
export function redact(text, roster, { author } = {}) {
  const m = compile(roster);
  let out = redactLabels(text.normalize("NFKC")); // fullwidth digits and letters become ASCII
  for (const pattern of [m.fullAny, m.comma, m.lastFirst, m.local, m.ids]) out = out.replace(pattern, REDACTED);
  // After local parts, so an exact one already redacted ("[REDACTED] at stateu dot edu") is taken with its domain.
  if (m.domainOnly.test(out)) out = out.replace(m.domain, REDACTED);
  out = redactPairs(out, m);
  if (out.includes("@")) out = out.replace(EMAIL, REDACTED);
  out = out.replace(ID_LIKE, REDACTED).replace(TAIL, REDACTED)
    .replace(m.bare, REDACTED);
  out = redactZones(redactAuthor(redactFoldedNames(out, m), m, author), m);
  // One marker per name, so the agent can't count its words.
  return redactNeighbors(out, m).replace(/\[REDACTED\](?:[ \t]*\[REDACTED\])+/g, REDACTED);
}

const FOLD = Object.fromEntries(Object.entries(DIGIT_LOOKALIKES).flatMap(([d, cs]) => [...cs].map((c) => [c, d])));
const LOOKS = escape(Object.values(DIGIT_LOOKALIKES).join("") + "3471");
const ID_RUN = new RegExp(`[${LOOKS}](?:[^\\p{L}\\p{N}\\n]{0,3}[${LOOKS}])*`, "gu");
const CAP_WORD = /\p{Lu}[\p{L}\p{M}'’]*/gu;

// Runs of consecutive tokens that are terms, extended only while they're still a term's leading words.
function* termRuns(tokens, terms, prefixes, join = " ") {
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i, run = tokens[i]; prefixes.has(run); run += join + tokens[++j]) {
      for (const t of terms.get(run) ?? []) yield t;
      if (j + 1 >= tokens.length) break;
    }
  }
}
// Every substring of s with one of the given lengths.
function* windows(s, lens) {
  for (const len of lens) for (let i = 0; i + len <= s.length; i++) yield s.slice(i, i + len);
}

// Independent second pass using a different method than redact(): it normalizes the text (accents, case,
// punctuation) and looks up word runs in hash sets. Any hit means "do not send".
// firstNames: false skips bare first names ("Will", "Grace") when scanning agent output, where they are ordinary words.
// zones (defaults to firstNames) applies the looser header/short-line check; author applies the looser author check.
export function findLeaks(text, roster, { firstNames = true, zones = firstNames, author } = {}) {
  const m = compile(roster);
  const found = new Map();
  const leak = (studentId, kind) => found.set(`${studentId}|${kind}`, { studentId, kind });
  const tokens = normalize(text).trim().split(" ").filter(Boolean);

  for (const t of termRuns(tokens, m.anyTerms, m.termPrefixes)) leak(t.id, t.kind);
  const capitals = normalize((text.match(CAP_WORD) ?? []).join(" ")).trim().split(" ").filter(Boolean);
  for (const t of termRuns(capitals, m.capTerms, m.termPrefixes)) if (firstNames || !t.first) leak(t.id, t.kind);

  // Runs of digits and OCR lookalikes, joined across any short separator ("800,123,4O5", "(800) 123-405"),
  // count when they already hold 3+ real digits. "|" and "!" may be a separator or a misread 1, so both readings count.
  const fold = (run, bars) => [...run].map((c) => (/\p{L}/u.test(c) || bars ? FOLD[c] ?? c : c)).join("").replace(/\D/g, "");
  for (const [run] of text.normalize("NFKC").matchAll(ID_RUN)) {
    if ((run.match(/\d/g) ?? []).length < 3) continue;
    for (const digits of [fold(run, false), fold(run, true)]) {
      for (const w of windows(digits, m.idLengths)) for (const id of m.idSet.get(w) ?? []) leak(id, "studentId");
    }
  }

  // An email local part spread over whole adjacent words ("w turner", "grace. kim"), never inside a word ("in brooks").
  const words = tokens.filter((t) => t !== "dot"); // "grace dot kim"
  for (const id of termRuns(words, m.locals, m.localPrefixes, "")) leak(id, "email");
  // Names OCR ran together: "PhotobyMayaChen".
  const squeezed = tokens.join("");
  for (let i = 0; i + 3 <= squeezed.length; i++) {
    for (const k of m.mergedByHead.get(squeezed.slice(i, i + 3)) ?? []) {
      if (squeezed.startsWith(k, i)) for (const id of m.merged.get(k)) leak(id, "name");
    }
  }
  // A long surname with a word glued on: "Alvarezand", "JorddrAlvarez".
  for (const w of (text.match(CAP_WORD) ?? []).map(squeeze)) {
    for (const len of m.surnameLengths) {
      if (w.length <= len) continue;
      for (const id of [...(m.longSurnames.get(w.slice(0, len)) ?? []), ...(m.longSurnames.get(w.slice(-len)) ?? [])]) leak(id, "name");
    }
  }
  // Any trace of a school email domain, however split or misread: "stateu dot edu", "stateu.eclu".
  const foldedText = ocrFold(words.join(" "));
  if (m.foldedDomains.some((d) => foldedText.includes(d)) || (text.includes("@") && text.search(EMAIL) !== -1)) leak(null, "email");

  if (zones) {
    const lines = text.split("\n");
    for (const i of zoneLines(lines)) {
      for (const [w] of lines[i].matchAll(WORD)) {
        if (w === "REDACTED") continue;
        for (const n of nearNames(m, w)) for (const id of m.owners.get(n)) leak(id, "name");
      }
    }
  }
  const a = author && m.authors.get(author);
  if (a) {
    for (const [w] of text.matchAll(MID_CAP)) {
      const f = ocrFold(w);
      if (!CALENDAR.has(f) && a.parts.some((n) => closeTo(f, n))) leak(author, "name");
    }
  }
  return [...found.values()];
}

// The allowlist. Nothing outside these two fields can reach the agent.
export function toAgentPayload({ token, text }) {
  for (const [k, v] of Object.entries({ token, text })) {
    if (typeof v !== "string" || !v) throw new Error(`payload field ${k} must be a non-empty string`);
  }
  return Object.freeze({ token, text });
}

const skippedImagesNote = (n) =>
  `${n} image(s) couldn't be read and were left out of what the agent graded. Check the original.`;

// studentId is the author, whose own name gets looser matching. It never reaches the agent.
export async function anonymizeSubmission({ buffer, file, studentId }, roster) {
  const extracted = await extractText(buffer, file);
  if (extracted.unreadableImages) {
    return { manual: `${extracted.unreadableImages} photographed passage(s) couldn't be read confidently; not sent to the agent.` };
  }
  if (isWeakOcr(extracted.ocrConfidence)) {
    return { manual: `Text was read by OCR with low confidence (${Math.round(extracted.ocrConfidence)}%); not sent to the agent.` };
  }
  const text = redact(extracted.text, roster, { author: studentId });
  const leaks = findLeaks(text, roster, { author: studentId });
  if (leaks.length) return { leaks };
  const payload = toAgentPayload({ token: randomUUID(), text });
  const { skippedImages } = extracted;
  return skippedImages ? { payload, note: skippedImagesNote(skippedImages) } : { payload };
}
