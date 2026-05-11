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
  getContentTimeline,
  resolvePsmSectionId,
  createAssignment,
  createDiscussion,
} = require("./wise");
const { gradeSubmission } = require("./grade");

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
