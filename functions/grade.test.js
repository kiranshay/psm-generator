// node --test tests for grade.js
// Run: node --test functions/grade.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalize,
  isMcAnswer,
  gradeMc,
  gradeFr,
  gradeOne,
  gradeSubmission,
} = require("./grade");

// ── normalize() table ────────────────────────────────────────────────────

test("normalize: trims and uppercases", () => {
  assert.equal(normalize("  a  "), "A");
  assert.equal(normalize("b"), "B");
});

test("normalize: handles null/undefined/empty", () => {
  assert.equal(normalize(null), "");
  assert.equal(normalize(undefined), "");
  assert.equal(normalize(""), "");
  assert.equal(normalize("   "), "");
});

test("normalize: numeric canonicalization", () => {
  assert.equal(normalize("27556"), "27556");
  assert.equal(normalize("27556.0"), "27556");
  assert.equal(normalize("27556.00"), "27556");
  assert.equal(normalize(".9411"), ".9411");
  assert.equal(normalize("0.9411"), ".9411");
  assert.equal(normalize("-0.5"), "-.5");
  assert.equal(normalize("-.5"), "-.5");
});

test("normalize: leaves fractions and non-numerics alone", () => {
  assert.equal(normalize("16/17"), "16/17");
  assert.equal(normalize("A"), "A");
});

// ── isMcAnswer() ─────────────────────────────────────────────────────────

test("isMcAnswer: single letter A-D only", () => {
  assert.equal(isMcAnswer("A"), true);
  assert.equal(isMcAnswer("d"), true);
  assert.equal(isMcAnswer("E"), false);
  assert.equal(isMcAnswer("27556"), false);
  assert.equal(isMcAnswer(".9411, .9412"), false);
  assert.equal(isMcAnswer(null), false);
});

// ── gradeMc() ────────────────────────────────────────────────────────────

test("gradeMc: correct and incorrect", () => {
  assert.equal(gradeMc("A", "A"), true);
  assert.equal(gradeMc("a", "A"), true);
  assert.equal(gradeMc("  A  ", "A"), true);
  assert.equal(gradeMc("B", "A"), false);
  assert.equal(gradeMc("", "A"), false);
  assert.equal(gradeMc(null, "A"), false);
});

// ── gradeFr() ────────────────────────────────────────────────────────────

test("gradeFr: exact numeric match", () => {
  assert.equal(gradeFr("27556", "27556"), true);
  assert.equal(gradeFr("27556.0", "27556"), true);
  assert.equal(gradeFr("  27556  ", "27556"), true);
  assert.equal(gradeFr("27557", "27556"), false);
});

test("gradeFr: dual/multi-answer grid-ins (the Session 12 case)", () => {
  const stored = ".9411, .9412, 16/17";
  assert.equal(gradeFr(".9411", stored), true);
  assert.equal(gradeFr("0.9411", stored), true);
  assert.equal(gradeFr(".9412", stored), true);
  assert.equal(gradeFr("16/17", stored), true);
  assert.equal(gradeFr(".94", stored), false);
  assert.equal(gradeFr("17/16", stored), false);
});

test("gradeFr: empty answer", () => {
  assert.equal(gradeFr("", "27556"), false);
  assert.equal(gradeFr("   ", "27556"), false);
});

// ── gradeSubmission() ────────────────────────────────────────────────────
//
// Fixtures: a two-worksheet assignment, one MC worksheet and one FR
// worksheet, plus a mixed worksheet used in dedicated cases below.

function makeFixture() {
  const assignment = {
    id: "asg1",
    worksheets: [
      { id: "w1", title: "MC Worksheet" },
      { id: "w2", title: "FR Worksheet" },
    ],
  };
  const catalogByTitle = new Map([
    ["MC Worksheet", {
      title: "MC Worksheet",
      answerFormat: "multiple-choice",
      questionIds: ["q1", "q2", "q3"],
    }],
    ["FR Worksheet", {
      title: "FR Worksheet",
      answerFormat: "free-response",
      questionIds: ["f1", "f2"],
    }],
  ]);
  const questionKeysById = new Map([
    ["q1", { correctAnswer: "A" }],
    ["q2", { correctAnswer: "B" }],
    ["q3", { correctAnswer: "C" }],
    ["f1", { correctAnswer: "27556" }],
    ["f2", { correctAnswer: ".9411, .9412, 16/17" }],
  ]);
  return { assignment, catalogByTitle, questionKeysById };
}

