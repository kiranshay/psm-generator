// psm-generator Cloud Functions entry point.
//
// Session 11 scope: reconcileStudentsWithWise (read-only).
// Session 11b adds:  assignToWise, sendStudentMessage (write path, gated
//                    on WISE_WRITE_ENABLED; redirect to DEV_TEST_RECIPIENT_EMAIL
//                    when the gate is false).
// Session 15 adds:   onSubmissionSubmit Firestore trigger for auto-grading
//                    + flag-gated Wise score post-back.
//
// Session 16 migrated assignToWise from the Wise chat API to the discussion
// (announcement) API. Score post-backs were removed in Session 15.

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions/v2");

const {
  ALL_WISE_SECRETS,
  WISE_WRITE_ENABLED,
  APP_BASE_URL,
  DEV_TEST_RECIPIENT_EMAIL,
  DEV_TEST_CLASS_ID,
  DEV_TEST_SECTION_ID,
  wiseConfig,
} = require("./config");
const { verifyCallerIsAdmin, verifyCallerIsTutor } = require("./auth");
const {
  userByIdentifierEmail,
  resolveWiseUserIdByEmail,
  ensureAdminChat,
  sendChatMessage,
  resolveClassForStudent,
  listAllInstituteStudents,
  getContentTimeline,
  resolvePsmSectionId,
  createAssignment,
  createDiscussion,
} = require("./wise");
const { gradeSubmission, gradeWorksheetSubmission } = require("./grade");

admin.initializeApp();

// ── Catalog loader (lazy, module-scoped cache) ────────────────────────────
//
// worksheets_catalog.json is the Hosting static asset at project root,
// copied into functions/ at deploy time via firebase.json predeploy hook.
// Load once per cold start, build the title→row Map, reuse for every
// trigger invocation.
//
// Returns null if the file is missing (e.g. local emulator without a
// predeploy run). The trigger treats a missing catalog as "skip grading."

let _catalogByTitleCache = null;
let _catalogLoadAttempted = false;

function loadCatalogByTitle() {
  if (_catalogByTitleCache) return _catalogByTitleCache;
  if (_catalogLoadAttempted) return null;
  _catalogLoadAttempted = true;
  try {
    const p = path.join(__dirname, "worksheets_catalog.json");
    const raw = fs.readFileSync(p, "utf8");
    const rows = JSON.parse(raw);
    const map = new Map();
    for (const row of rows) {
      if (row && row.title) map.set(row.title, row);
    }
    _catalogByTitleCache = map;
    logger.info("catalog loaded", { rows: rows.length, titles: map.size });
    return map;
  } catch (err) {
    logger.error("catalog load failed", { error: err.message });
    return null;
  }
}

// ── reconcileStudentsWithWise ─────────────────────────────────────────────
//
// Admin-only. Walks every /students/{id} doc, reads meta.email, and for
// each student hits Wise `userByIdentifier?provider=EMAIL` to answer:
// does this student exist in Wise, and if so does the email on the Wise
// user record match the email we sent?
//
// Read-only. Never writes to Firestore, never writes to Wise. Produces a
// report the caller reviews by hand; Kiran decides what to do about each
// gap (create the Wise user manually, fix the email on our side, etc.).
//
// Not auto-run on a schedule — invoked manually by an admin via the
// client-side `lib/wise.js` wrapper (to be added in a follow-up step).
//
// Rate limit: 500 calls/min per Wise API key. With ~51 students the
// sequential loop finishes in a few seconds; no throttling required.
//
// Returns:
//   {
//     totals: { students, withEmail, matched, unmatched, emailMismatched, errors },
//     students: [
//       {
//         studentId, name, email,
//         status: "matched" | "unmatched" | "email-mismatched" | "no-email" | "error",
//         wiseUserId?, wiseEmail?, errorMessage?
//       }, ...
//     ],
//     runAt: ISO timestamp,
//   }

