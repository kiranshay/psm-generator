// Pure grading module — no firebase-admin, no network, no side effects.
// All inputs are passed explicitly so this is trivially unit-testable.
//
// Called by the onSubmissionSubmit Firestore trigger in index.js.
//
// Join chain (spec'd in PHASE_3_SPEC.md §Worksheet data model,
// PHASE_3_SESSION_14.md §responses shape):
//
//   submission.responses[i]            // { worksheetId, questionIndex, studentAnswer }
//     .worksheetId                     // matches assignment.worksheets[n].id
//     → assignment.worksheets[n].title // matches worksheets_catalog row.title
//     → catalogRow.questionIds[qi]     // the CB question id for that slot
//     → questionKeys/{id}.correctAnswer

// ── Normalization ─────────────────────────────────────────────────────────
//
// Used on both sides of every comparison. Goals:
//   - case-insensitive MC ("A" === "a")
//   - whitespace-tolerant ("  B  " === "B")
//   - numeric-equivalent FR ("27556" === "27556.0", ".9411" === "0.9411")
//   - fraction-tolerant FR ("16/17" stays distinct unless you convert —
//     Session 12 stores grid-in answers verbatim so "16/17" must compare
//     byte-for-byte after trim against a student who typed "16/17")
//
// We do NOT try to evaluate fractions into decimals — a student typing
// ".9411" must match the stored ".9411" literal, and a student typing
// "16/17" must match the stored "16/17" literal. The dual-answer accept
// (see gradeFr) is how we handle the equivalence classes — not by math.

function normalize(s) {
  if (s === null || s === undefined) return "";
  let out = String(s).trim();
  if (!out) return "";
  // Case fold — MC answers are single letters, harmless on numeric.
  out = out.toUpperCase();
  // Numeric canonicalization: strip trailing zeros on decimals and
  // leading zero on sub-1 decimals, so "27556.0" == "27556" and
  // "0.9411" == ".9411". Leaves non-numeric strings alone.
  if (/^-?\d+(\.\d+)?$/.test(out) || /^-?\.\d+$/.test(out)) {
    const n = Number(out);
    if (Number.isFinite(n)) {
      // Use toString which collapses "27556.0" -> "27556" and
      // ".9411" -> "0.9411". We then strip the leading "0" before "."
      // so both .9411 and 0.9411 normalize identically.
      let canon = n.toString();
      if (canon.startsWith("0.")) canon = canon.slice(1);
      if (canon.startsWith("-0.")) canon = "-" + canon.slice(2);
      return canon;
    }
  }
  return out;
}

// ── MC grader ─────────────────────────────────────────────────────────────

function gradeMc(studentAnswer, correctAnswer) {
  const s = normalize(studentAnswer);
  const c = normalize(correctAnswer);
  if (!s || !c) return false;
  return s === c;
}

// ── FR grader ─────────────────────────────────────────────────────────────
//
// Session 12 stores FR answers verbatim from the KEY PDF. Grid-in answers
// often carry multiple equivalent forms, comma-separated:
//   "27556"
//   ".9411, .9412, 16/17"
//
// Accept-any semantics: split the stored answer on commas, normalize each
// piece, and accept the student answer iff it normalizes to any piece.
//
// Aidan confirmed (Session 15 kickoff) that FR is numeric-only and should
// accept all listed alternatives. The Session 12 classifier already ensures
// FR worksheets contain only numeric/grid-in answers, so this is safe.

function gradeFr(studentAnswer, correctAnswer) {
  const s = normalize(studentAnswer);
  if (!s) return false;
  if (correctAnswer === null || correctAnswer === undefined) return false;
  const pieces = String(correctAnswer)
    .split(/\s*,\s*/)
    .map(normalize)
    .filter(Boolean);
  if (pieces.length === 0) return false;
  return pieces.includes(s);
}

