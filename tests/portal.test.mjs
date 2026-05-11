import test from 'node:test';
import assert from 'node:assert/strict';

// Pure helpers copied out of app.jsx for node --test. Keep in sync manually.
// Matches the pattern used by tests/diagnostic.test.mjs.

function pickPortalStudentId(entry){
  if(!entry) return "";
  const ids = Array.isArray(entry.studentIds) ? entry.studentIds : [];
  return ids[0] || "";
}

test('pickPortalStudentId: null entry → empty string', () => {
  assert.equal(pickPortalStudentId(null), "");
});

test('pickPortalStudentId: missing studentIds → empty string', () => {
  assert.equal(pickPortalStudentId({role:"student"}), "");
});

test('pickPortalStudentId: empty studentIds → empty string', () => {
  assert.equal(pickPortalStudentId({role:"student", studentIds:[]}), "");
});

test('pickPortalStudentId: single studentId → that id', () => {
  assert.equal(pickPortalStudentId({role:"student", studentIds:["abc123"]}), "abc123");
});

test('pickPortalStudentId: multiple studentIds → first one (Session 4 adds switcher)', () => {
  assert.equal(pickPortalStudentId({role:"parent", studentIds:["kid1","kid2"]}), "kid1");
});

function pickParentSelectedChildId(entry, storedId){
  if(!entry) return "";
  const ids = Array.isArray(entry.studentIds) ? entry.studentIds : [];
  if(ids.length === 0) return "";
  if(ids.length === 1) return ids[0];
  if(storedId && ids.includes(storedId)) return storedId;
  return ids[0];
}

test('pickParentSelectedChildId: null entry → empty', () => {
  assert.equal(pickParentSelectedChildId(null, "anything"), "");
});

test('pickParentSelectedChildId: missing studentIds → empty', () => {
  assert.equal(pickParentSelectedChildId({role:"parent"}, "x"), "");
});

test('pickParentSelectedChildId: empty studentIds → empty', () => {
  assert.equal(pickParentSelectedChildId({role:"parent", studentIds:[]}, "x"), "");
});

test('pickParentSelectedChildId: single child → that id regardless of stored', () => {
  assert.equal(
    pickParentSelectedChildId({role:"parent", studentIds:["only1"]}, "ignored"),
    "only1"
  );
});

test('pickParentSelectedChildId: multi + stored matches → stored', () => {
  assert.equal(
    pickParentSelectedChildId({role:"parent", studentIds:["kid1","kid2","kid3"]}, "kid2"),
    "kid2"
  );
});

test('pickParentSelectedChildId: multi + no stored → first', () => {
  assert.equal(
    pickParentSelectedChildId({role:"parent", studentIds:["kid1","kid2"]}, ""),
    "kid1"
  );
});

test('pickParentSelectedChildId: multi + stale stored → first (fallback)', () => {
  assert.equal(
    pickParentSelectedChildId({role:"parent", studentIds:["kid1","kid2"]}, "removedKid"),
    "kid1"
  );
});

// Operates on a synthetic __pts array shaped like allScoreDataPoints output.
// The real buildScoreTrendsSeries in app.jsx calls allScoreDataPoints(student);
// here we inject __pts directly so we can unit-test the filter+sort logic.
function buildScoreTrendsSeries(student){
  const isFull = (cat)=> /Total SAT|R&W Section|Math Section|Full —|Section —|Practice|Official SAT|Full Practice|BlueBook|WellEd Full/i.test(cat||"");
  return (student.__pts || [])
    .filter(pt => isFull(pt.category) && pt.level!=="domain" && pt.level!=="sub")
    .filter(pt => pt.date && typeof pt.score==="number" && !Number.isNaN(pt.score))
    .map(pt => ({date: pt.date, score: pt.score, label: pt.category||"Exam"}))
    .sort((a,b)=> a.date.localeCompare(b.date));
}

test('buildScoreTrendsSeries: filters non-full points', () => {
  const out = buildScoreTrendsSeries({__pts:[
    {date:"2026-01-01", score:1200, category:"Total SAT Practice"},
    {date:"2026-01-02", score:80,   category:"Information & Ideas", level:"domain"},
    {date:"2026-01-03", score:70,   category:"Inference", level:"sub"},
  ]});
  assert.equal(out.length, 1);
  assert.equal(out[0].score, 1200);
});