exports.reconcileStudentsWithWise = onCall(
  {
    region: "us-central1",
    secrets: ALL_WISE_SECRETS,
    // Hard concurrency cap: this function is invoked by hand, never in a
    // hot loop. maxInstances:1 also prevents a runaway from fanning out.
    maxInstances: 1,
    timeoutSeconds: 300,
  },
  async (request) => {
    await verifyCallerIsAdmin(request);

    const cfg = wiseConfig();
    const db = admin.firestore();
    const snap = await db.collection("students").get();

    const results = [];
    const totals = {
      students: snap.size,
      withEmail: 0,
      matched: 0,
      unmatched: 0,
      emailMismatched: 0,
      noEmail: 0,
      errors: 0,
    };

    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const name = d.name || "(unnamed)";
      const rawEmail = (d.meta && d.meta.email) || "";
      const email = rawEmail.trim().toLowerCase();

      if (!email) {
        totals.noEmail++;
        results.push({
          studentId: doc.id,
          name,
          email: "",
          status: "no-email",
        });
        continue;
      }

      totals.withEmail++;

      try {
        const lookup = await userByIdentifierEmail(cfg, email);
        if (!lookup.found) {
          totals.unmatched++;
          results.push({
            studentId: doc.id,
            name,
            email,
            status: "unmatched",
          });
          continue;
        }

        const wiseEmail = (lookup.user.email || "").trim().toLowerCase();
        if (wiseEmail && wiseEmail !== email) {
          totals.emailMismatched++;
          results.push({
            studentId: doc.id,
            name,
            email,
            status: "email-mismatched",
            wiseUserId: lookup.user._id,
            wiseEmail: lookup.user.email,
          });
          continue;
        }

        totals.matched++;
        results.push({
          studentId: doc.id,
          name,
          email,
          status: "matched",
          wiseUserId: lookup.user._id,
          wiseEmail: lookup.user.email,
        });
      } catch (err) {
        totals.errors++;
        logger.error("reconcile: wise lookup failed", {
          studentId: doc.id,
          email,
          error: err.message,
        });
        results.push({
          studentId: doc.id,
          name,
          email,
          status: "error",
          errorMessage: err.message,
        });
      }
    }

    logger.info("reconcile: complete", totals);

    return {
      totals,
      students: results,
      runAt: new Date().toISOString(),
    };
  }
);

// ── Write-path helpers (shared between assignToWise + sendStudentMessage) ──
//
// Resolve the actual Wise user id to send to, applying the
// DEV_TEST_RECIPIENT_EMAIL redirect when WISE_WRITE_ENABLED is false.
//
// Behavior matrix:
//   WISE_WRITE_ENABLED=true  →  send to the real student. Student's email is
//                               resolved via Wise; result is cached on the
//                               student doc as `wiseUserId` on first resolve.
//   WISE_WRITE_ENABLED=false →  send to DEV_TEST_RECIPIENT_EMAIL. Student's
//                               `wiseUserId` is NOT cached (we didn't actually
//                               look up the student). The real student record
//                               is never touched on Wise in this mode.
//
// If the gate is false and DEV_TEST_RECIPIENT_EMAIL is blank/unresolvable,
// this throws — we refuse to fail-open onto a real student.
//
// Returns: { wiseUserId, mode: "real" | "dev-redirect", redirectedFrom? }
async function resolveRecipient(cfg, studentDoc) {
  const writeEnabled = WISE_WRITE_ENABLED.value() === true;

  if (!writeEnabled) {
    const devEmail = (DEV_TEST_RECIPIENT_EMAIL.value() || "").trim().toLowerCase();
    if (!devEmail) {
      throw new HttpsError(
        "failed-precondition",
        "WISE_WRITE_ENABLED is false and DEV_TEST_RECIPIENT_EMAIL is not set. " +
        "Refusing to send to the real student."
      );
    }
    const devWiseId = await resolveWiseUserIdByEmail(cfg, devEmail);
    if (!devWiseId) {
      throw new HttpsError(
        "failed-precondition",
        `DEV_TEST_RECIPIENT_EMAIL ${devEmail} was not found on Wise. ` +
        "Cannot redirect dev-mode Wise write."
      );
    }
    return {
      wiseUserId: devWiseId,
      mode: "dev-redirect",
      redirectedFrom: ((studentDoc && studentDoc.meta && studentDoc.meta.email) || "").toLowerCase() || null,
    };
  }

  // Real send. Use cached wiseUserId if present on the student doc, else
  // look up by email and let the caller write the cache back.
  if (studentDoc && studentDoc.wiseUserId) {
    return { wiseUserId: studentDoc.wiseUserId, mode: "real" };
  }
  const email = (studentDoc && studentDoc.meta && studentDoc.meta.email || "").trim().toLowerCase();
  if (!email) {
    throw new HttpsError(
      "failed-precondition",
      "Student has no email on file; cannot resolve Wise user."
    );
  }
  const wiseUserId = await resolveWiseUserIdByEmail(cfg, email);
  if (!wiseUserId) {
    throw new HttpsError(
      "not-found",
      `No Wise user found for ${email}.`
    );
  }
  return { wiseUserId, mode: "real" };
}