test("gradeSubmission: all correct, two worksheets", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A" },
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "B" },
      { worksheetId: "w1", questionIndex: 2, studentAnswer: "C" },
      { worksheetId: "w2", questionIndex: 0, studentAnswer: "27556" },
      { worksheetId: "w2", questionIndex: 1, studentAnswer: "16/17" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 5);
  assert.equal(res.scoreTotal, 5);
  assert.equal(res.perQuestion.length, 5);
  assert.equal(res.perQuestion.every((q) => q.correct === true), true);
  // Session 15 option C: correctAnswer populated on every graded entry.
  assert.equal(res.perQuestion[0].correctAnswer, "A");
  assert.equal(res.perQuestion[3].correctAnswer, "27556");
  assert.equal(res.perQuestion[4].correctAnswer, ".9411, .9412, 16/17");
});

test("gradeSubmission: MC incorrect, FR correct, partial score", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "B" }, // wrong
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "B" }, // right
      { worksheetId: "w1", questionIndex: 2, studentAnswer: "" },  // wrong (blank counts)
      { worksheetId: "w2", questionIndex: 0, studentAnswer: "27556.0" }, // right (normalized)
      { worksheetId: "w2", questionIndex: 1, studentAnswer: "0.9411" },  // right (dual-answer)
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 3);
  assert.equal(res.scoreTotal, 5);
  assert.equal(res.perQuestion[0].correct, false);
  assert.equal(res.perQuestion[1].correct, true);
  assert.equal(res.perQuestion[2].correct, false);
  assert.equal(res.perQuestion[3].correct, true);
  assert.equal(res.perQuestion[4].correct, true);
});

test("gradeSubmission: FR whitespace trim", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  const submission = {
    responses: [
      { worksheetId: "w2", questionIndex: 0, studentAnswer: "  27556  " },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 1);
  assert.equal(res.scoreTotal, 1);
});

test("gradeSubmission: mixed worksheet (per-question MC vs FR detection)", () => {
  const assignment = {
    id: "asg1",
    worksheets: [{ id: "wm", title: "Mixed Worksheet" }],
  };
  const catalogByTitle = new Map([
    ["Mixed Worksheet", {
      title: "Mixed Worksheet",
      answerFormat: "mixed",
      questionIds: ["m1", "m2", "m3", "m4"],
    }],
  ]);
  const questionKeysById = new Map([
    ["m1", { correctAnswer: "C" }],           // MC
    ["m2", { correctAnswer: "42" }],          // FR numeric
    ["m3", { correctAnswer: "D" }],           // MC
    ["m4", { correctAnswer: ".5, 1/2" }],     // FR grid-in dual
  ]);
  const submission = {
    responses: [
      { worksheetId: "wm", questionIndex: 0, studentAnswer: "C" },
      { worksheetId: "wm", questionIndex: 1, studentAnswer: "42" },
      { worksheetId: "wm", questionIndex: 2, studentAnswer: "A" }, // wrong
      { worksheetId: "wm", questionIndex: 3, studentAnswer: "1/2" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 3);
  assert.equal(res.scoreTotal, 4);
});

test("gradeSubmission: unsupported worksheet skipped (not counted)", () => {
  const assignment = {
    id: "asg1",
    worksheets: [
      { id: "w1", title: "MC Worksheet" },
      { id: "wu", title: "Unsupported Worksheet" },
    ],
  };
  const catalogByTitle = new Map([
    ["MC Worksheet", {
      title: "MC Worksheet",
      answerFormat: "multiple-choice",
      questionIds: ["q1"],
    }],
    ["Unsupported Worksheet", {
      title: "Unsupported Worksheet",
      answerFormat: "unsupported",
      questionIds: null,
    }],
  ]);
  const questionKeysById = new Map([["q1", { correctAnswer: "A" }]]);
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A" },
      { worksheetId: "wu", questionIndex: 0, studentAnswer: "anything" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 1);
  assert.equal(res.scoreTotal, 1); // unsupported not counted toward total
  const skip = res.perQuestion.find((p) => p.worksheetId === "wu");
  assert.equal(skip.correct, null);
  assert.equal(skip.skipReason, "unsupported-worksheet");
});

test("gradeSubmission: missing catalog entry skipped", () => {
  const assignment = {
    id: "asg1",
    worksheets: [{ id: "w1", title: "Ghost Worksheet" }],
  };
  const catalogByTitle = new Map(); // empty
  const questionKeysById = new Map();
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "skipped");
  assert.equal(res.reason, "all-questions-unsupported-or-missing");
});

test("gradeSubmission: missing key doc for a question skipped", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  questionKeysById.delete("q2"); // pretend the key is missing
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A" },
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "B" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 1);
  assert.equal(res.scoreTotal, 1); // q2 not counted
  const missing = res.perQuestion.find((p) => p.questionIndex === 1);
  assert.equal(missing.correct, null);
  assert.equal(missing.skipReason, "missing-key");
});

