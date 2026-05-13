#!/usr/bin/env node
// scripts/backfill_question_types.mjs
//
// Session 18C v10 — derives per-question answer type ("mc" | "fr") from
// scripts/extraction_output.json and writes it into worksheets_catalog.json
// alongside questionIds, so the client renderer can show MC bubbles XOR a
// numeric input per question instead of both-for-every-question.
//
// Pure local data transformation. No Firestore, no network. Idempotent —
// re-running with no source changes produces an identical catalog.
//
// Usage:
//   node scripts/backfill_question_types.mjs           # dry-run, prints diff
//   node scripts/backfill_question_types.mjs --commit  # writes the catalog

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CATALOG_PATH = join(REPO_ROOT, "worksheets_catalog.json");
const EXTRACTION_PATH = join(__dirname, "extraction_output.json");

const isCommit = process.argv.includes("--commit");

// Same classification rules as extract_answer_keys.mjs::classifyAnswer.
// MC = single letter A-D, FR = numeric (incl. decimals, fractions, negatives,
// comma-separated multi-form FR answers). "unknown" anything else.
const FR_PIECE = /^-?(?:\d+(?:\.\d+)?|\.\d+|\d+\/\d+)$/;
const MC_PIECE = /^[A-D]$/i;

function classifyAnswer(raw){
  if(raw == null) return "unknown";
  const a = String(raw).trim();
  if(!a) return "unknown";
  if(MC_PIECE.test(a)) return "mc";
  // SAT grid-in answers can be comma-separated equivalents. If every piece
  // is a clean FR token, the answer is FR.
  const pieces = a.split(/\s*,\s*/).filter(Boolean);
  if(pieces.length > 0 && pieces.every(p => FR_PIECE.test(p))) return "fr";
  return "unknown";
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
const extraction = JSON.parse(readFileSync(EXTRACTION_PATH, "utf8"));

// Build a tuples lookup by title (extraction is per-row, matches catalog by idx).
const tuplesByTitle = new Map();
for(const e of extraction){
  if(e && e.title && Array.isArray(e.tuples)) tuplesByTitle.set(e.title, e.tuples);
}

let updated = 0, unchanged = 0, skipped = 0;
const sample = [];
for(const row of catalog){
  if(!row || !Array.isArray(row.questionIds) || row.questionIds.length === 0){
    skipped++;
    continue;
  }
  const tuples = tuplesByTitle.get(row.title);
  if(!tuples){
    skipped++;
    continue;
  }
  // Build type array indexed the same way as questionIds. The extraction
  // tuples are in the same order as questionIds (both come from KEY PDF
  // top-to-bottom walk), so use questionIndex parallel.
  const types = row.questionIds.map((qid, i) => {
    const t = tuples[i];
    if(!t || t.questionId !== qid) {
      // Fallback: lookup by id
      const byId = tuples.find(x => x && x.questionId === qid);
      return classifyAnswer(byId && byId.correctAnswer);
    }
    return classifyAnswer(t.correctAnswer);
  });
  const prev = row.questionTypes;
  if(prev && JSON.stringify(prev) === JSON.stringify(types)){
    unchanged++;
  } else {
    row.questionTypes = types;
    updated++;
    if(sample.length < 6){
      const dist = types.reduce((acc,t)=>{ acc[t]=(acc[t]||0)+1; return acc; }, {});
      sample.push(`  ${row.title}  → ${JSON.stringify(dist)}  format=${row.answerFormat}`);
    }
  }
}

console.log(`[backfill] catalog rows: ${catalog.length}`);
console.log(`[backfill]   updated:   ${updated}`);
console.log(`[backfill]   unchanged: ${unchanged}`);
console.log(`[backfill]   skipped:   ${skipped} (no questionIds or no extraction match)`);
if(sample.length){
  console.log(`[backfill] sample of updated rows:`);
  for(const s of sample) console.log(s);
}

if(!isCommit){
  console.log(`\n[backfill] dry-run only. Pass --commit to write ${CATALOG_PATH}.`);
  process.exit(0);
}

const backup = CATALOG_PATH + ".bak.qtypes";
copyFileSync(CATALOG_PATH, backup);
console.log(`[backfill] backup written: ${backup}`);
writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n", "utf8");
console.log(`[backfill] catalog rewritten.`);
