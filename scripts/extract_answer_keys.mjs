#!/usr/bin/env node
// scripts/extract_answer_keys.mjs
//
// Phase 3 Session 12 — walks worksheets_catalog.json, locates each entry's
// KEY_*.pdf in the local OneDrive mirror, runs `pdftotext -layout`, and
// extracts (questionId, correctAnswer) tuples from each PDF. Writes a
// per-entry extraction report to scripts/extraction_output.json for the
// audit script to consume.
//
// Defaults to dry-run (no Firestore writes). Pass --commit to also upload
// questionKeys/{id} docs via the Firebase Admin SDK.
//
// Usage:
//   node scripts/extract_answer_keys.mjs                  # dry-run, all entries
//   node scripts/extract_answer_keys.mjs --sample 10      # dry-run, first 10 matched
//   node scripts/extract_answer_keys.mjs --commit         # writes Firestore
//
// Spec: docs/PHASE_3_SPEC.md §"Worksheet data model"

import { readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import admin from "firebase-admin";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CATALOG_PATH = join(REPO_ROOT, "worksheets_catalog.json");
const OUTPUT_PATH = join(__dirname, "extraction_output.json");
// Source trees, indexed together, earlier wins on duplicate basenames.
// See docs/PHASE_3_SESSION_12.md.
//   1. Canonical live OneDrive mount — authoritative for everything.
//   2. Fresh ats_psms bulk download (2026-04-14) — contains files (mostly
//      STUs and expanded-filename variants) the canonical tree is missing.
//   3. Client Profiles fallback — per-session folders that sometimes carry
//      the only surviving copy of a worksheet (e.g. CompAdvMath - Hard).
//      Priority-last because Client Profiles occasionally hold marked-up
//      copies; canonical trees win on conflict.
// The Desktop/stuff/OneDrive copy tree is stale and not used.
const ONEDRIVE_ROOTS = [
  // Authoritative: the full Official Worksheets & Resources tree, which
  // includes !SAT Test Banks, Old SAT Resources, Misc. Diagnostic Exams,
  // ACT Resources, FL B.E.S.T, and everything else Kiran maintains.
  "/Users/kiranshay/Library/CloudStorage/OneDrive-Personal/Desktop/Affordable Tutoring Solutions Inc/Official Worksheets & Resources",
  "/Users/kiranshay/Downloads/ats_psms",
  "/Users/kiranshay/Library/CloudStorage/OneDrive-Personal/Desktop/Affordable Tutoring Solutions Inc/Client Profiles",
];

const argv = process.argv.slice(2);
const isCommit = argv.includes("--commit");
const sampleIdx = argv.indexOf("--sample");
const sampleN = sampleIdx >= 0 ? parseInt(argv[sampleIdx + 1], 10) : null;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function indexPdfs(roots) {
  // Index by **normalized** basename so case-variant filenames on disk
  // (e.g. `Key_CompAdvMath - Easy (15Qs).pdf`, `LinEQ1Var - Comp.PDF`)
  // match the catalog's `keyTitle` / `title` without fiddling either side.
  // Normalization: lowercase, collapse whitespace.
  const keys = new Map(); // normalized-basename -> absolute path
  const stus = new Map();
  let totalKey = 0;
  let totalStu = 0;
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  for (const root of roots) {
    const all = walk(root);
    for (const path of all) {
      const base = basename(path);
      const lower = base.toLowerCase();
      if (!lower.endsWith(".pdf")) continue;
      if (lower.startsWith("key_")) {
        totalKey++;
        const k = normalize(base);
        if (!keys.has(k)) keys.set(k, path);
      } else if (lower.startsWith("stu_")) {
        totalStu++;
        const k = normalize(base);
        if (!stus.has(k)) stus.set(k, path);
      }
    }
  }
  return { keys, stus, totalKey, totalStu, normalize };
}

function extractFromPdf(pdfPath) {
  const r = spawnSync("pdftotext", ["-layout", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { error: `pdftotext exit ${r.status}: ${r.stderr?.slice(0, 200)}` };
  }
  const text = r.stdout;

  // Pair each "Question ID {hex}" header with the next "Correct Answer: X".
  // The header appears at the top of each question block; the same ID may
  // recur later in the block as "ID: {hex}" or "ID: {hex} Answer" — we only
  // anchor on the full "Question ID" form.
  const headerRe = /Question ID ([a-f0-9]+)/g;

  const tuples = [];
  const headers = [];
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    headers.push({ id: m[1], idx: m.index });
  }
  // Grab everything after "Correct Answer:" up to the first run of 3+ spaces
  // (a `pdftotext -layout` column/footer boundary) or end-of-line. This keeps
  // multi-token answers like ".9411, .9412, 16/17" intact while stripping
  // footers that land on the same physical line as a single-letter answer.
  const answerRe = /Correct Answer:\s*(.+?)(?:\s{3,}|\r?\n|\r|$)/;
  // Some worksheets render the ATS footer directly adjacent to the answer
  // letter with only single-space separation (pdftotext can't distinguish
  // that from a legitimate multi-token answer). Strip the footer literally.
  const FOOTER_MARKERS = [
    /\s*Affordable Tutoring Solutions Inc\..*$/,
    /\s*Sourced from CBQB.*$/,
    /\s*Updated \d{4}.*$/,
    /\s*\|\s*$/,
    /\s*Question #\d+.*$/,
  ];
  const stripFooter = (s) => {
    let out = s;
    for (const re of FOOTER_MARKERS) out = out.replace(re, "");
    return out.trim();
  };
  // Fallback extractors for blocks missing the "Correct Answer:" line.
  // Some CBQB PDFs omit that label entirely — the answer is only in the
  // Rationale section as "Choice X is correct" (MC) or "The correct
  // answer is Y" (FR), or in a "Note that X and Y are examples" line.
  const mcFallbackRe = /Choice ([A-D]) is correct/;
  const frFallbackRe = /The correct answer is\s+(-?[\d,./]+)/;
  // "Note that" lines list accepted answer forms and may span a line break.
  const noteFallbackRe = /Note that (.+?)(?:are|is an?)\s+example/s;
  const eitherFallbackRe = /(?:either|Either) (-?[\d./]+) or (-?[\d./]+)/;

  // Strip comma-thousands formatting (e.g. "3,540" → "3540") so the grader's
  // comma-split doesn't misinterpret it as two separate answers.
  const stripThousands = (s) => s.replace(/(\d),(\d{3})\b/g, "$1$2");

  function fallbackExtract(block) {
    const mc = block.match(mcFallbackRe);
    if (mc) return mc[1];

    const note = block.match(noteFallbackRe);
    if (note) {
      const raw = note[1].replace(/\s+/g, " ").trim();
      const cleaned = raw.replace(/,?\s+and\s+/g, ", ").replace(/,\s*$/, "").trim();
      if (cleaned) return stripThousands(cleaned);
    }

    const fr = block.match(frFallbackRe);
    if (fr) {
      const val = fr[1].replace(/[.,]+$/, "").trim();
      if (val) return stripThousands(val);
    }

    const either = block.match(eitherFallbackRe);
    if (either) return `${either[1].replace(/[.,]$/, "")}, ${either[2].replace(/[.,]$/, "")}`;

    return null;
  }

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].idx;
    const end = i + 1 < headers.length ? headers[i + 1].idx : text.length;
    const block = text.slice(start, end);
    const am = block.match(answerRe);
    if (am) {
      const cleaned = stripFooter(am[1].trim());
      tuples.push({ questionId: headers[i].id, correctAnswer: cleaned || null });
    } else {
      const fb = fallbackExtract(block);
      tuples.push({ questionId: headers[i].id, correctAnswer: fb, fallback: fb ? true : undefined });
    }
  }
  return { tuples, rawLength: text.length };
}