test('buildScoreTrendsSeries: drops dateless/NaN points', () => {
  const out = buildScoreTrendsSeries({__pts:[
    {date:"",           score:1200, category:"Total SAT Practice"},
    {date:"2026-02-01", score:NaN,  category:"Total SAT Practice"},
    {date:"2026-03-01", score:1250, category:"Total SAT Practice"},
  ]});
  assert.equal(out.length, 1);
  assert.equal(out[0].date, "2026-03-01");
});

test('buildScoreTrendsSeries: sorts ascending by date', () => {
  const out = buildScoreTrendsSeries({__pts:[
    {date:"2026-03-01", score:1300, category:"Total SAT Practice"},
    {date:"2026-01-01", score:1200, category:"Total SAT Practice"},
    {date:"2026-02-01", score:1250, category:"Total SAT Practice"},
  ]});
  assert.deepEqual(out.map(p=>p.date), ["2026-01-01","2026-02-01","2026-03-01"]);
});

function pickLatestSubmission(docs){
  if(!Array.isArray(docs) || docs.length === 0) return null;
  const draft = docs.find(d => d && d.status === "draft");
  if(draft) return draft;
  const submitted = docs.filter(d => d && d.status === "submitted");
  if(submitted.length === 0) return null;
  const ms = (d) => {
    const t = d.submittedAt;
    if(!t) return 0;
    if(typeof t.toMillis === "function") return t.toMillis();
    if(typeof t === "string") return Date.parse(t) || 0;
    if(typeof t === "number") return t;
    return 0;
  };
  return submitted.slice().sort((a,b)=> ms(b) - ms(a))[0];
}

test('pickLatestSubmission: empty → null', () => {
  assert.equal(pickLatestSubmission([]), null);
});

test('pickLatestSubmission: null input → null', () => {
  assert.equal(pickLatestSubmission(null), null);
});

test('pickLatestSubmission: single draft → draft', () => {
  const d = {id:"a", status:"draft"};
  assert.equal(pickLatestSubmission([d]), d);
});

test('pickLatestSubmission: draft + submitted → draft wins', () => {
  const draft = {id:"a", status:"draft"};
  const sub = {id:"b", status:"submitted", submittedAt:"2026-04-10T00:00:00Z"};
  assert.equal(pickLatestSubmission([sub, draft]), draft);
});

test('pickLatestSubmission: two submitted → most recent', () => {
  const older = {id:"a", status:"submitted", submittedAt:"2026-01-01T00:00:00Z"};
  const newer = {id:"b", status:"submitted", submittedAt:"2026-04-01T00:00:00Z"};
  assert.equal(pickLatestSubmission([older, newer]).id, "b");
});

test('pickLatestSubmission: only submitted, missing submittedAt → first non-null', () => {
  const a = {id:"a", status:"submitted"};
  const out = pickLatestSubmission([a]);
  assert.equal(out.id, "a");
});

function canSubmitDraft(submission){
  if(!submission) return false;
  if(submission.status !== "draft") return false;
  if(!Array.isArray(submission.responses)) return false;
  for(const r of submission.responses){
    const text = (r && typeof r.studentAnswer === "string") ? r.studentAnswer.trim() : "";
    if(text.length > 0) return true;
  }
  return false;
}

test('canSubmitDraft: null → false', () => {
  assert.equal(canSubmitDraft(null), false);
});

test('canSubmitDraft: submitted status → false', () => {
  assert.equal(canSubmitDraft({status:"submitted", responses:[{questionIndex:0, studentAnswer:"x"}]}), false);
});

test('canSubmitDraft: draft with empty answer → false', () => {
  assert.equal(canSubmitDraft({status:"draft", responses:[{questionIndex:0, studentAnswer:"   "}]}), false);
});

test('canSubmitDraft: draft with missing responses → false', () => {
  assert.equal(canSubmitDraft({status:"draft"}), false);
});

test('canSubmitDraft: draft with content → true', () => {
  assert.equal(canSubmitDraft({status:"draft", responses:[{questionIndex:0, studentAnswer:"1. B\n2. C"}]}), true);
});

// FieldValue stub so the test file can run without firebase-admin.
const SERVER_TS = Symbol("server-ts");
const FIELD_VALUE_STUB = { serverTimestamp: () => SERVER_TS };

