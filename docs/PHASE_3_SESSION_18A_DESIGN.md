# Phase 3 — Session 18A Design

**Date:** 2026-05-11
**Parent:** [PHASE_3_SESSION_18_PLAN.md](PHASE_3_SESSION_18_PLAN.md) · [PHASE_3_SESSION_17.md](PHASE_3_SESSION_17.md)
**Status:** Design committed. Schema additions + UI changes land in subsequent commits behind feature flags.

This doc captures the **schema decisions** for 18A's data-model work (per-worksheet submit, even/odd, flags, answer types). Implementation lands in follow-up commits with feature flags so nothing flips for live students until we explicitly enable it.

## What this commit ships

1. **Catalog port:** 8 SAT Old Writing entries staged in `worksheets_catalog.json` as `pending-extraction`. They surface in the worksheet picker but won't auto-grade until Kiran runs the extraction pipeline (see "Kiran hand-off" below).
2. **Vestigial code removed:** `Circles - Easy (Inactive)` placeholder in `app.jsx` deleted. The catalog has Medium / Hard / Comprehensive; no placeholder needed.
3. **Design doc** (this file).

**No deploy.** This commit only changes source files + the catalog JSON. The `index.html` rebuild + deploy will happen after the next batch of code changes lands.

---

## Schema additions (all backward-compatible)

Every new field is **optional and nullable**. Read paths in both client and grader default-handle missing fields so legacy production data continues to render identically.

### `responses[i]` (draft + submitted)

```js
{
  worksheetId: string,
  questionIndex: number,
  studentAnswer: string,
  // NEW in 18A:
  flag: "star" | "question" | null,   // 18A.5
}
```

- `flag === "star"` → purely informational, no grading effect, surfaces as a star icon in tutor review.
- `flag === "question"` → student intentionally left blank. Grading treats this as an unanswered question — counts as 0, does not get credit even if `studentAnswer` happens to contain something stale. UI shows a `?` icon.
- Missing or `null` → unchanged behavior (legacy).

### `assignment.worksheets[i]` (PSM assignment)

```js
{
  id: string,
  title: string,
  domain, subdomain, subject, difficulty,
  // NEW in 18A:
  subset: "all" | "even" | "odd",       // 18A.3 — defaults to "all"
}
```

- `subset` controls which questions in the worksheet's full question list the student is expected to answer.
- "all" = every question (current behavior).
- "even" = questions 2, 4, 6, … (1-indexed).
- "odd" = questions 1, 3, 5, …
- Same worksheet can be re-assigned with a different subset (e.g. odds week 1, evens week 2) — each subset assignment is its own Score Tracking time-point.

### `students/{sid}/assignments/{aid}/worksheetSubmissions/{wsId}` (NEW collection)

For 18A.1 — per-worksheet submit. Each document represents one worksheet's submission within a PSM.

```js
{
  worksheetId: string,
  status: "draft" | "submitted" | "graded",
  responses: [
    {questionIndex: number, studentAnswer: string, flag: ...},
  ],
  scoreCorrect: number?,
  scoreTotal: number?,
  perQuestion: [{questionIndex, correct, correctAnswer, flag, skipReason?}],
  createdAt, updatedAt, submittedAt?, gradedAt?,
}
```

**Legacy submissions stay intact.** The existing `students/{sid}/submissions/{subId}` collection is not migrated. Read code reconciles both sources:
- New PSM submissions write to `worksheetSubmissions/{wsId}` (per-worksheet docs)
- Legacy PSM submissions still read from `submissions/{subId}` (whole-PSM doc)
- The portal renders both seamlessly

### `questionKeys/{id}` — no schema break; reads only

For 18A.4, we read each question's `correctAnswer` and infer the per-question type from its shape (`isMcAnswer` already in `grade.js`). Mixed worksheets get per-question rendering by consulting the type of each individual question's stored answer. **No write to questionKeys.**

---

## Feature flags

Each landed independently, default false, flipped per environment in `functions/.env` and `app.jsx` config:

| Flag | Scope | Controls |
|---|---|---|
| `PER_QUESTION_FLAGS_ENABLED` | client + grader | Star/? UI + grader treats `flag:"question"` as blank |
| `WORKSHEET_SUBSET_ENABLED` | client + grader + Wise post | Even/odd renderer gate + grading subset + discussion text |
| `PER_QUESTION_ANSWER_TYPE` | client | Per-question MC/FR/Mixed renderer (currently render decision is per-worksheet) |
| `PER_WORKSHEET_SUBMIT_ENABLED` | client + grader trigger | Writes to `worksheetSubmissions/{wsId}` instead of the single `submissions/{subId}` doc |
| `PSM_EDITING_ENABLED` | client | Tutor can add/remove unsubmitted worksheets in an active PSM |

