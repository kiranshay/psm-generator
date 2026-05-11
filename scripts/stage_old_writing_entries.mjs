#!/usr/bin/env node
// scripts/stage_old_writing_entries.mjs
//
// Session 18A — surgical edit of worksheets_catalog.json. Replaces the
// single broken "STU" stub for SAT Old Writing Sections (currently
// answerFormat: "unsupported", title: "STU") with the 8 real
// Old Writing comprehensive practice entries that exist in embed.js but
// were never converted into the catalog by Session 12's pipeline.
//
// Each new entry is staged as answerFormat: "pending-extraction",
// questionIds: []. They will surface in the UI as available worksheets
// but won't auto-grade until Kiran runs:
//
//   1. node scripts/migrate_stu_pdfs.mjs --commit
//      (uploads STU PDFs to Firebase Storage, rewrites `stu` URLs)
//   2. node scripts/extract_answer_keys.mjs --commit
//      (extracts questionIds + writes questionKeys/{id} docs)
//
// Idempotent: re-running this script after the entries exist is a no-op.
//
// Read-only flag for inspection:
//   node scripts/stage_old_writing_entries.mjs --dry-run
//
// Live:
//   node scripts/stage_old_writing_entries.mjs

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CATALOG_PATH = join(REPO_ROOT, "worksheets_catalog.json");

const argv = process.argv.slice(2);
const isDryRun = argv.includes("--dry-run");

// Source: ats-portal/embed.js (WS_RAW) lines 2-9. Format:
//   [subject, sectionParent, domain, difficulty, qs, title, stuUrl, keyUrl]
const NEW_ENTRIES = [
  ["Reading & Writing","Standard English Conventions","SAT Old Writing Sections","comprehensive",44,
    "Old Writing - April 2019 QAS (44Qs)",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedSuq38KHblb0XtpQ?e=V6uvhG",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedR8gBwgTDyZ6CWng?e=fLXM3C"],
  ["Reading & Writing","Standard English Conventions","SAT Old Writing Sections","comprehensive",44,
    "Old Writing - PT #1 (44Qs)",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedXAradH0k5-6mlbA?e=xoeeZj",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedUOAOtXNFJYX_gLA?e=szfVa1"],
  ["Reading & Writing","Standard English Conventions","SAT Old Writing Sections","comprehensive",44,
    "Old Writing - PT #2 (44Qs)",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedamL3L0Q31vvorQQ?e=WjpFYQ",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedYdGzRupA8o61jcg?e=pi5jHb"],
  ["Reading & Writing","Standard English Conventions","SAT Old Writing Sections","comprehensive",44,
    "Old Writing - PT #4 (44Qs)",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedgwqavGdOLMrCDwA?e=lQvpLy",
    "https://1drv.ms/b/s!AsTNdk2gnmVMheddTKLdKwhLmvGntA?e=cB9BDe"],
  ["Reading & Writing","Standard English Conventions","SAT Old Writing Sections","comprehensive",44,
    "Old Writing - PT #5 (44Qs)",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedlL8wNX9h5DhgyKQ?e=FPFqgA",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedeJ0xSthOj0XzTIA?e=Qq2FoE"],
  ["Reading & Writing","Standard English Conventions","SAT Old Writing Sections","comprehensive",44,
    "Old Writing - PT #6 (44Qs)",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedm3iuj4-rZ-H00qg?e=TT3iRf",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedjlMzeBC0MKQwm8A?e=OHqAQS"],
  ["Reading & Writing","Standard English Conventions","SAT Old Writing Sections","comprehensive",44,
    "Old Writing - PT #7 (44Qs)",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedtYs7IWwMg7sgFlA?e=VxdVc0",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedotfZ2xBujQvp8hw?e=T8i7Qa"],
  ["Reading & Writing","Standard English Conventions","SAT Old Writing Sections","comprehensive",44,
    "Old Writing - PT #8 (44Qs)",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedvw9DUhQdoB3PQXA?e=ZEuy1G",
    "https://1drv.ms/b/s!AsTNdk2gnmVMhedrmKnoeZ664pb3Mg?e=0jSXZB"],
];

function buildEntry([subject, _section, domain, difficulty, qs, title, stuUrl, keyUrl]) {
  return {
    subject,
    domain,
    subdomain: "Comprehensive SAT Old Writing Sections",
    difficulty,
    title,
    keyTitle: title, // best guess until extraction runs; KEY filename usually mirrors title
    qs,
    stu: stuUrl,
    key: keyUrl,
    questionIds: [],
    answerFormat: "pending-extraction",
    // Session 18A staging marker — extract_answer_keys.mjs + migrate_stu_pdfs.mjs
    // need to run on these before they're fully usable.
    _stagedBy: "session-18A",
  };
}

const raw = readFileSync(CATALOG_PATH, "utf8");
const catalog = JSON.parse(raw);

// Find the broken stub by exact match — domain + title.
const stubIdx = catalog.findIndex(
  (r) =>
    r &&
    r.domain === "SAT Old Writing Sections" &&
    r.title === "STU" &&
    r.answerFormat === "unsupported",
);

if (stubIdx < 0) {
  // Already migrated? Check whether any of the new titles are already present.
  const alreadyPresent = NEW_ENTRIES.filter(
    (e) => catalog.find((r) => r && r.title === e[5]),
  );
  if (alreadyPresent.length > 0) {
    console.log(
      `[stage] no-op: ${alreadyPresent.length}/${NEW_ENTRIES.length} entries already present, stub already removed`,
    );
    process.exit(0);
  }
  console.error(
    "[stage] could not find broken STU stub for SAT Old Writing Sections — abort",
  );
  process.exit(1);
}

console.log(`[stage] found broken stub at index ${stubIdx}, replacing with 8 entries`);

const newEntries = NEW_ENTRIES.map(buildEntry);
const before = catalog.slice(0, stubIdx);
const after = catalog.slice(stubIdx + 1);
const updated = [...before, ...newEntries, ...after];

console.log(`[stage] catalog: ${catalog.length} -> ${updated.length} entries (+${updated.length - catalog.length})`);

if (isDryRun) {
  console.log("[stage] dry-run, not writing.");
  console.log("\nNew entries:");
  for (const e of newEntries) {
    console.log(`  - ${e.title}  [${e.difficulty}, ${e.qs}Qs, pending-extraction]`);
  }
  process.exit(0);
}

const backup = CATALOG_PATH + ".bak.session18a";
copyFileSync(CATALOG_PATH, backup);
console.log(`[stage] backup written: ${backup}`);

writeFileSync(CATALOG_PATH, JSON.stringify(updated, null, 2) + "\n", "utf8");
console.log(`[stage] catalog rewritten: ${CATALOG_PATH}`);
console.log("\nNext steps for Kiran:");
console.log("  1. node scripts/migrate_stu_pdfs.mjs --commit");
console.log("  2. node scripts/extract_answer_keys.mjs --commit");
console.log("  3. firebase deploy --only hosting,functions");