// Kept in sync with the canonical implementation in app.jsx.
// Session 18A: flagsByWorksheet added (parallel shape to answersByWorksheet).
function makeDraftPayload({assignmentId, answersText, answersByWorksheet, flagsByWorksheet, catalogByWorksheetId, isCreate, FieldValue}){
  let responses;
  if(answersByWorksheet && catalogByWorksheetId){
    responses = [];
    for(const wId of Object.keys(answersByWorksheet)){
      const answers = answersByWorksheet[wId] || [];
      const flags = (flagsByWorksheet && flagsByWorksheet[wId]) || [];
      const expectedLength = catalogByWorksheetId[wId]?.questionIds?.length ?? answers.length;
      for(let i=0; i<expectedLength; i++){
        const flag = flags[i] === "star" || flags[i] === "question" ? flags[i] : null;
        responses.push({
          worksheetId: wId,
          questionIndex: i,
          studentAnswer: typeof answers[i] === "string" ? answers[i] : "",
          flag,
        });
      }
    }
  } else {
    responses = [{worksheetId: null, questionIndex: 0, studentAnswer: answersText || "", flag: null}];
  }
  const base = {
    assignmentId,
    responses,
    status: "draft",
    updatedAt: FieldValue.serverTimestamp(),
  };
  if(isCreate){
    base.createdAt = FieldValue.serverTimestamp();
  }
  return base;
}

test('makeDraftPayload: create sets createdAt + updatedAt', () => {
  const p = makeDraftPayload({assignmentId:"asg1", answersText:"1. B", isCreate:true, FieldValue:FIELD_VALUE_STUB});
  assert.equal(p.assignmentId, "asg1");
  assert.equal(p.status, "draft");
  assert.equal(p.responses.length, 1);
  assert.equal(p.responses[0].questionIndex, 0);
  assert.equal(p.responses[0].studentAnswer, "1. B");
  assert.equal(p.createdAt, SERVER_TS);
  assert.equal(p.updatedAt, SERVER_TS);
});

test('makeDraftPayload: update has updatedAt but no createdAt', () => {
  const p = makeDraftPayload({assignmentId:"asg1", answersText:"x", isCreate:false, FieldValue:FIELD_VALUE_STUB});
  assert.equal(p.createdAt, undefined);
  assert.equal(p.updatedAt, SERVER_TS);
});

test('makeDraftPayload: empty answer still produces a response entry', () => {
  const p = makeDraftPayload({assignmentId:"asg1", answersText:"", isCreate:true, FieldValue:FIELD_VALUE_STUB});
  assert.equal(p.responses[0].studentAnswer, "");
});

test('makeDraftPayload: status is always "draft" (never submitted)', () => {
  const p = makeDraftPayload({assignmentId:"asg1", answersText:"anything", isCreate:false, FieldValue:FIELD_VALUE_STUB});
  assert.equal(p.status, "draft");
});

test('makeDraftPayload: legacy shape sets worksheetId null', () => {
  const p = makeDraftPayload({assignmentId:"asg1", answersText:"1. B", isCreate:false, FieldValue:FIELD_VALUE_STUB});
  assert.equal(p.responses[0].worksheetId, null);
  assert.equal(p.responses[0].questionIndex, 0);
  assert.equal(p.responses[0].studentAnswer, "1. B");
  assert.equal(p.responses[0].flag, null);
});

test('makeDraftPayload: nested shape flattens per-worksheet answers tagged with worksheetId', () => {
  const p = makeDraftPayload({
    assignmentId: "asg2",
    answersByWorksheet: {w1: ["A","B",""], w2: ["42",""]},
    catalogByWorksheetId: {w1: {questionIds: ["q1","q2","q3"]}, w2: {questionIds: ["q4","q5"]}},
    isCreate: false,
    FieldValue: FIELD_VALUE_STUB,
  });
  assert.equal(p.responses.length, 5);
  // Session 18A: every response now carries a `flag` field. When
  // no flags were passed, all default to null.
  assert.deepEqual(p.responses[0], {worksheetId:"w1", questionIndex:0, studentAnswer:"A", flag:null});
  assert.deepEqual(p.responses[1], {worksheetId:"w1", questionIndex:1, studentAnswer:"B", flag:null});
  assert.deepEqual(p.responses[2], {worksheetId:"w1", questionIndex:2, studentAnswer:"", flag:null});
  assert.deepEqual(p.responses[3], {worksheetId:"w2", questionIndex:0, studentAnswer:"42", flag:null});
  assert.deepEqual(p.responses[4], {worksheetId:"w2", questionIndex:1, studentAnswer:"", flag:null});
});