Roll-out order (each ships in its own commit):
1. `PER_QUESTION_FLAGS_ENABLED` (smallest, additive)
2. `WORKSHEET_SUBSET_ENABLED`
3. `PER_QUESTION_ANSWER_TYPE`
4. `PER_WORKSHEET_SUBMIT_ENABLED` (largest; requires migration validation)
5. `PSM_EDITING_ENABLED`

---

## Kiran hand-off (extraction + storage migration)

The 8 newly-staged Old Writing entries are visible in the UI but not gradable. To make them gradable:

```bash
# 1. Upload STU PDFs to Firebase Storage and rewrite stu URLs.
#    Reads scripts/extraction_output.json (run extract first to populate).
node scripts/extract_answer_keys.mjs           # dry-run, populates extraction_output.json
node scripts/migrate_stu_pdfs.mjs --commit     # uploads STU PDFs, rewrites stu URLs

# 2. Extract questionIds + write questionKeys/{id} docs to Firestore.
node scripts/extract_answer_keys.mjs --commit  # writes Firestore

# 3. Verify the entries flipped from "pending-extraction" to a real
#    answerFormat ("multiple-choice" / "free-response" / "mixed").
python -c "
import json
c = json.load(open('worksheets_catalog.json'))
for r in c:
  if r.get('domain') == 'SAT Old Writing Sections':
    print(r['title'], '|', r['answerFormat'], '|', len(r.get('questionIds', [])))
"

# 4. Rebuild + deploy.
python3 build_index.py
firebase deploy --only hosting,functions
```

**Prerequisites for steps 1-2 to work on Kiran's machine:**
- OneDrive mounted at the canonical paths in `scripts/extract_answer_keys.mjs::ONEDRIVE_ROOTS`
- KEY_Old Writing - PT #N.pdf and STU_Old Writing - PT #N.pdf files exist for each entry
- `GOOGLE_APPLICATION_CREDENTIALS` exported with the psm-generator service account
- `gcloud auth application-default login` if using ADC instead

**If a KEY PDF is missing on disk:** `extract_answer_keys.mjs` will mark the row as `unsupported` with a `missing-key` reason. That's fine — the entry stays in the catalog as a tutor-only reference but won't grade.

---

## Other 19 unkeyed entries — not addressed in 18A

`scripts/audit_catalog.mjs` already produces a full report. Most are:
- "STU" placeholder stubs (Literary Worksheets, Poetry Practices — content didn't make it to disk)
- Old extraction-failure marks (CompAlgebra Easy, Probability Hard, G&T N.A. — see `apply_catalog_fixes_v2.mjs` notes)

These need either (a) the content team to produce the KEY PDF, or (b) Kiran to investigate why extraction fails. Out of scope for 18A — captured as a follow-up.

---

## Testing strategy (lands with each follow-up commit)

| Workstream | Test target | New file/test |
|---|---|---|
| A5 flags | grade.js | `functions/grade.test.js`: `flag:"question"` → score 0; `flag:"star"` preserves score |
| A5 flags | UI | `tests/portal.test.mjs`: flag round-trip through draft → submit |
| A3 subset | grade.js | `functions/grade.test.js`: subset="odd" only scores odd questions |
| A3 subset | UI | `tests/portal.test.mjs`: even/odd masking renders correct slots |
| A4 types | render | `tests/portal.test.mjs`: mixed worksheet shows MC for MC questions, FR for FR questions |
| A1 per-WS | trigger | `functions/grade.test.js`: per-WS docs grade independently |
| A1 per-WS | UI | `tests/portal.test.mjs`: legacy + per-WS submissions coexist |
| A2 editing | UI | `tests/portal.test.mjs`: cannot remove submitted worksheet; can remove unsubmitted |

---

## Pause points

Standard 18A pauses (from PHASE_3_SESSION_18_PLAN.md):
- Before any production Firestore writes (catalog extraction commit, backfill scripts)
- Before flipping any feature flag for real students
- Before any hosting deploy → confirm `python3 build_index.py` ran

This commit hits **none** of those pauses — it's source-only.
