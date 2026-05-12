// Single source of truth for all Wise API calls.
//
// Session 11 shipped:   userByIdentifierEmail (read)
// Session 11b adds:     listAllChats, ensureAdminChat, sendChatMessage,
//                       resolveWiseUserIdByEmail
//
// reconcileStudentsWithWise has its own inline call to userByIdentifierEmail
// from Session 11. Intentionally NOT refactoring it this session — see
// Session 11b kickoff "Do NOT touch reconcileStudentsWithWise".

const NAMESPACE_UA_PREFIX = "VendorIntegrations";

function basicAuthHeader(userId, apiKey) {
  const token = Buffer.from(`${userId}:${apiKey}`).toString("base64");
  return `Basic ${token}`;
}

function wiseHeaders(cfg) {
  return {
    "Authorization":   basicAuthHeader(cfg.userId, cfg.apiKey),
    "x-api-key":       cfg.apiKey,
    "x-wise-namespace": cfg.namespace,
    "user-agent":      `${NAMESPACE_UA_PREFIX}/${cfg.namespace}`,
    "Content-Type":    "application/json",
  };
}

// GET /vendors/userByIdentifier?provider=EMAIL&identifier=<urlencoded>
//
// Returns:
//   { found: true,  user: { _id, email, name, ... } }
//   { found: false }                                     // 404 — user not in Wise
//
// Throws on any other non-2xx status so callers see real errors.
async function userByIdentifierEmail(cfg, email) {
  const url = `${cfg.host}/vendors/userByIdentifier`
    + `?provider=EMAIL&identifier=${encodeURIComponent(email)}`;
  const res = await fetch(url, { method: "GET", headers: wiseHeaders(cfg) });

  if (res.status === 404) {
    return { found: false };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Wise userByIdentifier ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const user = body && body.data && body.data.user;
  if (!user) {
    return { found: false };
  }
  return { found: true, user };
}

// Wrapper around userByIdentifierEmail that returns just the Wise user id
// (or null). Used by assignToWise and sendStudentMessage to resolve a
// student email → Wise `_id` before any write. Kept as a separate function
// so the reconcile inline call site in index.js stays untouched.
async function resolveWiseUserIdByEmail(cfg, email) {
  const lookup = await userByIdentifierEmail(cfg, email);
  if (!lookup.found) return null;
  return lookup.user._id || null;
}

// GET /institutes/{institute_id}/chats?chatSection=all_chats&page_number=N&page_size=M
//
// Returns the raw `data.chats` array for the requested page. Callers paginate
// if they need to. Shape of each entry (verified from docs/wise_postman.md
// §"Get All Chats" example response, Session 11b):
//
//   {
//     _id: "<chatId>",
//     chatType: "INSTITUTE" | "CLASSROOM",
//     chatWithId: { _id: "<wiseUserId>", name, profile, profilePicture },
//     instituteId, lastMessage, numParticipants, unreadCount, class
//   }
//
// Note `chatWithId` is an *object* on list responses but a bare string on
// get-by-id / create responses. Callers must handle both.
async function listAllChats(cfg, { pageNumber = 1, pageSize = 50 } = {}) {
  const url = `${cfg.host}/institutes/${cfg.instituteId}/chats`
    + `?page_number=${pageNumber}&page_size=${pageSize}&chatSection=all_chats`;
  const res = await fetch(url, { method: "GET", headers: wiseHeaders(cfg) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Wise listAllChats ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const chats = body && body.data && body.data.chats;
  return Array.isArray(chats) ? chats : [];
}

// POST /institutes/{institute_id}/chats
// Body: { chatType: "INSTITUTE", chatWithId: <wiseUserId> }
//
// Wire-format source: docs/wise_postman.md §"Admin Only Chat with Student"
// (pasted into Session 11b; was missing from Session 11's copy of the doc).
//
// Returns the chat `_id` (string).
async function createAdminChat(cfg, wiseUserId) {
  const url = `${cfg.host}/institutes/${cfg.instituteId}/chats`;
  const res = await fetch(url, {
    method: "POST",
    headers: wiseHeaders(cfg),
    body: JSON.stringify({ chatType: "INSTITUTE", chatWithId: wiseUserId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Wise createAdminChat ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const chatId = body && body.data && body.data.chat && body.data.chat._id;
  if (!chatId) {
    throw new Error("Wise createAdminChat: missing data.chat._id in response");
  }
  return chatId;
}

// Idempotent: scan the first N chats for an existing INSTITUTE (admin-only)
// chat with this Wise user. If none, create one.
//
// pageScanLimit is a safety cap on how many chats we page through before
// giving up and just creating a new one. For an institute with a handful
// of students the first page (50) is plenty; for scale-out it may need
// bumping. Logged (via return value) so callers can surface the scan depth.
//
// Returns: { chatId, reused: boolean }
async function ensureAdminChat(cfg, wiseUserId, { pageScanLimit = 5, pageSize = 50 } = {}) {
  for (let p = 1; p <= pageScanLimit; p++) {
    const chats = await listAllChats(cfg, { pageNumber: p, pageSize });
    if (chats.length === 0) break;
    for (const c of chats) {
      if (c.chatType !== "INSTITUTE") continue;
      // chatWithId is an object in list responses
      const wid = c.chatWithId && (c.chatWithId._id || c.chatWithId);
      if (wid === wiseUserId) {
        return { chatId: c._id, reused: true };
      }
    }
    if (chats.length < pageSize) break; // last page
  }
  const chatId = await createAdminChat(cfg, wiseUserId);
  return { chatId, reused: false };
}

// POST /institutes/{institute_id}/chats/{chatId}/messages
// Body: { message: "<text>" }
//
// Wire-format source: docs/wise_postman.md §"Send a Message" (pasted into
// Session 11b; was missing from Session 11's copy of the doc).
//
// Returns `data.chatMessage._id` (string). Throws on non-2xx.
async function sendChatMessage(cfg, chatId, message) {
  const url = `${cfg.host}/institutes/${cfg.instituteId}/chats/${chatId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: wiseHeaders(cfg),
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Wise sendChatMessage ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const messageId = body && body.data && body.data.chatMessage && body.data.chatMessage._id;
  if (!messageId) {
    throw new Error("Wise sendChatMessage: missing data.chatMessage._id in response");
  }
  return messageId;
}

// ── Discussion (announcement) API — Session 16 ──────────────────────────
//
// Wise "discussions" are the API's "announcements". They live on a class,
// not on a user-to-user chat. The tutor posts a discussion to the
// student's 1:1 class when assigning a new PSM.

// GET /institutes/{institute_id}/classes
//
// Returns all classes for the institute. Each class object includes
// `joinedRequest` (array of enrolled Wise user IDs), which is how we
// resolve a student's wiseUserId → classId.
async function listInstituteClasses(cfg) {
  const url = `${cfg.host}/institutes/${cfg.instituteId}/classes`;
  const res = await fetch(url, { method: "GET", headers: wiseHeaders(cfg) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Wise listInstituteClasses ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const classes = body && body.data && body.data.classes;
  return Array.isArray(classes) ? classes : [];
}

// Scan all institute classes for the one containing this Wise user ID in
// its `joinedRequest` array. Returns the classId string or null.
async function resolveClassForStudent(cfg, wiseUserId) {
  const classes = await listInstituteClasses(cfg);
  for (const c of classes) {
    const joined = Array.isArray(c.joinedRequest) ? c.joinedRequest : [];
    if (joined.includes(wiseUserId)) {
      return c._id;
    }
  }
  return null;
}

// GET /user/classes/{classId}/contentTimeline?showSequentialLearningDisabledSections=true
//
// Returns the content timeline (sections + their entities) for a class.
// Used to find the "Post-Session Materials (PSMs)" section ID.
async function getContentTimeline(cfg, classId) {
  const url = `${cfg.host}/user/classes/${classId}/contentTimeline?showSequentialLearningDisabledSections=true`;
  const res = await fetch(url, { method: "GET", headers: wiseHeaders(cfg) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Wise getContentTimeline ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const timeline = body && body.data && body.data.timeline;
  return Array.isArray(timeline) ? timeline : [];
}

// Scan a class's content timeline for the PSMs section. Matches section
// names containing "PSM" (case-insensitive). Returns the section _id or null.
async function resolvePsmSectionId(cfg, classId) {
  const sections = await getContentTimeline(cfg, classId);
  for (const s of sections) {
    if (s.name && /psm/i.test(s.name)) {
      return s._id;
    }
  }
  return null;
}

// POST /teacher/createAssignments
//
// Creates an assessment (assignment) inside a content section. This is how
// PSM assignments land in the "Post-Session Materials (PSMs)" module in
// each student's 1:1 class.
async function createAssignment(cfg, { classId, sectionId, topic, description, submitBy, startTime }) {
  const url = `${cfg.host}/teacher/createAssignments`;
  const res = await fetch(url, {
    method: "POST",
    headers: wiseHeaders(cfg),
    body: JSON.stringify({
      classId,
      sectionId,
      topic,
      description,
      maxMarks: "100",
      submitBy,
      startTime,
      criteria: [],
      uploadTokens: [],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Wise createAssignment ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  return (body && body.data) || "ok";
}

// POST /user/createAnnouncements
//
// Creates a discussion (announcement) on a class. Used for PSM posts
// that include the full instruction text with HTML formatting.
async function createDiscussion(cfg, classId, { title, description }) {
  const url = `${cfg.host}/user/createAnnouncements`;
  const res = await fetch(url, {
    method: "POST",
    headers: wiseHeaders(cfg),
    body: JSON.stringify({
      classId,
      title,
      description,
      disableCommenting: false,
      uploadTokens: "",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Wise createDiscussion ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  return (body && body.data) || "ok";
}

// GET /institutes/{institute_id}/students?status=ACCEPTED&page_size=N&page_number=N&showParents=true
//
// Session 18C: full institute roster pull. Replaces the manual CSV
// import workflow with a direct API sync. Each result row carries:
//   _id, instituteId, userId: {_id, name, email, phoneNumber, ...},
//   joinedOn, status, classes: [{_id, name, subject, ...}]
//
// Paginated — caller walks until an empty page comes back. We default
// to page_size=100; the Wise API caps at 100.
async function listInstituteStudents(cfg, { pageNumber = 1, pageSize = 100 } = {}) {
  const url = `${cfg.host}/institutes/${cfg.instituteId}/students`
    + `?status=ACCEPTED`
    + `&page_size=${encodeURIComponent(pageSize)}`
    + `&page_number=${encodeURIComponent(pageNumber)}`
    + `&showParents=false&showFeedbackData=false`;
  const res = await fetch(url, { method: "GET", headers: wiseHeaders(cfg) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Wise listInstituteStudents ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const students = body && body.data && body.data.students;
  return Array.isArray(students) ? students : [];
}

// Walks every page of the institute roster and returns the flat array
// of all student records. Stops when a page returns < pageSize results.
async function listAllInstituteStudents(cfg, { pageSize = 100 } = {}) {
  const out = [];
  for (let page = 1; page <= 50; page++) { // hard cap 5000 students
    const batch = await listInstituteStudents(cfg, { pageNumber: page, pageSize });
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

module.exports = {
  userByIdentifierEmail,
  resolveWiseUserIdByEmail,
  listAllChats,
  createAdminChat,
  ensureAdminChat,
  sendChatMessage,
  listInstituteClasses,
  resolveClassForStudent,
  listInstituteStudents,
  listAllInstituteStudents,
  getContentTimeline,
  resolvePsmSectionId,
  createAssignment,
  createDiscussion,
};