// ── Session 18A: per-question flag passthrough ───────────────────────────

test('makeDraftPayload: flagsByWorksheet passed through into responses', () => {
  const p = makeDraftPayload({
    assignmentId: "asg3",
    answersByWorksheet: {w1: ["A","B","C","D"]},
    flagsByWorksheet: {w1: ["star", "question", null, "star"]},
    catalogByWorksheetId: {w1: {questionIds: ["q1","q2","q3","q4"]}},
    isCreate: false,
    FieldValue: FIELD_VALUE_STUB,
  });
  assert.equal(p.responses.length, 4);
  assert.equal(p.responses[0].flag, "star");
  assert.equal(p.responses[1].flag, "question");
  assert.equal(p.responses[2].flag, null);
  assert.equal(p.responses[3].flag, "star");
});

test('makeDraftPayload: missing flagsByWorksheet defaults every flag to null', () => {
  const p = makeDraftPayload({
    assignmentId: "asg4",
    answersByWorksheet: {w1: ["A","B"]},
    // flagsByWorksheet omitted
    catalogByWorksheetId: {w1: {questionIds: ["q1","q2"]}},
    isCreate: false,
    FieldValue: FIELD_VALUE_STUB,
  });
  assert.equal(p.responses[0].flag, null);
  assert.equal(p.responses[1].flag, null);
});

test('makeDraftPayload: bad flag values get coerced to null', () => {
  // Defense-in-depth: any value other than "star" / "question" → null
  // so a typo or stale field can never poison the grader.
  const p = makeDraftPayload({
    assignmentId: "asg5",
    answersByWorksheet: {w1: ["A","B","C"]},
    flagsByWorksheet: {w1: ["star", "", "bogus"]},
    catalogByWorksheetId: {w1: {questionIds: ["q1","q2","q3"]}},
    isCreate: false,
    FieldValue: FIELD_VALUE_STUB,
  });
  assert.equal(p.responses[0].flag, "star");
  assert.equal(p.responses[1].flag, null);
  assert.equal(p.responses[2].flag, null);
});

test('makeDraftPayload: flag preserved on empty answer', () => {
  // The student can mark "?" without ever typing — the flag is
  // independent of the answer string. Common when they realize
  // they have no clue and want to skip.
  const p = makeDraftPayload({
    assignmentId: "asg6",
    answersByWorksheet: {w1: ["", "A"]},
    flagsByWorksheet: {w1: ["question", null]},
    catalogByWorksheetId: {w1: {questionIds: ["q1","q2"]}},
    isCreate: true,
    FieldValue: FIELD_VALUE_STUB,
  });
  assert.equal(p.responses[0].studentAnswer, "");
  assert.equal(p.responses[0].flag, "question");
  assert.equal(p.responses[1].flag, null);
});

test('canSubmitDraft: nested — true when any entry is non-empty', () => {
  const sub = {
    status: "draft",
    responses: [
      {worksheetId:"w1", questionIndex:0, studentAnswer:""},
      {worksheetId:"w1", questionIndex:1, studentAnswer:"B"},
      {worksheetId:"w2", questionIndex:0, studentAnswer:""},
    ],
  };
  assert.equal(canSubmitDraft(sub), true);
});

test('canSubmitDraft: nested — false when all entries empty or whitespace', () => {
  const sub = {
    status: "draft",
    responses: [
      {worksheetId:"w1", questionIndex:0, studentAnswer:"  "},
      {worksheetId:"w1", questionIndex:1, studentAnswer:""},
      {worksheetId:"w2", questionIndex:0, studentAnswer:"\t"},
    ],
  };
  assert.equal(canSubmitDraft(sub), false);
});

// ── Session 6: tutor submission review helpers ────────────────────────────