// ── assignToWise ──────────────────────────────────────────────────────────
//
// Tutor-only. Given { studentId, assignmentId }, posts a Wise discussion
// (announcement) to the student's 1:1 class with a deep link back into
// the portal. NOT idempotent at the discussion level — calling twice
// creates two discussions, by design (a tutor re-assigning should produce
// a fresh notification).
//
// Session 16 migrated this from the chat API (ensureAdminChat +
// sendChatMessage) to the discussion API (createDiscussion), posting a
// discussion to the student's 1:1 class with the full PSM instruction
// text and a deep link to the portal.
//
// Dev-mode behavior: when WISE_WRITE_ENABLED=false, the discussion posts
// to DEV_TEST_CLASS_ID. Real student records on Wise are never touched.
//
// Returns: { ok: true, mode, classId, deepLink }

function buildPsmDescription(deepLink, worksheets, practiceExams) {
  const lines = [
    `The recording of today's session has been posted on Wise. Please complete the following worksheets using the PSM instructions posted in the PSMs modules.`,
    ``,
    `<b>Important Reminder:</b> Please book your next session in advance, timing it for when you expect to have these PSMs completed. After completing the worksheets, check and mark your work according to the PSM instructions, then upload your marked work as a comment to this PSMs assignment.`,
    ``,
    `<b>Portal Link:</b> ${deepLink}`,
  ];

  if (worksheets.length > 0) {
    lines.push(``, `<b>Worksheets:</b>`, ``);
    worksheets.forEach((w) => {
      // Session 18A: surface even/odd subset assignment so the student
      // knows up front which half of the worksheet they're responsible
      // for. The portal hides answer slots for the other half — Wise
      // discussion mirrors that with a "(odd questions only)" hint.
      const eo = String(w.evenOdd || "").toUpperCase();
      const suffix = eo === "EVEN"
        ? " — even questions only"
        : eo === "ODD"
          ? " — odd questions only"
          : "";
      lines.push(`  • ${w.title}${suffix}`);
    });
  }

  const bbExams = practiceExams.filter((e) => e.platform === "BlueBook");
  const weExams = practiceExams.filter((e) => e.platform === "WellEd");

  if (bbExams.length > 0 || weExams.length > 0) {
    lines.push(``, `<b>Practice Exams:</b>`);
  }

  if (bbExams.length > 0) {
    lines.push(
      ``,
      `Please complete the following on <b>BlueBook (College Board)</b> using the instructions for BlueBook (College Board) practice exams located in your Wise "Full Practice Exam Instructions" Module - https://bluebook.app.collegeboard.org/. Be sure to follow instructions regarding screenshots of missed questions!`,
      ``
    );
    bbExams.forEach((e) => lines.push(`  • Practice Exam #${e.number || "?"}`));
  }

  if (weExams.length > 0) {
    lines.push(
      ``,
      `Please complete the following on <b>WellEd Labs</b> using the instructions for WellEd Labs practice exams located in your Wise "Full Practice Exam Instructions" Module - https://ats.practicetest.io/sign-in.`,
      ``
    );
    weExams.forEach((e) => lines.push(`  • Practice Exam #${e.number || "?"}`));
  }

  return lines.join("\n");
}

