#!/usr/bin/env node
// scripts/extract_old_writing_keys.mjs
//
// Session 18A — positional-format extractor for the 8 SAT Old Writing
// PT answer keys. These PDFs use the legacy SAT QAS grid layout
// (`1B 2B 3C 4A ...`) rather than the modern CBQB `Question ID {hex}`
// header format that scripts/extract_answer_keys.mjs expects.
//
// What this script does:
//   1. Walks the local OneDrive Old Writing directory and finds each
//      "PT N Writing Answer Key PDF.pdf" or "April 2019 Answer Key.pdf".
//   2. Runs `pdftotext -layout` and pulls the positional answer grid
//      from the page-2 "Writing and Language Test Answers" section.
//   3. Synthesizes question IDs (`oldwriting-pt{n}-q{NN}` /
//      `oldwriting-april2019-q{NN}`) so they never collide with CBQB
//      hex IDs in the existing questionKeys collection.
//   4. Writes the catalog `questionIds` array + `answerFormat` and
//      emits a `questionKeys` JSON file ready for upload.
//   5. Dry-run by default. `--commit-catalog` rewrites
//      worksheets_catalog.json. `--commit-keys` uploads questionKeys to
//      Firestore via the Admin SDK (requires GOOGLE_APPLICATION_CREDENTIALS
//      or ADC).

import { readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CATALOG_PATH = join(REPO_ROOT, "worksheets_catalog.json");
const OUTPUT_PATH = join(__dirname, "old_writing_keys.json");

// Where to look for the source PDFs. The script will fall through these
// candidates in order — first hit wins.
const ROOT_CANDIDATES = [
  "C:\\Users\\aidan\\OneDrive\\Desktop\\Affordable Tutoring Solutions Inc\\Official Worksheets & Resources\\!SAT Test Banks\\I. Reading Section\\IV. Standard English Conventions\\Old Writing Sections",
  "/Users/kiranshay/Library/CloudStorage/OneDrive-Personal/Desktop/Affordable Tutoring Solutions Inc/Official Worksheets & Resources/!SAT Test Banks/I. Reading Section/IV. Standard English Conventions/Old Writing Sections",
];

const argv = process.argv.slice(2);
const isCommitCatalog = argv.includes("--commit-catalog");
const isCommitKeys = argv.includes("--commit-keys");

// (catalogTitle, sourcePdfBasename, questionIdPrefix)
const ENTRIES = [
  ["Old Writing - April 2019 QAS (44Qs)", "April 2019 Answer Key.pdf",       "oldwriting-april2019"],
  ["Old Writing - PT #1 (44Qs)",          "PT1 Writing Answer Key PDF.pdf",  "oldwriting-pt1"],
  ["Old Writing - PT #2 (44Qs)",          "PT2 Writing Answer Key PDF.pdf",  "oldwriting-pt2"],
  ["Old Writing - PT #4 (44Qs)",          "PT4 Writing Answer Key PDF.pdf",  "oldwriting-pt4"],
  ["Old Writing - PT #5 (44Qs)",          "PT5 Writing Answer Key PDF.pdf",  "oldwriting-pt5"],
  ["Old Writing - PT #6 (44Qs)",          "PT6 Writing Answer Key PDF.pdf",  "oldwriting-pt6"],
  ["Old Writing - PT #7 (44Qs)",          "PT7 Writing Answer Key PDF.pdf",  "oldwriting-pt7"],
  ["Old Writing - PT #8 (44Qs)",          "PT8 Writing Answer Key PDF.pdf",  "oldwriting-pt8"],
];

const EXPECTED_QS = 44;

function pickRoot() {
  for (const r of ROOT_CANDIDATES) {
    try {
      const st = statSync(r);
      if (st.isDirectory()) return r;
    } catch {}
  }
  return null;
}

function extractWritingAnswers(pdfPath) {
  const r = spawnSync("pdftotext", ["-layout", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { error: `pdftotext exit ${r.status}: ${(r.stderr || "").slice(0, 200)}` };
  }
  const text = r.stdout;

  // The QAS grid lists Reading + Writing in two side-by-side columns.
  // Per-line shape: ` 1B   12 B    23 D  34 C   45 D    1D   12 B   23 D  34 A`
  // We want the Writing answers (right half) which are 1..44.
  //
  // Strategy: scan every line, find tokens of the shape `NN L` or `NN  L`
  // where L ∈ A..D. Build a map of {questionNumber -> letter}. The same
  // question number may appear twice (once in reading, once in writing) so
  // we use the column position to disambiguate — but for this purpose
  // it's enough to grab the LAST occurrence of each `N` on each line
  // (writing is always to the right of reading in the layout).
  //
  // Then validate we got exactly 44 question→letter pairs. If not, fall
  // back to a stricter pattern.

  // \s* (not \s+) — pdftotext renders single-digit answers as "1B"
  // (no space) and two-digit as "12 B" (with space). Need to match both.
  const pairsRe = /(\d{1,2})\s*([A-D])\b/g;
  // Pull from the page that contains the WRITING section header.
  const writingIdx = text.search(/Writing and Language Test Answers/i);
  let scope = text;
  if (writingIdx >= 0) {
    // Limit to a few pages after the header so we don't accidentally
    // pick up later score-conversion tables that also contain
    // "N letter" pairs.
    scope = text.slice(writingIdx, writingIdx + 12_000);
  }

  // Walk line by line, picking the rightmost (N, letter) pair on each line.
  // The reading column ends and writing column begins — last token wins.
  const byQ = new Map();
  const lines = scope.split(/\r?\n/);
  for (const line of lines) {
    // Reset regex state per line
    let m;
    const local = [];
    while ((m = pairsRe.exec(line)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= EXPECTED_QS) local.push({ n, letter: m[2] });
    }
    pairsRe.lastIndex = 0; // reset for the next line
    if (local.length === 0) continue;
    // Heuristic: the rightmost pair on the line is the writing column entry
    // when the line has both reading + writing answers. Some lines may
    // contain only writing (e.g. the page-2 right-side block).
    // We'll take the last 1-2 numeric tokens.
    // Simpler + correct enough: register every (n,letter) on the line; if
    // the same n is seen on multiple lines, the later line wins.
    for (const p of local) byQ.set(p.n, p.letter);
  }

  if (byQ.size < EXPECTED_QS) {
    return { error: `parsed ${byQ.size}/${EXPECTED_QS} answers` };
  }

  // Emit in question order 1..44.
  const answers = [];
  for (let q = 1; q <= EXPECTED_QS; q++) {
    const letter = byQ.get(q);
    if (!letter) return { error: `missing answer for Q${q}` };
    answers.push({ q, correctAnswer: letter });
  }
  return { answers };
}

function main() {
  console.log(`[oldwriting-extract] mode=${isCommitCatalog || isCommitKeys ? "COMMIT" : "DRY-RUN"}`);
  if (isCommitCatalog) console.log("[oldwriting-extract]   --commit-catalog: will rewrite worksheets_catalog.json");
  if (isCommitKeys)    console.log("[oldwriting-extract]   --commit-keys: will write questionKeys/{id} to Firestore");

  const root = pickRoot();
  if (!root) {
    console.error("[oldwriting-extract] could not find Old Writing source folder. Update ROOT_CANDIDATES.");
    process.exit(1);
  }
  console.log(`[oldwriting-extract] source root: ${root}`);

  const results = [];
  for (const [title, fname, idPrefix] of ENTRIES) {
    const pdfPath = join(root, fname);
    let st;
    try { st = statSync(pdfPath); } catch { st = null; }
    if (!st) {
      console.warn(`  - ${title.padEnd(40)} | MISSING (${fname})`);
      results.push({ title, idPrefix, fname, error: "file-not-found", answers: null });
      continue;
    }
    const ex = extractWritingAnswers(pdfPath);
    if (ex.error) {
      console.warn(`  - ${title.padEnd(40)} | FAILED: ${ex.error}`);
      results.push({ title, idPrefix, fname, error: ex.error, answers: null });
      continue;
    }
    console.log(`  - ${title.padEnd(40)} | ${ex.answers.length}/44 answers`);
    results.push({ title, idPrefix, fname, error: null, answers: ex.answers });
  }

  // Build the questionKeys + catalog mutations.
  const questionKeyDocs = []; // {id, correctAnswer}
  const catalogUpdates = new Map(); // title -> {questionIds[], answerFormat}
  for (const r of results) {
    if (!r.answers) continue;
    const qIds = [];
    for (const a of r.answers) {
      const id = `${r.idPrefix}-q${String(a.q).padStart(2, "0")}`;
      qIds.push(id);
      questionKeyDocs.push({ id, correctAnswer: a.correctAnswer });
    }
    catalogUpdates.set(r.title, {
      questionIds: qIds,
      answerFormat: "multiple-choice",
    });
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify({ results, questionKeyDocs, catalogUpdates: Array.from(catalogUpdates.entries()) }, null, 2));
  console.log(`[oldwriting-extract] wrote ${OUTPUT_PATH}`);

  if (isCommitCatalog) {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    let mutated = 0;
    for (let i = 0; i < catalog.length; i++) {
      const upd = catalogUpdates.get(catalog[i].title);
      if (!upd) continue;
      catalog[i] = {
        ...catalog[i],
        questionIds: upd.questionIds,
        answerFormat: upd.answerFormat,
      };
      delete catalog[i]._stagedBy;
      mutated++;
    }
    if (mutated > 0) {
      copyFileSync(CATALOG_PATH, CATALOG_PATH + ".bak.session18a-oldwriting");
      writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n");
      console.log(`[oldwriting-extract] catalog updated: ${mutated} entries`);
    } else {
      console.log("[oldwriting-extract] catalog: no entries to update");
    }
  }

  if (isCommitKeys) {
    // Admin SDK upload.
    import("firebase-admin").then(async (mod) => {
      const admin = mod.default;
      admin.initializeApp({ projectId: "psm-generator" });
      const db = admin.firestore();
      let written = 0;
      for (let i = 0; i < questionKeyDocs.length; i += 400) {
        const batch = db.batch();
        for (const q of questionKeyDocs.slice(i, i + 400)) {
          batch.set(db.collection("questionKeys").doc(q.id), { correctAnswer: q.correctAnswer });
          written++;
        }
        await batch.commit();
      }
      console.log(`[oldwriting-extract] questionKeys written: ${written}`);
      process.exit(0);
    }).catch((e) => {
      console.error("[oldwriting-extract] firestore commit failed:", e);
      process.exit(1);
    });
  }
}

main();