function groupSubmissionsByAssignment(submissions, assignments){
  const byId = new Map();
  const orderIdx = new Map();
  (assignments||[]).forEach((a, i) => {
    if(a && a.id) orderIdx.set(a.id, i);
  });
  (submissions||[]).forEach(s => {
    if(!s) return;
    const key = s.assignmentId || "__orphan__";
    if(!byId.has(key)) byId.set(key, []);
    byId.get(key).push(s);
  });
  const groups = [];
  byId.forEach((subs, key) => {
    const assignment = key === "__orphan__"
      ? null
      : (assignments||[]).find(a => a && a.id === key) || null;
    groups.push({assignment, assignmentId: key, submissions: subs});
  });
  groups.sort((a, b) => {
    const ai = orderIdx.has(a.assignmentId) ? orderIdx.get(a.assignmentId) : -1;
    const bi = orderIdx.has(b.assignmentId) ? orderIdx.get(b.assignmentId) : -1;
    if(ai === -1 && bi === -1) return 0;
    if(ai === -1) return 1;
    if(bi === -1) return -1;
    return bi - ai;
  });
  return groups;
}

test('groupSubmissionsByAssignment: empty input → empty array', () => {
  assert.deepEqual(groupSubmissionsByAssignment([], []), []);
  assert.deepEqual(groupSubmissionsByAssignment(null, null), []);
});

test('groupSubmissionsByAssignment: groups by assignmentId', () => {
  const asgs = [{id:"a1"},{id:"a2"}];
  const subs = [
    {id:"s1", assignmentId:"a1"},
    {id:"s2", assignmentId:"a2"},
    {id:"s3", assignmentId:"a1"},
  ];
  const g = groupSubmissionsByAssignment(subs, asgs);
  assert.equal(g.length, 2);
  const a1 = g.find(x => x.assignmentId === "a1");
  assert.equal(a1.submissions.length, 2);
  assert.equal(a1.assignment.id, "a1");
});

test('groupSubmissionsByAssignment: newest-assignment-first order', () => {
  const asgs = [{id:"a1"},{id:"a2"},{id:"a3"}];
  const subs = [
    {id:"s1", assignmentId:"a1"},
    {id:"s2", assignmentId:"a3"},
    {id:"s3", assignmentId:"a2"},
  ];
  const g = groupSubmissionsByAssignment(subs, asgs);
  assert.deepEqual(g.map(x=>x.assignmentId), ["a3","a2","a1"]);
});

test('groupSubmissionsByAssignment: orphan submissions go in a null-assignment bucket at the end', () => {
  const asgs = [{id:"a1"}];
  const subs = [
    {id:"s1", assignmentId:"a1"},
    {id:"s2", assignmentId:"gone"},
  ];
  const g = groupSubmissionsByAssignment(subs, asgs);
  assert.equal(g.length, 2);
  assert.equal(g[0].assignmentId, "a1");
  assert.equal(g[1].assignment, null);
  assert.equal(g[1].submissions[0].id, "s2");
});

test('groupSubmissionsByAssignment: submissions without assignmentId bucketed as orphans', () => {
  const g = groupSubmissionsByAssignment([{id:"s1"}], [{id:"a1"}]);
  assert.equal(g.length, 1);
  assert.equal(g[0].assignment, null);
});

function isReviewed(sub){
  return sub
    && typeof sub.scoreTotal === "number"
    && sub.scoreTotal > 0
    && typeof sub.scoreCorrect === "number";
}

function summarizeSubmissions(submissions){
  const list = Array.isArray(submissions) ? submissions.filter(Boolean) : [];
  const drafts = list.filter(s => s.status === "draft");
  const submitted = list.filter(s => s.status === "submitted");
  const reviewed = submitted.filter(isReviewed);
  const unreviewed = submitted.filter(s => !isReviewed(s));
  const missed = reviewed.filter(s => s.scoreCorrect < s.scoreTotal);
  const totalQuestions = reviewed.reduce((n,s)=>n + s.scoreTotal, 0);
  const totalCorrect = reviewed.reduce((n,s)=>n + s.scoreCorrect, 0);
  const totalMissed = totalQuestions - totalCorrect;
  const percentCorrect = totalQuestions > 0
    ? Math.round((totalCorrect / totalQuestions) * 100)
    : null;
  return {
    total: list.length,
    submittedCount: submitted.length,
    draftCount: drafts.length,
    reviewedCount: reviewed.length,
    unreviewedCount: unreviewed.length,
    totalQuestions,
    totalCorrect,
    totalMissed,
    percentCorrect,
    missed,
  };
}