exports.assignToWise = onCall(
  {
    region: "us-central1",
    secrets: ALL_WISE_SECRETS,
    maxInstances: 5,
    timeoutSeconds: 60,
  },
  async (request) => {
    await verifyCallerIsTutor(request);

    const { studentId, assignmentId } = request.data || {};
    if (!studentId || typeof studentId !== "string") {
      throw new HttpsError("invalid-argument", "studentId is required.");
    }
    if (!assignmentId || typeof assignmentId !== "string") {
      throw new HttpsError("invalid-argument", "assignmentId is required.");
    }

    const cfg = wiseConfig();
    const db = admin.firestore();
    const studentRef = db.collection("students").doc(studentId);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists) {
      throw new HttpsError("not-found", `Student ${studentId} not found.`);
    }
    const student = studentSnap.data() || {};

    const assignments = Array.isArray(student.assignments) ? student.assignments : [];
    const assignment = assignments.find((a) => a && a.id === assignmentId);
    if (!assignment) {
      throw new HttpsError(
        "not-found",
        `Assignment ${assignmentId} not found on student ${studentId}.`
      );
    }

    const baseUrl = (APP_BASE_URL.value() || "").replace(/\/+$/, "");
    const deepLink = `${baseUrl}/?a=${encodeURIComponent(assignmentId)}&s=${encodeURIComponent(studentId)}`;

    const writeEnabled = WISE_WRITE_ENABLED.value() === true;
    let classId;
    let mode;

    if (!writeEnabled) {
      const devClassId = (DEV_TEST_CLASS_ID.value() || "").trim();
      if (!devClassId) {
        throw new HttpsError(
          "failed-precondition",
          "WISE_WRITE_ENABLED is false and DEV_TEST_CLASS_ID is not set."
        );
      }
      classId = devClassId;
      mode = "dev-redirect";
    } else {
      if (student.wiseClassId) {
        classId = student.wiseClassId;
      } else {
        const recipient = await resolveRecipient(cfg, student);
        if (recipient.mode === "real" && !student.wiseUserId) {
          await studentRef.update({ wiseUserId: recipient.wiseUserId });
        }
        classId = await resolveClassForStudent(cfg, recipient.wiseUserId);
        if (!classId) {
          throw new HttpsError(
            "not-found",
            `No Wise class found for student ${studentId}.`
          );
        }
        await studentRef.update({ wiseClassId: classId });
      }
      mode = "real";
    }

    const sessionDate = assignment.date || "";
    const discussionTitle = sessionDate ? `PSM for ${sessionDate}` : "New PSM Assignment";
    const worksheets = Array.isArray(assignment.worksheets) ? assignment.worksheets : [];
    const practiceExams = Array.isArray(assignment.practiceExams) ? assignment.practiceExams : [];
    const description = buildPsmDescription(deepLink, worksheets, practiceExams);

    await createDiscussion(cfg, classId, {
      title: discussionTitle,
      description,
    });

    logger.info("assignToWise: discussion posted", {
      studentId,
      assignmentId,
      mode,
      classId,
    });

    return {
      ok: true,
      mode,
      classId,
      deepLink,
    };
  }
);

// ── listClassSections (temporary, admin-only, for section ID lookup) ─────
exports.listClassSections = onCall(
  { region: "us-central1", secrets: ALL_WISE_SECRETS, maxInstances: 1 },
  async (request) => {
    await verifyCallerIsAdmin(request);
    const { classId } = request.data || {};
    if (!classId) throw new HttpsError("invalid-argument", "classId required");
    const cfg = wiseConfig();
    const sections = await getContentTimeline(cfg, classId);
    return sections.map((s) => ({ id: s._id, name: s.name, entityCount: (s.entities || []).length }));
  }
);

// ── sendStudentMessage ────────────────────────────────────────────────────
//
// Tutor-only. Thin wrapper around Wise sendMessage for ad-hoc tutor notes.
// Same dev-mode redirect as assignToWise — per Session 11b decision #2,
// both functions apply the DEV_TEST_RECIPIENT_EMAIL override symmetrically.
//
// Returns: { ok: true, mode, chatId, messageId, reusedChat }
exports.sendStudentMessage = onCall(
  {
    region: "us-central1",
    secrets: ALL_WISE_SECRETS,
    maxInstances: 5,
    timeoutSeconds: 60,
  },
  async (request) => {
    await verifyCallerIsTutor(request);

    const { studentId, text } = request.data || {};
    if (!studentId || typeof studentId !== "string") {
      throw new HttpsError("invalid-argument", "studentId is required.");
    }
    if (!text || typeof text !== "string" || !text.trim()) {
      throw new HttpsError("invalid-argument", "text is required.");
    }
    if (text.length > 4000) {
      throw new HttpsError("invalid-argument", "text exceeds 4000 chars.");
    }

    const cfg = wiseConfig();
    const db = admin.firestore();
    const studentRef = db.collection("students").doc(studentId);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists) {
      throw new HttpsError("not-found", `Student ${studentId} not found.`);
    }
    const student = studentSnap.data() || {};

    const recipient = await resolveRecipient(cfg, student);

    if (recipient.mode === "real" && !student.wiseUserId) {
      await studentRef.update({ wiseUserId: recipient.wiseUserId });
    }

    const { chatId, reused } = await ensureAdminChat(cfg, recipient.wiseUserId);
    const messageId = await sendChatMessage(cfg, chatId, text);

    logger.info("sendStudentMessage: sent", {
      studentId,
      mode: recipient.mode,
      redirectedFrom: recipient.redirectedFrom || null,
      chatId,
      reusedChat: reused,
      messageId,
    });

    return {
      ok: true,
      mode: recipient.mode,
      chatId,
      messageId,
      reusedChat: reused,
    };
  }
);