// ── Mixed grader ──────────────────────────────────────────────────────────
//
// A "mixed" worksheet has some MC questions and some FR questions in the
// same file. The catalog row's `answerFormat` is "mixed" but each individual
// stored correctAnswer is still either a single letter (MC) or a numeric /
// comma-delimited numeric (FR). We detect per-question by looking at the
// stored answer shape.

function isMcAnswer(correctAnswer) {
  if (correctAnswer === null || correctAnswer === undefined) return false;
  return /^[A-D]$/i.test(String(correctAnswer).trim());
}

function gradeOne(studentAnswer, correctAnswer) {
  if (isMcAnswer(correctAnswer)) return gradeMc(studentAnswer, correctAnswer);
  return gradeFr(studentAnswer, correctAnswer);
}

// ── Submission grader ─────────────────────────────────────────────────────
//
// Inputs:
//   submission         — the submission doc data. Must have responses[] in
//                        the nested shape: { worksheetId, questionIndex,
//                        studentAnswer }. Legacy blob shape (worksheetId =
//                        null) is detected and returns SKIP.
//   assignment         — the assignment object from student.assignments[]
//                        matching submission.assignmentId. Must have
//                        worksheets[] with { id, title } entries.
//   catalogByTitle     — Map<string, catalogRow>. Keys are w.title as they
//                        appear in assignment.worksheets. Values are the
//                        worksheets_catalog.json rows. Caller bundles or
//                        fetches the catalog and hands it in.
//   questionKeysById   — Map<string, { correctAnswer }>. Caller fetches
//                        all relevant key docs and hands them in. Missing
//                        keys → question is skipped (not graded).
//
// Returns:
//   { status: "graded", scoreCorrect, scoreTotal, perQuestion: [
//       { worksheetId, questionIndex, questionId, correct: bool | null }
//     ], skippedReasons: [] }
//   OR
//   { status: "skipped", reason: string }
//
// Skip conditions (entire submission):
//   - submission.responses is empty
//   - submission.responses[0].worksheetId is null (legacy blob)
//   - assignment has no worksheets[] that match any responses worksheetId
//
// Per-question "correct: null" (not counted as wrong, not counted toward
// total) conditions — these are "unsupported" rather than "incorrect":
//   - worksheet's catalog row has answerFormat === "unsupported"
//   - worksheet's title is not in catalogByTitle
//   - catalog row is missing questionIds or questionIndex is out of range
//   - questionKey doc is missing for the joined questionId
//
// Per-question "correct: false" is reserved for real wrong answers only.
// studentAnswer = "" also counts as incorrect (not skipped) — a blank
// response in a submitted submission is a wrong answer, not an exempt one.

function gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById }) {
  const responses = Array.isArray(submission && submission.responses) ? submission.responses : [];
  if (responses.length === 0) {
    return { status: "skipped", reason: "no-responses" };
  }
  // Legacy blob detection: Session 14 shipped the nested shape. A single
  // response entry with worksheetId === null is the pre-Session-14 blob.
  if (responses.length === 1 && (responses[0].worksheetId === null || responses[0].worksheetId === undefined)) {
    return { status: "skipped", reason: "legacy-blob-shape" };
  }
  // Any response with worksheetId === null in a multi-response submission
  // is also legacy-looking — skip to be safe.
  if (responses.some((r) => r && (r.worksheetId === null || r.worksheetId === undefined))) {
    return { status: "skipped", reason: "legacy-blob-shape" };
  }

  const worksheets = Array.isArray(assignment && assignment.worksheets) ? assignment.worksheets : [];
  const worksheetById = new Map();
  for (const w of worksheets) {
    if (w && w.id) worksheetById.set(w.id, w);
  }
  if (worksheetById.size === 0) {
    return { status: "skipped", reason: "assignment-has-no-worksheets" };
  }

  let scoreCorrect = 0;
  let scoreTotal = 0;
  const perQuestion = [];

  // Session 18A: helper for even/odd subset filtering. Mirrors the
  // client-side `isInSubset` in app.jsx — keep these two in sync.
  function isInSubset(qi, subset) {
    const s = String(subset || "").toUpperCase();
    if (s === "EVEN") return qi % 2 === 1;
    if (s === "ODD") return qi % 2 === 0;
    return true;
  }

  for (const r of responses) {
    const wId = r.worksheetId;
    const qi = Number(r.questionIndex);
    const studentAnswer = r.studentAnswer;

    const w = worksheetById.get(wId);
    if (!w) {
      perQuestion.push({ worksheetId: wId, questionIndex: qi, questionId: null, correct: null, skipReason: "worksheet-not-in-assignment" });
      continue;
    }
    // Session 18A: skip questions that are not in the assigned even/odd
    // subset. They never appear on the student's answer column (the
    // client masks them as "not assigned"), so if a response slipped
    // through (e.g. legacy client write) we should not count it either
    // way — flag it as not-in-subset so it shows up in the audit trail
    // but never contributes to scoreCorrect/scoreTotal.
    if (!isInSubset(qi, w.evenOdd)) {
      perQuestion.push({ worksheetId: wId, questionIndex: qi, questionId: null, correct: null, skipReason: "not-in-subset", flag: r.flag || null });
      continue;
    }
    const row = catalogByTitle.get(w.title);
    if (!row) {
      perQuestion.push({ worksheetId: wId, questionIndex: qi, questionId: null, correct: null, skipReason: "no-catalog-row" });
      continue;
    }
    if (row.answerFormat === "unsupported") {
      perQuestion.push({ worksheetId: wId, questionIndex: qi, questionId: null, correct: null, skipReason: "unsupported-worksheet" });
      continue;
    }
    const qIds = Array.isArray(row.questionIds) ? row.questionIds : null;
    if (!qIds || qi < 0 || qi >= qIds.length) {
      perQuestion.push({ worksheetId: wId, questionIndex: qi, questionId: null, correct: null, skipReason: "questionIndex-out-of-range" });
      continue;
    }
    const qid = qIds[qi];
    const key = questionKeysById.get(qid);
    if (!key || key.correctAnswer === undefined) {
      perQuestion.push({ worksheetId: wId, questionIndex: qi, questionId: qid, correct: null, skipReason: "missing-key", flag: r.flag || null });
      continue;
    }

    // Session 18A: per-question flag semantics.
    //   flag === "question" → student intentionally left blank.
    //     Treat as an incorrect answer; ignore whatever studentAnswer
    //     contains. Counts toward scoreTotal but never increments
    //     scoreCorrect. Surfaced to the tutor as a "?" indicator on
    //     the response row so they know the student bailed out.
    //   flag === "star"    → purely informational, no grade effect.
    //     Surfaced as a star icon next to the row. The grade happens
    //     normally against the student's actual answer.
    //   flag absent/null   → unchanged behavior (legacy).
    const flag = r.flag || null;
    let isCorrect;
    if (flag === "question") {
      isCorrect = false;
    } else {
      isCorrect = gradeOne(studentAnswer, key.correctAnswer);
    }
    scoreTotal += 1;
    if (isCorrect) scoreCorrect += 1;
    perQuestion.push({
      worksheetId: wId,
      questionIndex: qi,
      questionId: qid,
      correct: isCorrect,
      correctAnswer: key.correctAnswer,
      flag,
    });
  }

  // If every question was a per-question skip we don't have a meaningful
  // score. Mark the whole submission as skipped so the trigger doesn't
  // write 0/0 onto the doc (which would look like a real grade of "all
  // wrong, zero questions" in the UI).
  if (scoreTotal === 0) {
    return { status: "skipped", reason: "all-questions-unsupported-or-missing" };
  }

  return { status: "graded", scoreCorrect, scoreTotal, perQuestion };
}

// ── Exports (test + trigger surface) ──────────────────────────────────────

module.exports = {
  normalize,
  isMcAnswer,
  gradeMc,
  gradeFr,
  gradeOne,
  gradeSubmission,
};