test('summarizeSubmissions: empty → zeros and null percent', () => {
  const s = summarizeSubmissions([]);
  assert.equal(s.total, 0);
  assert.equal(s.submittedCount, 0);
  assert.equal(s.reviewedCount, 0);
  assert.equal(s.unreviewedCount, 0);
  assert.equal(s.totalQuestions, 0);
  assert.equal(s.totalCorrect, 0);
  assert.equal(s.totalMissed, 0);
  assert.equal(s.percentCorrect, null);
  assert.deepEqual(s.missed, []);
});

test('summarizeSubmissions: draft excluded from submitted and reviewed', () => {
  const s = summarizeSubmissions([{status:"draft"}]);
  assert.equal(s.total, 1);
  assert.equal(s.draftCount, 1);
  assert.equal(s.submittedCount, 0);
  assert.equal(s.reviewedCount, 0);
  assert.equal(s.unreviewedCount, 0);
});

test('summarizeSubmissions: submitted without scoreTotal is unreviewed', () => {
  const s = summarizeSubmissions([{status:"submitted"}]);
  assert.equal(s.submittedCount, 1);
  assert.equal(s.unreviewedCount, 1);
  assert.equal(s.reviewedCount, 0);
});

test('summarizeSubmissions: aggregates across reviewed submissions', () => {
  const s = summarizeSubmissions([
    {id:"a", status:"submitted", scoreCorrect:10, scoreTotal:10}, // perfect
    {id:"b", status:"submitted", scoreCorrect:7,  scoreTotal:10}, // missed 3
    {id:"c", status:"submitted", scoreCorrect:4,  scoreTotal:8},  // missed 4
    {id:"d", status:"submitted"},                                  // unreviewed
    {id:"e", status:"draft"},                                      // draft
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.submittedCount, 4);
  assert.equal(s.draftCount, 1);
  assert.equal(s.reviewedCount, 3);
  assert.equal(s.unreviewedCount, 1);
  assert.equal(s.totalQuestions, 28);
  assert.equal(s.totalCorrect, 21);
  assert.equal(s.totalMissed, 7);
  assert.equal(s.percentCorrect, 75);
  assert.equal(s.missed.length, 2);
  assert.deepEqual(s.missed.map(x=>x.id), ["b","c"]);
});

test('summarizeSubmissions: perfect score not in missed list', () => {
  const s = summarizeSubmissions([
    {status:"submitted", scoreCorrect:5, scoreTotal:5},
  ]);
  assert.equal(s.reviewedCount, 1);
  assert.equal(s.totalMissed, 0);
  assert.equal(s.percentCorrect, 100);
  assert.deepEqual(s.missed, []);
});

test('summarizeSubmissions: nullish entries filtered', () => {
  const s = summarizeSubmissions([null, undefined, {status:"submitted", scoreCorrect:3, scoreTotal:5}]);
  assert.equal(s.total, 1);
  assert.equal(s.reviewedCount, 1);
  assert.equal(s.totalCorrect, 3);
});

test('summarizeSubmissions: scoreTotal of 0 is not reviewed (guards div-by-zero)', () => {
  const s = summarizeSubmissions([{status:"submitted", scoreCorrect:0, scoreTotal:0}]);
  assert.equal(s.reviewedCount, 0);
  assert.equal(s.unreviewedCount, 1);
});

function formatSubmittedAt(value){
  if(!value) return "";
  if(typeof value === "string") return value.slice(0, 10);
  if(typeof value.toDate === "function"){
    try { return value.toDate().toISOString().slice(0, 10); }
    catch { return ""; }
  }
  if(value instanceof Date) return value.toISOString().slice(0, 10);
  return "";
}

test('formatSubmittedAt: null/undefined → empty', () => {
  assert.equal(formatSubmittedAt(null), "");
  assert.equal(formatSubmittedAt(undefined), "");
});

test('formatSubmittedAt: ISO string truncated to date', () => {
  assert.equal(formatSubmittedAt("2026-04-14T12:34:56.000Z"), "2026-04-14");
});

test('formatSubmittedAt: Firestore Timestamp via toDate', () => {
  const ts = { toDate: () => new Date("2026-03-01T00:00:00Z") };
  assert.equal(formatSubmittedAt(ts), "2026-03-01");
});

test('formatSubmittedAt: JS Date', () => {
  assert.equal(formatSubmittedAt(new Date("2026-01-15T00:00:00Z")), "2026-01-15");
});

test('formatSubmittedAt: junk → empty', () => {
  assert.equal(formatSubmittedAt(42), "");
  assert.equal(formatSubmittedAt({}), "");
});

const DELETE_TS = Symbol("delete-sentinel");
const FIELD_VALUE_STUB_V2 = {
  serverTimestamp: () => SERVER_TS,
  delete: () => DELETE_TS,
};

// Tutor review write payload. Numeric scope: scoreCorrect/scoreTotal
// describe "N correct out of M" per submission. Both null (the "clear" path)
// deletes the fields and reviewedAt so the doc reverts to unreviewed.
// reviewerNotes is always written so empty-string clears propagate cleanly.
function makeReviewPayload({scoreCorrect, scoreTotal, reviewerNotes, FieldValue}){
  const payload = {
    reviewerNotes: typeof reviewerNotes === "string" ? reviewerNotes : "",
  };
  const hasScore = typeof scoreCorrect === "number"
    && typeof scoreTotal === "number"
    && scoreTotal > 0;
  if(hasScore){
    payload.scoreCorrect = Math.max(0, Math.min(scoreCorrect, scoreTotal));
    payload.scoreTotal = scoreTotal;
    payload.reviewedAt = FieldValue.serverTimestamp();
  } else {
    payload.scoreCorrect = FieldValue.delete();
    payload.scoreTotal = FieldValue.delete();
    payload.reviewedAt = FieldValue.delete();
  }
  return payload;
}

test('makeReviewPayload: numeric score sets reviewedAt', () => {
  const p = makeReviewPayload({scoreCorrect:7, scoreTotal:10, reviewerNotes:"nice", FieldValue:FIELD_VALUE_STUB_V2});
  assert.equal(p.scoreCorrect, 7);
  assert.equal(p.scoreTotal, 10);
  assert.equal(p.reviewerNotes, "nice");
  assert.equal(p.reviewedAt, SERVER_TS);
});

test('makeReviewPayload: perfect score preserved', () => {
  const p = makeReviewPayload({scoreCorrect:10, scoreTotal:10, FieldValue:FIELD_VALUE_STUB_V2});
  assert.equal(p.scoreCorrect, 10);
  assert.equal(p.scoreTotal, 10);
});

test('makeReviewPayload: scoreCorrect clamped to [0, scoreTotal]', () => {
  const hi = makeReviewPayload({scoreCorrect:12, scoreTotal:10, FieldValue:FIELD_VALUE_STUB_V2});
  assert.equal(hi.scoreCorrect, 10);
  const lo = makeReviewPayload({scoreCorrect:-3, scoreTotal:10, FieldValue:FIELD_VALUE_STUB_V2});
  assert.equal(lo.scoreCorrect, 0);
});

test('makeReviewPayload: null scores clear all three review fields', () => {
  const p = makeReviewPayload({scoreCorrect:null, scoreTotal:null, reviewerNotes:"", FieldValue:FIELD_VALUE_STUB_V2});
  assert.equal(p.scoreCorrect, DELETE_TS);
  assert.equal(p.scoreTotal, DELETE_TS);
  assert.equal(p.reviewedAt, DELETE_TS);
});

test('makeReviewPayload: scoreTotal of 0 treated as clear (prevents div-by-zero)', () => {
  const p = makeReviewPayload({scoreCorrect:0, scoreTotal:0, FieldValue:FIELD_VALUE_STUB_V2});
  assert.equal(p.scoreCorrect, DELETE_TS);
  assert.equal(p.scoreTotal, DELETE_TS);
});

test('makeReviewPayload: missing reviewerNotes coerced to empty string', () => {
  const p = makeReviewPayload({scoreCorrect:5, scoreTotal:5, FieldValue:FIELD_VALUE_STUB_V2});
  assert.equal(p.reviewerNotes, "");
});

test('makeReviewPayload: reviewerNotes preserved verbatim (including whitespace)', () => {
  const p = makeReviewPayload({scoreCorrect:5, scoreTotal:5, reviewerNotes:"  trailing  ", FieldValue:FIELD_VALUE_STUB_V2});
  assert.equal(p.reviewerNotes, "  trailing  ");
});