test("gradeSubmission: partial submission with blanks (blanks are wrong)", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A" },
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "" },
      { worksheetId: "w1", questionIndex: 2, studentAnswer: "   " },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 1);
  assert.equal(res.scoreTotal, 3);
  assert.equal(res.perQuestion[1].correct, false);
  assert.equal(res.perQuestion[2].correct, false);
});

test("gradeSubmission: legacy blob shape skipped", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  const submission = {
    responses: [
      { worksheetId: null, questionIndex: 0, studentAnswer: "whatever" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "skipped");
  assert.equal(res.reason, "legacy-blob-shape");
});

test("gradeSubmission: empty responses skipped", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  const submission = { responses: [] };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "skipped");
  assert.equal(res.reason, "no-responses");
});

test("gradeSubmission: assignment with no worksheets skipped", () => {
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A" },
    ],
  };
  const res = gradeSubmission({
    submission,
    assignment: { id: "asg1", worksheets: [] },
    catalogByTitle: new Map(),
    questionKeysById: new Map(),
  });
  assert.equal(res.status, "skipped");
  assert.equal(res.reason, "assignment-has-no-worksheets");
});

// ── Session 18A: per-question flag semantics ─────────────────────────────

test("gradeSubmission: flag='question' counts as incorrect, ignores studentAnswer", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  // Student typed "A" (the correct answer) but flagged with ? — should
  // grade as incorrect because the ? means "I had no clue, leaving blank".
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A", flag: "question" },
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "B" },
      { worksheetId: "w1", questionIndex: 2, studentAnswer: "C" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 2);
  assert.equal(res.scoreTotal, 3);
  assert.equal(res.perQuestion[0].correct, false);
  assert.equal(res.perQuestion[0].flag, "question");
  assert.equal(res.perQuestion[1].correct, true);
  assert.equal(res.perQuestion[1].flag, null);
});

test("gradeSubmission: flag='star' has no grading effect, just passes through", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  // Student got Q1 right and starred it; got Q2 wrong and starred it.
  // Star is informational — doesn't change the grade either way.
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A", flag: "star" },
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "X", flag: "star" },
      { worksheetId: "w1", questionIndex: 2, studentAnswer: "C" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 2);
  assert.equal(res.scoreTotal, 3);
  assert.equal(res.perQuestion[0].correct, true);
  assert.equal(res.perQuestion[0].flag, "star");
  assert.equal(res.perQuestion[1].correct, false);
  assert.equal(res.perQuestion[1].flag, "star");
  assert.equal(res.perQuestion[2].flag, null);
});

test("gradeSubmission: legacy submissions without flag field grade normally", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  // Backward compat: nothing on the response has `flag`. All perQuestion
  // entries get flag: null and the grade is identical to pre-Session-18A.
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A" },
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "B" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 2);
  assert.equal(res.scoreTotal, 2);
  for (const pq of res.perQuestion) {
    assert.equal(pq.flag, null);
  }
});

// ── Session 18A: even/odd subset semantics ───────────────────────────────