// A single free-response answer. Matches integers, decimals with optional
// leading dot (`.9411`), fractions (`16/17`), and negatives.
const FR_PIECE = /^-?(?:\d+(?:\.\d+)?|\.\d+|\d+\/\d+)$/;
const MC_PIECE = /^[A-D]$/;

function classifyAnswer(raw) {
  if (!raw) return "null";
  const a = raw.trim();
  if (MC_PIECE.test(a)) return "mc";
  // SAT grid-in answers sometimes ship as comma-separated equivalents
  // (range lower, range upper, fraction form). If every comma-delimited
  // piece is a clean FR token, the whole answer is FR.
  const pieces = a.split(/\s*,\s*/).filter(Boolean);
  if (pieces.length > 0 && pieces.every((p) => FR_PIECE.test(p))) return "fr";
  return "other";
}

function deriveAnswerFormat(tuples) {
  const answers = tuples.map((t) => t.correctAnswer).filter(Boolean);
  if (answers.length === 0) return "unknown";
  let mc = 0,
    fr = 0,
    other = 0;
  for (const a of answers) {
    const kind = classifyAnswer(a);
    if (kind === "mc") mc++;
    else if (kind === "fr") fr++;
    else other++;
  }
  if (other > 0) return "mixed";
  if (mc > 0 && fr === 0) return "multiple-choice";
  if (fr > 0 && mc === 0) return "free-response";
  return "mixed";
}