// ── onSubmissionSubmit (Session 15) ───────────────────────────────────────
//
// Firestore trigger. Fires on every update to
//   students/{sid}/submissions/{subId}
// and grades iff the update transitioned status draft → submitted.
//
// Idempotent: if `after.gradedAt` is already set, skip. At-least-once
// delivery means this trigger can re-fire after a crash, and we must not
// double-write the score or double-send the Wise post-back.
//
// Security: trigger runs under the function's service account via the
// Admin SDK, which bypasses Firestore rules. The student client cannot
// write scoreCorrect/scoreTotal/perQuestion/gradedAt (see firestore.rules
// line 109's hasOnly clause). This is the intended trust model.
//
// No Wise post-back — Session 15 directive removed it entirely. PSM scores
// live in the portal UI only, never in Wise.
//
// Error handling: grade-write errors throw (trigger will retry). Wise
// post-back errors are logged and swallowed — a failed Wise post must
// NOT un-grade the submission.

exports.onSubmissionSubmit = onDocumentUpdated(
  {
    document: "students/{sid}/submissions/{subId}",
    region: "us-central1",
    // No Wise secrets — Session 15 (Kiran directive) removed the Wise
    // post-back. The trigger only reads/writes Firestore.
    maxInstances: 10,
    timeoutSeconds: 120,
  },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after  = event.data && event.data.after  && event.data.after.data();
    if (!before || !after) {
      logger.warn("onSubmissionSubmit: missing before/after snapshot");
      return;
    }

    // Gate: only grade on draft → submitted transitions.
    if (before.status !== "draft" || after.status !== "submitted") {
      return;
    }

    // Idempotency: don't re-grade if this submission already has a score.
    if (after.gradedAt) {
      logger.info("onSubmissionSubmit: already graded, skipping", {
        sid: event.params.sid,
        subId: event.params.subId,
      });
      return;
    }

    const { sid, subId } = event.params;
    logger.info("onSubmissionSubmit: start", { sid, subId });

    const db = admin.firestore();

    // Load the student doc to find the assignment.
    const studentRef = db.collection("students").doc(sid);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists) {
      logger.error("onSubmissionSubmit: student not found", { sid, subId });
      return;
    }
    const student = studentSnap.data() || {};
    const assignments = Array.isArray(student.assignments) ? student.assignments : [];
    const assignment = assignments.find((a) => a && a.id === after.assignmentId);
    if (!assignment) {
      logger.warn("onSubmissionSubmit: assignment not found on student", {
        sid, subId, assignmentId: after.assignmentId,
      });
      return;
    }

    // Catalog (bundled at deploy time).
    const catalogByTitle = loadCatalogByTitle();
    if (!catalogByTitle) {
      logger.error("onSubmissionSubmit: catalog missing, cannot grade", { sid, subId });
      return;
    }

    // Collect every questionId we need for this submission, then batch-fetch.
    const neededIds = new Set();
    const worksheetById = new Map();
    for (const w of (assignment.worksheets || [])) {
      if (w && w.id) worksheetById.set(w.id, w);
    }
    for (const r of (after.responses || [])) {
      const w = r && worksheetById.get(r.worksheetId);
      if (!w) continue;
      const row = catalogByTitle.get(w.title);
      if (!row || !Array.isArray(row.questionIds)) continue;
      const qi = Number(r.questionIndex);
      if (qi < 0 || qi >= row.questionIds.length) continue;
      const qid = row.questionIds[qi];
      if (qid) neededIds.add(qid);
    }

    const questionKeysById = new Map();
    if (neededIds.size > 0) {
      const refs = Array.from(neededIds).map((id) => db.collection("questionKeys").doc(id));
      const snaps = await db.getAll(...refs);
      for (const s of snaps) {
        if (s.exists) questionKeysById.set(s.id, s.data());
      }
    }

    const result = gradeSubmission({
      submission: after,
      assignment,
      catalogByTitle,
      questionKeysById,
    });

    if (result.status === "skipped") {
      logger.info("onSubmissionSubmit: skipped", { sid, subId, reason: result.reason });
      // Write a minimal marker so the tutor UI can distinguish "not graded
      // because unsupported" from "not graded yet." gradedAt is written so
      // idempotency check fires on re-delivery.
      await event.data.after.ref.update({
        gradedAt: admin.firestore.FieldValue.serverTimestamp(),
        gradeSkipReason: result.reason,
      });
      return;
    }

    // Graded: write back the score fields. Session 15 (Kiran directive):
    // scores are shown in the portal UI only — no Wise post-back. The only
    // Wise write path for PSMs is the assign-time discussion that Session 16
    // will wire up (createAnnouncements), and it's tutor-initiated, not
    // triggered by submissions.
    await event.data.after.ref.update({
      scoreCorrect: result.scoreCorrect,
      scoreTotal:   result.scoreTotal,
      perQuestion:  result.perQuestion,
      gradedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.info("onSubmissionSubmit: graded", {
      sid, subId,
      scoreCorrect: result.scoreCorrect,
      scoreTotal:   result.scoreTotal,
    });
  }
);