test("gradeSubmission: subset='ODD' grades only odd display numbers (indices 0,2)", () => {
  const { catalogByTitle, questionKeysById } = makeFixture();
  // assignment.worksheets[0] is "MC Worksheet" but with evenOdd: "ODD".
  // Student supplies answers for all 3 — only display Q1 (idx 0) and
  // Q3 (idx 2) should count. Q2 (idx 1) is skipped as not-in-subset.
  const assignment = {
    id: "asg1",
    worksheets: [{ id: "w1", title: "MC Worksheet", evenOdd: "ODD" }],
  };
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A" }, // display 1 — in subset, correct
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "B" }, // display 2 — NOT in subset (skipped)
      { worksheetId: "w1", questionIndex: 2, studentAnswer: "X" }, // display 3 — in subset, wrong
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 1);
  assert.equal(res.scoreTotal, 2); // only 2 questions counted
  assert.equal(res.perQuestion[0].correct, true);
  assert.equal(res.perQuestion[1].correct, null);
  assert.equal(res.perQuestion[1].skipReason, "not-in-subset");
  assert.equal(res.perQuestion[2].correct, false);
});

test("gradeSubmission: subset='EVEN' grades only even display numbers (idx 1)", () => {
  const { catalogByTitle, questionKeysById } = makeFixture();
  const assignment = {
    id: "asg1",
    worksheets: [{ id: "w1", title: "MC Worksheet", evenOdd: "EVEN" }],
  };
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A" }, // display 1 — NOT in subset
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "B" }, // display 2 — in subset, correct
      { worksheetId: "w1", questionIndex: 2, studentAnswer: "Z" }, // display 3 — NOT in subset
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.status, "graded");
  assert.equal(res.scoreCorrect, 1);
  assert.equal(res.scoreTotal, 1);
  assert.equal(res.perQuestion[0].skipReason, "not-in-subset");
  assert.equal(res.perQuestion[1].correct, true);
  assert.equal(res.perQuestion[2].skipReason, "not-in-subset");
});

test("gradeSubmission: missing/null subset grades every question (legacy)", () => {
  const { assignment, catalogByTitle, questionKeysById } = makeFixture();
  // assignment from makeFixture has no evenOdd field on its worksheets
  // — every question should count, identical to pre-Session-18A behavior.
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A" },
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "B" },
      { worksheetId: "w1", questionIndex: 2, studentAnswer: "C" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.scoreTotal, 3);
  assert.equal(res.scoreCorrect, 3);
});

test("gradeSubmission: subset + flag interact correctly (?-flagged in-subset still counts as wrong)", () => {
  const { catalogByTitle, questionKeysById } = makeFixture();
  const assignment = {
    id: "asg1",
    worksheets: [{ id: "w1", title: "MC Worksheet", evenOdd: "ODD" }],
  };
  const submission = {
    responses: [
      // In-subset, ?-flagged → counts but as wrong
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A", flag: "question" },
      // NOT in subset → skipped regardless of flag
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "B", flag: "star" },
      // In-subset, no flag, correct
      { worksheetId: "w1", questionIndex: 2, studentAnswer: "C" },
    ],
  };
  const res = gradeSubmission({ submission, assignment, catalogByTitle, questionKeysById });
  assert.equal(res.scoreTotal, 2);
  assert.equal(res.scoreCorrect, 1);
  assert.equal(res.perQuestion[0].correct, false);
  assert.equal(res.perQuestion[0].flag, "question");
  assert.equal(res.perQuestion[1].skipReason, "not-in-subset");
  assert.equal(res.perQuestion[1].flag, "star"); // flag preserved on skip
  assert.equal(res.perQuestion[2].correct, true);
});

test("gradeSubmission: flag preserved on missing-key skip path", () => {
  const { assignment, catalogByTitle } = makeFixture();
  // Empty questionKeysById — every question hits the missing-key path.
  // Flag should still be on the perQuestion entry for tutor display.
  const submission = {
    responses: [
      { worksheetId: "w1", questionIndex: 0, studentAnswer: "A", flag: "star" },
      { worksheetId: "w1", questionIndex: 1, studentAnswer: "", flag: "question" },
    ],
  };
  const res = gradeSubmission({
    submission,
    assignment,
    catalogByTitle,
    questionKeysById: new Map(),
  });
  assert.equal(res.status, "skipped"); // all-questions-unsupported-or-missing
  // Skipped status doesn't return perQuestion, but the legacy "any
  // graded question" path would; the test exists to flag if that
  // changes. Behavior for now: perQuestion is not returned on skip.
});