async function main() {
  console.log(`[extract] mode=${isCommit ? "COMMIT" : "DRY-RUN"}`);
  if (sampleN) console.log(`[extract] sample=${sampleN}`);

  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  console.log(`[extract] catalog entries: ${catalog.length}`);

  console.log(`[extract] indexing ${ONEDRIVE_ROOTS.length} tree(s):`);
  for (const r of ONEDRIVE_ROOTS) console.log(`    ${r}`);
  const { keys, stus, totalKey, totalStu, normalize } = indexPdfs(ONEDRIVE_ROOTS);
  console.log(
    `[extract]   found ${keys.size} unique KEY basenames (${totalKey} total files across trees), ${stus.size} unique STU basenames (${totalStu} total)`
  );

  const results = [];
  let processed = 0;
  for (let i = 0; i < catalog.length; i++) {
    const entry = catalog[i];
    if (entry.answerFormat === "unsupported") {
      results.push({
        idx: i,
        title: entry.title,
        keyTitle: entry.keyTitle,
        expectedQs: entry.qs,
        keyFile: null,
        keyFound: false,
        keyPath: null,
        stuFile: null,
        stuFound: false,
        stuPath: null,
        tuples: null,
        answerFormat: "unsupported",
        extractionError: null,
        countMismatch: false,
        unsupportedReason: entry.unsupportedReason || null,
      });
      continue;
    }
    const keyBase = `KEY_${entry.keyTitle}.pdf`;
    // For STU lookup prefer stuTitle if set — a handful of catalog rows
    // have a short `title` matching the portal's WS_RAW display name while
    // the STU file on disk uses an expanded form. See Session 12 docs.
    const stuBase = `STU_${entry.stuTitle || entry.title}.pdf`;
    const keyPath = keys.get(normalize(keyBase)) || null;
    const stuPath = stus.get(normalize(stuBase)) || null;

    const result = {
      idx: i,
      title: entry.title,
      keyTitle: entry.keyTitle,
      expectedQs: entry.qs,
      keyFile: keyBase,
      keyFound: !!keyPath,
      keyPath,
      stuFile: stuBase,
      stuFound: !!stuPath,
      stuPath,
      tuples: null,
      answerFormat: null,
      extractionError: null,
      countMismatch: false,
    };

    if (keyPath) {
      const extract = extractFromPdf(keyPath);
      if (extract.error) {
        result.extractionError = extract.error;
      } else {
        result.tuples = extract.tuples;
        result.answerFormat = deriveAnswerFormat(extract.tuples);
        result.countMismatch = extract.tuples.length !== entry.qs;
      }
    }

    results.push(result);
    if (keyPath) processed++;
    if (sampleN && processed >= sampleN) break;
  }

  // Summary
  const withKey = results.filter((r) => r.keyFound).length;
  const withStu = results.filter((r) => r.stuFound).length;
  const extractedClean = results.filter(
    (r) => r.tuples && !r.countMismatch && r.answerFormat !== "unknown" && r.answerFormat !== "mixed"
  ).length;
  const extractedMixed = results.filter((r) => r.answerFormat === "mixed").length;
  const mismatches = results.filter((r) => r.countMismatch).length;
  const unknown = results.filter((r) => r.answerFormat === "unknown").length;
  const missingKey = results.filter((r) => !r.keyFound).length;

  console.log("");
  console.log("[extract] === SUMMARY ===");
  console.log(`  catalog rows examined:   ${results.length}`);
  console.log(`  KEY PDF found:           ${withKey}`);
  console.log(`  STU PDF found:           ${withStu}`);
  console.log(`  KEY PDF missing:         ${missingKey}`);
  console.log(`  clean extraction (mc/fr, count OK): ${extractedClean}`);
  console.log(`  mixed answerFormat:      ${extractedMixed}`);
  console.log(`  unknown (no tuples):     ${unknown}`);
  console.log(`  q-count mismatch:        ${mismatches}`);

  // First 5 sample extractions
  const samples = results.filter((r) => r.tuples).slice(0, 5);
  if (samples.length) {
    console.log("");
    console.log("[extract] === SAMPLE (first 5 with tuples) ===");
    for (const s of samples) {
      const mark = s.countMismatch ? "  ⚠ COUNT MISMATCH" : "";
      console.log(
        `  [${s.idx}] ${s.title}  expected=${s.expectedQs} got=${s.tuples.length} fmt=${s.answerFormat}${mark}`
      );
      for (const t of s.tuples.slice(0, 3)) {
        console.log(`       ${t.questionId} -> ${t.correctAnswer}`);
      }
      if (s.tuples.length > 3) console.log(`       ... +${s.tuples.length - 3} more`);
    }
  }

  // Mismatches and missing keys, for quick eyeball
  const misses = results.filter((r) => !r.keyFound).slice(0, 10);
  if (misses.length) {
    console.log("");
    console.log(`[extract] === MISSING KEY PDF (first 10 of ${missingKey}) ===`);
    for (const m of misses) console.log(`  [${m.idx}] ${m.keyFile}`);
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));
  console.log("");
  console.log(`[extract] wrote ${OUTPUT_PATH} (${results.length} rows)`);

  if (!isCommit) return;

  // --commit path: write questionKeys/{id} docs via admin SDK and rewrite
  // worksheets_catalog.json with questionIds[] + answerFormat per row.
  console.log("");
  console.log("[extract] === COMMIT PASS ===");

  // Only rows with a clean extraction or a true-mixed extraction are
  // commit-eligible. Unsupported rows, rows with no KEY on disk, rows with
  // count mismatches, and rows with no tuples are all skipped.
  const commitRows = results.filter(
    (r) =>
      r.tuples &&
      r.tuples.length > 0 &&
      !r.countMismatch &&
      r.answerFormat !== "unsupported" &&
      r.answerFormat !== "unknown"
  );
  console.log(`[extract] commit-eligible rows: ${commitRows.length}`);

  // Count total question-key docs we will write (deduped by questionId
  // across worksheets — same CB question appearing in two worksheets only
  // writes once per run, then merges via arrayUnion on re-run).
  const keyDocs = new Map(); // questionId -> { correctAnswer, sourceFiles: Set }
  for (const r of commitRows) {
    for (const t of r.tuples) {
      if (!t.correctAnswer) continue;
      const existing = keyDocs.get(t.questionId);
      if (existing) {
        if (existing.correctAnswer !== t.correctAnswer) {
          console.warn(
            `[extract] WARN: questionId ${t.questionId} has conflicting answers across worksheets: "${existing.correctAnswer}" vs "${t.correctAnswer}" (from ${r.keyFile}). First wins.`
          );
        }
        existing.sourceFiles.add(r.keyFile);
      } else {
        keyDocs.set(t.questionId, {
          correctAnswer: t.correctAnswer,
          sourceFiles: new Set([r.keyFile]),
        });
      }
    }
  }
  console.log(`[extract] unique questionKeys/{id} docs to write: ${keyDocs.size}`);

  // Firebase project ID is immutably `psm-generator` even though the display
  // name and GitHub repo are now `ats-portal`. See docs/PHASE_3_CUSTOM_DOMAIN.md.
  admin.initializeApp({ projectId: "psm-generator" });
  const db = admin.firestore();
  console.log(`[extract] firestore project: psm-generator`);

  // Batch writes in chunks of 500 (Firestore limit).
  const BATCH_SIZE = 500;
  const entries = [...keyDocs.entries()];
  let written = 0;
  for (let start = 0; start < entries.length; start += BATCH_SIZE) {
    const batch = db.batch();
    const slice = entries.slice(start, start + BATCH_SIZE);
    for (const [questionId, data] of slice) {
      const ref = db.collection("questionKeys").doc(questionId);
      batch.set(
        ref,
        {
          correctAnswer: data.correctAnswer,
          sourceFiles: admin.firestore.FieldValue.arrayUnion(...data.sourceFiles),
          extractedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();
    written += slice.length;
    console.log(`[extract]   wrote batch ${start}..${start + slice.length - 1} (${written}/${entries.length})`);
  }
  console.log(`[extract] Firestore writes complete: ${written} questionKeys/{id} docs`);

  // Rewrite worksheets_catalog.json with questionIds[] + answerFormat per
  // commit-eligible row. Backup first.
  const catalogBackup = CATALOG_PATH + ".bak.precommit";
  copyFileSync(CATALOG_PATH, catalogBackup);
  console.log(`[extract] catalog backup: ${catalogBackup}`);

  const catalogRaw = readFileSync(CATALOG_PATH, "utf8");
  const trailing = catalogRaw.endsWith("\n") ? "\n" : "";
  let catalogMutated = 0;
  for (const r of commitRows) {
    const row = catalog[r.idx];
    if (!row) continue;
    const questionIds = r.tuples.map((t) => t.questionId);
    row.questionIds = questionIds;
    row.answerFormat = r.answerFormat;
    // Session 18C v10: per-question answer type, parallel to questionIds.
    // Lets the client render MC bubbles XOR numeric input on a per-question
    // basis instead of showing both for every question on mixed worksheets.
    row.questionTypes = r.tuples.map((t) => classifyAnswer(t.correctAnswer));
    catalogMutated++;
  }
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + trailing);
  console.log(`[extract] catalog rows mutated: ${catalogMutated}`);
  console.log(`[extract] wrote ${CATALOG_PATH}`);

  console.log("");
  console.log("[extract] ✓ commit pass complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