// ── onWorksheetSubmissionSubmit (Session 18A) ─────────────────────────────
//
// Per-worksheet grading trigger. Mirrors onSubmissionSubmit but scoped to
// a single worksheet at students/{sid}/assignments/{aid}/worksheetSubmissions/{wsId}.
// Fires only when status flips draft → submitted. Reads the assignment to
// find the worksheet entry (for evenOdd subset), the catalog row, and the
// questionKeys for that worksheet's question IDs, then runs
// gradeWorksheetSubmission and writes the score back to the same doc.
//
// Coexists with the legacy onSubmissionSubmit trigger — only the per-WS
// write path (gated on PER_WORKSHEET_SUBMIT_ENABLED on the client) reaches
// this trigger; legacy writes still go through onSubmissionSubmit.

exports.onWorksheetSubmissionSubmit = onDocumentUpdated(
  {
    document: "students/{sid}/assignments/{aid}/worksheetSubmissions/{wsId}",
    region: "us-central1",
    maxInstances: 10,
    timeoutSeconds: 120,
  },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after  = event.data && event.data.after  && event.data.after.data();
    if (!before || !after) {
      logger.warn("onWorksheetSubmissionSubmit: missing snapshot");
      return;
    }
    if (before.status !== "draft" || after.status !== "submitted") return;
    if (after.gradedAt) {
      logger.info("onWorksheetSubmissionSubmit: already graded, skipping", event.params);
      return;
    }

    const { sid, aid, wsId } = event.params;
    logger.info("onWorksheetSubmissionSubmit: start", { sid, aid, wsId });

    const db = admin.firestore();
    const studentRef = db.collection("students").doc(sid);
    const studentSnap = await studentRef.get();
    if (!studentSnap.exists) {
      logger.error("onWorksheetSubmissionSubmit: student not found", { sid });
      return;
    }
    const student = studentSnap.data() || {};
    const assignment = (student.assignments || []).find((a) => a && a.id === aid);
    if (!assignment) {
      logger.warn("onWorksheetSubmissionSubmit: assignment not found", { sid, aid });
      return;
    }
    const worksheet = (assignment.worksheets || []).find((w) => w && w.id === wsId);
    if (!worksheet) {
      logger.warn("onWorksheetSubmissionSubmit: worksheet not on assignment", { sid, aid, wsId });
      return;
    }

    const catalogByTitle = loadCatalogByTitle();
    if (!catalogByTitle) {
      logger.error("onWorksheetSubmissionSubmit: catalog missing", { sid, aid, wsId });
      return;
    }
    const catalogRow = catalogByTitle.get(worksheet.title);
    if (!catalogRow) {
      await event.data.after.ref.update({
        gradedAt: admin.firestore.FieldValue.serverTimestamp(),
        gradeSkipReason: "no-catalog-row",
      });
      return;
    }

    // Fetch questionKeys for this worksheet's questionIds only.
    const questionKeysById = new Map();
    const qIds = Array.isArray(catalogRow.questionIds) ? catalogRow.questionIds : [];
    if (qIds.length > 0) {
      const refs = qIds.map((id) => db.collection("questionKeys").doc(id));
      const snaps = await db.getAll(...refs);
      for (const s of snaps) {
        if (s.exists) questionKeysById.set(s.id, s.data());
      }
    }

    const result = gradeWorksheetSubmission({
      worksheetSubmission: after,
      worksheet,
      catalogRow,
      questionKeysById,
    });

    if (result.status === "skipped") {
      logger.info("onWorksheetSubmissionSubmit: skipped", { sid, aid, wsId, reason: result.reason });
      await event.data.after.ref.update({
        gradedAt: admin.firestore.FieldValue.serverTimestamp(),
        gradeSkipReason: result.reason,
      });
      return;
    }

    await event.data.after.ref.update({
      status:       "graded",
      scoreCorrect: result.scoreCorrect,
      scoreTotal:   result.scoreTotal,
      perQuestion:  result.perQuestion,
      gradedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.info("onWorksheetSubmissionSubmit: graded", {
      sid, aid, wsId,
      scoreCorrect: result.scoreCorrect,
      scoreTotal:   result.scoreTotal,
    });
  }
);

// ── syncStudentsFromWise (Session 18C) ────────────────────────────────────
//
// Full institute roster sync from Wise API. Admin-only. Replaces the
// manual CSV-export workflow for bulk imports.
//
// Two-phase operation:
//   1. dryRun:true  → returns the plan {toAdd, toUpdate, toTrash, errors}
//                     without writing anything.
//   2. dryRun:false → executes the plan: creates new student docs,
//                     updates wise metadata on existing ones (preserves
//                     assignments/scores/diagnostics/welledLogs),
//                     soft-deletes non-SAT students with source:wise-sync,
//                     and writes/clears their allowlist entries.
//
// SAT match: any of the student classes.name contains "SAT" (case-insensitive).
//
// Existing-data preservation: for any student already in Firestore
// (matched by email or wiseUserId), only meta fields are updated.
// All other fields are left exactly as-is.

exports.syncStudentsFromWise = onCall(
  {
    region: "us-central1",
    secrets: ALL_WISE_SECRETS,
    maxInstances: 1,
    timeoutSeconds: 300,
  },
  async (request) => {
    await verifyCallerIsAdmin(request);
    const dryRun = !!(request.data && request.data.dryRun);

    const cfg = wiseConfig();
    const db = admin.firestore();

    const [wiseStudents, fsSnap] = await Promise.all([
      listAllInstituteStudents(cfg, { pageSize: 100 }),
      db.collection("students").get(),
    ]);

    const fsStudents = fsSnap.docs.map(function(d){ return { id: d.id, ref: d.ref, data: d.data() || {} }; });

    const fsByEmail = new Map();
    const fsByWiseId = new Map();
    for (const fs of fsStudents) {
      const email = ((fs.data.meta && fs.data.meta.email) || "").trim().toLowerCase();
      if (email) fsByEmail.set(email, fs);
      const wiseId = fs.data.wiseUserId || (fs.data.meta && fs.data.meta.wiseUserId);
      if (wiseId) fsByWiseId.set(wiseId, fs);
    }

    const plan = { toAdd: [], toUpdate: [], toTrash: [], errors: [] };
    const seenFsIds = new Set();
    let satCount = 0, nonSatCount = 0;

    for (const w of wiseStudents) {
      const u = (w && w.userId) || {};
      const wiseUserId = u._id || w._id;
      const email = (u.email || "").trim().toLowerCase();
      const name = u.name || "";
      const classes = Array.isArray(w.classes) ? w.classes : [];
      const isSat = classes.some(function(c){ return c && typeof c.name === "string" && /\bSAT\b/i.test(c.name); });

      if (isSat) satCount++; else nonSatCount++;

      if (!isSat) continue;

      const fsHit = (email && fsByEmail.get(email)) || (wiseUserId && fsByWiseId.get(wiseUserId)) || null;

      const satClasses = classes
        .filter(function(c){ return c && /\bSAT\b/i.test(c.name || ""); })
        .map(function(c){ return { id: c._id, name: c.name, subject: c.subject || "" }; });

      if (fsHit) {
        seenFsIds.add(fsHit.id);
        plan.toUpdate.push({
          studentId: fsHit.id,
          name: fsHit.data.name,
          email,
          wiseUserId,
          satClasses,
          updates: {
            wiseUserId,
            wiseClassId: (satClasses[0] && satClasses[0].id) || fsHit.data.wiseClassId || null,
            "meta.email": email || (fsHit.data.meta && fsHit.data.meta.email) || "",
            "meta.wiseUserId": wiseUserId,
            "meta.wiseClasses": satClasses,
            "meta.lastSyncedFromWise": new Date().toISOString(),
          },
        });
      } else {
        plan.toAdd.push({
          name,
          email,
          wiseUserId,
          satClasses,
          dataToWrite: {
            name,
            dateAdded: new Date().toISOString().slice(0, 10),
            wiseUserId,
            wiseClassId: (satClasses[0] && satClasses[0].id) || null,
            meta: {
              email,
              wiseUserId,
              wiseClasses: satClasses,
              source: "wise-sync",
              lastSyncedFromWise: new Date().toISOString(),
              joinedOn: w.joinedOn || "",
            },
            assignments: [],
            scores: [],
            welledLogs: [],
            diagnostics: [],
          },
        });
      }
    }

    const wiseByUserId = new Map();
    for (const w of wiseStudents) {
      const wid = (w.userId && w.userId._id) || w._id;
      if (wid) wiseByUserId.set(wid, w);
    }
    for (const fs of fsStudents) {
      if (fs.id === "__consultation__") continue;
      if (fs.data.deleted) continue;
      const fsSource = (fs.data.meta && fs.data.meta.source) || "";
      if (fsSource !== "wise" && fsSource !== "wise-sync") continue;
      if (seenFsIds.has(fs.id)) continue;

      const wiseId = fs.data.wiseUserId || (fs.data.meta && fs.data.meta.wiseUserId);
      const stillInWise = wiseId && wiseByUserId.has(wiseId);
      const wiseRecord = stillInWise ? wiseByUserId.get(wiseId) : null;
      const stillInSatClass = !!(wiseRecord && (wiseRecord.classes || []).some(function(c){ return /\bSAT\b/i.test(c.name || ""); }));

      if (!stillInSatClass) {
        plan.toTrash.push({
          studentId: fs.id,
          name: fs.data.name,
          email: (fs.data.meta && fs.data.meta.email) || "",
          reason: stillInWise ? "no-longer-in-SAT-class" : "not-found-in-wise",
        });
      }
    }

    const summary = {
      totalWise: wiseStudents.length,
      satCount,
      nonSatCount,
      toAddCount: plan.toAdd.length,
      toUpdateCount: plan.toUpdate.length,
      toTrashCount: plan.toTrash.length,
      errorCount: plan.errors.length,
    };

    logger.info("syncStudentsFromWise: plan built", { dryRun, summary });

    if (dryRun) {
      return { summary, plan, committed: false, runAt: new Date().toISOString() };
    }

    let writes = 0;

    for (const a of plan.toAdd) {
      try {
        const id = a.wiseUserId ? `wise_${a.wiseUserId}` : db.collection("students").doc().id;
        await db.collection("students").doc(id).set(Object.assign({ id }, a.dataToWrite));
        if (a.email) {
          await db.collection("allowlist").doc(a.email).set({
            email: a.email,
            role: "student",
            active: true,
            studentIds: [id],
            source: "wise-sync",
            addedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        writes++;
      } catch (e) {
        plan.errors.push({ kind: "add", name: a.name, message: e.message || String(e) });
      }
    }

    for (const u of plan.toUpdate) {
      try {
        await db.collection("students").doc(u.studentId).update(u.updates);
        if (u.email) {
          await db.collection("allowlist").doc(u.email).set({
            email: u.email,
            role: "student",
            active: true,
            studentIds: admin.firestore.FieldValue.arrayUnion(u.studentId),
            source: "wise-sync",
          }, { merge: true });
        }
        writes++;
      } catch (e) {
        plan.errors.push({ kind: "update", studentId: u.studentId, message: e.message || String(e) });
      }
    }

    for (const t of plan.toTrash) {
      try {
        await db.collection("students").doc(t.studentId).update({
          deleted: true,
          deletedAt: admin.firestore.FieldValue.serverTimestamp(),
          deletedReason: t.reason,
        });
        if (t.email) {
          await db.collection("allowlist").doc(t.email).update({
            active: false,
            revokedAt: admin.firestore.FieldValue.serverTimestamp(),
            revokedReason: t.reason,
          }).catch(function(){ /* allowlist entry may not exist */ });
        }
        writes++;
      } catch (e) {
        plan.errors.push({ kind: "trash", studentId: t.studentId, message: e.message || String(e) });
      }
    }

    logger.info("syncStudentsFromWise: committed", { writes, summary });
    return { summary, plan, committed: true, writes, runAt: new Date().toISOString() };
  },
);
