/* ============ CONSTANTS ============ */
/* ATS brand navies — sampled from the official logo (2.png = #004A79).
   B1 = deepest, B2 = primary, B3 = lighter accent. Do not alter without brand approval. */
const B1="#003258", B2="#004A79", B3="#0066A6";
/* Editorial semantic palettes — muted, paper-friendly, readable at small sizes. */
const DC={easy:"#4C7A4C",medium:"#A9761B",hard:"#8C2E2E",comprehensive:"#5B4B8A",mixed:"#5B4B8A"};
const SUBJ_COLOR={
  "Reading & Writing":{bg:"#E9F0F6",fg:"#003258",accent:"#004A79"},
  "Math":{bg:"#F5ECDF",fg:"#6E3F12",accent:"#9A5B1F"}
};
const DOMAIN_COLOR={
  "Information & Ideas":"#003258",
  "Craft & Structure":"#5B4B8A",
  "Expression of Ideas":"#1F4E7A",
  "Standard English Conventions":"#2B6A6A",
  "Algebra":"#4C7A4C",
  "Advanced Math":"#2F5F4F",
  "Problem-Solving & Data Analysis":"#A9761B",
  "Geometry & Trigonometry":"#8C2E2E"
};
const DIFF_ORDER=["easy","medium","hard","comprehensive"];

const uid=()=>Math.random().toString(36).slice(2,10);
const todayStr=()=>new Date().toISOString().slice(0,10);
const sLoad=(k,fb)=>{try{const r=localStorage.getItem(k);return r?JSON.parse(r):fb;}catch{return fb;}};
const sSave=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}};

// Wise Cloud Function caller — posts PSM discussion to the student's Wise class.
// Depends on firebase-functions-compat.js loaded in index.html.
// Waits for the Firestore batch write (debounced in useEffect) to land
// before calling the callable. Polls for the assignment doc to appear.
function assignToWise(studentId, assignmentId, showToastFn){
  if(!studentId||!assignmentId) return;
  const db = window.db;
  if(!db) return;
  showToastFn("Posting to Wise…");
  const fns = firebase.app().functions("us-central1");
  const fn = fns.httpsCallable("assignToWise");
  let attempts = 0;
  function tryCall(){
    fn({studentId, assignmentId})
      .then(r=>{
        const mode = r.data && r.data.mode;
        showToastFn(mode==="dev-redirect" ? "Posted to Wise (dev mode)" : "Posted to Wise ✓");
      })
      .catch(err=>{
        if(attempts < 3 && err.message && err.message.includes("not found")){
          attempts++;
          console.log("assignToWise: retry", attempts, "waiting for Firestore sync…");
          setTimeout(tryCall, 2000);
        } else {
          console.error("assignToWise failed:", err);
          showToastFn("Wise post failed — see console");
        }
      });
  }
  setTimeout(tryCall, 2000);
}

/* Soft-delete helpers. Items with a truthy `deleted` flag are in the trash;
   live() strips them for display, trash() keeps only them for the Trash tab.
   Raw `students` state always contains both — we filter at display time so
   mutations (addAsg, setExamScore, etc.) keep working against the full array. */
const live = arr => (arr||[]).filter(x=>!x.deleted);
const trashed = arr => (arr||[]).filter(x=>x.deleted);
const softDel = x => ({...x, deleted:true, deletedAt: Date.now()});
const softRestore = x => { const {deleted, deletedAt, ...rest} = x; return rest; };

/* CSV parser — RFC 4180-ish, handles quoted fields with embedded commas,
   embedded newlines, and "" escapes. Returns array of row arrays. */
function parseCsvText(text){
  const rows=[]; let row=[]; let cell=""; let q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){
      if(ch==='"'){ if(text[i+1]==='"'){cell+='"';i++;} else q=false; }
      else cell+=ch;
    } else {
      if(ch==='"') q=true;
      else if(ch===','){ row.push(cell); cell=""; }
      else if(ch==='\r'){/*skip*/}
      else if(ch==='\n'){ row.push(cell); rows.push(row); row=[]; cell=""; }
      else cell+=ch;
    }
  }
  if(cell.length||row.length){ row.push(cell); rows.push(row); }
  return rows;
}

/* Parse a Wise "Learner Report" CSV export into a list of clean student
   objects. Skips rows before the header ("Table 1" title), handles duplicate
   "Phone Number" columns, and ignores the accommodations column entirely
   (PII we explicitly don't want in PSM). */
function parseWiseCsv(text){
  const rows = parseCsvText(text);
  const headerIdx = rows.findIndex(r => r.some(c => (c||"").trim() === "Name"));
  if(headerIdx < 0) throw new Error('Could not find "Name" column — is this a Wise Learner Report?');
  const header = rows[headerIdx].map(c => (c||"").trim());
  const col = n => header.indexOf(n);
  const idxName = col("Name");
  const idxPhone1 = col("Phone Number");
  const idxPhone2 = header.lastIndexOf("Phone Number");
  const idxEmail = col("Email");
  const idxJoined = col("Joined On");
  const idxGrade = col("Grade Level");
  const idxLevel = col("Level of Tutoring");
  const idxSubject = col("Specific Subject of Tutoring");
  const idxGoals = header.findIndex(c => c.toLowerCase().startsWith("what are your outcome goals"));
  const get = (r,i) => (i>=0 && r[i]!=null) ? String(r[i]).trim() : "";
  const out = [];
  for(let i = headerIdx+1; i < rows.length; i++){
    const r = rows[i];
    const name = get(r, idxName);
    if(!name) continue;
    const phone = get(r, idxPhone1) || (idxPhone2!==idxPhone1 ? get(r, idxPhone2) : "");
    const subject = get(r, idxSubject);
    const level = get(r, idxLevel);
    // Session 18C: Wise import auto-filter — only SAT-tagged rows are
    // brought in by default. Match is "SAT" appearing in either the
    // Specific Subject or the Level of Tutoring column, case-insensitive.
    // Non-SAT rows still appear in the preview so the tutor can opt in
    // if they want, but are unchecked by default.
    const isSat = /\bSAT\b/i.test(subject) || /\bSAT\b/i.test(level);
    out.push({
      name,
      isSat,
      meta: {
        email: get(r, idxEmail),
        phone,
        joinedOn: get(r, idxJoined),
        gradeLevel: get(r, idxGrade),
        levelOfTutoring: level,
        subjectOfTutoring: subject,
        goals: get(r, idxGoals),
        source: "wise",
        importedAt: Date.now(),
      },
    });
  }
  return out;
}

/* ============ CONSULTATION STUDENT (Session 18C) ============ */
//
// Synthetic demo student visible to all tutors/admin. Excluded from
// aggregates (heat map, dashboards) via the isConsultation flag — see
// excludeConsultation() below.
//
// Seeded once into Firestore on first AppInner mount that finds the
// /students collection missing the doc. Subsequent loads find the doc
// and skip creation. Wise reconcile also skips this id explicitly.

const CONSULTATION_STUDENT_ID = "__consultation__";
// Bump this when makeConsultationStudent changes meaningfully. The seed
// effect compares it against the doc's stored marker and overwrites if
// it's stale. Lets us refresh synthetic data without manual deletion.
const CONSULTATION_DATA_VERSION = 2;

function makeConsultationStudent() {
  // Helper to add days/months to a date string YYYY-MM-DD.
  const dayShift = (base, days) => {
    const d = new Date(base + "T00:00:00");
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  // Synthetic timeline: Sep 2025 → Apr 2026, ~8 months of activity.
  const START = "2025-09-01";

  // WellEd Domain log entries — at least 3 per domain showing realistic
  // progression. NOT monotonically up — students plateau, dip on hard
  // material, then rebound. Pattern is +up, ±flat-or-dip, +up so the net
  // trend is positive but variance looks like a real human curve.
  const welledLogs = [];
  let logIdx = 0;
  const pushLog = (subject, domain, difficulty, score, qs, daysAfterStart) => {
    welledLogs.push({
      id: `consult_log_${logIdx++}`,
      date: dayShift(START, daysAfterStart),
      subject,
      domain,
      difficulty,
      score,
      qs,
    });
  };

  // R&W domains (out of 27). Notice the dips at medium-tier (introduces
  // harder material, slight regression before mastery on hard).
  pushLog("Reading & Writing", "Information & Ideas",        "easy",   15, 27,  14);  // baseline
  pushLog("Reading & Writing", "Information & Ideas",        "medium", 17, 27,  60);  // small gain
  pushLog("Reading & Writing", "Information & Ideas",        "hard",   15, 27, 105);  // dip on hard
  pushLog("Reading & Writing", "Information & Ideas",        "hard",   22, 27, 165);  // rebound
  pushLog("Reading & Writing", "Craft & Structure",          "easy",   17, 27,  21);
  pushLog("Reading & Writing", "Craft & Structure",          "medium", 21, 27,  75);  // big gain
  pushLog("Reading & Writing", "Craft & Structure",          "medium", 19, 27, 120);  // plateau/dip
  pushLog("Reading & Writing", "Craft & Structure",          "hard",   23, 27, 180);
  pushLog("Reading & Writing", "Expression of Ideas",        "easy",   18, 27,  28);
  pushLog("Reading & Writing", "Expression of Ideas",        "medium", 16, 27,  85);  // dip — tricky transitions
  pushLog("Reading & Writing", "Expression of Ideas",        "hard",   21, 27, 170);
  pushLog("Reading & Writing", "Standard English Conventions","easy",  20, 27,  35);  // strong baseline
  pushLog("Reading & Writing", "Standard English Conventions","medium",22, 27,  98);
  pushLog("Reading & Writing", "Standard English Conventions","hard",  21, 27, 145);  // slight regress
  pushLog("Reading & Writing", "Standard English Conventions","hard",  25, 27, 195);

  // Math domains (out of 22). Same pattern.
  pushLog("Math", "Algebra",                         "easy",   15, 22,  18);
  pushLog("Math", "Algebra",                         "medium", 14, 22,  68);  // initial dip
  pushLog("Math", "Algebra",                         "medium", 18, 22, 115);  // catches up
  pushLog("Math", "Algebra",                         "hard",   19, 22, 175);
  pushLog("Math", "Advanced Math",                   "easy",   12, 22,  24);  // weakest start
  pushLog("Math", "Advanced Math",                   "easy",   16, 22,  72);
  pushLog("Math", "Advanced Math",                   "medium", 14, 22, 130);  // setback on quadratics
  pushLog("Math", "Advanced Math",                   "hard",   18, 22, 188);
  pushLog("Math", "Problem-Solving & Data Analysis", "easy",   16, 22,  31);
  pushLog("Math", "Problem-Solving & Data Analysis", "hard",   17, 22, 110);
  pushLog("Math", "Problem-Solving & Data Analysis", "hard",   20, 22, 178);
  pushLog("Math", "Geometry & Trigonometry",         "easy",   13, 22,  38);
  pushLog("Math", "Geometry & Trigonometry",         "easy",   17, 22,  92);
  pushLog("Math", "Geometry & Trigonometry",         "hard",   14, 22, 140);  // dip on trig
  pushLog("Math", "Geometry & Trigonometry",         "hard",   19, 22, 192);

  // Practice exam scores — diagnostic + multiple checkpoints with
  // realistic ups/downs but net positive trend. Total goes 1050 → 1090 →
  // 1080 (dip) → 1140 → 1170 → 1260 (final). Each section also moves
  // independently — math regresses slightly mid-program before rebounding.
  const scores = [
    {
      id: "consult_score_1",
      date: dayShift(START, 7),
      testType: "BlueBook Diagnostic — Practice Test 1",
      score: 1050,
      maxScore: 1600,
      rwScore: 540,
      mathScore: 510,
      isDiagnostic: true,
      notes: "Baseline practice exam (no prep yet).",
    },
    {
      id: "consult_score_2",
      date: dayShift(START, 45),
      testType: "WellEd Full — Practice Test 2",
      score: 1090,
      maxScore: 1600,
      rwScore: 560,
      mathScore: 530,
      notes: "First post-prep test — modest gain.",
    },
    {
      id: "consult_score_3",
      date: dayShift(START, 95),
      testType: "BlueBook Full — Practice Test 2",
      score: 1080,
      maxScore: 1600,
      rwScore: 570,
      mathScore: 510,
      notes: "Math regressed under timed conditions; R&W still climbing.",
    },
    {
      id: "consult_score_4",
      date: dayShift(START, 130),
      testType: "WellEd Full — Practice Test 5",
      score: 1140,
      maxScore: 1600,
      rwScore: 580,
      mathScore: 560,
      notes: "Math recovers after Advanced Math drills.",
    },
    {
      id: "consult_score_5",
      date: dayShift(START, 165),
      testType: "BlueBook Full — Practice Test 4",
      score: 1170,
      maxScore: 1600,
      rwScore: 600,
      mathScore: 570,
      notes: "Solid week. R&W now consistently 600+.",
    },
    {
      id: "consult_score_6",
      date: dayShift(START, 210),
      testType: "BlueBook Full — Practice Test 3",
      score: 1260,
      maxScore: 1600,
      rwScore: 640,
      mathScore: 620,
      notes: "Final pre-test practice. +210 from baseline.",
    },
  ];

  // Diagnostic baseline upload — single ZipGrade-style result with
  // per-tag breakdown so the diagnostic profile view has something to
  // render. Numbers chosen to roughly match the 1050 baseline above.
  const diagnostics = [
    {
      id: "consult_diag_1",
      date: dayShift(START, 7),
      fileName: "Consultation_Diagnostic_2025-09-08.pdf",
      examType: "SAT",
      sectionScores: {
        "Reading & Writing": { scaled: 540, raw: 32, total: 54 },
        "Math":              { scaled: 510, raw: 24, total: 44 },
      },
      totalScaled: 1050,
      tags: [
        { tag: "Information & Ideas",         correct: 7,  total: 13 },
        { tag: "Craft & Structure",           correct: 8,  total: 13 },
        { tag: "Expression of Ideas",         correct: 8,  total: 14 },
        { tag: "Standard English Conventions",correct: 9,  total: 14 },
        { tag: "Algebra",                     correct: 7,  total: 13 },
        { tag: "Advanced Math",               correct: 5,  total: 13 },
        { tag: "Problem-Solving & Data Analysis", correct: 7, total: 9 },
        { tag: "Geometry & Trigonometry",     correct: 5,  total: 9 },
      ],
    },
  ];

  // Five PSMs spread across the timeline with varied worksheets.
  const psm = (idSuffix, daysAfterStart, worksheets, opts = {}) => ({
    id: `consult_asg_${idSuffix}`,
    date: dayShift(START, daysAfterStart),
    examType: "SAT",
    worksheets,
    welledDomain: opts.welledDomain || [],
    vocab: opts.vocab || [],
    practiceExams: opts.practiceExams || [],
    timeDrill: !!opts.timeDrill,
    oneNote: !!opts.oneNote,
    notes: opts.notes || "",
  });

  // Reference worksheets by ALL_WS id format (`subject|domain|subdomain|difficulty|title`)
  // matches what the Generator produces. We use real titles from the catalog.
  const ws = (subject, domain, subdomain, difficulty, qs, title) => ({
    id: `${subject}|${domain}|${subdomain}|${difficulty}|${title}`,
    title,
    subject,
    domain,
    subdomain,
    difficulty,
    qs,
    evenOdd: null,
    timeLimit: null,
  });

  const assignments = [
    psm("1", 7, [
      ws("Reading & Writing", "Information & Ideas", "Central Ideas & Details", "easy", 7, "CID-Easy (7Qs)"),
      ws("Reading & Writing", "Craft & Structure", "Words in Context", "easy", 6, "Words in Context - Easy (6Qs)"),
      ws("Math", "Algebra", "Linear Equations in One Variable", "easy", 5, "LinEQ1Var - Easy (5Qs)"),
    ], { notes: "Diagnostic-week opener." }),
    psm("2", 38, [
      ws("Reading & Writing", "Information & Ideas", "Inferences", "medium", 5, "Inferences-Med (5Qs)"),
      ws("Math", "Advanced Math", "Equivalent Expressions", "medium", 6, "EquivExp-Med (6Qs)"),
      ws("Math", "Problem-Solving & Data Analysis", "Probability", "easy", 4, "Probability - Easy (4Qs)"),
    ]),
    psm("3", 88, [
      ws("Reading & Writing", "Craft & Structure", "Text Structure & Purpose", "hard", 5, "TextStructPurp - Hard (5Qs)"),
      ws("Math", "Algebra", "Systems of Linear Equations", "hard", 6, "Systems - Hard (6Qs)"),
      ws("Math", "Geometry & Trigonometry", "Circles", "medium", 3, "Circles - Medium (3Qs)"),
    ], { welledDomain: [{ id: "WED|Math|Algebra|hard", subject: "Math", domain: "Algebra", difficulty: "hard", qs: 22, label: "Algebra - Hard (22Qs)", score: 17 }] }),
    psm("4", 140, [
      ws("Reading & Writing", "Expression of Ideas", "Rhetorical Synthesis", "hard", 4, "RhetSynth - Hard (4Qs)"),
      ws("Math", "Advanced Math", "Nonlinear Functions", "hard", 5, "NonlinFunc - Hard (5Qs)"),
      ws("Math", "Geometry & Trigonometry", "Circles", "hard", 10, "Circles - Hard (10Qs)"),
    ], { timeDrill: true }),
    psm("5", 195, [
      ws("Reading & Writing", "Standard English Conventions", "Boundaries", "hard", 5, "Boundaries - Hard (5Qs)"),
      ws("Reading & Writing", "Expression of Ideas", "Comprehensive Expression of Ideas", "comprehensive", 10, "CompExpIdeas-Comp (10Qs)"),
      ws("Math", "Problem-Solving & Data Analysis", "Comprehensive PSDA", "comprehensive", 12, "CompPSDA - Comp (12Qs)"),
    ], { practiceExams: [{ platform: "BlueBook", number: 3, type: "full", rwScore: 640, mathScore: 620 }] }),
  ];

  return {
    name: "Consultation Student",
    isConsultation: true,
    dateAdded: START,
    meta: {
      grade: "11",
      source: "synthetic",
      isConsultation: true,
      joinedOn: START,
      levelOfTutoring: "Demo",
      subjectOfTutoring: "SAT",
      goals: "Synthetic profile to demonstrate tracking views. Excluded from real-student aggregates.",
    },
    assignments,
    scores,
    welledLogs,
    diagnostics,
  };
}

// Helper used in aggregate computations (heat map, dashboards) to exclude
// the consultation profile from real-student rollups.
function excludeConsultation(list){
  return (list || []).filter(s => !(s && (s.isConsultation === true || s.id === CONSULTATION_STUDENT_ID)));
}

/* ============ WORKSHEET CATALOG ============ */
const ALL_WS = WS_RAW.map(([subject,domain,subdomain,difficulty,qs,title,stu,key])=>({
  subject,domain,subdomain,difficulty,qs,title,stu,key,
  id:`${subject}|${domain}|${subdomain}|${difficulty}|${title}`,
  isComprehensiveGroup: subdomain.startsWith("Comprehensive "),
}));
// Session 18A: dropped the "Circles - Easy (Inactive)" placeholder that
// was injected to fill a (subdomain, difficulty) hole that no longer
// exists in WS_RAW. Circles is present at Medium / Hard / Comprehensive
// difficulty and the UI handles absent (subdomain, difficulty) combos
// gracefully — no placeholder needed.

/* ============ WELLED DOMAIN ASSIGNMENTS ============ */
// R&W: 27 Qs each. Math: 22 Qs. Geo & PSDA only Easy/Hard.
const WELLED_DOMAIN = [
  {subject:"Reading & Writing",domain:"Information & Ideas",diffs:["easy","medium","hard"],qs:27},
  {subject:"Reading & Writing",domain:"Craft & Structure",diffs:["easy","medium","hard"],qs:27},
  {subject:"Reading & Writing",domain:"Expression of Ideas",diffs:["easy","medium","hard"],qs:27},
  {subject:"Reading & Writing",domain:"Standard English Conventions",diffs:["easy","medium","hard"],qs:27},
  {subject:"Math",domain:"Algebra",diffs:["easy","medium","hard"],qs:22},
  {subject:"Math",domain:"Advanced Math",diffs:["easy","medium","hard"],qs:22},
  {subject:"Math",domain:"Problem-Solving & Data Analysis",diffs:["easy","hard"],qs:22},
  {subject:"Math",domain:"Geometry & Trigonometry",diffs:["easy","hard"],qs:22},
];
const WE_DOMAIN_ITEMS = [];
WELLED_DOMAIN.forEach(e=>e.diffs.forEach(d=>{
  const label=`${e.domain} - ${d[0].toUpperCase()+d.slice(1)} (${e.qs}Qs)`;
  WE_DOMAIN_ITEMS.push({id:`WED|${e.subject}|${e.domain}|${d}`,subject:e.subject,domain:e.domain,difficulty:d,qs:e.qs,label,kind:"welled_domain"});
}));

const WELLED_PRACTICE_TESTS = Array.from({length:46},(_,i)=>i+1); // Tests 1-46
const BLUEBOOK_PRACTICE_TESTS = Array.from({length:6},(_,i)=>i+1); // Tests 1-6

/* ============ VOCAB ITEMS ============ */
const VOCAB_ITEMS = [];
VOCAB_SETS.forEach(name=>{
  VOCAB_ITEMS.push({id:`VF|${name}`,kind:"vocab_flash",name,label:`Flashcards: ${name}`});
  for(let i=1;i<=4;i++) VOCAB_ITEMS.push({id:`VQ|${name}|${i}`,kind:"vocab_quiz",name,variant:i,label:`Quiz ${i}: ${name}`});
});

/* ============ INSTRUCTION TEMPLATES ============ */
// Each block: {title, body}. Title is bolded with ** in output. Intro A has no title.
const INTRO_A = `The recording of today's session has been posted on Wise. Please complete the following worksheets using the PSM instructions posted in the PSMs modules.`;
const INTRO_B = {title:"Important Reminder:", body:"Please book your next session in advance, timing it for when you expect to have these PSMs completed. After completing the worksheets, check and mark your work according to the PSM instructions, then upload your marked work as a comment to this PSMs assignment."};
const ONENOTE_TXT = {title:"OneNote Instructions:", body:"Printouts of the worksheet have been added to the next session's page on OneNote for you to complete all of your work/annotations on. Please complete all of your work in black ink and check all answers with the answer keys provided below. Please use red ink for marks on your paper (correct/incorrect) and for stars on questions you had trouble on. Please make sure to leave room for us to work through problems you miss on each page."};
const WED_TXT = {title:"WellEd Labs Domain Assignment Instructions:", body:"Please complete assigned domain assignments on WellEd Labs. Use the instructions for WellEd Labs practice exams located in your Wise \"Full Practice Exam Instructions\" Module to login to the platform and make sure to toggle the assignments section in the top right of the page, so that you see the topic-specific assignments you are to complete.  https://ats.practicetest.io/sign-in"};
const VOCAB_TXT = {title:"WellEd Labs Vocab Instructions:", body:"Please complete assigned vocab flashcards and/or quizzes on WellEd Labs. Login to the platform using the instructions in your Wise \"Full Practice Exam Instructions\" Module and toggle to the Vocab section in the top right of the page, so that you see the vocab sets and quizzes you are to complete.  https://ats.practicetest.io/sign-in"};
const TIME_TXT = {title:"Time Drilling Instructions:", body:"Time limits are indicated in parentheses before each worksheet name. Please set a timer for the allotted minutes before beginning each worksheet and stop working when time expires. Mark any unfinished questions clearly so we can discuss them in the next session."};
const fmtInstr = (o)=>`**${o.title}** ${o.body}`;
// Convert our markdown-style `**bold**` output to safe HTML
const mdBoldToHtml = (text)=>{
  const esc = (s)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return esc(text||"")
    .split("\n")
    .map(line=>line.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>'))
    .map(line=>line.trim()===""?"<br/>":`<div>${line||"&nbsp;"}</div>`)
    .join("");
};

/* ============ STYLE HELPERS ============ */
/* Editorial primitives — all cards/inputs/buttons inherit the paper-and-ink system. */
const INP={border:"1px solid rgba(15,26,46,.18)",borderRadius:4,padding:"8px 12px",fontSize:13,outline:"none",width:"100%",background:"#fff",color:"#0F1A2E",fontFamily:"'IBM Plex Sans',system-ui,sans-serif"};
const CARD={background:"#fff",borderRadius:6,padding:18,boxShadow:"0 0 0 1px rgba(15,26,46,.08), 0 1px 2px rgba(15,26,46,.04)"};
const mkPill=(bg,fg)=>({background:bg,color:fg,borderRadius:3,padding:"2px 8px",fontSize:10,fontWeight:500,letterSpacing:.3,textTransform:"uppercase",fontFamily:"'IBM Plex Mono',monospace",display:"inline-block"});
const mkBtn=(bg,fg)=>({background:bg,color:fg,border:"1px solid transparent",borderRadius:4,padding:"8px 16px",fontSize:12,cursor:"pointer",fontWeight:500,letterSpacing:.2,fontFamily:"'IBM Plex Sans',system-ui,sans-serif"});

function Tag({c="#E9F0F6",t="#003258",children}){return <span style={mkPill(c,t)}>{children}</span>;}
function SH({children}){return <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 48',fontSize:11,fontWeight:600,color:"#66708A",textTransform:"uppercase",letterSpacing:1.6,marginBottom:10,paddingBottom:8,borderBottom:"1px solid rgba(15,26,46,.08)"}}>{children}</div>;}

function Toggle({on,set,label,sub}){
  return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer"}} onClick={()=>set(!on)}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:14,fontWeight:600,color:"#0F1A2E",letterSpacing:-.05}}>{label}</div>
        {sub&&<div style={{fontSize:11,color:"#66708A",marginTop:2}}>{sub}</div>}
      </div>
      <div style={{width:38,height:22,borderRadius:11,background:on?B2:"rgba(15,26,46,.18)",position:"relative",transition:"background .2s",flexShrink:0,marginLeft:12,boxShadow:on?"inset 0 1px 2px rgba(0,50,88,.35)":"inset 0 1px 2px rgba(15,26,46,.12)"}}>
        <div style={{position:"absolute",top:2,left:on?18:2,width:18,height:18,borderRadius:9,background:"#FAF7F2",transition:"left .2s",boxShadow:"0 1px 2px rgba(15,26,46,.25)"}}/>
      </div>
    </div>
  );
}

/* ============ PDF DIAGNOSTIC PARSER ============ */
// Thin I/O shell around the pure `parseDiagnosticText` function defined in
// lib/diagnostic.mjs (inlined by build_index.py). Opens the PDF with pdf.js,
// reconstructs the text in reading order using item coordinates, then hands
// off to the pure parser. All fragile heuristics — subject detection, tag
// row regex, module detection — live in `parseDiagnosticText` and are
// covered by tests/diagnostic.test.mjs.
async function parseDiagnosticPdf(file){
  if(!window.pdfjsLib) throw new Error("pdf.js not loaded");
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({data:buf}).promise;
  let fullText = "";
  for(let p=1;p<=pdf.numPages;p++){
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.map(it=>({s:it.str,x:it.transform[4],y:it.transform[5]}));
    items.sort((a,b)=>(b.y-a.y)||(a.x-b.x));
    let lastY=null, line=[];
    const lines=[];
    items.forEach(it=>{
      if(lastY===null||Math.abs(it.y-lastY)>3){if(line.length)lines.push(line.join(" ").trim());line=[it.s];lastY=it.y;}
      else line.push(it.s);
    });
    if(line.length)lines.push(line.join(" ").trim());
    fullText += "\n" + lines.join("\n");
  }
  const result = parseDiagnosticText(fullText, file.name || "");
  if(result.tags.length) console.log("[PSM Parser] Extracted", result.tags.length, "tags:", result.tags.map(r=>`"${r.tag}" ${r.earn}/${r.poss}`));
  return {...result, parsedAt: todayStr()};
}


/* ============ WELLED SCORE REPORT PARSER ============ */
async function parseWelledReport(file){
  if(!window.pdfjsLib) throw new Error("pdf.js not loaded");
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({data:buf}).promise;
  // Session 18C v3: coordinate-aware text reconstruction. The previous
  // naive `items.join(" ")` mangled two-column layouts (WellEd's
  // Category Scores section lists R&W on the left, Math on the right
  // — flat-joining produces "Craft and Structure Problem-Solving and
  // Data Analysis ... 10/13 3/6" which the per-domain regex can't
  // match). Now we sort items by (y desc, x asc), group items with
  // close y into a single visual row, and produce one joined string
  // per row — same approach the diagnostic parser uses.
  let fullText = "";
  let xSortedText = "";  // also build a "left-column-first then right-column" pass
  for(let i=1;i<=pdf.numPages;i++){
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const items = tc.items.map(it=>({s:it.str, x:it.transform[4], y:it.transform[5]}));
    items.sort((a,b)=>(b.y-a.y)||(a.x-b.x));
    let lastY=null, line=[];
    const lines=[];
    items.forEach(it=>{
      if(lastY===null||Math.abs(it.y-lastY)>3){
        if(line.length) lines.push(line.join(" ").trim());
        line=[it.s]; lastY=it.y;
      } else line.push(it.s);
    });
    if(line.length) lines.push(line.join(" ").trim());
    fullText += "\n" + lines.join("\n");
    // Second pass — items sorted strictly by x-then-y so a
    // left-column-first read order is captured too. WellEd's Category
    // Scores section places R&W on the left and Math on the right;
    // without column-aware ordering the domain name and its N/M may
    // be on different "visual rows" by y but still belong together.
    const xItems = [...items].sort((a,b)=>(a.x-b.x)||(b.y-a.y));
    xSortedText += "\n" + xItems.map(it=>it.s).join(" ");
  }
  // Combined search corpus: regex tries each pass before giving up.
  const textForSearch = fullText + "\n" + xSortedText;
  const result = {
    fileName:file.name, raw:fullText,
    testName:null, testNumber:null, testedOn:null,
    totalScore:null, rwScore:null, mathScore:null,
    rawScores:{},
    // domains[] (8 entries for full, 4 for section-only) populated below.
    // subskills stays empty — WellEd reports don't have catalog-aligned
    // subskill granularity. They contribute to DOMAIN time-points only.
    subskills:[], domains:[],
    type:"full",
  };

  // Test name and number
  const tnMatch = textForSearch.match(/Test name[:\s]*(.+?)(?:\n|Tested)/i);
  if(tnMatch){
    result.testName = tnMatch[1].trim();
    const numMatch = result.testName.match(/Practice Test\s*#?\s*(\d+)/i);
    if(numMatch) result.testNumber = parseInt(numMatch[1]);
  }
  // Fallback test-number detection — also scan body text for "Practice Test #N".
  if(result.testNumber == null){
    const ptm = textForSearch.match(/Practice Test\s*#?\s*(\d+)/i);
    if(ptm) result.testNumber = parseInt(ptm[1]);
  }
  // Tested-on date — accept several labels + formats. Normalizes to YYYY-MM-DD.
  for(const label of ["Tested on", "Test date", "Date tested", "Taken on", "Date taken"]){
    let m = null;
    try { m = textForSearch.match(new RegExp(label + "[:\\s]*([\\d\\/\\-]+|[A-Za-z]+\\s+\\d{1,2},?\\s+\\d{4})", "i")); }
    catch { m = null; }
    if(m){
      const norm = _normalizeReportDate(m[1]);
      if(norm){ result.testedOn = norm; break; }
      if(!result.testedOn) result.testedOn = m[1].trim(); // store raw fallback
    }
  }

  // Session 18C v4: STRICT score extraction with validation.
  //
  // Bug being fixed: prior regex like /\bMath\s+(\d{3})\b/i was too
  // greedy — "Math" appears many times in a WellEd report ("Math",
  // "Math Section", "Math Section Score", "Advanced Math", "Math
  // Module 1") and the first 3-digit number after ANY "Math" got
  // picked up. Same for "Reading and Writing". Resulted in spurious
  // 200 or 800 readings (200 = min scale floor that shows up in axis
  // labels, 800 = max that shows up in /800 denominators).
  //
  // Strategy:
  //   1. Find the "TOTAL SCORE" anchor — that's the section-scores
  //      panel header. Score grid lives within ~400 chars after it.
  //   2. Within that window, find the THREE largest 3-digit numbers
  //      in valid score ranges (sections in [200,800], total in
  //      [400,1600]) by their proximity to known labels.
  //   3. Validate every extracted value. Reject anything out of range
  //      or that looks like a denominator (preceded by '/' or
  //      followed by '/800', '/1600').
  //   4. Cross-check: if all three are present, rw+math should ≈ total.
  //      If not, prefer the total + one section (the more confident
  //      pair).

  const _IS_VALID_SECTION = (n) => Number.isFinite(n) && n >= 200 && n <= 800;
  const _IS_VALID_TOTAL = (n) => Number.isFinite(n) && n >= 400 && n <= 1600;

  // Helper: extract a candidate score from a regex match while rejecting
  // false-positive contexts (numbers that are part of /800 or 200-800).
  function _grabScore(text, namePattern, validate){
    // Match: <label><sep><N> but NOT <label>/N (denominator) and NOT
    // <label> 200-800 (a range like "scaled 200-800").
    let rx;
    try { rx = new RegExp(namePattern + "[\\s:]*(\\d{3,4})\\b(?!\\s*[-/]\\s*\\d)", "i"); }
    catch { return null; }
    const m = text.match(rx);
    if(!m) return null;
    const n = parseInt(m[1]);
    return validate(n) ? n : null;
  }

  // Anchor: find the section-scores block. Most WellEd reports have
  // "TOTAL SCORE" as the header. Slice ~500 chars from there.
  const anchorMatch = textForSearch.match(/TOTAL\s*SCORE/i);
  const scoreBlock = anchorMatch
    ? textForSearch.slice(anchorMatch.index, anchorMatch.index + 600)
    : textForSearch.slice(0, 1200); // fallback: search the top of the doc

  // 1. Total — anchor to "TOTAL SCORE" specifically.
  const totalGrabbed = _grabScore(scoreBlock, "TOTAL\\s*SCORE", _IS_VALID_TOTAL);
  if(totalGrabbed != null) result.totalScore = totalGrabbed;

  // 2. R&W section. Try labels in order of specificity.
  for(const lbl of [
    "Reading\\s*(?:and|&)\\s*Writing\\s*Section",  // most specific
    "Reading\\s*(?:and|&)\\s*Writing",
    "R\\s*&?\\s*W\\s*Section",
  ]){
    const n = _grabScore(scoreBlock, lbl, _IS_VALID_SECTION);
    if(n != null){ result.rwScore = n; break; }
  }

  // 3. Math section. The word "Math" alone is too generic — anchor it
  // to "Math Section" or require it to appear AFTER R&W in the grid.
  for(const lbl of [
    "Math\\s*Section",
    "(?:^|\\n)\\s*Math\\b",
  ]){
    const n = _grabScore(scoreBlock, lbl, _IS_VALID_SECTION);
    if(n != null){ result.mathScore = n; break; }
  }

  // 4. Cross-validation: if total and both sections are present,
  // rw+math should be within 20 points of total (small differences
  // happen due to the lookup-table conversion; >20 means something's
  // wrong with the extraction).
  if(result.totalScore && result.rwScore && result.mathScore){
    const diff = Math.abs(result.totalScore - (result.rwScore + result.mathScore));
    if(diff > 20){
      console.warn("[WellEd Parser] score cross-check failed", {
        total: result.totalScore, rw: result.rwScore, math: result.mathScore, diff,
      });
      // Drop the section that's most suspicious. The total is usually
      // most reliable because the "TOTAL SCORE" label is unambiguous.
      const expectedRw = result.totalScore - result.mathScore;
      const expectedMath = result.totalScore - result.rwScore;
      if(_IS_VALID_SECTION(expectedRw) && Math.abs(expectedRw - result.rwScore) > 30){
        result.rwScore = null;
      } else if(_IS_VALID_SECTION(expectedMath) && Math.abs(expectedMath - result.mathScore) > 30){
        result.mathScore = null;
      }
    }
  }

  // Determine type
  if(result.rwScore && !result.mathScore) result.type = "rw-only";
  else if(result.mathScore && !result.rwScore) result.type = "math-only";
  else result.type = "full";

  // Raw scores per module
  const modRx = /Module\s*(\d)\s*(?:\(([^)]+)\))?\s*:\s*(\d+)\s*\/\s*(\d+)/gi;
  let mm;
  while((mm=modRx.exec(textForSearch))!==null){
    const key = `Module ${mm[1]}${mm[2]?" ("+mm[2]+")":""}`;
    result.rawScores[key] = {correct:parseInt(mm[3]),total:parseInt(mm[4])};
  }
  const totalRaw = textForSearch.match(/Total\s*:\s*(\d+)\s*\/\s*(\d+)/i);
  if(totalRaw) result.rawScores["Total"] = {correct:parseInt(totalRaw[1]),total:parseInt(totalRaw[2])};

  // Session 18C v2: WellEd reports do NOT have subskill granularity that
  // maps to our catalog's subdomain taxonomy. They only have the 8
  // standard SAT domains in "Category Scores". So we extract those as
  // DOMAIN entries (not subskills). Subskills array stays empty.
  //
  // Per Aidan: "for subskills, the only things that count toward them
  // are the diagnostic and the scored worksheets. WellEd assignments
  // and practice tests/sections should only be counted toward overall
  // domains."
  const _WELLED_DOMAIN_MAP = [
    ["Information & Ideas",              "Reading & Writing", "information\\s*(?:and|&)\\s*ideas"],
    ["Craft & Structure",                "Reading & Writing", "craft\\s*(?:and|&)\\s*structure"],
    ["Expression of Ideas",              "Reading & Writing", "expression\\s*of\\s*ideas"],
    ["Standard English Conventions",     "Reading & Writing", "standard\\s*english\\s*conventions"],
    ["Algebra",                          "Math",              "(?<!comp\\s)algebra\\b"],
    ["Advanced Math",                    "Math",              "advanced\\s*math"],
    ["Problem-Solving & Data Analysis",  "Math",              "problem[\\s\\-]*solving\\s*(?:and|&)\\s*data\\s*analysis"],
    ["Geometry & Trigonometry",          "Math",              "geometry\\s*(?:and|&)\\s*trigonometry"],
  ];
  // Session 18C v3: domain extraction handles 3 layout variations:
  //   1. "<Domain Name> <earn>/<poss>"   (single column, inline)
  //   2. "<Domain Name>" ... "<earn>/<poss>"   (multi-row, same column)
  //   3. Two-column layout where domain names cluster, then N/M values
  //      cluster separately. The xSortedText pass catches this.
  // We try the strictest pattern first, fall back to a "name followed
  // by N/M anywhere within 80 chars" search.
  for(const [name, subject, srcFrag] of _WELLED_DOMAIN_MAP){
    let earn = null, poss = null;
    // Pattern A: direct adjacency in coordinate-sorted text
    try {
      const rxA = new RegExp(srcFrag + "\\s*(\\d+)\\s*\\/\\s*(\\d+)", "i");
      const ma = textForSearch.match(rxA);
      if(ma){ earn = parseInt(ma[1]); poss = parseInt(ma[2]); }
    } catch { /* bail */ }
    // Pattern B: name followed by N/M within an 80-char window (handles
    // PDFs where progress-bar glyphs or column gaps inject noise).
    if(earn == null){
      try {
        const rxB = new RegExp(srcFrag + "[\\s\\S]{0,80}?(\\d+)\\s*\\/\\s*(\\d+)", "i");
        const mb = textForSearch.match(rxB);
        if(mb){ earn = parseInt(mb[1]); poss = parseInt(mb[2]); }
      } catch { /* bail */ }
    }
    if(earn != null && poss != null && Number.isFinite(earn) && Number.isFinite(poss) && poss > 0 && poss <= 30){
      // Sanity cap: domains have at most ~20 questions; anything bigger
      // is almost certainly a false positive grab from a section total.
      result.domains.push({subject, name, earn, poss});
    }
  }
  // Debug logging — surface what was parsed so failed extractions are
  // diagnosable from the console without re-running the file.
  console.log("[WellEd Parser]", {
    file: file.name,
    testNumber: result.testNumber,
    testedOn: result.testedOn,
    type: result.type,
    totalScore: result.totalScore,
    rwScore: result.rwScore,
    mathScore: result.mathScore,
    domainsFound: result.domains.length,
    domains: result.domains.map(d=>`${d.name} ${d.earn}/${d.poss}`),
  });
  return result;
}

// Normalize a date string from a WellEd report to YYYY-MM-DD.
function _normalizeReportDate(raw){
  if(!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m) return `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if(m){
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${String(m[1]).padStart(2,"0")}-${String(m[2]).padStart(2,"0")}`;
  }
  const MONTHS = {jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if(m){
    const mo = MONTHS[m[1].slice(0,3).toLowerCase()];
    if(mo) return `${m[3]}-${mo}-${String(m[2]).padStart(2,"0")}`;
  }
  return null;
}

/* ============ HEAT COLORS ============ */
const heatColorPct = (pct)=>{
  if(pct===null||pct===undefined) return "#f1f5f9";
  if(pct>=85) return "#15803d";
  if(pct>=70) return "#65a30d";
  if(pct>=55) return "#ca8a04";
  if(pct>=40) return "#ea580c";
  return "#dc2626";
};

/* ============ FIRESTORE HELPERS ============ */
// Firestore is initialized in the HTML shell as window.db
// We use a single document "psm-data/main" to store all app data
// This keeps things simple — one real-time listener, one write target
const FS_DOC = "psm-data/main";
const fsRef = ()=> window.db ? window.db.doc(FS_DOC) : null;
// Write to Firestore (debounced to avoid rapid writes)
let _fsWriteTimer = null;
let _studentsBatchTimer = null;
const fsWrite = (data)=>{
  const ref = fsRef();
  if(!ref) return;
  if(_fsWriteTimer) clearTimeout(_fsWriteTimer);
  _fsWriteTimer = setTimeout(()=>{
    ref.set(data, {merge:true}).catch(e=>console.warn("[Firestore] write error:", e));
  }, 800);
};

// Per-student collection refs (Phase 2). Legacy FS_DOC still used for
// customAssignments and for dual-write during DUAL_WRITE_GRACE.
const studentsCollection = () => window.db ? window.db.collection("students") : null;
const studentDocRef = (id) => window.db ? window.db.collection("students").doc(id) : null;
const notesDocRef = (id) => window.db
  ? window.db.collection("students").doc(id).collection("_private").doc("info")
  : null;
const studentSubmissionsCollection = (id) => window.db
  ? window.db.collection("students").doc(id).collection("submissions")
  : null;

// Session 18A — per-worksheet submissions (foundation; flag-gated below).
//
// New path: students/{sid}/assignments/{aid}/worksheetSubmissions/{worksheetId}
// One doc per worksheet within a PSM. Doc id = worksheetId so reads/writes
// are by-id (no query). Shape:
//   { worksheetId, status: "draft"|"submitted"|"graded",
//     responses: [{questionIndex, studentAnswer, flag}],
//     scoreCorrect?, scoreTotal?, perQuestion?,
//     createdAt, updatedAt, submittedAt?, gradedAt? }
//
// Legacy `students/{sid}/submissions/{subId}` stays the canonical write
// target until PER_WORKSHEET_SUBMIT_ENABLED is flipped on. Read code
// prefers per-worksheet docs when both exist (per-worksheet doc wins for
// the worksheet it represents); legacy fills in the rest.
//
// This commit only adds the helpers + read hook. SubmissionEditor still
// writes legacy. The new write path lands in a follow-up after smoke
// testing on a non-production student.
const studentAssignmentWorksheetSubmissionsCollection = (studentId, assignmentId) =>
  (window.db && studentId && assignmentId)
    ? window.db.collection("students").doc(studentId)
        .collection("assignments").doc(assignmentId)
        .collection("worksheetSubmissions")
    : null;

// Feature flag — read from window.localStorage so we can flip per-browser
// without a redeploy during smoke testing. Set window.localStorage.setItem(
// "psm_per_worksheet_submit", "1") in the dev console to enable.
function perWorksheetSubmitEnabled() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    return window.localStorage.getItem("psm_per_worksheet_submit") === "1";
  } catch {
    return false;
  }
}

// Notes are written out-of-band from the main students batch — they change
// rarely (only on student creation today) and mixing them into every tutor
// state change would fire wasted writes. Notes also must never appear in
// /students/{id} itself because that doc is student-readable.
async function saveStudentNotes(id, notes){
  const ref = notesDocRef(id);
  if(!ref) return;
  try { await ref.set({ notes: notes ?? "" }); }
  catch(e){ console.warn("[Firestore] notes write error:", e); }
}

// Single-doc subscription used by StudentPortal. Never reads the full
// /students collection — that would defeat the per-student rules from
// Phase 2 Session 2. Returns {status, student, error} where status is
// "loading" | "ready" | "not-found" | "error".
//
// Dev-bypass note: ?dev=1 fakes client auth state but does NOT create a
// real Firebase Auth session, and the Firestore rules require one. To test
// the portal locally, sign in for real first (load / without ?dev=1, click
// Sign in with Google, complete workspace auth), then navigate to
// ?dev=1&role=student&studentId=... — the persisted Firebase session will
// satisfy the rules. Without this, reads fail with permission-denied and
// the portal renders the "Couldn't load your student record" error card.
function usePortalStudent(studentId){
  const [state, setState] = useState({status:"loading", student:null, error:null});
  useEffect(()=>{
    if(!studentId){
      setState({status:"not-found", student:null, error:null});
      return;
    }
    const ref = studentDocRef(studentId);
    if(!ref){
      setState({status:"error", student:null, error:new Error("Firestore not initialized")});
      return;
    }
    setState({status:"loading", student:null, error:null});
    const unsub = ref.onSnapshot(
      (snap)=>{
        if(!snap.exists){
          setState({status:"not-found", student:null, error:null});
          return;
        }
        const data = snap.data() || {};
        setState({status:"ready", student:{id:snap.id, ...data}, error:null});
      },
      (err)=>{
        console.warn("[portal] student snapshot error:", err);
        setState({status:"error", student:null, error:err});
      }
    );
    return ()=>unsub();
  }, [studentId]);
  return state;
}

// One-shot lookup for an existing submission doc for (studentId, assignmentId).
// Not a subscription: the editor owns the live textarea state locally, and
// writes are fire-and-forget through a debounced effect. Re-queries when the
// assignment changes. See pickLatestSubmission for the canonical-pick policy.
//
// Same dev-bypass caveat as usePortalStudent: requires a real Firebase Auth
// session. The Firestore rules from Phase 2 Session 2 allow reads only for
// tutor/admin or linked student/parent, neither of which a ?dev=1-only session
// satisfies — sign in for real first.

// Module-cached fetch of the static worksheets catalog hosted at
// /worksheets_catalog.json. Session 14 reads this instead of WS_RAW for
// per-question metadata (questionIds, answerFormat) that Session 12 populated.
// Shared promise — multiple SubmissionEditor instances on the same page
// resolve against one fetch.
let __worksheetCatalogPromise = null;
function fetchWorksheetCatalog(){
  if(__worksheetCatalogPromise) return __worksheetCatalogPromise;
  __worksheetCatalogPromise = fetch("/worksheets_catalog.json", {cache:"force-cache"})
    .then(r => {
      if(!r.ok) throw new Error(`catalog fetch ${r.status}`);
      return r.json();
    })
    .catch(err => {
      __worksheetCatalogPromise = null;  // allow retry on next hook mount
      throw err;
    });
  return __worksheetCatalogPromise;
}
function useWorksheetCatalog(){
  const [state, setState] = useState({status:"loading", catalog:null});
  useEffect(()=>{
    let alive = true;
    fetchWorksheetCatalog().then(
      catalog => { if(alive) setState({status:"ready", catalog}); },
      err => {
        console.warn("[portal] catalog fetch failed:", err);
        if(alive) setState({status:"error", catalog:null});
      }
    );
    return ()=>{ alive = false; };
  }, []);
  return state;
}

// Session 18A: live snapshot of per-worksheet submission docs for one
// (studentId, assignmentId) pair. Returns { status, byWorksheet } where
// byWorksheet is keyed by worksheetId. Used by SubmissionEditor (future)
// for the per-worksheet submit path and by TutorSubmissionsPanel /
// PortalHistoryTab to render per-worksheet status pills.
//
// onSnapshot subscription — tutor + student may be looking at the same
// PSM at the same time, and grading writes happen out-of-band from the
// auto-grade trigger; the live channel keeps the UI consistent without
// hand-rolled invalidation.
function useWorksheetSubmissions(studentId, assignmentId){
  const [state, setState] = useState({status:"loading", byWorksheet:{}});
  useEffect(()=>{
    if(!studentId || !assignmentId){
      setState({status:"not-found", byWorksheet:{}});
      return;
    }
    const col = studentAssignmentWorksheetSubmissionsCollection(studentId, assignmentId);
    if(!col){
      setState({status:"error", byWorksheet:{}});
      return;
    }
    setState({status:"loading", byWorksheet:{}});
    const unsub = col.onSnapshot(
      (snap)=>{
        const by = {};
        snap.forEach(d => { by[d.id] = {id:d.id, ...d.data()}; });
        setState({status:"ready", byWorksheet:by});
      },
      (err)=>{
        console.warn("[portal] worksheetSubmissions snapshot error:", err);
        setState({status:"error", byWorksheet:{}});
      }
    );
    return ()=>unsub();
  }, [studentId, assignmentId]);
  return state;
}

function useSubmissionDraft(studentId, assignmentId){
  const [state, setState] = useState({status:"loading", submission:null});
  useEffect(()=>{
    if(!studentId || !assignmentId){
      setState({status:"not-found", submission:null});
      return;
    }
    const col = studentSubmissionsCollection(studentId);
    if(!col){
      setState({status:"error", submission:null});
      return;
    }
    let cancelled = false;
    setState({status:"loading", submission:null});
    col.where("assignmentId", "==", assignmentId).get()
      .then(snap => {
        if(cancelled) return;
        const docs = snap.docs.map(d => ({id:d.id, ...d.data()}));
        const picked = pickLatestSubmission(docs);
        setState({status: picked ? "ready" : "not-found", submission: picked});
      })
      .catch(err => {
        if(cancelled) return;
        console.warn("[portal] submission query error:", err);
        setState({status:"error", submission:null});
      });
    return ()=>{ cancelled = true; };
  }, [studentId, assignmentId]);
  return state;
}

// Tutor-side live view of one student's submissions. Unlike useSubmissionDraft,
// this is an onSnapshot subscription because the tutor may be reviewing while
// the student is actively submitting — a one-shot .get() would miss the arrival.
// Scoped to one student; the tutor view never needs a cross-student listener.
function useTutorSubmissions(studentId){
  const [state, setState] = useState({status:"loading", submissions:[], error:null});
  useEffect(()=>{
    if(!studentId){
      setState({status:"ready", submissions:[], error:null});
      return;
    }
    const col = studentSubmissionsCollection(studentId);
    if(!col){
      setState({status:"error", submissions:[], error:new Error("Firestore not initialized")});
      return;
    }
    setState({status:"loading", submissions:[], error:null});
    const unsub = col.onSnapshot(
      (snap)=>{
        const docs = snap.docs.map(d => ({id:d.id, ...d.data()}));
        setState({status:"ready", submissions:docs, error:null});
      },
      (err)=>{
        console.warn("[tutor] submissions snapshot error:", err);
        setState({status:"error", submissions:[], error:err});
      }
    );
    return ()=>unsub();
  }, [studentId]);
  return state;
}

// Fetches display metadata ({id, name, grade}) for a small list of children
// in parallel. One-shot .get() per id — labels don't need live updates, and
// the selected child's full live view still goes through usePortalStudent.
// Per-child failures fall back to blank name so the switcher stays usable.
function usePortalChildrenMeta(studentIds){
  const key = (studentIds || []).join(",");
  const [state, setState] = useState({
    status: studentIds && studentIds.length ? "loading" : "idle",
    children: []
  });
  useEffect(()=>{
    if(!studentIds || studentIds.length === 0){
      setState({status:"idle", children:[]});
      return;
    }
    if(!window.db){
      setState({status:"error", children: studentIds.map(id=>({id, name:"", grade:""}))});
      return;
    }
    let cancelled = false;
    setState({status:"loading", children:[]});
    Promise.all(studentIds.map(id =>
      window.db.collection("students").doc(id).get()
        .then(snap => snap.exists
          ? {id, name: (snap.data()||{}).name || "", grade: (snap.data()||{}).grade || ""}
          : {id, name:"", grade:""}
        )
        .catch(err => {
          console.warn("[portal] child meta fetch error:", id, err);
          return {id, name:"", grade:""};
        })
    )).then(children => {
      if(!cancelled) setState({status:"ready", children});
    });
    return ()=>{ cancelled = true; };
  // key is the stable join of ids — avoids re-running on unrelated re-renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/* ============ AUTH GATE ============ */
// Allowlist-based auth. Any signed-in, email-verified Firebase Auth user
// whose lowercased email appears as an active `allowlist/{email}` doc is
// granted access; their role and linked student ids are read from that
// doc. Enforced server-side by firestore.rules. This component is UX.

// Dual-write grace window for the Phase 2 schema migration. When true,
// tutor writes go to BOTH /students/{id} (new authoritative path) and
// psm-data/main.students[] (legacy blob). Kept on for ~24 hours post-cutover
// so an in-window rollback is a client revert instead of a reverse
// migration. Flipped to false manually after a clean monitoring window.
// See docs/PHASE_2_SESSION_1.md §Cutover sequence.
const DUAL_WRITE_GRACE = true;

// Read allowlist/{emailLowercase}. Returns {role, studentIds, active, ...} or null.
// One-shot, not a subscription — cached in React state for the session.
async function getAllowlistEntry(email){
  if(!window.db || !email) return null;
  const key = String(email).trim().toLowerCase();
  if(!key) return null;
  try{
    const snap = await window.db.collection("allowlist").doc(key).get();
    if(!snap.exists) return null;
    const data = snap.data() || {};
    // Normalize: studentIds is the source of truth; fall back to legacy singular studentId.
    const studentIds = Array.isArray(data.studentIds)
      ? data.studentIds
      : (data.studentId ? [data.studentId] : []);
    return {
      email: data.email || key,
      role: data.role || null,
      studentIds,
      active: data.active !== false, // default true if missing
      addedBy: data.addedBy || null,
      addedAt: data.addedAt || null,
      raw: data,
    };
  } catch(e){
    console.warn("[allowlist] read error:", e);
    return null;
  }
}

function LockoutScreen({email, onSignOut}){
  return (
    <div style={{
      minHeight:"100vh",background:"var(--paper)",display:"flex",
      alignItems:"center",justifyContent:"center",padding:"40px 24px",
      backgroundImage:"radial-gradient(circle at 20% 10%, rgba(154,91,31,.08), transparent 45%), radial-gradient(circle at 80% 80%, rgba(0,74,121,.05), transparent 45%)"
    }}>
      <div style={{
        maxWidth:480,width:"100%",background:"var(--card)",
        border:"1px solid var(--rule)",borderRadius:14,
        boxShadow:"var(--shadow-lg)",padding:"44px 44px 36px",position:"relative",overflow:"hidden"
      }}>
        <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,var(--accent) 0,var(--accent) 72px,transparent 72px)"}}/>
        <h2 style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 72",fontWeight:500,fontSize:22,margin:"0 0 10px",letterSpacing:"-0.01em"}}>Account not authorized</h2>
        <p style={{fontSize:13.5,lineHeight:1.55,color:"var(--ink-soft)",margin:"0 0 18px"}}>
          You signed in successfully, but this account isn't on the SAT Student Portal allowlist yet. Send the email below to Kiran or Aidan and they can add you.
        </p>
        <div style={{
          padding:"12px 14px",borderRadius:8,background:"var(--paper-alt)",
          border:"1px solid var(--rule)",fontFamily:"var(--font-mono)",fontSize:13,
          color:"var(--ink)",userSelect:"all",marginBottom:22,wordBreak:"break-all"
        }}>{email || "(no email on account)"}</div>
        <button
          onClick={onSignOut}
          style={{
            width:"100%",padding:"12px 20px",borderRadius:10,
            border:"1px solid var(--rule-strong)",background:"var(--card)",
            color:"var(--ink)",fontFamily:"var(--font-body)",fontSize:13.5,
            fontWeight:500,cursor:"pointer"
          }}>Sign out and try a different account</button>
        <div style={{marginTop:24,paddingTop:16,borderTop:"1px solid var(--rule)",fontSize:11,color:"var(--ink-mute)",lineHeight:1.6}}>
          If you were recently added to the allowlist, try reloading this page.
        </div>
      </div>
    </div>
  );
}

function SignInScreen({onGoogleSignIn, onEmailSignIn, onForgotPassword, onEmailLinkSignIn, error, info, busy, initialMode}){
  // Default to "emaillink" when we've detected a pending assignment from a
  // Wise deep link — students landing via Wise should see the email-link
  // path first, not Google.
  const [mode, setMode] = useState(initialMode || "google"); // "google" | "password" | "emaillink"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [linkEmail, setLinkEmail] = useState("");

  const tabStyle = (active)=>({
    flex:1, padding:"10px 14px", border:"1px solid var(--rule-strong)",
    background: active ? "var(--brand)" : "var(--card)",
    color: active ? "var(--paper)" : "var(--ink-soft)",
    fontFamily:"var(--font-body)", fontSize:12.5, fontWeight:500,
    letterSpacing:"0.02em", cursor: active ? "default" : "pointer",
  });

  const input = {
    width:"100%", padding:"12px 14px", borderRadius:10,
    border:"1px solid var(--rule-strong)", background:"var(--paper)",
    fontFamily:"var(--font-body)", fontSize:14, color:"var(--ink)",
    marginBottom:12,
  };

  const submitEmail = (e)=>{
    if(e && e.preventDefault) e.preventDefault();
    const em = email.trim().toLowerCase();
    if(!em || !password){ return; }
    onEmailSignIn(em, password);
  };

  const forgot = ()=>{
    const em = email.trim().toLowerCase();
    onForgotPassword(em);
  };

  const submitLink = (e)=>{
    if(e && e.preventDefault) e.preventDefault();
    const em = linkEmail.trim().toLowerCase();
    if(!em) return;
    onEmailLinkSignIn(em);
  };

  return (
    <div style={{
      minHeight:"100vh",background:"var(--paper)",display:"flex",
      alignItems:"center",justifyContent:"center",padding:"40px 24px",
      backgroundImage:"radial-gradient(circle at 20% 10%, rgba(0,74,121,.06), transparent 45%), radial-gradient(circle at 80% 80%, rgba(154,91,31,.05), transparent 45%)"
    }}>
      <div style={{
        maxWidth:480,width:"100%",background:"var(--card)",
        border:"1px solid var(--rule)",borderRadius:14,
        boxShadow:"var(--shadow-lg)",padding:"44px 44px 36px",position:"relative",overflow:"hidden"
      }}>
        <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,var(--brand) 0,var(--brand) 72px,transparent 72px)"}}/>
        <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:28}}>
          <img src="ats_logo.png" alt="ATS" style={{width:48,height:48,borderRadius:11,boxShadow:"0 0 0 1px var(--rule-strong), 0 6px 16px -8px rgba(0,74,121,.45)"}}/>
          <div>
            <div style={{fontFamily:"var(--font-body)",fontSize:10,fontWeight:600,letterSpacing:"0.18em",textTransform:"uppercase",color:"var(--ink-mute)",marginBottom:4}}>Affordable Tutoring Solutions</div>
            <div style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 144, 'SOFT' 20",fontWeight:600,fontSize:26,letterSpacing:"-0.02em",lineHeight:1.05,color:"var(--ink)"}}>PSM <em style={{fontStyle:"italic",color:"var(--brand)",fontWeight:500}}>Generator</em></div>
          </div>
        </div>
        <h2 style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 72",fontWeight:500,fontSize:22,margin:"0 0 10px",letterSpacing:"-0.01em"}}>Sign in</h2>
        <p style={{fontSize:13.5,lineHeight:1.55,color:"var(--ink-soft)",margin:"0 0 22px"}}>
          Access is limited to authorized users. If you don&apos;t see an account here yet, ask Kiran or Aidan for an invitation.
        </p>

        <div style={{display:"flex",marginBottom:8,borderRadius:10,overflow:"hidden"}}>
          <button type="button" onClick={()=>setMode("google")} style={{...tabStyle(mode==="google"), borderRadius:"10px 0 0 10px", borderRight:"none"}}>Google</button>
          <button type="button" onClick={()=>setMode("emaillink")} style={{...tabStyle(mode==="emaillink"), borderRadius:0, borderRight:"none"}}>Email link</button>
          <button type="button" onClick={()=>setMode("password")} style={{...tabStyle(mode==="password"), borderRadius:"0 10px 10px 0"}}>Password</button>
        </div>
        <div style={{fontSize:11,color:"var(--ink-mute)",lineHeight:1.5,marginBottom:18,letterSpacing:"0.01em"}}>
          <strong style={{color:"var(--ink-soft)",fontWeight:600}}>Students &amp; parents</strong>: use <span style={{textDecoration:"underline",color:"var(--ink-soft)"}}>Email link</span>. <strong style={{color:"var(--ink-soft)",fontWeight:600}}>Tutors</strong>: use <span style={{textDecoration:"underline",color:"var(--ink-soft)"}}>Google</span> or <span style={{textDecoration:"underline",color:"var(--ink-soft)"}}>Password</span>.
        </div>

        {mode === "google" && (
          <>
            <button
              onClick={onGoogleSignIn}
              disabled={busy}
              style={{
                width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:12,
                padding:"14px 20px",borderRadius:10,border:"1px solid var(--brand)",
                background:busy?"var(--paper-alt)":"var(--brand)",color:busy?"var(--ink-mute)":"var(--paper)",
                fontFamily:"var(--font-body)",fontSize:14,fontWeight:500,letterSpacing:"0.01em",
                cursor:busy?"default":"pointer",boxShadow:busy?"none":"0 6px 18px -10px rgba(0,74,121,.7)"
              }}>
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path fill="#fff" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
                <path fill="#fff" opacity=".95" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                <path fill="#fff" opacity=".85" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
                <path fill="#fff" opacity=".75" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
              </svg>
              <span>{busy ? "Opening Google…" : "Continue with Google"}</span>
            </button>
          </>
        )}

        {mode === "emaillink" && (
          <form onSubmit={submitLink}>
            <p style={{fontSize:12.5,lineHeight:1.55,color:"var(--ink-soft)",margin:"0 0 14px"}}>
              Enter your email and we&apos;ll send you a one-time sign-in link. No password needed.
            </p>
            <input
              type="email" autoComplete="email" placeholder="Email"
              value={linkEmail} onChange={e=>setLinkEmail(e.target.value)}
              style={input} disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !linkEmail}
              style={{
                width:"100%",padding:"14px 20px",borderRadius:10,border:"1px solid var(--brand)",
                background:(busy||!linkEmail)?"var(--paper-alt)":"var(--brand)",
                color:(busy||!linkEmail)?"var(--ink-mute)":"var(--paper)",
                fontFamily:"var(--font-body)",fontSize:14,fontWeight:500,letterSpacing:"0.01em",
                cursor:(busy||!linkEmail)?"default":"pointer",
                boxShadow:(busy||!linkEmail)?"none":"0 6px 18px -10px rgba(0,74,121,.7)"
              }}>
              {busy ? "Sending…" : "Send sign-in link"}
            </button>
          </form>
        )}

        {mode === "password" && (
          <form onSubmit={submitEmail}>
            <input
              type="email" autoComplete="email" placeholder="Email"
              value={email} onChange={e=>setEmail(e.target.value)}
              style={input} disabled={busy}
            />
            <input
              type="password" autoComplete="current-password" placeholder="Password"
              value={password} onChange={e=>setPassword(e.target.value)}
              style={input} disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !email || !password}
              style={{
                width:"100%",padding:"14px 20px",borderRadius:10,border:"1px solid var(--brand)",
                background:(busy||!email||!password)?"var(--paper-alt)":"var(--brand)",
                color:(busy||!email||!password)?"var(--ink-mute)":"var(--paper)",
                fontFamily:"var(--font-body)",fontSize:14,fontWeight:500,letterSpacing:"0.01em",
                cursor:(busy||!email||!password)?"default":"pointer",
                boxShadow:(busy||!email||!password)?"none":"0 6px 18px -10px rgba(0,74,121,.7)"
              }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <div style={{marginTop:12,textAlign:"center"}}>
              <button type="button" onClick={forgot} disabled={busy} style={{
                background:"none",border:"none",color:"var(--brand)",
                fontFamily:"var(--font-body)",fontSize:12,cursor:busy?"default":"pointer",
                textDecoration:"underline"
              }}>
                Forgot password?
              </button>
            </div>
          </form>
        )}

        {error && (
          <div style={{
            marginTop:18,padding:"12px 14px",borderRadius:8,
            background:"var(--accent-soft)",border:"1px solid rgba(154,91,31,.3)",
            fontSize:12.5,color:"var(--accent)",lineHeight:1.5
          }}>{error}</div>
        )}
        {info && !error && (
          <div style={{
            marginTop:18,padding:"12px 14px",borderRadius:8,
            background:"var(--brand-soft)",border:"1px solid rgba(0,74,121,.25)",
            fontSize:12.5,color:"var(--brand)",lineHeight:1.5
          }}>{info}</div>
        )}
        <div style={{marginTop:28,paddingTop:18,borderTop:"1px solid var(--rule)",fontSize:11,color:"var(--ink-mute)",letterSpacing:"0.01em",lineHeight:1.6}}>
          Need access? Ask Kiran or Aidan to add you. Families without Google accounts can request a password account.
        </div>
      </div>
    </div>
  );
}

function UnverifiedScreen({email, onResend, onSignOut, busy, info, error}){
  return (
    <div style={{
      minHeight:"100vh",background:"var(--paper)",display:"flex",
      alignItems:"center",justifyContent:"center",padding:"40px 24px",
      backgroundImage:"radial-gradient(circle at 20% 10%, rgba(154,91,31,.08), transparent 45%), radial-gradient(circle at 80% 80%, rgba(0,74,121,.05), transparent 45%)"
    }}>
      <div style={{
        maxWidth:480,width:"100%",background:"var(--card)",
        border:"1px solid var(--rule)",borderRadius:14,
        boxShadow:"var(--shadow-lg)",padding:"44px 44px 36px",position:"relative",overflow:"hidden"
      }}>
        <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,var(--brand) 0,var(--brand) 72px,transparent 72px)"}}/>
        <h2 style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 72",fontWeight:500,fontSize:22,margin:"0 0 10px",letterSpacing:"-0.01em"}}>Check your email</h2>
        <p style={{fontSize:13.5,lineHeight:1.55,color:"var(--ink-soft)",margin:"0 0 18px"}}>
          Your email isn&apos;t verified yet. Open the setup link we sent to{" "}
          <span style={{fontFamily:"var(--font-mono)",fontSize:12.5,color:"var(--ink)"}}>{email || "your email"}</span>{" "}
          and follow it to set your password — that step also verifies your address. Then come back and sign in.
        </p>
        <button
          onClick={onResend}
          disabled={busy}
          style={{
            width:"100%",padding:"12px 20px",borderRadius:10,
            border:"1px solid var(--brand)",background:busy?"var(--paper-alt)":"var(--brand)",
            color:busy?"var(--ink-mute)":"var(--paper)",
            fontFamily:"var(--font-body)",fontSize:13.5,fontWeight:500,
            cursor:busy?"default":"pointer",marginBottom:10
          }}>{busy?"Sending…":"Resend setup link"}</button>
        <button
          onClick={onSignOut}
          style={{
            width:"100%",padding:"12px 20px",borderRadius:10,
            border:"1px solid var(--rule-strong)",background:"var(--card)",
            color:"var(--ink)",fontFamily:"var(--font-body)",fontSize:13.5,
            fontWeight:500,cursor:"pointer"
          }}>Sign out</button>
        {info && !error && (
          <div style={{marginTop:18,padding:"12px 14px",borderRadius:8,background:"var(--brand-soft)",border:"1px solid rgba(0,74,121,.25)",fontSize:12.5,color:"var(--brand)",lineHeight:1.5}}>{info}</div>
        )}
        {error && (
          <div style={{marginTop:18,padding:"12px 14px",borderRadius:8,background:"var(--accent-soft)",border:"1px solid rgba(154,91,31,.3)",fontSize:12.5,color:"var(--accent)",lineHeight:1.5}}>{error}</div>
        )}
      </div>
    </div>
  );
}

// Session 13: shown when a student opens a Firebase email-link URL on a
// different device than the one that requested the link. We can't complete
// signInWithEmailLink without replaying the email it was sent to, and
// localStorage from the requesting device isn't available here. Firebase
// requires this step explicitly to defend against link forwarding.
function ConfirmEmailScreen({onConfirm, error, busy}){
  const [email, setEmail] = useState("");
  const submit = (e)=>{
    if(e && e.preventDefault) e.preventDefault();
    const em = email.trim().toLowerCase();
    if(!em) return;
    onConfirm(em);
  };
  return (
    <div style={{
      minHeight:"100vh",background:"var(--paper)",display:"flex",
      alignItems:"center",justifyContent:"center",padding:"40px 24px",
      backgroundImage:"radial-gradient(circle at 20% 10%, rgba(0,74,121,.06), transparent 45%), radial-gradient(circle at 80% 80%, rgba(154,91,31,.05), transparent 45%)"
    }}>
      <div style={{
        maxWidth:480,width:"100%",background:"var(--card)",
        border:"1px solid var(--rule)",borderRadius:14,
        boxShadow:"var(--shadow-lg)",padding:"44px 44px 36px",position:"relative",overflow:"hidden"
      }}>
        <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,var(--brand) 0,var(--brand) 72px,transparent 72px)"}}/>
        <h2 style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 72",fontWeight:500,fontSize:22,margin:"0 0 10px",letterSpacing:"-0.01em"}}>Confirm your email</h2>
        <p style={{fontSize:13.5,lineHeight:1.55,color:"var(--ink-soft)",margin:"0 0 18px"}}>
          Type the email address this sign-in link was sent to. We need to match the link to the right account before signing you in.
        </p>
        <form onSubmit={submit}>
          <input
            type="email" autoComplete="email" placeholder="Email"
            value={email} onChange={e=>setEmail(e.target.value)}
            style={{
              width:"100%", padding:"12px 14px", borderRadius:10,
              border:"1px solid var(--rule-strong)", background:"var(--paper)",
              fontFamily:"var(--font-body)", fontSize:14, color:"var(--ink)",
              marginBottom:12,
            }}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !email}
            style={{
              width:"100%",padding:"14px 20px",borderRadius:10,border:"1px solid var(--brand)",
              background:(busy||!email)?"var(--paper-alt)":"var(--brand)",
              color:(busy||!email)?"var(--ink-mute)":"var(--paper)",
              fontFamily:"var(--font-body)",fontSize:14,fontWeight:500,letterSpacing:"0.01em",
              cursor:(busy||!email)?"default":"pointer",
            }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {error && (
          <div style={{marginTop:18,padding:"12px 14px",borderRadius:8,background:"var(--accent-soft)",border:"1px solid rgba(154,91,31,.3)",fontSize:12.5,color:"var(--accent)",lineHeight:1.5}}>{error}</div>
        )}
      </div>
    </div>
  );
}

// ── Dev bypass (Option C) ──────────────────────────────────────────────────
// Localhost-only escape hatch: if the page is served from localhost/127.0.0.1
// AND the URL contains ?dev=1, skip SignInScreen and stub a fake authUser so
// Claude (or any dev) can visually verify UI changes without the Google
// workspace gate. BOTH conditions are required — production hostnames ignore
// the flag entirely. The Firestore security rules are the real data gate and
// are untouched by this bypass: writes will be rejected server-side and the
// app falls back to localStorage automatically. This ONLY hides the client-
// side SignInScreen; it does not weaken any security boundary.
const DEV_BYPASS = (()=>{
  if(typeof window === "undefined" || typeof location === "undefined") return false;
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if(!isLocal) return false;
  try{
    return new URLSearchParams(location.search).get("dev") === "1";
  }catch{ return false; }
})();
// Optional role override for local dev bypass: ?dev=1&role=admin|tutor|student|parent
// Lets Claude (or Kiran) exercise the Phase 2 role-aware code paths without
// being on a real Firestore allowlist. Only read when DEV_BYPASS is active.
const DEV_FAKE_ROLE = (()=>{
  if(!DEV_BYPASS) return null;
  try{
    const r = new URLSearchParams(location.search).get("role");
    if(!r) return null;
    const allowed = ["admin","tutor","student","parent"];
    return allowed.includes(r) ? r : null;
  }catch{ return null; }
})();
// Optional studentId override for portal dev bypass. Accepts a single id or
// a comma-separated list so parent multi-child can be tested locally:
//   ?dev=1&role=student&studentId=rnbw56f5
//   ?dev=1&role=parent&studentId=id1,id2,id3
// When absent and role is student/parent, the portal renders an empty state.
const DEV_FAKE_STUDENT_IDS = (()=>{
  if(!DEV_BYPASS) return [];
  try{
    const raw = new URLSearchParams(location.search).get("studentId") || "";
    return raw.split(",").map(s=>s.trim()).filter(Boolean);
  }catch{ return []; }
})();
const DEV_FAKE_USER = {
  email: "dev@localhost",
  displayName: "Dev User",
  photoURL: null,
  emailVerified: true,
  uid: "dev-local",
};
// Default dev bypass role when none specified: "tutor" preserves prior behavior.
const DEV_FAKE_ENTRY = {
  email: "dev@localhost",
  role: DEV_FAKE_ROLE || "tutor",
  studentIds: DEV_FAKE_STUDENT_IDS,
  active: true,
  addedBy: "dev-bypass",
  addedAt: null,
};

// ── Session 13: magic-link auth + deep-link handoff ───────────────────────
// Hardcoded prod host so Wise-delivered deep links always return to the
// custom domain, never psm-generator.web.app — see PHASE_3_SESSION_11b.md
// follow-up #5. On localhost we fall back to location.origin so dev-mode
// email-link flows can be exercised without bouncing through prod.
const AUTH_CONTINUE_HOST = (()=>{
  if(typeof location === "undefined") return "https://portal.affordabletutoringsolutions.org";
  const h = location.hostname;
  if(h === "localhost" || h === "127.0.0.1") return location.origin;
  return "https://portal.affordabletutoringsolutions.org";
})();

// sessionStorage key the deep-link parser stashes into, and StudentPortal
// reads on mount. Session 14 replaces the banner with a real editor open.
const PENDING_ASSIGNMENT_KEY = "psm-pending-assignment";
// localStorage key for the email the user typed into SignInScreen. Firebase
// requires us to replay it when completing signInWithEmailLink so we can
// verify the link hasn't been forwarded to a different address. Cross-device
// opens clear localStorage between devices; ConfirmEmailScreen handles that.
const EMAIL_FOR_SIGNIN_KEY = "psm-email-for-signin";

// Parse ?a=<assignmentId>&s=<studentId> out of the current URL and stash in
// sessionStorage. Called at module load (initial deep-link arrival) and again
// after the Firebase email-link redirect, since Firebase preserves the `a`
// and `s` params on the continue URL it bounces back to.
function stashPendingAssignmentFromUrl(){
  if(typeof location === "undefined" || typeof sessionStorage === "undefined") return;
  try{
    const params = new URLSearchParams(location.search);
    const a = params.get("a");
    const s = params.get("s");
    if(a && s){
      sessionStorage.setItem(PENDING_ASSIGNMENT_KEY, JSON.stringify({a, s, stashedAt: Date.now()}));
    }
  }catch{ /* private mode or malformed URL — ignore */ }
}
stashPendingAssignmentFromUrl();

// Build the continueUrl passed to sendSignInLinkToEmail. Preserves whatever
// ?a=&s= params are on the current URL so the student lands back on the
// same assignment after clicking the email link, then `a` and `s` get
// re-stashed on return by stashPendingAssignmentFromUrl().
function buildAuthContinueUrl(){
  try{
    const u = new URL(AUTH_CONTINUE_HOST);
    const cur = new URLSearchParams(location.search);
    const a = cur.get("a");
    const s = cur.get("s");
    if(a) u.searchParams.set("a", a);
    if(s) u.searchParams.set("s", s);
    return u.toString();
  }catch{
    return AUTH_CONTINUE_HOST;
  }
}

// Portal routing helper. Session 4 will add a child-switcher that may pick a
// different id from entry.studentIds; for Session 3 we always take the first.
function pickPortalStudentId(entry){
  if(!entry) return "";
  const ids = Array.isArray(entry.studentIds) ? entry.studentIds : [];
  return ids[0] || "";
}

// Parent multi-child picker. Given the parent's allowlist entry and the
// id they last viewed (from localStorage), return the id to render now.
// Falls back to studentIds[0] when the stored id is stale or missing.
// Returns "" when there are no linked children. Kept pure for unit testing.
function pickParentSelectedChildId(entry, storedId){
  if(!entry) return "";
  const ids = Array.isArray(entry.studentIds) ? entry.studentIds : [];
  if(ids.length === 0) return "";
  if(ids.length === 1) return ids[0];
  if(storedId && ids.includes(storedId)) return storedId;
  return ids[0];
}

// Canonical pick across N submission docs for the same assignment. Draft
// wins over any submitted (students can only have one open draft at a time);
// otherwise the most recent submittedAt — Firestore Timestamps normalized via
// toMillis, ISO strings via Date.parse.
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

// Group submissions under their assignment. Newest-assignment-first (matches
// the tutor's mental model in the rest of StudentProfile). Submissions whose
// assignment has been deleted fall into a trailing {assignment:null} bucket
// so the tutor can still see and delete them.
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

// "Reviewed" means the tutor has recorded both scoreCorrect and scoreTotal
// on the submission. scoreTotal of 0 is treated as unreviewed to guard the
// percent-correct division below.
function isSubmissionReviewed(sub){
  return sub
    && typeof sub.scoreTotal === "number"
    && sub.scoreTotal > 0
    && typeof sub.scoreCorrect === "number";
}

// Session 15: a submission is "stale-unscored" if it's been submitted for
// more than ~30s and still has no scoreCorrect AND no gradeSkipReason AND
// no gradedAt marker. This is how we distinguish the <1s race window
// between submit-click and trigger-fire from genuinely-never-graded docs
// (pre-Session-15 submissions, or trigger crashes). 30s is comfortably
// above the normal cold-start + grade latency (~1-3s observed).
function isSubmissionStaleUnscored(sub){
  if(!sub || sub.status !== "submitted") return false;
  if(typeof sub.scoreCorrect === "number") return false;
  if(sub.gradeSkipReason) return false;
  if(sub.gradedAt) return false;
  if(!sub.submittedAt) return true; // no timestamp → assume stale
  try {
    const t = sub.submittedAt.toDate
      ? sub.submittedAt.toDate()
      : new Date(sub.submittedAt);
    return (Date.now() - t.getTime()) > 30_000;
  } catch { return true; }
}

// Rolling totals across all reviewed submissions for this student. Drafts and
// unreviewed-submitted docs don't contribute to the question counts — they
// surface separately so the tutor knows there's work left.
function summarizeSubmissions(submissions){
  const list = Array.isArray(submissions) ? submissions.filter(Boolean) : [];
  const drafts = list.filter(s => s.status === "draft");
  const submitted = list.filter(s => s.status === "submitted");
  const reviewed = submitted.filter(isSubmissionReviewed);
  const unreviewed = submitted.filter(s => !isSubmissionReviewed(s));
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

// Normalizes the submittedAt field (Firestore Timestamp, ISO string, or null)
// into a YYYY-MM-DD display string. Shared by the tutor summary and row UI.
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

// Tutor review write payload. Numeric scope: scoreCorrect/scoreTotal describe
// "N correct out of M" per submission. Passing null/undefined/zero-total clears
// all three review fields so the doc reverts to unreviewed cleanly on reload.
// reviewerNotes is always written so empty-string clears propagate.
function makeReviewPayload({scoreCorrect, scoreTotal, reviewerNotes}){
  const FV = firebase.firestore.FieldValue;
  const payload = {
    reviewerNotes: typeof reviewerNotes === "string" ? reviewerNotes : "",
  };
  const hasScore = typeof scoreCorrect === "number"
    && typeof scoreTotal === "number"
    && scoreTotal > 0;
  if(hasScore){
    payload.scoreCorrect = Math.max(0, Math.min(scoreCorrect, scoreTotal));
    payload.scoreTotal = scoreTotal;
    payload.reviewedAt = FV.serverTimestamp();
  } else {
    payload.scoreCorrect = FV.delete();
    payload.scoreTotal = FV.delete();
    payload.reviewedAt = FV.delete();
  }
  return payload;
}

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

function makeDraftPayload({assignmentId, answersText, answersByWorksheet, flagsByWorksheet, catalogByWorksheetId, isCreate}){
  const FV = firebase.firestore.FieldValue;
  let responses;
  if(answersByWorksheet && catalogByWorksheetId){
    // Nested shape — one entry per question per worksheet, flat + tagged.
    // Session 18A: optional flagsByWorksheet[wId][i] ∈ {"star","question",null}.
    // Always included so the grader can read it; null = no flag (legacy).
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
    // Legacy single-blob shape — zero-worksheet fallback or Phase 2 resume.
    responses = [{worksheetId: null, questionIndex: 0, studentAnswer: answersText || "", flag: null}];
  }
  const base = {
    assignmentId,
    responses,
    status: "draft",
    updatedAt: FV.serverTimestamp(),
  };
  if(isCreate) base.createdAt = FV.serverTimestamp();
  return base;
}

// Build the x-ordered points the Score Trends chart plots. A full practice
// score is any point whose category matches the fullPts regex used in
// ScoreHistoryPanel. Dateless / NaN points are dropped (can't be plotted).
function buildScoreTrendsSeries(student){
  const pts = allScoreDataPoints(student);
  const isFull = (cat)=> /Total SAT|R&W Section|Math Section|Full —|Section —|Practice|Official SAT|Full Practice|BlueBook|WellEd Full/i.test(cat||"");
  return pts
    .filter(pt => isFull(pt.category) && pt.level!=="domain" && pt.level!=="sub")
    .filter(pt => pt.date && typeof pt.score==="number" && !Number.isNaN(pt.score))
    .map(pt => ({date: pt.date, score: pt.score, label: pt.category||"Exam"}))
    .sort((a,b)=> a.date.localeCompare(b.date));
}

// Top-level role-aware router. Tutors and admins see AppInner. Students and
// parents see StudentPortal scoped to their linked student(s). This is the
// only place the role check gates which app renders.
// Session 18B: read impersonation target from URL. Tutors/admins can
// open ?impersonate=<studentId> to view the portal as that student.
// Returns null when the param is missing, the URL APIs aren't available,
// or the value is empty.
function getImpersonateStudentId(){
  try {
    if(typeof window === "undefined" || !window.location) return null;
    const params = new URLSearchParams(window.location.search || "");
    const v = (params.get("impersonate") || "").trim();
    return v || null;
  } catch { return null; }
}

function RoleRouter({authUser, onSignOut, currentUserEntry}){
  const role = currentUserEntry?.role || null;
  // Session 18C v8: diagnostic logging — when a student reports a
  // blank/wrong page, this gives us the exact entry state from the
  // console.
  if(typeof window !== "undefined" && !window._loggedRoleOnce){
    window._loggedRoleOnce = true;
    console.log("[RoleRouter]", {
      email: (currentUserEntry && currentUserEntry.email) || (authUser && authUser.email) || null,
      role,
      studentIds: (currentUserEntry && currentUserEntry.studentIds) || [],
      url: typeof location !== "undefined" ? location.href : "",
      stashed: (typeof sessionStorage !== "undefined") ? sessionStorage.getItem(PENDING_ASSIGNMENT_KEY) : null,
    });
  }

  // Session 18B: admin/tutor impersonation. Renders the student portal
  // for the target studentId, with a banner indicating read-only view.
  // Security: only admin/tutor roles can impersonate. The portal still
  // reads data via the tutor's own auth session — Firestore rules permit
  // tutor reads of any student doc, so no rule changes required.
  const impersonateId = getImpersonateStudentId();
  if(impersonateId && (role === "admin" || role === "tutor")){
    return <StudentPortal
      studentId={impersonateId}
      onSignOut={onSignOut}
      currentUserEntry={currentUserEntry}
      impersonating={true}
    />;
  }

  if(role === "parent"){
    const ids = Array.isArray(currentUserEntry?.studentIds) ? currentUserEntry.studentIds : [];
    if(ids.length > 1){
      return <ParentPortal onSignOut={onSignOut} currentUserEntry={currentUserEntry}/>;
    }
    // Single-child or zero-child parent falls through to the same
    // single-student path students use.
  }
  if(role === "student" || role === "parent"){
    const studentId = pickPortalStudentId(currentUserEntry);
    return <StudentPortal studentId={studentId} onSignOut={onSignOut} currentUserEntry={currentUserEntry}/>;
  }
  // Session 18C v8: tutor/admin → tutor app. Any OTHER role (or no role
  // at all) lands here — used to silently fall through to AppInner,
  // which crashes for non-tutors because they don't have Firestore
  // permission for tutor reads (no /students/* list, no admin allowlist
  // access, etc.). That crash + no top-level error boundary = blank
  // page, which is what Michael was seeing when his allowlist entry
  // came back without role:'student' set.
  //
  // Now: if role is tutor/admin, show the tutor app. Anything else
  // shows a helpful diagnostic screen instead of a blank crash.
  if(role === "tutor" || role === "admin"){
    return <AppInner authUser={authUser} onSignOut={onSignOut} currentUserEntry={currentUserEntry}/>;
  }
  // Unrecognized / missing role.
  return (
    <div style={{minHeight:"100vh",background:"var(--paper)",display:"flex",alignItems:"center",justifyContent:"center",padding:"24px"}}>
      <div style={{...CARD, padding:"40px 32px", maxWidth: 520, textAlign:"left"}}>
        <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,fontWeight:700,letterSpacing:1.4,color:"#9A5B1F",textTransform:"uppercase",marginBottom:6}}>
          Account not configured
        </div>
        <h2 style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:22,fontWeight:600,color:"#0F1A2E",margin:"0 0 14px",letterSpacing:-.2}}>
          Hi {(currentUserEntry && currentUserEntry.email) || (authUser && authUser.email) || "there"} — your account is signed in but missing a role.
        </h2>
        <div style={{fontSize:13,color:"#66708A",lineHeight:1.6,marginBottom:16}}>
          We see your allowlist entry but it doesn't have a role set yet
          (student / parent / tutor / admin). Please contact your tutor to
          have your role configured. Once that's done, click your portal
          link again.
        </div>
        <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",marginBottom:18,padding:"8px 10px",background:"rgba(15,26,46,.04)",borderRadius:4,wordBreak:"break-all"}}>
          email: {(currentUserEntry && currentUserEntry.email) || (authUser && authUser.email) || "(unknown)"}<br/>
          role: {role || "(not set)"}<br/>
          studentIds: {JSON.stringify((currentUserEntry && currentUserEntry.studentIds) || [])}
        </div>
        <button onClick={onSignOut} style={{...mkBtn("transparent","#0F1A2E"),border:"1px solid rgba(15,26,46,.2)",padding:"10px 18px",fontSize:12}}>
          Sign out
        </button>
      </div>
    </div>
  );
}

function App(){
  const [authUser, setAuthUser] = useState(()=>{
    if(DEV_BYPASS) return DEV_FAKE_USER;
    return window.auth ? window.auth.currentUser : null;
  });
  // currentUserEntry: the allowlist entry for the signed-in user, or null.
  const [currentUserEntry, setCurrentUserEntry] = useState(()=>{
    if(DEV_BYPASS) return DEV_FAKE_ENTRY;
    return null;
  });
  const [authReady, setAuthReady] = useState(DEV_BYPASS);
  const [signInError, setSignInError] = useState("");
  const [signInInfo, setSignInInfo] = useState("");
  const [signInBusy, setSignInBusy] = useState(false);
  // lockedOutEmail: authenticated + verified but not on the allowlist.
  const [lockedOutEmail, setLockedOutEmail] = useState("");
  // unverifiedUser: authenticated but emailVerified === false. Seen primarily
  // by email/password users who haven't completed the password-reset flow
  // (which is what marks their email verified). Google users should never
  // hit this state because Google always reports verified emails.
  const [unverifiedUser, setUnverifiedUser] = useState(null);
  // Session 13: when the user lands on a Firebase email-link URL but we have
  // no stored email (different device than the one that requested the link),
  // we render ConfirmEmailScreen to collect it before calling signInWithEmailLink.
  const [needsEmailConfirm, setNeedsEmailConfirm] = useState(false);
  // Whether the initial URL carried ?a=&s= — drives SignInScreen's default tab.
  const hasPendingAssignment = (()=>{
    if(typeof sessionStorage === "undefined") return false;
    try{ return !!sessionStorage.getItem(PENDING_ASSIGNMENT_KEY); }
    catch{ return false; }
  })();

  useEffect(()=>{
    if(DEV_BYPASS){
      console.warn(`[psm-generator] DEV_BYPASS active — auth gate skipped. Fake role: ${DEV_FAKE_ENTRY.role}`);
      return;
    }
    if(!window.auth){ setAuthReady(true); return; }
    const unsub = window.auth.onAuthStateChanged(async (u)=>{
      if(!u){
        setAuthUser(null);
        setCurrentUserEntry(null);
        setLockedOutEmail("");
        setUnverifiedUser(null);
        setAuthReady(true);
        setSignInBusy(false);
        return;
      }
      const email = (u.email||"").toLowerCase();

      if(!u.emailVerified){
        // Route to UnverifiedScreen instead of signing them out. The rules
        // require email_verified=true before the allowlist self-read will
        // succeed, so there's no point calling getAllowlistEntry yet.
        setUnverifiedUser(u);
        setAuthUser(null);
        setCurrentUserEntry(null);
        setLockedOutEmail("");
        setSignInError("");
        setAuthReady(true);
        setSignInBusy(false);
        return;
      }
      const entry = await getAllowlistEntry(email);
      if(!entry || !entry.active || !entry.role){
        setAuthUser(u);
        setCurrentUserEntry(null);
        setUnverifiedUser(null);
        setLockedOutEmail(email);
        setSignInError("");
        setAuthReady(true);
        setSignInBusy(false);
        return;
      }
      setSignInError("");
      setSignInInfo("");
      setLockedOutEmail("");
      setUnverifiedUser(null);
      setAuthUser(u);
      setCurrentUserEntry(entry);
      setAuthReady(true);
      setSignInBusy(false);
    });
    return ()=>unsub();
  },[]);

  // Session 13: complete an incoming Firebase email-link sign-in. Runs once
  // on mount. Detects isSignInWithEmailLink, pulls the email out of
  // localStorage (or defers to ConfirmEmailScreen if this is a different
  // device), calls signInWithEmailLink, and then onAuthStateChanged takes
  // over the same way it does for Google/password sign-ins. The query
  // params ?a=&s= are preserved by Firebase on the redirect and re-stashed
  // by the module-load parser, so by the time we reach RoleRouter the
  // pending-assignment handoff is already in sessionStorage.
  useEffect(()=>{
    if(DEV_BYPASS) return;
    if(!window.auth) return;
    if(!firebase?.auth?.() || typeof window.auth.isSignInWithEmailLink !== "function") return;
    if(!window.auth.isSignInWithEmailLink(location.href)) return;

    let stored = "";
    try{ stored = localStorage.getItem(EMAIL_FOR_SIGNIN_KEY) || ""; }
    catch{ /* private mode */ }

    if(!stored){
      // Cross-device: the opening device never typed an email, so we can't
      // complete the sign-in without the user re-entering it. Render
      // ConfirmEmailScreen instead of signing in automatically.
      setNeedsEmailConfirm(true);
      setAuthReady(true);
      return;
    }

    setSignInBusy(true);
    window.auth.signInWithEmailLink(stored, location.href)
      .then(()=>{
        try{ localStorage.removeItem(EMAIL_FOR_SIGNIN_KEY); }catch{}
        // Strip Firebase's oobCode/apiKey/mode params from the URL but
        // keep ?a=&s= so the deep-link params stay visible and re-stashable.
        try{
          const u = new URL(location.href);
          ["apiKey","oobCode","mode","continueUrl","lang"].forEach(k=>u.searchParams.delete(k));
          history.replaceState({}, "", u.toString());
          stashPendingAssignmentFromUrl();
        }catch{}
        // onAuthStateChanged will route us from here.
      })
      .catch(e=>{
        setSignInBusy(false);
        const code = e && e.code;
        if(code === "auth/invalid-action-code" || code === "auth/expired-action-code"){
          setSignInError("This sign-in link has expired or already been used. Ask your tutor to resend it, or request a new one below.");
        } else if(code === "auth/invalid-email"){
          setSignInError("The email stored on this device doesn't match the link. Try requesting a new link.");
        } else {
          setSignInError(e && e.message ? e.message : "Couldn't complete sign-in from the email link.");
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const handleGoogleSignIn = async ()=>{
    if(!window.auth){ setSignInError("Auth not initialized."); return; }
    setSignInBusy(true);
    setSignInError("");
    setSignInInfo("");
    try{
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({prompt:"select_account"});
      await window.auth.signInWithPopup(provider);
    }catch(e){
      setSignInBusy(false);
      if(e && e.code === "auth/popup-closed-by-user"){ setSignInError(""); return; }
      if(e && e.code === "auth/cancelled-popup-request"){ return; }
      setSignInError(e && e.message ? e.message : "Sign-in failed. Try again.");
    }
  };

  const handleEmailSignIn = async (email, password)=>{
    if(!window.auth){ setSignInError("Auth not initialized."); return; }
    setSignInBusy(true);
    setSignInError("");
    setSignInInfo("");
    try{
      await window.auth.signInWithEmailAndPassword(email, password);
      // onAuthStateChanged takes it from here (unverified → UnverifiedScreen,
      // verified + allowlisted → RoleRouter, verified + not allowlisted →
      // LockoutScreen).
    }catch(e){
      setSignInBusy(false);
      const code = e && e.code;
      if(code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found"){
        setSignInError("Wrong email or password. If this is your first time, check your email for a setup link.");
      } else if(code === "auth/too-many-requests"){
        setSignInError("Too many attempts. Wait a few minutes and try again, or use 'Forgot password?'.");
      } else if(code === "auth/invalid-email"){
        setSignInError("That doesn't look like a valid email.");
      } else {
        setSignInError(e && e.message ? e.message : "Sign-in failed. Try again.");
      }
    }
  };

  const handleForgotPassword = async (email)=>{
    setSignInError("");
    setSignInInfo("");
    if(!email || !email.includes("@")){
      setSignInError("Type your email in the field above, then click 'Forgot password?' again.");
      return;
    }
    if(!window.auth){ setSignInError("Auth not initialized."); return; }
    setSignInBusy(true);
    try{
      await window.auth.sendPasswordResetEmail(email);
      setSignInInfo(`Reset link sent to ${email}. Check your inbox (and spam).`);
    }catch(e){
      const code = e && e.code;
      if(code === "auth/user-not-found"){
        // Don't leak which emails exist — same success message.
        setSignInInfo(`If an account exists for ${email}, a reset link has been sent.`);
      } else if(code === "auth/invalid-email"){
        setSignInError("That doesn't look like a valid email.");
      } else {
        setSignInError(e && e.message ? e.message : "Couldn't send reset email.");
      }
    }
    setSignInBusy(false);
  };

  const handleEmailLinkSignIn = async (email)=>{
    if(!window.auth){ setSignInError("Auth not initialized."); return; }
    setSignInBusy(true);
    setSignInError("");
    setSignInInfo("");
    try{
      await window.auth.sendSignInLinkToEmail(email, {
        url: buildAuthContinueUrl(),
        handleCodeInApp: true,
      });
      try{ localStorage.setItem(EMAIL_FOR_SIGNIN_KEY, email); }catch{}
      setSignInInfo(`Sign-in link sent to ${email}. Check your inbox (and spam). The link opens this page.`);
    }catch(e){
      const code = e && e.code;
      if(code === "auth/invalid-email"){
        setSignInError("That doesn't look like a valid email.");
      } else if(code === "auth/unauthorized-continue-uri"){
        setSignInError("This domain isn't authorized for email-link sign-in. Ask Kiran to add it in Firebase.");
      } else if(code === "auth/missing-continue-uri" || code === "auth/invalid-continue-uri"){
        setSignInError("Internal: bad continue URL. Report this to Kiran.");
      } else {
        setSignInError(e && e.message ? e.message : "Couldn't send the sign-in link.");
      }
    }
    setSignInBusy(false);
  };

  const handleConfirmEmail = async (email)=>{
    if(!window.auth){ setSignInError("Auth not initialized."); return; }
    setSignInBusy(true);
    setSignInError("");
    try{
      await window.auth.signInWithEmailLink(email, location.href);
      try{ localStorage.removeItem(EMAIL_FOR_SIGNIN_KEY); }catch{}
      try{
        const u = new URL(location.href);
        ["apiKey","oobCode","mode","continueUrl","lang"].forEach(k=>u.searchParams.delete(k));
        history.replaceState({}, "", u.toString());
        stashPendingAssignmentFromUrl();
      }catch{}
      setNeedsEmailConfirm(false);
      // onAuthStateChanged routes from here.
    }catch(e){
      setSignInBusy(false);
      const code = e && e.code;
      if(code === "auth/invalid-email" || code === "auth/invalid-action-code"){
        setSignInError("That email doesn't match this sign-in link. Double-check the address the link was sent to.");
      } else if(code === "auth/expired-action-code"){
        setSignInError("This sign-in link has expired. Ask for a new one.");
      } else {
        setSignInError(e && e.message ? e.message : "Couldn't complete sign-in.");
      }
    }
  };

  const handleResendVerification = async ()=>{
    if(!unverifiedUser){ return; }
    setSignInError("");
    setSignInInfo("");
    setSignInBusy(true);
    try{
      // Setup-link-as-verification: sending a password reset email is the
      // same mechanism admin-issued accounts use for first-time setup, and
      // completing it marks the email verified. Simpler and more useful
      // than sendEmailVerification for this product.
      await window.auth.sendPasswordResetEmail(unverifiedUser.email);
      setSignInInfo(`Setup link re-sent to ${unverifiedUser.email}.`);
    }catch(e){
      setSignInError(e && e.message ? e.message : "Couldn't send setup link.");
    }
    setSignInBusy(false);
  };

  const handleSignOut = ()=>{
    if(DEV_BYPASS){
      const url = new URL(location.href);
      url.searchParams.delete("dev");
      url.searchParams.delete("role");
      location.href = url.toString();
      return;
    }
    if(!window.auth) return;
    setLockedOutEmail("");
    setUnverifiedUser(null);
    setCurrentUserEntry(null);
    setSignInInfo("");
    setSignInError("");
    window.auth.signOut();
  };

  if(!authReady){
    return (
      <div style={{minHeight:"100vh",background:"var(--paper)",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{fontFamily:"var(--font-display)",fontSize:18,color:"var(--ink-mute)"}} className="pl">Loading…</div>
      </div>
    );
  }

  if(needsEmailConfirm){
    return <ConfirmEmailScreen
      onConfirm={handleConfirmEmail}
      error={signInError}
      busy={signInBusy}
    />;
  }

  if(unverifiedUser){
    return <UnverifiedScreen
      email={unverifiedUser.email}
      onResend={handleResendVerification}
      onSignOut={handleSignOut}
      busy={signInBusy}
      info={signInInfo}
      error={signInError}
    />;
  }

  if(lockedOutEmail){
    return <LockoutScreen email={lockedOutEmail} onSignOut={handleSignOut}/>;
  }

  if(!authUser){
    return <SignInScreen
      onGoogleSignIn={handleGoogleSignIn}
      onEmailSignIn={handleEmailSignIn}
      onEmailLinkSignIn={handleEmailLinkSignIn}
      onForgotPassword={handleForgotPassword}
      initialMode={hasPendingAssignment ? "emaillink" : "google"}
      error={signInError}
      info={signInInfo}
      busy={signInBusy}
    />;
  }

  return <RoleRouter authUser={authUser} onSignOut={handleSignOut} currentUserEntry={currentUserEntry}/>;
}

/* ============ APP (authenticated inner) ============ */
// ── Admins tab ────────────────────────────────────────────────────────────
// Admin-only UI for managing the Firestore `allowlist` collection. Only
// rendered when currentUserEntry.role === "admin".
function AdminsTab({currentUserEntry, students, showToast}){
  const [entries, setEntries] = useState([]);        // allowlist docs
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [stuSearch, setStuSearch] = useState("");
  // Add-form state
  const [fEmail, setFEmail] = useState("");
  const [fRole, setFRole] = useState("tutor");
  const [fStudentIds, setFStudentIds] = useState([]);
  const [fCreatePw, setFCreatePw] = useState(false);
  const [fBusy, setFBusy] = useState(false);
  const [fError, setFError] = useState("");
  const [fInfo, setFInfo] = useState("");

  const selfEmail = (currentUserEntry?.email || "").toLowerCase();

  const loadEntries = async ()=>{
    if(!window.db){ setLoadError("Firestore not initialized"); setLoading(false); return; }
    setLoading(true);
    setLoadError("");
    try{
      const snap = await window.db.collection("allowlist").get();
      const rows = [];
      snap.forEach(d=>{
        const data = d.data() || {};
        rows.push({
          id: d.id,
          email: data.email || d.id,
          role: data.role || "",
          studentIds: Array.isArray(data.studentIds) ? data.studentIds : (data.studentId ? [data.studentId] : []),
          active: data.active !== false,
          addedBy: data.addedBy || "",
          addedAt: data.addedAt || "",
        });
      });
      rows.sort((a,b)=>{
        // admins first, then tutors, then students/parents; within group alphabetical
        const order = {admin:0, tutor:1, parent:2, student:3};
        const oa = order[a.role] ?? 9;
        const ob = order[b.role] ?? 9;
        if(oa !== ob) return oa - ob;
        return a.email.localeCompare(b.email);
      });
      setEntries(rows);
    }catch(e){
      setLoadError(e && e.message ? e.message : "Failed to load allowlist");
    }
    setLoading(false);
  };

  useEffect(()=>{ loadEntries(); // eslint-disable-next-line
  }, []);

  const addEntry = async ()=>{
    setFError("");
    setFInfo("");
    const emailKey = fEmail.trim().toLowerCase();
    if(!emailKey || !emailKey.includes("@")){ setFError("Enter a valid email."); return; }
    if((fRole==="student" || fRole==="parent") && fStudentIds.length === 0){
      setFError("Student and parent roles need at least one student selected.");
      return;
    }
    if(!window.db){ setFError("Firestore not initialized"); return; }
    setFBusy(true);

    // Optional step: create a Firebase Auth email/password account and
    // email the family a setup link. Done BEFORE the allowlist write so a
    // create failure doesn't leave a dangling allowlist entry. Uses a
    // secondary named Firebase app so the createUserWithEmailAndPassword
    // side-effect (sign-in) doesn't sign the admin out of the primary app.
    let createdAuthAccount = false;
    let authAlreadyExisted = false;
    if(fCreatePw){
      if(!window.firebaseConfig || !window.auth){
        setFError("Auth not initialized; cannot create password account.");
        setFBusy(false);
        return;
      }
      const secondaryName = "admin-create-" + Date.now();
      let secondary = null;
      try{
        secondary = firebase.initializeApp(window.firebaseConfig, secondaryName);
        const tmpPw = Math.random().toString(36).slice(2) + "Aa1!" + Math.random().toString(36).slice(2);
        try{
          await secondary.auth().createUserWithEmailAndPassword(emailKey, tmpPw);
          createdAuthAccount = true;
        }catch(ce){
          if(ce && ce.code === "auth/email-already-in-use"){
            authAlreadyExisted = true;
          } else {
            throw ce;
          }
        }
        await secondary.auth().signOut().catch(()=>{});
        // Send the reset/setup email via the PRIMARY app (stateless call).
        // Completing the reset flow marks email_verified=true, which is
        // what firestore.rules requires before the allowlist self-read
        // will succeed.
        await window.auth.sendPasswordResetEmail(emailKey);
      }catch(e){
        setFError("Auth step failed: " + (e && e.message ? e.message : "unknown"));
        setFBusy(false);
        if(secondary){ try{ await secondary.delete(); }catch{} }
        return;
      }
      try{ await secondary.delete(); }catch{}
    }

    try{
      await window.db.collection("allowlist").doc(emailKey).set({
        email: emailKey,
        role: fRole,
        studentIds: (fRole==="student" || fRole==="parent") ? fStudentIds : [],
        studentId: null, // legacy field kept null; studentIds is source of truth
        active: true,
        addedBy: selfEmail || "admin-ui",
        addedAt: new Date().toISOString(),
      }, {merge:false});
      setFEmail(""); setFRole("tutor"); setFStudentIds([]); setFCreatePw(false);
      let msg = `Added ${emailKey}`;
      if(fCreatePw){
        msg = authAlreadyExisted
          ? `Added ${emailKey}. Auth account already existed — setup link sent.`
          : `Added ${emailKey}. Password account created and setup link emailed.`;
      }
      setFInfo(msg);
      showToast && showToast(msg);
      await loadEntries();
    }catch(e){
      const warnPrefix = createdAuthAccount
        ? "Auth account was created and setup email sent, but allowlist write failed: "
        : "Write failed: ";
      setFError(warnPrefix + (e && e.message ? e.message : "unknown"));
    }
    setFBusy(false);
  };

  const toggleActive = async (row)=>{
    if(row.email.toLowerCase() === selfEmail){
      showToast && showToast("You can't deactivate yourself");
      return;
    }
    if(!window.db) return;
    try{
      await window.db.collection("allowlist").doc(row.id).update({active: !row.active});
      await loadEntries();
    }catch(e){
      showToast && showToast("Update failed: " + (e.message||""));
    }
  };

  const deleteEntry = async (row)=>{
    if(row.email.toLowerCase() === selfEmail){
      showToast && showToast("You can't delete yourself");
      return;
    }
    if(!confirm(`Delete allowlist entry for ${row.email}? They will lose access on next reload.`)) return;
    if(!window.db) return;
    try{
      await window.db.collection("allowlist").doc(row.id).delete();
      await loadEntries();
      showToast && showToast(`Deleted ${row.email}`);
    }catch(e){
      showToast && showToast("Delete failed: " + (e.message||""));
    }
  };

  const toggleStudentPick = (id)=>{
    setFStudentIds(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  };

  const filteredStudents = (students||[]).filter(s =>
    !stuSearch || (s.name||"").toLowerCase().includes(stuSearch.toLowerCase())
  );

  const card = {
    background:"var(--card)", border:"1px solid var(--rule)", borderRadius:12,
    padding:"20px 22px", marginBottom:20,
  };
  const label = {
    display:"block", fontFamily:"var(--font-body)", fontSize:11, fontWeight:600,
    letterSpacing:"0.08em", textTransform:"uppercase", color:"var(--ink-mute)",
    marginBottom:6,
  };
  const input = {
    width:"100%", padding:"9px 12px", borderRadius:8,
    border:"1px solid var(--rule-strong)", background:"var(--paper)",
    fontFamily:"var(--font-body)", fontSize:13, color:"var(--ink)",
  };

  return (
    <div style={{padding:"24px 28px", maxWidth:1080, margin:"0 auto"}}>
      <div style={{marginBottom:18}}>
        <h2 style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 72",fontWeight:500,fontSize:24,margin:"0 0 6px",letterSpacing:"-0.01em"}}>Admins</h2>
        <p style={{fontSize:13,color:"var(--ink-soft)",margin:0,lineHeight:1.55}}>
          Manage the <span style={{fontFamily:"var(--font-mono)",fontSize:12}}>allowlist</span> collection — who can sign in, what role they have, and which student(s) they're scoped to.
        </p>
      </div>

      {/* Add entry */}
      <div style={card}>
        <div style={{fontFamily:"var(--font-display)",fontSize:16,fontWeight:500,marginBottom:14}}>Add allowlist entry</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 180px",gap:14,marginBottom:14}}>
          <div>
            <label style={label}>Email</label>
            <input type="email" value={fEmail} onChange={e=>setFEmail(e.target.value)} placeholder="person@gmail.com" style={input}/>
          </div>
          <div>
            <label style={label}>Role</label>
            <select value={fRole} onChange={e=>{setFRole(e.target.value); if(e.target.value!=="student"&&e.target.value!=="parent") setFStudentIds([]);}} style={input}>
              <option value="admin">admin</option>
              <option value="tutor">tutor</option>
              <option value="student">student</option>
              <option value="parent">parent</option>
            </select>
          </div>
        </div>

        {(fRole==="student" || fRole==="parent") && (
          <div style={{marginBottom:14}}>
            <label style={label}>Linked student{fRole==="parent"?"(s)":""}</label>
            <input type="text" placeholder="Filter students…" value={stuSearch} onChange={e=>setStuSearch(e.target.value)} style={{...input, marginBottom:8}}/>
            <div style={{maxHeight:180, overflowY:"auto", border:"1px solid var(--rule)", borderRadius:8, padding:"6px 10px", background:"var(--paper)"}}>
              {filteredStudents.length === 0 && (
                <div style={{fontSize:12, color:"var(--ink-mute)", padding:"10px 0"}}>No students match.</div>
              )}
              {filteredStudents.map(s=>(
                <label key={s.id} style={{display:"flex",alignItems:"center",gap:10,padding:"5px 0",fontSize:13,cursor:"pointer"}}>
                  <input
                    type={fRole==="student" ? "radio" : "checkbox"}
                    checked={fStudentIds.includes(s.id)}
                    onChange={()=>{
                      if(fRole==="student"){ setFStudentIds([s.id]); }
                      else { toggleStudentPick(s.id); }
                    }}
                  />
                  <span>{s.name}{s.grade?` · Grade ${s.grade}`:""}</span>
                </label>
              ))}
            </div>
            {fStudentIds.length > 0 && (
              <div style={{marginTop:8,fontSize:11,color:"var(--ink-mute)"}}>
                {fStudentIds.length} student{fStudentIds.length===1?"":"s"} selected
              </div>
            )}
          </div>
        )}

        <div style={{marginBottom:14,padding:"10px 12px",borderRadius:8,background:"var(--paper-alt)",border:"1px solid var(--rule)"}}>
          <label style={{display:"flex",alignItems:"flex-start",gap:10,cursor:"pointer",fontSize:12.5,color:"var(--ink-soft)",lineHeight:1.5}}>
            <input
              type="checkbox"
              checked={fCreatePw}
              onChange={e=>setFCreatePw(e.target.checked)}
              style={{marginTop:3}}
            />
            <span>
              <strong style={{color:"var(--ink)"}}>Also create a password account and email a setup link.</strong>
              {" "}Use this for families without a Google account. Firebase sends a password-reset link that doubles as first-time setup; clicking it verifies the email and lets them pick a password.
            </span>
          </label>
        </div>

        {fError && (
          <div style={{padding:"10px 12px",borderRadius:8,background:"var(--accent-soft)",border:"1px solid rgba(154,91,31,.3)",fontSize:12,color:"var(--accent)",marginBottom:12}}>{fError}</div>
        )}
        {fInfo && !fError && (
          <div style={{padding:"10px 12px",borderRadius:8,background:"var(--brand-soft)",border:"1px solid rgba(0,74,121,.25)",fontSize:12,color:"var(--brand)",marginBottom:12}}>{fInfo}</div>
        )}

        <button
          onClick={addEntry}
          disabled={fBusy}
          style={{
            padding:"10px 22px",borderRadius:8,border:"1px solid var(--brand)",
            background:fBusy?"var(--paper-alt)":"var(--brand)",
            color:fBusy?"var(--ink-mute)":"var(--paper)",
            fontFamily:"var(--font-body)",fontSize:13,fontWeight:500,
            cursor:fBusy?"default":"pointer"
          }}>
          {fBusy ? (fCreatePw?"Creating…":"Adding…") : (fCreatePw?"Create account + add entry":"Add entry")}
        </button>
      </div>

      {/* List */}
      <div style={card}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <div style={{fontFamily:"var(--font-display)",fontSize:16,fontWeight:500}}>Current allowlist ({entries.length})</div>
          <button onClick={loadEntries} style={{padding:"6px 14px",borderRadius:6,border:"1px solid var(--rule-strong)",background:"var(--card)",fontSize:12,cursor:"pointer"}}>Refresh</button>
        </div>

        {loading && <div style={{fontSize:13,color:"var(--ink-mute)",padding:"12px 0"}}>Loading…</div>}
        {loadError && (
          <div style={{padding:"10px 12px",borderRadius:8,background:"var(--accent-soft)",border:"1px solid rgba(154,91,31,.3)",fontSize:12,color:"var(--accent)"}}>
            {loadError}
          </div>
        )}
        {!loading && !loadError && entries.length === 0 && (
          <div style={{fontSize:13,color:"var(--ink-mute)",padding:"12px 0"}}>No entries yet. Add one above, or seed the collection from Firebase Console.</div>
        )}
        {!loading && entries.length > 0 && (
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
            <thead>
              <tr style={{textAlign:"left",color:"var(--ink-mute)",fontSize:11,textTransform:"uppercase",letterSpacing:"0.08em"}}>
                <th style={{padding:"8px 6px",borderBottom:"1px solid var(--rule)"}}>Email</th>
                <th style={{padding:"8px 6px",borderBottom:"1px solid var(--rule)"}}>Role</th>
                <th style={{padding:"8px 6px",borderBottom:"1px solid var(--rule)"}}>Students</th>
                <th style={{padding:"8px 6px",borderBottom:"1px solid var(--rule)"}}>Active</th>
                <th style={{padding:"8px 6px",borderBottom:"1px solid var(--rule)",textAlign:"right"}}></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(row=>{
                const isSelf = row.email.toLowerCase() === selfEmail;
                const stuNames = row.studentIds
                  .map(id => (students||[]).find(s=>s.id===id)?.name || id)
                  .join(", ");
                return (
                  <tr key={row.id} style={{borderBottom:"1px solid var(--rule)"}}>
                    <td style={{padding:"10px 6px",fontFamily:"var(--font-mono)",fontSize:12}}>
                      {row.email}
                      {isSelf && <span style={{marginLeft:8,fontSize:10,color:"var(--ink-mute)",textTransform:"uppercase",letterSpacing:"0.1em"}}>you</span>}
                    </td>
                    <td style={{padding:"10px 6px"}}>{row.role}</td>
                    <td style={{padding:"10px 6px",color:"var(--ink-soft)"}}>{stuNames || <span style={{color:"var(--ink-mute)"}}>—</span>}</td>
                    <td style={{padding:"10px 6px"}}>
                      <button
                        onClick={()=>toggleActive(row)}
                        disabled={isSelf}
                        style={{
                          padding:"3px 10px",borderRadius:999,
                          border:"1px solid "+(row.active?"var(--brand)":"var(--rule-strong)"),
                          background: row.active ? "rgba(0,74,121,.08)" : "var(--paper-alt)",
                          color: row.active ? "var(--brand)" : "var(--ink-mute)",
                          fontSize:11,fontWeight:500,
                          cursor: isSelf ? "not-allowed" : "pointer"
                        }}>
                        {row.active ? "active" : "inactive"}
                      </button>
                    </td>
                    <td style={{padding:"10px 6px",textAlign:"right"}}>
                      <button
                        onClick={()=>deleteEntry(row)}
                        disabled={isSelf}
                        style={{
                          padding:"4px 12px",borderRadius:6,border:"1px solid var(--rule-strong)",
                          background:"var(--card)",color: isSelf?"var(--ink-mute)":"var(--accent)",
                          fontSize:11,cursor:isSelf?"not-allowed":"pointer"
                        }}>
                        delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function AppInner({authUser, onSignOut, currentUserEntry}){
  const isAdmin = !!(currentUserEntry && currentUserEntry.role === "admin" && currentUserEntry.active);
  const[tab,setTab]=useState("generator");
  const[students,setStudents]=useState(()=>sLoad("psm_v4",sLoad("psm_v3",[])));
  const[selSt,setSelSt]=useState("");
  const[cloudStatus,setCloudStatus]=useState("connecting"); // connecting | synced | offline
  // Filters
  const[subjF,setSubjF]=useState("All");
  const[domF,setDomF]=useState("All");
  const[sdomF,setSdomF]=useState("All");
  const[diffF,setDiffF]=useState("All");
  const[srch,setSrch]=useState("");
  // Selections
  const[chk,setChk]=useState({});            // worksheet id -> true
  const[evenOdd,setEvenOdd]=useState({});    // worksheet id -> "" | "EVEN" | "ODD"
  const[weChk,setWeChk]=useState({});        // welled domain id -> true
  const[vocabChk,setVocabChk]=useState({});  // vocab id -> true
  // Toggles
  const[examType,setExamType]=useState("SAT"); // "SAT" | "PSAT"
  const[timeDrill,setTimeDrill]=useState(false);
  const[timeLims,setTimeLims]=useState({});
  const[oneNote,setOneNote]=useState(false);
  const[weDomEn,setWeDomEn]=useState(false);  // WellEd Domain assignments enable
  const[vocabEn,setVocabEn]=useState(false);
  const[addBB,setAddBB]=useState(false);
  const[bbType,setBbType]=useState("full");
  const[bbCnt,setBbCnt]=useState(1);
  const[bbMode,setBbMode]=useState("auto"); // "auto" | "specific"
  const[bbPicks,setBbPicks]=useState([]);    // specific BlueBook test numbers
  const[addWE,setAddWE]=useState(false);
  const[weType,setWeType]=useState("full");
  const[weCnt,setWeCnt]=useState(1);
  const[weMode,setWeMode]=useState("auto");
  const[wePicks,setWePicks]=useState([]);
  // Output
  const[output,setOutput]=useState("");
  const[copied,setCopied]=useState(false);
  // Students / profile
  const[profile,setProfile]=useState(null);
  const[showAdd,setShowAdd]=useState(false);
  // Wise CSV import staging — null = no import in progress, object = preview dialog open.
  const[wiseImport,setWiseImport]=useState(null);
  const wiseInputRef=useRef(null);
  // Session 18C: Wise API sync staging. `null` = no sync in progress.
  // `{loading:true}` = pulling preview from server.
  // `{summary, plan}` = preview returned, awaiting confirm.
  // `{committing:true, summary, plan}` = user confirmed, executing.
  const[wiseSync,setWiseSync]=useState(null);
  // Session 18C v11: SAT-student broadcast modal state. `null`/false =
  // closed. `true` = open. The default message tells students to use
  // the central portal URL going forward and explains old deep-links
  // were retired.
  const[broadcastOpen,setBroadcastOpen]=useState(false);
  const[broadcastTitle,setBroadcastTitle]=useState("Portal sign-in update");
  const[broadcastBody,setBroadcastBody]=useState(
    "Hi! Quick update on how to access your PSM portal going forward:\n\n"
    + "• Please use this link to sign in: https://portal.affordabletutoringsolutions.org/\n"
    + "• Older personal portal links sent in past PSM posts may not work — "
    + "use the link above instead.\n\n"
    + "Once signed in, your latest PSM appears at the top with each "
    + "worksheet listed individually. Click a worksheet to answer it, "
    + "submit, then move on to the next.\n\n"
    + "Reach out to your tutor with any sign-in issues."
  );
  const[broadcastBusy,setBroadcastBusy]=useState(false);
  const[broadcastResult,setBroadcastResult]=useState(null);
  // Global search (⌘K / Ctrl+K)
  const[searchOpen,setSearchOpen]=useState(false);
  const[searchQuery,setSearchQuery]=useState("");
  const searchInputRef=useRef(null);
  const[newS,setNewS]=useState({name:"",grade:"",tutor:"",notes:""});
  // Tutor-only notes for the currently open profile. Hydrated from
  // /students/{id}/_private/info on openProfile because notes aren't
  // included in the students[] array post-Phase-2.
  const[profileNotes,setProfileNotes]=useState("");
  const[ptab,setPtab]=useState("history");
  const[paChk,setPaChk]=useState({});
  const[paSubj,setPaSubj]=useState("All");
  const[paSrch,setPaSrch]=useState("");
  const[paDate,setPaDate]=useState(todayStr());
  const[paWeChk,setPaWeChk]=useState({});   // pre-assign WellEd domain checks
  const[paBBPicks,setPaBBPicks]=useState([]); // pre-assign BlueBook test numbers
  const[paWEPicks,setPaWEPicks]=useState([]); // pre-assign WellEd test numbers
  const[sfm,setSfm]=useState({date:todayStr(),testType:"",score:"",maxScore:"",notes:""});
  const[toast,setToast]=useState("");
  const[parsing,setParsing]=useState(false);
  const diagInputRef = useRef(null);
  const welledInputRef = useRef(null);
  // Custom assignments
  const[customAssignments,setCustomAssignments]=useState(()=>sLoad("psm_custom_asg",[]));

  // Track whether current state came from Firestore (prevent write-back loops)
  const _fromFirestore = useRef(false);
  // Session 18C bug fix: keep a ref to current students so the Firestore
  // listener (registered once via useEffect on []) can compare incoming
  // snapshots against the latest local state without going stale.
  const _studentsRef = useRef([]);
  useEffect(()=>{ _studentsRef.current = students; }, [students]);

  // ── Firestore real-time sync (Phase 2 — per-student docs + legacy blob) ──
  // Two listeners: /students is authoritative for student rows; psm-data/main
  // carries customAssignments (and, during DUAL_WRITE_GRACE, a mirror of
  // students[] that we ignore on read). The `notes` field is NOT hydrated
  // into students[] here — it lives in /students/{id}/_private/info and is
  // read lazily when a tutor opens a profile.
  useEffect(()=>{
    const col = studentsCollection();
    const blobRef = fsRef();
    if(!col || !blobRef){
      setCloudStatus("offline");
      console.log("[Firestore] No db available, using localStorage only");
      return;
    }

    const unsubStudents = col.onSnapshot((snap)=>{
      const next = snap.docs.map(d=>{
        const data = d.data() || {};
        return { ...data, id: data.id || d.id };
      });
      // ── Session 18C feedback-loop fix ──────────────────────────────────
      // Previously the listener always called setStudents(next), which
      // triggered the write effect ([students] dep changed → another
      // batched write → another listener tick → forever). The _fromFirestore
      // flag SHOULD have prevented the write, but it was reset
      // synchronously before React's effect commit phase ran, so the
      // effect always saw `false`.
      //
      // Two-pronged fix:
      //   1. JSON-string-compare incoming with current state and skip
      //      setStudents entirely when nothing actually changed. This is
      //      the most important guard — Firestore re-fires onSnapshot
      //      on every doc-version bump even when the byte content is
      //      identical, so a single user write produces N listener ticks
      //      (one per affected doc) and each of those would otherwise
      //      cause its own write-back cycle.
      //   2. Defer the _fromFirestore.current=false reset to a macrotask
      //      so the write effect (which runs after commit but BEFORE
      //      macrotask queue) still sees true and bails.
      try{
        const prev = _studentsRef.current || [];
        const prevJson = JSON.stringify(prev);
        const nextJson = JSON.stringify(next);
        if(prevJson === nextJson) return;
      } catch { /* fall through to setStudents */ }
      _fromFirestore.current = true;
      setStudents(next);
      setTimeout(()=>{ _fromFirestore.current = false; }, 100);
      setCloudStatus("synced");
      sSave("psm_v4", next);
    }, (err)=>{
      console.warn("[Firestore] students listen error:", err);
      setCloudStatus("offline");
    });

    const unsubBlob = blobRef.onSnapshot((snap)=>{
      if(!snap.exists) return;
      const data = snap.data() || {};
      if(data.customAssignments){
        _fromFirestore.current = true;
        setCustomAssignments(data.customAssignments);
        setTimeout(()=>{ _fromFirestore.current = false; }, 100);
        sSave("psm_custom_asg", data.customAssignments);
      }
    }, (err)=>{
      console.warn("[Firestore] blob listen error:", err);
    });

    return ()=>{ unsubStudents(); unsubBlob(); };
  }, []);

  // ── Session 18C v4: Consultation Student DISABLED + auto-cleanup ──
  // Per Aidan: "remove consultation student profile for now. we will
  // just use one of our current students as example."
  //
  // Seed effect removed. On mount, if the synthetic doc exists in the
  // roster we permanently delete it (one-shot). Manual recreation would
  // require re-enabling this effect.
  const _consultationCleanedUp = useRef(false);
  useEffect(()=>{
    if(_consultationCleanedUp.current) return;
    if(cloudStatus !== "synced") return;
    const existing = students.find(st => st && st.id === CONSULTATION_STUDENT_ID);
    if(!existing){
      _consultationCleanedUp.current = true;
      return;
    }
    const col = studentsCollection();
    if(!col) return;
    _consultationCleanedUp.current = true;
    col.doc(CONSULTATION_STUDENT_ID).delete()
      .then(()=> console.log("[consultation] cleanup: synthetic profile deleted"))
      .catch(e=> console.warn("[consultation] cleanup failed:", e));
  }, [students, cloudStatus]);

  // ── Write students: per-doc batch to /students, dual-write to blob ──
  useEffect(()=>{
    if(_fromFirestore.current) return;
    sSave("psm_v4", students);

    if(_studentsBatchTimer) clearTimeout(_studentsBatchTimer);
    _studentsBatchTimer = setTimeout(()=>{
      const db = window.db;
      if(!db) return;
      const batch = db.batch();
      students.forEach(s=>{
        if(!s || !s.id) return;
        // Strip `notes` before writing — notes live in /_private/info
        // and would bleed tutor-only data into the student-readable doc.
        const { notes, ...rest } = s;
        batch.set(db.collection("students").doc(s.id), rest);
      });
      batch.commit().catch(e=>console.warn("[Firestore] students batch error:", e));

      if(DUAL_WRITE_GRACE) fsWrite({students});
    }, 800);
  },[students]);

  useEffect(()=>{
    if(_fromFirestore.current) return;
    sSave("psm_custom_asg", customAssignments);
    fsWrite({customAssignments});
  },[customAssignments]);

  const showToast=(msg)=>{setToast(msg);setTimeout(()=>setToast(""),2500);};

  /* ============ FILTERED LISTS ============ */
  const availDoms=useMemo(()=>{const s=new Set();ALL_WS.forEach(ws=>{if(subjF==="All"||ws.subject===subjF)s.add(ws.domain);});return[...s];},[subjF]);
  const availSdoms=useMemo(()=>{const s=new Set();ALL_WS.forEach(ws=>{if((subjF==="All"||ws.subject===subjF)&&(domF==="All"||ws.domain===domF))s.add(ws.subdomain);});return[...s].sort((a,b)=>{const ac=a.startsWith("Comprehensive ")?0:1;const bc=b.startsWith("Comprehensive ")?0:1;return ac-bc||a.localeCompare(b);});},[subjF,domF]);

  const filtWS=useMemo(()=>ALL_WS.filter(ws=>{
    if(subjF!=="All"&&ws.subject!==subjF)return false;
    if(domF!=="All"&&ws.domain!==domF)return false;
    if(sdomF!=="All"&&ws.subdomain!==sdomF)return false;
    if(diffF!=="All"&&ws.difficulty!==diffF)return false;
    if(srch&&!ws.title.toLowerCase().includes(srch.toLowerCase()))return false;
    return true;
  }),[subjF,domF,sdomF,diffF,srch]);

  // Group by subject -> domain -> subdomain, with Comprehensive (domain-level) first
  const grouped=useMemo(()=>{
    const bySubj={};
    filtWS.forEach(ws=>{
      if(!bySubj[ws.subject]) bySubj[ws.subject]={};
      if(!bySubj[ws.subject][ws.domain]) bySubj[ws.subject][ws.domain]={};
      if(!bySubj[ws.subject][ws.domain][ws.subdomain]) bySubj[ws.subject][ws.domain][ws.subdomain]=[];
      bySubj[ws.subject][ws.domain][ws.subdomain].push(ws);
    });
    // Sort each sheet list by difficulty order
    Object.values(bySubj).forEach(doms=>Object.values(doms).forEach(subs=>Object.values(subs).forEach(arr=>arr.sort((a,b)=>DIFF_ORDER.indexOf(a.difficulty)-DIFF_ORDER.indexOf(b.difficulty)))));
    return bySubj;
  },[filtWS]);

  const selWS = useMemo(()=>ALL_WS.filter(ws=>chk[ws.id]),[chk]);
  const selWeDom = useMemo(()=>WE_DOMAIN_ITEMS.filter(i=>weChk[i.id]),[weChk]);
  const selVocab = useMemo(()=>VOCAB_ITEMS.filter(i=>vocabChk[i.id]),[vocabChk]);

  // LIVE QUESTION COUNTER
  const totalQs = useMemo(()=>{
    let t = selWS.reduce((n,ws)=>n+(ws.qs||0),0);
    t += selWeDom.reduce((n,i)=>n+(i.qs||0),0);
    // Practice exams — count is picks.length in specific mode, bbCnt/weCnt in auto.
    const bbN = addBB ? (bbMode==="specific" ? bbPicks.length : bbCnt) : 0;
    const weN = addWE ? (weMode==="specific" ? wePicks.length : weCnt) : 0;
    t += bbN * (bbType==="full" ? 98 : 49); // 54 R&W + 44 Math per full
    t += weN * (weType==="full" ? 98 : 49);
    return t;
  },[selWS,selWeDom,addBB,bbCnt,bbType,bbMode,bbPicks,addWE,weCnt,weType,weMode,wePicks]);

  // visibleStudents is the deep-filtered view used for all display. Raw `students`
  // still contains soft-deleted records so the Trash tab can show them and mutations
  // keep working against the full array.
  const visibleStudents = useMemo(()=>live(students).map(st=>({
    ...st,
    assignments: live(st.assignments),
    scores: live(st.scores),
    welledLogs: live(st.welledLogs),
    diagnostics: live(st.diagnostics),
  })),[students]);
  const curStudent = visibleStudents.find(st=>st.id===selSt);

  // Heat Map domains (from assignments). Session 18C: aggregate
  // computations exclude the Consultation Student (synthetic) so demo
  // data never inflates real-roster stats.
  const heatDoms = useMemo(()=>[...new Set(ALL_WS.map(ws=>ws.domain))],[]);
  const getHV = (st,d)=>(st.assignments||[]).reduce((n,a)=>n+(a.worksheets||[]).filter(w=>w.domain===d).length,0);
  const aggregateStudents = useMemo(()=>excludeConsultation(visibleStudents),[visibleStudents]);
  const heatMax = useMemo(()=>aggregateStudents.reduce((mx,st)=>heatDoms.reduce((m,d)=>Math.max(m,getHV(st,d)),mx),1),[aggregateStudents,heatDoms]);
  const heatC = (v)=>{if(!v)return"#f1f5f9";const i=v/heatMax;return i<.25?"#bfdbfe":i<.5?"#60a5fa":i<.75?"#3b82f6":"#1d4ed8";};

  /* ============ GENERATE OUTPUT ============ */
  const generate = ()=>{
    const lines = [];
    // Intro paragraphs (always). Plain text, no decorative borders.
    lines.push(INTRO_A);
    lines.push("");
    lines.push(fmtInstr(INTRO_B));
    if(oneNote){ lines.push(""); lines.push(fmtInstr(ONENOTE_TXT)); }
    if(timeDrill){ lines.push(""); lines.push(fmtInstr(TIME_TXT)); }
    if(weDomEn && selWeDom.length){ lines.push(""); lines.push(fmtInstr(WED_TXT)); }
    if(vocabEn && selVocab.length){ lines.push(""); lines.push(fmtInstr(VOCAB_TXT)); }

    // WellEd Domain Assignments block
    if(weDomEn && selWeDom.length){
      lines.push("");
      lines.push("**WellEd Domain Assignments:**");
      selWeDom.forEach(i=>lines.push(i.label));
    }
    // Vocab block
    if(vocabEn && selVocab.length){
      lines.push("");
      lines.push("**Vocab Assignments:**");
      selVocab.forEach(i=>lines.push(i.label));
    }
    // Practice Exams block
    // Resolve the actual test-number arrays for each platform up-front so the
    // same numbers flow into both the text output AND the saved entry below.
    const bbNumsOut = addBB
      ? (bbMode==="specific" ? [...bbPicks].sort((a,b)=>a-b) : nextExamNumbers(curStudent,"BlueBook",bbCnt))
      : [];
    const weNumsOut = addWE
      ? (weMode==="specific" ? [...wePicks].sort((a,b)=>a-b) : nextExamNumbers(curStudent,"WellEd",weCnt))
      : [];
    if(bbNumsOut.length || weNumsOut.length){
      lines.push("");
      lines.push("**Practice Exams:**");
      bbNumsOut.forEach(n=>{
        lines.push(`Please complete Practice Exam # ${n} on BlueBook (College Board) using the instructions for BlueBook (College Board) practice exams located in your Wise "Full Practice Exam Instructions" Module -  https://bluebook.app.collegeboard.org/.  Be sure to follow instructions regarding screenshots of missed questions!`);
      });
      weNumsOut.forEach(n=>{
        lines.push(`Please complete Practice Exam # ${n} on WellEd Labs using the instructions for WellEd Labs practice exams located in your Wise "Full Practice Exam Instructions" Module - https://ats.practicetest.io/sign-in.`);
      });
    }

    // Student Forms (flat list, STU_ prefix, .pdf suffix, URL appended)
    if(selWS.length>0){
      lines.push("");
      lines.push("**Student Forms:**");
      selWS.forEach(ws=>{
        const eo = evenOdd[ws.id] ? ` (${evenOdd[ws.id]})` : "";
        const tl = timeDrill && timeLims[ws.id] ? `(${timeLims[ws.id]} min) ` : "";
        lines.push(`${tl}STU_${ws.title}.pdf${eo} - ${ws.stu||"[LINK PENDING]"}`);
      });

      // Answer Keys
      lines.push("");
      lines.push("**Answer Keys:**");
      selWS.forEach(ws=>{
        lines.push(`KEY_${ws.title}.pdf - ${ws.key||"[LINK PENDING]"}`);
      });
    }

    setOutput(lines.join("\n"));

    // Save to student profile
    if(curStudent){
      const weEntries = selWeDom.map(i=>({kind:"welled_domain",subject:i.subject,domain:i.domain,difficulty:i.difficulty,label:i.label,qs:i.qs}));
      const vocabEntries = selVocab.map(i=>({kind:i.kind,name:i.name,variant:i.variant||null,label:i.label}));
      const entry={
        id:uid(),
        date:todayStr(),
        preAssigned:false,
        examType,
        worksheets:selWS.map(ws=>({id:ws.id,title:ws.title,subject:ws.subject,domain:ws.domain,subdomain:ws.subdomain,difficulty:ws.difficulty,qs:ws.qs,evenOdd:evenOdd[ws.id]||null,timeLimit:timeDrill?timeLims[ws.id]||null:null})),
        welledDomain:weEntries,
        vocab:vocabEntries,
        practiceExams:[
          ...bbNumsOut.map(n=>({platform:"BlueBook",type:bbType,number:n,examType})),
          ...weNumsOut.map(n=>({platform:"WellEd",type:weType,number:n,examType})),
        ],
        timeDrill,oneNote,
      };
      if(selWS.length>0 || weEntries.length>0 || vocabEntries.length>0 || bbNumsOut.length>0 || weNumsOut.length>0){
        setStudents(prev=>prev.map(st=>st.id===curStudent.id?{...st,assignments:[...(st.assignments||[]),entry]}:st));
        showToast(`Saved to ${curStudent.name}'s profile`);
        assignToWise(curStudent.id, entry.id, showToast);
      }
    }
  };

  // Returns an array of exam numbers to assign next (avoiding already-used numbers)
  function nextExamNumbers(student,platform,count){
    const used = new Set();
    (student?.assignments||[]).forEach(a=>{
      (a.practiceExams||[]).forEach(ex=>{
        if(ex.platform===platform && ex.number) used.add(ex.number);
      });
    });
    const out=[];
    let n=1;
    while(out.length<count){
      if(!used.has(n)){out.push(n);used.add(n);}
      n++;
    }
    return out;
  }

  const copyOut=()=>{if(!output)return;navigator.clipboard.writeText(output).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);});};
  const copyRichOut=()=>{
    if(!output)return;
    const html = mdBoldToHtml(output);
    const plain = output.replace(/\*\*/g,"");
    try{
      const item = new ClipboardItem({
        "text/html": new Blob([`<div style="font-family:Segoe UI,system-ui,sans-serif;font-size:13px;line-height:1.55;">${html}</div>`],{type:"text/html"}),
        "text/plain": new Blob([plain],{type:"text/plain"}),
      });
      navigator.clipboard.write([item]).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);showToast("Copied with formatting");});
    }catch(err){
      // Fallback: copy plain
      navigator.clipboard.writeText(plain).then(()=>showToast("Copied (plain)"));
    }
  };
  const downloadPdf=async()=>{
    if(!output){showToast("Nothing to export");return;}
    if(!window.jspdf){showToast("PDF library not loaded");return;}
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({unit:"pt",format:"letter"});
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 56;
    const wrapW = pageW - margin*2;

    // Rehaul palette — mirrors the CSS tokens in build_index.py
    const PAPER     = [250,247,242]; // --paper
    const PAPER_ALT = [243,238,228]; // --paper-alt
    const INK       = [15,26,46];    // --ink
    const INK_SOFT  = [46,58,87];    // --ink-soft
    const INK_MUTE  = [102,112,138]; // --ink-mute
    const RULE      = [220,216,208]; // ~rgba(15,26,46,.12) on paper
    const NAVY      = [0,74,121];    // --brand
    const SIENNA    = [154,91,31];   // --accent
    const LINK      = [0,102,166];   // --brand-light

    const studentName = curStudent?.name || "";
    const safeName = (studentName||"student").replace(/[^a-zA-Z0-9-_]/g,"_");

    // Every page gets a paper-toned background.
    const paintPage = ()=>{
      doc.setFillColor(...PAPER);
      doc.rect(0,0,pageW,pageH,"F");
    };
    const newPage = ()=>{ doc.addPage(); paintPage(); return margin + 24; };

    paintPage();

    // ── Header (first page only) ──
    let y = margin;
    const logoData = window.ATS_LOGO_PNG || null;
    const logoSize = 46;
    if(logoData){
      try{ doc.addImage(logoData,"PNG",margin,y,logoSize,logoSize); }catch(e){}
    }
    const titleX = margin + (logoData ? logoSize + 16 : 0);
    // Eyebrow
    doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(...INK_MUTE);
    doc.setCharSpace(1.4);
    doc.text("PSM ASSIGNMENT", titleX, y + 14);
    doc.setCharSpace(0);
    // Wordmark
    doc.setFont("helvetica","bold"); doc.setFontSize(18); doc.setTextColor(...INK);
    doc.text("Affordable Tutoring Solutions", titleX, y + 34);
    // Date, right-aligned, mono-ish caption
    doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(...INK_MUTE);
    doc.text(todayStr().toUpperCase(), pageW - margin, y + 14, {align:"right"});

    y += logoSize + 14;
    // Sienna short rule — mirrors the CSS header ::after accent
    doc.setDrawColor(...SIENNA); doc.setLineWidth(2);
    doc.line(margin, y, margin + 72, y);
    // Hairline continuation
    doc.setDrawColor(...RULE); doc.setLineWidth(0.6);
    doc.line(margin + 72, y, pageW - margin, y);
    y += 22;

    // Student block
    if(studentName){
      doc.setFont("helvetica","bold"); doc.setFontSize(20); doc.setTextColor(...INK);
      doc.text(studentName, margin, y);
      y += 20;
    }
    doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(...INK_MUTE);
    const metaBits = [];
    if(totalQs) metaBits.push(`${totalQs} questions`);
    if(curStudent?.grade) metaBits.push(`Grade ${curStudent.grade}`);
    if(curStudent?.tutor) metaBits.push(`Tutor: ${curStudent.tutor}`);
    if(metaBits.length){ doc.text(metaBits.join("  ·  "), margin, y); y += 18; }
    y += 6;

    // ── Parse output into sections ──
    // Intro: everything before the first "**Label:**" header line.
    // Sections: each header line starts a section that runs to the next header.
    const rawLines = output.split("\n");
    const headerRx = /^\*\*([^*]+):\*\*\s*$/;
    const intro = [];
    const sections = [];
    let cur = null;
    rawLines.forEach(line=>{
      const hm = line.match(headerRx);
      if(hm){ cur = {title: hm[1].trim(), items: []}; sections.push(cur); return; }
      if(cur) cur.items.push(line);
      else intro.push(line);
    });

    // ── Helpers ──
    const ensure = (needed)=>{ if(y + needed > pageH - 72){ y = newPage(); } };

    const drawWrapped = (text, opts={})=>{
      const { size=10, font="normal", color=INK_SOFT, lineH=13, indent=0 } = opts;
      doc.setFont("helvetica",font); doc.setFontSize(size); doc.setTextColor(...color);
      const lines = doc.splitTextToSize(text, wrapW - indent);
      lines.forEach(ln=>{
        ensure(lineH);
        doc.text(ln, margin + indent, y);
        y += lineH;
      });
    };

    // Render a line that may contain URLs: plain text in color, URLs as clickable LINK-colored.
    const drawLineWithLinks = (text, opts={})=>{
      const { size=10, font="normal", color=INK_SOFT, lineH=13, indent=0 } = opts;
      doc.setFont("helvetica",font); doc.setFontSize(size);
      const urlRx = /(https?:\/\/[^\s]+)/g;
      // Naive wrap: split text into tokens, rebuild lines within wrapW-indent.
      const maxW = wrapW - indent;
      const tokens = text.split(/(\s+)/); // keep whitespace tokens
      let buf = [], bufW = 0;
      const flush = ()=>{
        if(!buf.length) return;
        ensure(lineH);
        let x = margin + indent;
        buf.forEach(tok=>{
          if(urlRx.test(tok)){
            urlRx.lastIndex = 0;
            doc.setTextColor(...LINK);
            doc.textWithLink(tok, x, y, {url: tok});
          } else {
            doc.setTextColor(...color);
            doc.text(tok, x, y);
          }
          x += doc.getTextWidth(tok);
        });
        y += lineH;
        buf = []; bufW = 0;
      };
      tokens.forEach(tok=>{
        if(!tok) return;
        const tw = doc.getTextWidth(tok);
        if(bufW + tw > maxW && buf.length){ flush(); if(/^\s+$/.test(tok)) return; }
        buf.push(tok); bufW += tw;
      });
      flush();
    };

    // Intro paragraphs — plain, no decoration. Support **bold** inline.
    intro.forEach(raw=>{
      if(raw.trim()===""){ y += 5; return; }
      const hasBold = /\*\*[^*]+\*\*/.test(raw);
      if(hasBold){
        // Strip markers; render bold segments inline on a single (wrapped) line.
        const segs = [];
        const rx = /\*\*([^*]+)\*\*/g;
        let li = 0, m;
        while((m = rx.exec(raw))!==null){
          if(m.index>li) segs.push({b:false,t:raw.slice(li,m.index)});
          segs.push({b:true,t:m[1]});
          li = m.index + m[0].length;
        }
        if(li<raw.length) segs.push({b:false,t:raw.slice(li)});
        // Simple approach: render joined text; bold only applies if the whole line is bold.
        const joined = segs.map(s=>s.t).join("");
        drawWrapped(joined, {size:10, font:"normal", color:INK_SOFT, lineH:13});
      } else {
        drawWrapped(raw, {size:10, font:"normal", color:INK_SOFT, lineH:13});
      }
      y += 2;
    });

    // ── Sections ──
    sections.forEach((sec)=>{
      y += 12;
      ensure(40);
      // Sienna square marker + navy title + hairline to right margin
      doc.setFillColor(...SIENNA);
      doc.rect(margin, y - 7, 6, 6, "F");
      doc.setFont("helvetica","bold"); doc.setFontSize(12); doc.setTextColor(...NAVY);
      doc.text(sec.title, margin + 14, y);
      const titleEndX = margin + 14 + doc.getTextWidth(sec.title) + 10;
      doc.setDrawColor(...RULE); doc.setLineWidth(0.6);
      if(titleEndX < pageW - margin){
        doc.line(titleEndX, y - 3, pageW - margin, y - 3);
      }
      y += 14;

      const isFormSection = /Student Forms|Answer Keys/i.test(sec.title);
      const contentIndent = 14;

      sec.items.forEach(item=>{
        if(item.trim()===""){ y += 4; return; }

        if(isFormSection){
          // Two-line treatment: bold title on line 1, muted URL on line 2.
          // Split on the LAST " - " so titles containing hyphens survive.
          const sepIdx = item.lastIndexOf(" - ");
          const label = sepIdx>=0 ? item.slice(0, sepIdx) : item;
          const url = sepIdx>=0 ? item.slice(sepIdx + 3).trim() : "";
          ensure(28);
          doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(...INK);
          const labelLines = doc.splitTextToSize(label, wrapW - contentIndent);
          labelLines.forEach(ln=>{
            ensure(13);
            doc.text(ln, margin + contentIndent, y);
            y += 13;
          });
          if(url){
            doc.setFont("helvetica","normal"); doc.setFontSize(8.5);
            const isHttp = /^https?:\/\//.test(url);
            if(isHttp){
              doc.setTextColor(...LINK);
              const urlLines = doc.splitTextToSize(url, wrapW - contentIndent);
              urlLines.forEach((ln,i)=>{
                ensure(11);
                if(i===0) doc.textWithLink(ln, margin + contentIndent, y, {url});
                else doc.text(ln, margin + contentIndent, y);
                y += 11;
              });
            } else {
              doc.setTextColor(...INK_MUTE);
              doc.text(url, margin + contentIndent, y);
              y += 11;
            }
          }
          y += 4;
        } else {
          // WellEd / Vocab / Practice Exams / other — flowed, with clickable URLs.
          // Render a sienna bullet for short label rows, inline-wrap for long rows.
          const hasUrl = /https?:\/\//.test(item);
          if(hasUrl){
            drawLineWithLinks(item, {size:9.5, color:INK_SOFT, lineH:13, indent:contentIndent});
            y += 2;
          } else {
            // Bullet row
            ensure(13);
            doc.setFillColor(...SIENNA);
            doc.circle(margin + contentIndent - 6, y - 3, 1.4, "F");
            doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(...INK_SOFT);
            const lines = doc.splitTextToSize(item, wrapW - contentIndent);
            lines.forEach((ln,i)=>{
              if(i>0) ensure(13);
              doc.text(ln, margin + contentIndent, y);
              y += 13;
            });
          }
        }
      });
    });

    // ── Footer on every page: hairline rule + small caption + page number ──
    const pageCount = doc.getNumberOfPages();
    for(let i=1;i<=pageCount;i++){
      doc.setPage(i);
      const fy = pageH - 42;
      doc.setDrawColor(...RULE); doc.setLineWidth(0.6);
      doc.line(margin, fy, pageW - margin, fy);
      doc.setFont("helvetica","normal"); doc.setFontSize(7.5); doc.setTextColor(...INK_MUTE);
      doc.text("Affordable Tutoring Solutions  ·  Melbourne, FL  ·  Winter Park, FL  ·  Baltimore, MD", margin, fy + 14);
      doc.text("support@affordabletutoringsolutions.org  ·  +1 (321) 341-9820", margin, fy + 25);
      doc.setFont("helvetica","bold");
      doc.text(`${i} / ${pageCount}`, pageW - margin, fy + 14, {align:"right"});
    }

    doc.save(`PSM_${safeName}_${todayStr()}.pdf`);
    showToast("PDF downloaded");
  };
  const addStudent=()=>{
    if(!newS.name.trim())return;
    const newId=uid();
    const notesValue=newS.notes;
    setStudents(prev=>[...prev,{...newS,id:newId,dateAdded:todayStr(),assignments:[],scores:[],diagnostics:[]}]);
    // Notes live in /_private/info, not in the students[] batch.
    saveStudentNotes(newId, notesValue);
    setNewS({name:"",grade:"",tutor:"",notes:""});
    setShowAdd(false);
    showToast("Student added");
  };
  const openProfile=(st)=>{
    setProfile(st);
    setPtab("history");
    setPaChk({});
    setPaSubj("All");
    setPaSrch("");
    setSfm({date:todayStr(),testType:"",score:"",maxScore:"",notes:""});
    setTab("students");
    setProfileNotes("");
    const ref=notesDocRef(st.id);
    if(ref) ref.get()
      .then(snap=>{ if(snap.exists) setProfileNotes(snap.data().notes || ""); })
      .catch(e=>console.warn("[Firestore] notes read error:", e));
  };

  const savePreAssign=()=>{
    const ids=Object.keys(paChk).filter(k=>paChk[k]);
    const weIds=Object.keys(paWeChk).filter(k=>paWeChk[k]);
    const bbArr=[...paBBPicks].sort((a,b)=>a-b);
    const weArr=[...paWEPicks].sort((a,b)=>a-b);
    if(!ids.length&&!weIds.length&&!bbArr.length&&!weArr.length)return;
    const sheets=ALL_WS.filter(ws=>ids.includes(ws.id));
    const weEntries=WE_DOMAIN_ITEMS.filter(i=>weIds.includes(i.id)).map(i=>({kind:"welled_domain",subject:i.subject,domain:i.domain,difficulty:i.difficulty,label:i.label,qs:i.qs}));
    const practiceExams=[
      ...bbArr.map(n=>({platform:"BlueBook",type:"full",number:n,examType})),
      ...weArr.map(n=>({platform:"WellEd",type:"full",number:n,examType})),
    ];
    const entry={id:uid(),date:paDate||todayStr(),preAssigned:true,examType,worksheets:sheets.map(ws=>({id:ws.id,title:ws.title,subject:ws.subject,domain:ws.domain,subdomain:ws.subdomain,difficulty:ws.difficulty,qs:ws.qs})),welledDomain:weEntries,vocab:[],practiceExams,timeDrill:false,oneNote:false};
    const upd=students.map(st=>st.id===profile.id?{...st,assignments:[...(st.assignments||[]),entry]}:st);
    const totalItems=ids.length+weIds.length+bbArr.length+weArr.length;
    setStudents(upd);setProfile(upd.find(st=>st.id===profile.id));setPaChk({});setPaWeChk({});setPaBBPicks([]);setPaWEPicks([]);showToast(`${totalItems} item(s) pre-assigned`);
    // Session 18C v5: pre-assigned PSMs no longer auto-post to Wise.
    // Per Aidan: pre-assigns are planning placeholders the tutor stages
    // ahead of a session — they shouldn't show up in the student's Wise
    // class discussion until the tutor formally assigns them (via the
    // Generator → Save flow, which still calls assignToWise).
  };
  const addScore=()=>{if(!sfm.testType||!sfm.score)return;const entry={...sfm,id:uid()};const upd=students.map(st=>st.id===profile.id?{...st,scores:[...(st.scores||[]),entry]}:st);setStudents(upd);setProfile(upd.find(st=>st.id===profile.id));setSfm({date:todayStr(),testType:"",score:"",maxScore:"",notes:""});showToast("Score recorded");};
  // Soft-delete — items stay in the array with deleted:true and deletedAt,
  // filtered out of display via live(). Restore + hard-delete live in the Trash tab.
  const delScore=(sid)=>{
    if(!profile) return;
    const sc = (profile.scores||[]).find(s=>s.id===sid);
    const label = sc ? (sc.testType || sc.date || "this score") : "this score";
    // Session 18C v4: offer hard delete option. Prompt asks; ENTER=soft,
    // type 'HARD' = remove from the array entirely (no recovery).
    const choice = window.prompt(
      `Remove "${label}"?\n\nEnter to SOFT delete (recoverable, won't show in charts).\nType HARD then Enter to permanently delete (cannot be undone).\nCancel to keep.`,
      ""
    );
    if(choice === null) return;
    const hard = choice.trim().toUpperCase() === "HARD";
    const upd = students.map(st => {
      if(st.id !== profile.id) return st;
      if(hard) return {...st, scores: (st.scores||[]).filter(s=>s.id!==sid)};
      return {...st, scores: (st.scores||[]).map(s=>s.id===sid?softDel(s):s)};
    });
    setStudents(upd);
    setProfile(upd.find(st=>st.id===profile.id));
    showToast(`${hard?"Permanently deleted":"Removed"}: ${label}`);
  };
  // Standalone WellEd Domain score logs — continuous tracking per subdomain outside of assignment history
  const addWelledLog=(log)=>{
    const entry = {...log,id:uid()};
    const upd = students.map(st=>st.id===profile.id?{...st,welledLogs:[...(st.welledLogs||[]),entry]}:st);
    setStudents(upd); setProfile(upd.find(st=>st.id===profile.id));
    showToast("WellEd domain score logged");
  };
  const delWelledLog=(lid)=>{
    const upd = students.map(st=>st.id===profile.id?{...st,welledLogs:(st.welledLogs||[]).map(l=>l.id===lid?softDel(l):l)}:st);
    setStudents(upd); setProfile(upd.find(st=>st.id===profile.id));
    showToast("Log moved to Trash");
  };
  const delAsg=(aid)=>{const upd=students.map(st=>st.id===profile.id?{...st,assignments:(st.assignments||[]).map(a=>a.id===aid?softDel(a):a)}:st);setStudents(upd);setProfile(upd.find(st=>st.id===profile.id));showToast("Assignment moved to Trash");};

  // Session 18A: PSM editing — per-worksheet operations.
  //
  // delWs: soft-removes one worksheet from an active assignment. Refuses
  //   if any submission already touched that worksheet (the tutor cannot
  //   yank the rug out from under a student who has answered or
  //   submitted). hasWorksheetSubmission walks the legacy submissions
  //   collection for any non-empty studentAnswer on a matching
  //   worksheetId; this is conservative but cheap.
  // addWs: appends one or more worksheets to an existing assignment.
  //   Skips duplicates by id. No restriction on which assignments can be
  //   extended.
  //
  // Both helpers write back through setStudents → the existing Firestore
  // batch write debounce; no special handling required.
  const hasWorksheetSubmission = (student, asgId, wsId) => {
    const subs = Array.isArray(student && student.submissions) ? student.submissions : [];
    for (const s of subs) {
      if (!s || s.assignmentId !== asgId) continue;
      const responses = Array.isArray(s.responses) ? s.responses : [];
      for (const r of responses) {
        if (r && r.worksheetId === wsId) {
          const ans = typeof r.studentAnswer === "string" ? r.studentAnswer.trim() : "";
          if (ans.length > 0 || (r.flag && r.flag !== null)) return true;
        }
      }
    }
    return false;
  };
  const delWs = (asgId, wsId) => {
    const student = students.find(st => st.id === profile.id);
    if (student && hasWorksheetSubmission(student, asgId, wsId)) {
      showToast("Cannot remove — student already submitted answers for this worksheet");
      return;
    }
    const upd = students.map(st => {
      if (st.id !== profile.id) return st;
      return {
        ...st,
        assignments: (st.assignments || []).map(a => {
          if (a.id !== asgId) return a;
          return {
            ...a,
            worksheets: (a.worksheets || []).map(w => w.id === wsId ? softDel(w) : w),
          };
        }),
      };
    });
    setStudents(upd);
    setProfile(upd.find(st => st.id === profile.id));
    showToast("Worksheet removed");
  };
  const addWs = (asgId, wsList) => {
    if (!wsList || wsList.length === 0) return;
    const upd = students.map(st => {
      if (st.id !== profile.id) return st;
      return {
        ...st,
        assignments: (st.assignments || []).map(a => {
          if (a.id !== asgId) return a;
          const existing = a.worksheets || [];
          const existingIds = new Set(existing.filter(w => !w.deleted).map(w => w.id));
          const toAdd = wsList
            .filter(ws => !existingIds.has(ws.id))
            .map(ws => ({
              id: ws.id,
              title: ws.title,
              subject: ws.subject,
              domain: ws.domain,
              subdomain: ws.subdomain,
              difficulty: ws.difficulty,
              qs: ws.qs,
              evenOdd: null,
              timeLimit: null,
            }));
          return { ...a, worksheets: [...existing, ...toAdd] };
        }),
      };
    });
    setStudents(upd);
    setProfile(upd.find(st => st.id === profile.id));
    showToast(`Added ${wsList.length} worksheet${wsList.length === 1 ? "" : "s"}`);
  };
  const delStudent=(id)=>{
    if(!confirm("Move this student to Trash? You can restore them later from the Trash tab.")) return;
    setStudents(prev=>prev.map(st=>st.id===id?softDel(st):st));
    if(profile?.id===id) setProfile(null);
    showToast("Student moved to Trash");
  };

  // Restore / hard-delete operations used by the Trash tab.
  const restoreStudent=(id)=>setStudents(prev=>prev.map(st=>st.id===id?softRestore(st):st));
  const purgeStudent=(id)=>{
    if(!confirm("Delete this student forever? This cannot be undone.")) return;
    setStudents(prev=>prev.filter(st=>st.id!==id));
  };
  const restoreSubItem=(stId,key,itemId)=>setStudents(prev=>prev.map(st=>st.id===stId?{...st,[key]:(st[key]||[]).map(x=>x.id===itemId?softRestore(x):x)}:st));
  const purgeSubItem=(stId,key,itemId)=>{
    if(!confirm("Delete forever? This cannot be undone.")) return;
    setStudents(prev=>prev.map(st=>st.id===stId?{...st,[key]:(st[key]||[]).filter(x=>x.id!==itemId)}:st));
  };
  const emptyTrash=()=>{
    if(!confirm("Permanently delete every item in Trash? This cannot be undone.")) return;
    setStudents(prev=>prev.filter(st=>!st.deleted).map(st=>({
      ...st,
      assignments: (st.assignments||[]).filter(a=>!a.deleted),
      scores: (st.scores||[]).filter(x=>!x.deleted),
      welledLogs: (st.welledLogs||[]).filter(x=>!x.deleted),
      diagnostics: (st.diagnostics||[]).filter(x=>!x.deleted),
    })));
    showToast("Trash emptied");
  };

  // Update a practice exam in assignment history — accepts a patch object
  const setExamScore = (aid,examIdx,patch)=>{
    const upd = students.map(st=>{
      if(st.id!==profile.id) return st;
      return {...st, assignments: st.assignments.map(a=>{
        if(a.id!==aid) return a;
        const ex = [...(a.practiceExams||[])];
        ex[examIdx] = {...ex[examIdx], ...patch};
        return {...a, practiceExams: ex};
      })};
    });
    setStudents(upd); setProfile(upd.find(st=>st.id===profile.id));
  };
  const setWelledDomainScore = (aid,idx,score)=>{
    const upd = students.map(st=>{
      if(st.id!==profile.id) return st;
      return {...st, assignments: st.assignments.map(a=>{
        if(a.id!==aid) return a;
        const arr=[...(a.welledDomain||[])];
        arr[idx]={...arr[idx],score};
        return {...a, welledDomain:arr};
      })};
    });
    setStudents(upd); setProfile(upd.find(st=>st.id===profile.id));
  };

  const exportData=()=>{
    const blob=new Blob([JSON.stringify(students,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download=`psm-data-${todayStr()}.json`;a.click();
    URL.revokeObjectURL(url);
    showToast("Data exported");
  };
  const importData=(e)=>{
    const f=e.target.files?.[0];if(!f)return;
    const r=new FileReader();
    r.onload=()=>{try{const d=JSON.parse(r.result);if(Array.isArray(d)){if(confirm(`Import ${d.length} students? This will REPLACE all current data.`)){setStudents(d);showToast("Data imported");}}else alert("Invalid file format");}catch{alert("Failed to parse file");}};
    r.readAsText(f);
    e.target.value="";
  };

  // Wise Learner Report CSV import — additive, with preview + dedupe.
  const handleWiseFile=(e)=>{
    const f=e.target.files?.[0]; if(!f) return;
    const r=new FileReader();
    r.onload=()=>{
      try{
        const parsed = parseWiseCsv(String(r.result||""));
        if(!parsed.length){ alert("No students found in this file."); return; }
        const existingNames = new Set(students.filter(s=>!s.deleted).map(s=>s.name.trim().toLowerCase()));
        // Session 18C: default-select only SAT-tagged + non-duplicate rows.
        // Non-SAT rows still appear in the preview so the tutor can opt in
        // (e.g. ACT prep), but the auto-allowlist intent is SAT-only.
        const rows = parsed.map(p=>({
          ...p,
          duplicate: existingNames.has(p.name.trim().toLowerCase()),
          selected: !existingNames.has(p.name.trim().toLowerCase()) && !!p.isSat,
        }));
        setWiseImport({fileName: f.name, rows});
      }catch(err){
        console.error("[Wise import]", err);
        alert("Failed to parse: "+(err.message||err));
      }
    };
    r.readAsText(f);
    e.target.value="";
  };
  const toggleWiseRow=(i)=>setWiseImport(w=>w?{...w, rows: w.rows.map((r,idx)=>idx===i?{...r,selected:!r.selected}:r)}:w);
  const setWiseAll=(sel,onlyNew)=>setWiseImport(w=>w?{...w, rows: w.rows.map(r=>({...r, selected: onlyNew ? (sel && !r.duplicate) : sel}))}:w);
  const cancelWiseImport=()=>setWiseImport(null);
  const confirmWiseImport=()=>{
    if(!wiseImport) return;
    const picked = wiseImport.rows.filter(r=>r.selected);
    if(!picked.length){ cancelWiseImport(); return; }
    const newStudents = picked.map(p=>({
      id: uid(),
      name: p.name,
      meta: p.meta,
      assignments: [],
      scores: [],
      welledLogs: [],
      diagnostics: [],
    }));
    setStudents(prev=>[...prev, ...newStudents]);
    showToast(`Imported ${newStudents.length} student${newStudents.length!==1?"s":""} from Wise`);
    setWiseImport(null);
  };

  /* ============ DIAGNOSTIC UPLOAD ============ */
  const handleDiagUpload = async(files)=>{
    if(!files||!files.length) return;
    // Session 18C v3: prompt for the actual test date instead of using
    // today's upload date. ZipGrade PDFs don't carry the test-taken date
    // in a parseable format, so we ask the tutor. parsedAt then reflects
    // when the student actually took the diagnostic, which is what
    // every chart wants for sorting and time-point #1 placement.
    const defaultDate = todayStr();
    const dateInput = window.prompt(
      "Date this diagnostic was TAKEN (not uploaded):\nFormat: YYYY-MM-DD",
      defaultDate,
    );
    if(dateInput === null) return; // user cancelled
    // Validate / normalize
    let testDate = (dateInput||"").trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(testDate)){
      const try1 = testDate.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if(try1){
        const yr = try1[3].length===2 ? `20${try1[3]}` : try1[3];
        testDate = `${yr}-${String(try1[1]).padStart(2,"0")}-${String(try1[2]).padStart(2,"0")}`;
      } else if(testDate === "") {
        testDate = defaultDate;
      } else {
        alert(`Couldn't parse date "${dateInput}". Using today instead.`);
        testDate = defaultDate;
      }
    }
    setParsing(true);
    try{
      const results=[];
      for(const f of files){
        try{
          const r = await parseDiagnosticPdf(f);
          // Override parsedAt with the user-supplied test date so it
          // anchors chart sorting + appears in legends as the baseline.
          r.parsedAt = testDate;
          r.testedOn = testDate;
          results.push(r);
        }catch(err){
          console.error("parse error",f.name,err);
          showToast(`Failed to parse ${f.name}`);
        }
      }
      if(results.length){
        const stamped = results.map(r=>({id:uid(),...r}));
        const upd = students.map(st=>{
          if(st.id!==profile.id) return st;
          const existing = st.diagnostics||[];
          return {...st, diagnostics:[...existing, ...stamped]};
        });
        setStudents(upd);
        setProfile(upd.find(st=>st.id===profile.id));
        showToast(`Parsed ${results.length} diagnostic${results.length!==1?"s":""} (test date: ${testDate})`);
      }
    } finally { setParsing(false); }
  };
  const clearDiagnostics=()=>{
    if(!confirm("Move all diagnostic data for this student to Trash? You can restore them individually.")) return;
    const upd = students.map(st=>{
      if(st.id!==profile.id) return st;
      const diags = (st.diagnostics||[]).map(d=>d.deleted?d:softDel({id:d.id||uid(),...d}));
      return {...st, diagnostics: diags};
    });
    setStudents(upd); setProfile(upd.find(st=>st.id===profile.id));
    showToast("Diagnostics moved to Trash");
  };

  /* ============ WELLED REPORT UPLOAD ============ */
  const handleWelledUpload = async(files)=>{
    if(!files||!files.length||!profile) return;
    setParsing(true);
    try{
      for(const f of files){
        try{
          const r = await parseWelledReport(f);
          // Session 18C v4: confirmation dialog before saving. Lets
          // tutor verify the parser's output and override any number
          // the parser got wrong. The parser is heuristic + WellEd
          // PDF layouts vary, so a manual review checkpoint is the
          // safety net.
          const review = window.prompt(
            [
              `WellEd report parsed — please review before saving.`,
              `File: ${f.name}`,
              `Test #: ${r.testNumber||"?"}`,
              `Tested on: ${r.testedOn||"unknown"}`,
              `Type: ${r.type}`,
              ``,
              `Scores (edit any cell, comma-separated, leave blank to keep):`,
              `  total=${r.totalScore||""}  rw=${r.rwScore||""}  math=${r.mathScore||""}`,
              ``,
              `Domains found: ${r.domains.length}/8`,
              ``,
              `OK to save with these values? (Cancel to skip this file.)`,
              `To override, type: testDate,total,rw,math`,
              `Example: 2026-03-03,1230,630,600`,
              `Or leave blank and click OK to accept the parsed values.`,
            ].join("\n"),
            "" // empty default → accept as-is
          );
          if(review === null) {
            showToast(`Skipped: ${f.name}`);
            continue;
          }
          // Apply override if user typed values
          if(review.trim()){
            const parts = review.split(",").map(s=>s.trim());
            const [td, t, rw, m] = parts;
            if(td && /^\d{4}-\d{2}-\d{2}$/.test(td)) r.testedOn = td;
            const tnum = parseInt(t);  if(Number.isFinite(tnum)) r.totalScore = tnum;
            const rwnum = parseInt(rw); if(Number.isFinite(rwnum)) r.rwScore = rwnum;
            const mnum = parseInt(m);  if(Number.isFinite(mnum)) r.mathScore = mnum;
            // Recompute type based on what's now present
            if(r.rwScore && !r.mathScore) r.type = "rw-only";
            else if(r.mathScore && !r.rwScore) r.type = "math-only";
            else r.type = "full";
          }
          // Session 18C v2: build a score entry whose top-line max
          // reflects the actual test scope. Full reports are /1600;
          // section-only reports are /800. The aggregator
          // (allScoreDataPoints) reads welledReport.{type,rwScore,
          // mathScore,totalScore,domains} to emit one time-point per
          // section + one per domain — not a per-test-number bucket.
          let topLineScore = "";
          let topLineMax = "1600";
          if(r.type === "rw-only" && r.rwScore){
            topLineScore = r.rwScore;
            topLineMax = "800";
          } else if(r.type === "math-only" && r.mathScore){
            topLineScore = r.mathScore;
            topLineMax = "800";
          } else {
            topLineScore = r.totalScore || ((r.rwScore||0)+(r.mathScore||0)) || "";
            topLineMax = "1600";
          }
          const testLabel = r.testNumber
            ? (r.type === "rw-only" ? `WellEd PT #${r.testNumber} (Reading)`
              : r.type === "math-only" ? `WellEd PT #${r.testNumber} (Math)`
              : `WellEd Practice Test ${r.testNumber}`)
            : "WellEd Report";
          const scoreEntry = {
            id:uid(),
            date: r.testedOn || todayStr(),
            testType: testLabel,
            score: topLineScore,
            maxScore: topLineMax,
            notes: `R&W: ${r.rwScore||"—"}, Math: ${r.mathScore||"—"}, Type: ${r.type}, Tested: ${r.testedOn||"unknown"}, Domains parsed: ${r.domains.length}/8`,
            welledReport: r,
          };
          const upd = students.map(st=>{
            if(st.id!==profile.id) return st;
            return {...st, scores:[...(st.scores||[]), scoreEntry]};
          });
          setStudents(upd);
          setProfile(upd.find(st=>st.id===profile.id));
          showToast(`WellEd report parsed: ${testLabel} — ${topLineScore || "N/A"}, ${r.domains.length} domains`);
        }catch(err){
          console.error("WellEd parse error",f.name,err);
          showToast(`Failed to parse ${f.name}: ${err.message}`);
        }
      }
    } finally { setParsing(false); }
  };

  // p is looked up from visibleStudents so its sub-items are already filtered.
  // If the underlying student was soft-deleted since the profile opened we fall
  // back to the raw record (rare — delStudent closes the profile itself).
  const p = profile && (visibleStudents.find(st=>st.id===profile.id) || students.find(st=>st.id===profile.id) || profile);
  const diagProfile = useMemo(()=>p?.diagnostics?.length?buildDiagnosticProfile(p.diagnostics):null,[p]);

  // Global search keyboard shortcut — Cmd/Ctrl+K toggles, Escape closes.
  useEffect(()=>{
    const onKey = (e)=>{
      if((e.metaKey||e.ctrlKey) && e.key && e.key.toLowerCase()==="k"){
        e.preventDefault();
        setSearchOpen(o=>!o);
      } else if(e.key==="Escape"){
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return ()=>window.removeEventListener("keydown", onKey);
  },[]);
  // When the search overlay opens, clear the query and focus the input.
  useEffect(()=>{
    if(searchOpen){
      setSearchQuery("");
      setTimeout(()=>searchInputRef.current?.focus(),20);
    }
  },[searchOpen]);

  // Grouped search results — substring (case-insensitive), all tokens must match.
  const searchResults = useMemo(()=>{
    const q = searchQuery.trim().toLowerCase();
    if(!q) return null;
    const tokens = q.split(/\s+/).filter(Boolean);
    const hit = (text)=>{
      const t = (text||"").toLowerCase();
      return tokens.every(tok => t.includes(tok));
    };
    const groups = {students:[], worksheets:[], welled:[], exams:[], diagnostics:[], scores:[]};
    for(const st of visibleStudents){
      const stName = st.name || "(unnamed)";
      const stBlob = [stName, st.meta?.email, st.meta?.phone, st.meta?.gradeLevel, st.meta?.levelOfTutoring, st.meta?.subjectOfTutoring, st.meta?.goals].filter(Boolean).join(" ");
      if(hit(stBlob)){
        groups.students.push({student:st, ptab:"history", label:stName, detail:[st.meta?.email,st.meta?.gradeLevel,st.meta?.levelOfTutoring].filter(Boolean).join(" · ")});
      }
      // Every nested blob starts with the student name so queries like
      // "sample info" (student + worksheet topic) match the right row.
      for(const a of st.assignments||[]){
        for(const ws of a.worksheets||[]){
          const blob = [stName, ws.title, ws.domain, ws.subdomain, ws.difficulty, ws.subject, a.date].filter(Boolean).join(" ");
          if(hit(blob)){
            groups.worksheets.push({student:st, ptab:"history", label:ws.title||"Worksheet", detail:`${stName} · ${ws.domain||""}${ws.difficulty?` · ${ws.difficulty}`:""} · ${a.date||""}`});
          }
        }
        for(const w of a.welledDomain||[]){
          const blob = [stName, w.label, w.domain, w.difficulty, w.subject, a.date].filter(Boolean).join(" ");
          if(hit(blob)){
            groups.welled.push({student:st, ptab:"history", label:w.label||w.domain||"WellEd", detail:`${stName} · ${w.subject||""}${w.difficulty?` · ${w.difficulty}`:""} · ${a.date||""}`});
          }
        }
        for(const ex of a.practiceExams||[]){
          const blob = [stName, ex.platform, ex.number, ex.type, a.date].filter(Boolean).join(" ");
          if(hit(blob)){
            groups.exams.push({student:st, ptab:"history", label:`${ex.platform||"Exam"} #${ex.number||"?"}`, detail:`${stName} · ${ex.type||"full"} · ${a.date||""}`});
          }
        }
      }
      for(const d of st.diagnostics||[]){
        const blob = [stName, d.testName, d.dateTaken, d.name].filter(Boolean).join(" ");
        if(hit(blob)){
          groups.diagnostics.push({student:st, ptab:"diagnostics", label:d.testName||d.name||"Diagnostic", detail:`${stName} · ${d.dateTaken||""}`});
        }
      }
      for(const sc of st.scores||[]){
        const blob = [stName, sc.testType, sc.notes, sc.score, sc.maxScore, sc.date].filter(Boolean).join(" ");
        if(hit(blob)){
          groups.scores.push({student:st, ptab:"scores", label:sc.testType||"Score", detail:`${stName} · ${sc.score||"—"}${sc.maxScore?` / ${sc.maxScore}`:""} · ${sc.date||""}`});
        }
      }
      for(const lg of st.welledLogs||[]){
        const blob = [stName, lg.subject, lg.domain, lg.difficulty, lg.notes, lg.date].filter(Boolean).join(" ");
        if(hit(blob)){
          groups.scores.push({student:st, ptab:"scores", label:`WellEd · ${lg.domain||""}`, detail:`${stName} · ${lg.score||"—"} · ${lg.date||""}`});
        }
      }
    }
    const total = Object.values(groups).reduce((n,a)=>n+a.length,0);
    return {groups, total};
  },[searchQuery, visibleStudents]);

  // Navigate to a search result — open the student profile at the right sub-tab.
  const selectSearchResult = (r)=>{
    setTab("students");
    setProfile(r.student);
    setPtab(r.ptab||"history");
    setSearchOpen(false);
  };

  // Counts for the Trash tab badge.
  const trashCount = useMemo(()=>{
    let n = 0;
    for(const st of students){
      if(st.deleted) n++;
      n += trashed(st.assignments).length;
      n += trashed(st.scores).length;
      n += trashed(st.welledLogs).length;
      n += trashed(st.diagnostics).length;
    }
    return n;
  },[students]);

  // Check whether a given worksheet was already assigned, and find the latest date
  const lastAssignedDate = (stud, wsId)=>{
    if(!stud) return null;
    let latest = null;
    (stud.assignments||[]).forEach(a=>{
      (a.worksheets||[]).forEach(w=>{
        if((w.id||w.name)===wsId || w.title===wsId){
          if(!latest || (a.date||"")>latest) latest = a.date||"pre-assigned";
        }
      });
    });
    return latest;
  };

  /* ============ RENDER ============ */
  return(
    <div style={{fontFamily:"'IBM Plex Sans',system-ui,sans-serif",background:"var(--paper)",minHeight:"100vh",display:"flex",flexDirection:"column"}}>
      {toast&&<div style={{position:"fixed",top:16,right:16,background:"#1e293b",color:"#fff",padding:"10px 18px",borderRadius:10,fontSize:13,fontWeight:600,zIndex:9999,boxShadow:"0 4px 16px rgba(0,0,0,.25)"}}>{toast}</div>}
      {parsing&&<div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",background:"#4338ca",color:"#fff",padding:"10px 18px",borderRadius:10,fontSize:13,fontWeight:600,zIndex:9999}} className="pl">Parsing diagnostic PDF(s)...</div>}

      {searchOpen && (()=>{
        const groupDefs = [
          {key:"students", label:"Students", color:"var(--brand)"},
          {key:"worksheets", label:"Worksheets", color:"var(--ink-soft)"},
          {key:"welled", label:"WellEd Domains", color:"var(--accent)"},
          {key:"exams", label:"Practice Exams", color:"var(--brand-light)"},
          {key:"diagnostics", label:"Diagnostics", color:"var(--brand-dark)"},
          {key:"scores", label:"Scores & Logs", color:"var(--ok)"},
        ];
        const PER_GROUP = 5;
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,26,46,.55)",zIndex:10001,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"80px 24px 24px"}} onClick={()=>setSearchOpen(false)}>
            <div onClick={e=>e.stopPropagation()} style={{background:"var(--card)",border:"1px solid var(--rule)",borderRadius:14,boxShadow:"var(--shadow-lg)",maxWidth:720,width:"100%",maxHeight:"78vh",display:"flex",flexDirection:"column",overflow:"hidden",position:"relative"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,var(--brand) 0,var(--brand) 72px,transparent 72px)"}}/>
              <div style={{padding:"22px 24px 14px",borderBottom:"1px solid var(--rule)",display:"flex",alignItems:"center",gap:12}}>
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{flexShrink:0,color:"var(--ink-mute)"}}><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={e=>setSearchQuery(e.target.value)}
                  placeholder="Search students, worksheets, domains, exams, scores…"
                  style={{flex:1,border:"none",outline:"none",background:"transparent",fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 72",fontSize:20,fontWeight:500,color:"var(--ink)",letterSpacing:"-0.01em"}}
                />
                <kbd style={{fontFamily:"var(--font-mono)",fontSize:10,color:"var(--ink-mute)",border:"1px solid var(--rule)",padding:"2px 7px",borderRadius:4,letterSpacing:0}}>Esc</kbd>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"8px 0"}}>
                {!searchResults ? (
                  <div style={{padding:"40px 24px",textAlign:"center",color:"var(--ink-mute)",fontFamily:"var(--font-display)",fontStyle:"italic",fontSize:14}}>
                    Start typing to search across students, worksheets, domains, exams, scores, and diagnostics.
                  </div>
                ) : searchResults.total===0 ? (
                  <div style={{padding:"40px 24px",textAlign:"center",color:"var(--ink-mute)",fontFamily:"var(--font-display)",fontStyle:"italic",fontSize:14}}>
                    No matches for “{searchQuery}”.
                  </div>
                ) : (
                  groupDefs.map(g=>{
                    const items = searchResults.groups[g.key];
                    if(!items.length) return null;
                    const shown = items.slice(0,PER_GROUP);
                    const more = items.length - shown.length;
                    return (
                      <div key={g.key} style={{padding:"10px 0"}}>
                        <div style={{padding:"4px 24px",fontFamily:"var(--font-mono)",fontSize:9,fontWeight:600,color:"var(--ink-mute)",letterSpacing:"0.1em",textTransform:"uppercase",display:"flex",alignItems:"center",gap:10}}>
                          <span style={{width:6,height:6,borderRadius:"50%",background:g.color}}/>
                          {g.label}
                          <span style={{marginLeft:"auto",opacity:.7}}>{items.length}</span>
                        </div>
                        {shown.map((r,i)=>(
                          <button key={i} onClick={()=>selectSearchResult(r)} style={{
                            display:"block",width:"100%",textAlign:"left",background:"transparent",border:"none",
                            padding:"10px 24px",cursor:"pointer",borderLeft:`2px solid transparent`,
                            transition:"background .12s ease, border-color .12s ease"
                          }}
                          onMouseEnter={e=>{e.currentTarget.style.background="var(--paper-alt)";e.currentTarget.style.borderLeftColor=g.color;}}
                          onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderLeftColor="transparent";}}
                          >
                            <div style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 48",fontSize:14,fontWeight:500,color:"var(--ink)",letterSpacing:"-0.005em"}}>{r.label}</div>
                            {r.detail && <div style={{fontSize:11,color:"var(--ink-mute)",marginTop:2,fontFamily:"var(--font-mono)"}}>{r.detail}</div>}
                          </button>
                        ))}
                        {more>0 && <div style={{padding:"6px 24px",fontSize:10,color:"var(--ink-mute)",fontFamily:"var(--font-mono)",fontStyle:"italic"}}>+ {more} more — refine your query</div>}
                      </div>
                    );
                  })
                )}
              </div>
              <div style={{padding:"10px 24px",borderTop:"1px solid var(--rule)",background:"var(--paper-alt)",display:"flex",gap:16,fontFamily:"var(--font-mono)",fontSize:9,color:"var(--ink-mute)",letterSpacing:"0.04em",textTransform:"uppercase"}}>
                <span><kbd style={{fontFamily:"var(--font-mono)",fontSize:9,border:"1px solid var(--rule)",padding:"1px 5px",borderRadius:3,marginRight:4}}>⌘K</kbd> Open</span>
                <span><kbd style={{fontFamily:"var(--font-mono)",fontSize:9,border:"1px solid var(--rule)",padding:"1px 5px",borderRadius:3,marginRight:4}}>Esc</kbd> Close</span>
                <span style={{marginLeft:"auto"}}>All words must match · case-insensitive</span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Session 18C v11: Broadcast-to-SAT-students modal */}
      {broadcastOpen && (
        <div onClick={()=> !broadcastBusy && setBroadcastOpen(false)} style={{position:"fixed",inset:0,background:"rgba(15,26,46,.55)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:"40px 24px"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--card)",border:"1px solid var(--rule)",borderRadius:14,boxShadow:"var(--shadow-lg)",maxWidth:680,width:"100%",maxHeight:"88vh",display:"flex",flexDirection:"column",overflow:"hidden",position:"relative"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,var(--brand) 0,var(--brand) 72px,transparent 72px)"}}/>
            <div style={{padding:"28px 32px 18px",borderBottom:"1px solid var(--rule)"}}>
              <div style={{fontFamily:"var(--font-body)",fontSize:10,fontWeight:600,letterSpacing:"0.18em",textTransform:"uppercase",color:"var(--ink-mute)",marginBottom:6}}>Wise · Broadcast</div>
              <h2 style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 144, 'SOFT' 20",fontWeight:600,fontSize:26,letterSpacing:"-0.02em",margin:"0 0 6px",lineHeight:1.1}}>
                Post a Wise discussion to every active SAT student
              </h2>
              <div style={{fontSize:13,color:"var(--ink-soft)",lineHeight:1.55,maxWidth:560}}>
                Discussion will be posted to each student's 1:1 SAT class in Wise (notifies them). Recipients: every active student with <code style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,background:"rgba(15,26,46,.05)",padding:"1px 4px",borderRadius:2}}>meta.source ∈ wise / wise-sync</code> and a cached class id.
              </div>
            </div>
            {!broadcastResult ? (
              <>
                <div style={{padding:"18px 32px 8px",flex:1,overflowY:"auto"}}>
                  <div style={{marginBottom:14}}>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,letterSpacing:1.2,color:"#66708A",textTransform:"uppercase",marginBottom:6}}>Discussion title</div>
                    <input value={broadcastTitle} onChange={e=>setBroadcastTitle(e.target.value)} disabled={broadcastBusy} style={{width:"100%",padding:"8px 12px",fontSize:13,fontFamily:"inherit",border:"1px solid rgba(15,26,46,.18)",borderRadius:4,boxSizing:"border-box"}}/>
                  </div>
                  <div>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,letterSpacing:1.2,color:"#66708A",textTransform:"uppercase",marginBottom:6}}>Body</div>
                    <textarea value={broadcastBody} onChange={e=>setBroadcastBody(e.target.value)} disabled={broadcastBusy} rows={10} style={{width:"100%",padding:"10px 12px",fontSize:13,fontFamily:"inherit",border:"1px solid rgba(15,26,46,.18)",borderRadius:4,boxSizing:"border-box",resize:"vertical",lineHeight:1.55}}/>
                  </div>
                </div>
                <div style={{padding:"14px 32px",borderTop:"1px solid var(--rule)",display:"flex",justifyContent:"flex-end",gap:10}}>
                  <button onClick={()=>setBroadcastOpen(false)} disabled={broadcastBusy} style={{...mkBtn("transparent","var(--ink-soft)"),border:"1px solid var(--rule)",padding:"8px 16px",fontSize:12}}>
                    Cancel
                  </button>
                  <button onClick={async()=>{
                    if(!window.firebase || !window.firebase.app){ alert("Firebase not loaded"); return; }
                    if(!broadcastTitle.trim() || !broadcastBody.trim()){ alert("Title and body are required."); return; }
                    setBroadcastBusy(true);
                    try{
                      // First, dry-run to count recipients.
                      const fn = window.firebase.app().functions("us-central1").httpsCallable("broadcastToSatStudents");
                      const preview = await fn({dryRun:true, title: broadcastTitle, body: broadcastBody});
                      const count = preview.data?.summary?.recipientCount || 0;
                      if(!window.confirm(`This will post the discussion to ${count} SAT student${count===1?"":"s"}. Proceed?`)){
                        setBroadcastBusy(false);
                        return;
                      }
                      const res = await fn({dryRun:false, title: broadcastTitle, body: broadcastBody});
                      setBroadcastResult(res.data || {error:"empty response"});
                      showToast(`Broadcast complete: ${res.data?.summary?.posted||0} posted, ${res.data?.summary?.failed||0} failed`);
                    }catch(e){
                      console.warn("[broadcast] failed:", e);
                      alert("Broadcast failed: " + (e.message||e));
                    } finally {
                      setBroadcastBusy(false);
                    }
                  }} disabled={broadcastBusy} style={{...mkBtn(broadcastBusy?"rgba(15,26,46,.2)":"#003258","#FAF7F2"),padding:"8px 18px",fontSize:12,fontWeight:600,letterSpacing:.4,textTransform:"uppercase"}}>
                    {broadcastBusy ? "Sending…" : "Preview & send"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{padding:"18px 32px 8px",flex:1,overflowY:"auto"}}>
                  <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:14}}>
                    <span style={{...mkPill("transparent","#4C7A4C"),border:"1px solid rgba(76,122,76,.4)",fontWeight:600}}>✓ {broadcastResult.summary?.posted||0} posted</span>
                    <span style={{...mkPill("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.4)",fontWeight:600}}>✗ {broadcastResult.summary?.failed||0} failed</span>
                  </div>
                  {Array.isArray(broadcastResult.results) && (
                    <div style={{maxHeight:240,overflowY:"auto",fontSize:12,fontFamily:"'IBM Plex Mono',monospace"}}>
                      {broadcastResult.results.map((r,i)=>(
                        <div key={i} style={{padding:"4px 8px",borderBottom:"1px solid rgba(15,26,46,.06)",color:r.status==="posted"?"#4C7A4C":"#8C2E2E"}}>
                          {r.status==="posted"?"✓":"✗"} {r.name} · {r.email}{r.error?` · ${r.error}`:""}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{padding:"14px 32px",borderTop:"1px solid var(--rule)",display:"flex",justifyContent:"flex-end"}}>
                  <button onClick={()=>{ setBroadcastOpen(false); setBroadcastResult(null); }} style={{...mkBtn("transparent","var(--ink)"),border:"1px solid var(--rule)",padding:"8px 18px",fontSize:12}}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Session 18C: Wise API sync preview modal */}
      {wiseSync && (()=>{
        if(wiseSync.loading){
          return (
            <div style={{position:"fixed",inset:0,background:"rgba(15,26,46,.55)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <div style={{background:"var(--card)",border:"1px solid var(--rule)",borderRadius:14,padding:"32px 40px",fontFamily:"var(--font-display)",fontSize:18,color:"var(--ink)"}}>
                Pulling roster from Wise API…
              </div>
            </div>
          );
        }
        if(wiseSync.error){
          return null;
        }
        const summary = wiseSync.summary || {};
        const plan = wiseSync.plan || {};
        const toAdd = plan.toAdd || [];
        const toUpdate = plan.toUpdate || [];
        const toTrash = plan.toTrash || [];
        const errs = plan.errors || [];
        const committing = !!wiseSync.committing;
        const committed = !!wiseSync.committed;
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,26,46,.55)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:"40px 24px"}} onClick={()=>!committing && setWiseSync(null)}>
            <div onClick={e=>e.stopPropagation()} style={{background:"var(--card)",border:"1px solid var(--rule)",borderRadius:14,boxShadow:"var(--shadow-lg)",maxWidth:880,width:"100%",maxHeight:"88vh",display:"flex",flexDirection:"column",overflow:"hidden",position:"relative"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,var(--brand) 0,var(--brand) 72px,transparent 72px)"}}/>
              <div style={{padding:"28px 32px 18px",borderBottom:"1px solid var(--rule)"}}>
                <div style={{fontFamily:"var(--font-body)",fontSize:10,fontWeight:600,letterSpacing:"0.18em",textTransform:"uppercase",color:"var(--ink-mute)",marginBottom:6}}>Wise API · Sync Preview</div>
                <h2 style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 144, 'SOFT' 20",fontWeight:600,fontSize:26,letterSpacing:"-0.02em",margin:"0 0 10px",lineHeight:1.1}}>
                  {committed ? "Sync complete" : `Pulled ${summary.totalWise||0} students from Wise`}
                </h2>
                <div style={{fontSize:13,color:"var(--ink-soft)",lineHeight:1.55,maxWidth:680}}>
                  {summary.satCount||0} in SAT classes · {summary.nonSatCount||0} non-SAT (not affected unless already imported).
                  {!committed && " Existing data (assignments, scores, diagnostics) on already-imported students is preserved — only the Wise metadata gets updated."}
                </div>
                <div style={{marginTop:14,display:"flex",gap:14,flexWrap:"wrap"}}>
                  <span style={{...mkPill("transparent","#4C7A4C"),border:"1px solid rgba(76,122,76,.4)",fontWeight:600}}>+ {summary.toAddCount||0} new</span>
                  <span style={{...mkPill("transparent","#003258"),border:"1px solid rgba(0,50,88,.35)",fontWeight:600}}>~ {summary.toUpdateCount||0} update meta</span>
                  <span style={{...mkPill("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.4)",fontWeight:600}}>– {summary.toTrashCount||0} trash (lost SAT)</span>
                  {summary.errorCount>0 && <span style={{...mkPill("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.4)",fontWeight:700}}>{summary.errorCount} errors</span>}
                </div>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:"16px 32px"}}>
                {[
                  {label:"Will add (new student + allowlist + Wise metadata)", items:toAdd, color:"#4C7A4C", tone:"rgba(76,122,76,.06)"},
                  {label:"Will update (preserves existing scores/assignments — only Wise metadata changes)", items:toUpdate, color:"#003258", tone:"rgba(0,50,88,.05)"},
                  {label:"Will trash (no longer in any SAT class on Wise)", items:toTrash, color:"#8C2E2E", tone:"rgba(140,46,46,.05)"},
                ].map((sect,si)=>(
                  sect.items.length===0 ? null : (
                    <div key={si} style={{marginBottom:18}}>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:sect.color,letterSpacing:1.2,textTransform:"uppercase",marginBottom:8}}>
                        {sect.label} ({sect.items.length})
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:2,background:sect.tone,padding:8,borderRadius:4,border:`1px solid ${sect.color}22`,maxHeight:240,overflowY:"auto"}}>
                        {sect.items.map((it,i)=>(
                          <div key={i} style={{display:"flex",gap:10,alignItems:"baseline",fontSize:12,padding:"3px 6px",borderRadius:2,background:i%2===0?"rgba(255,255,255,.5)":"transparent"}}>
                            <span style={{flex:"1 1 200px",fontWeight:500,color:"#0F1A2E"}}>{it.name || "(no name)"}</span>
                            <span style={{flex:"1 1 200px",color:"#66708A",fontFamily:"'IBM Plex Mono',monospace",fontSize:11}}>{it.email || "(no email)"}</span>
                            {it.reason && <span style={{color:sect.color,fontSize:10,fontFamily:"'IBM Plex Mono',monospace"}}>{it.reason}</span>}
                            {Array.isArray(it.satClasses) && it.satClasses.length>0 && <span style={{color:sect.color,fontSize:10}}>{it.satClasses[0].name}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                ))}
                {errs.length>0 && (
                  <div style={{marginTop:18,padding:12,background:"rgba(140,46,46,.06)",border:"1px solid rgba(140,46,46,.3)",borderRadius:4}}>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#8C2E2E",letterSpacing:1.2,textTransform:"uppercase",marginBottom:6}}>Errors</div>
                    {errs.map((e,i)=><div key={i} style={{fontSize:12,color:"#0F1A2E",marginBottom:2}}>{e.kind}: {e.studentId||e.name} — {e.message}</div>)}
                  </div>
                )}
                {(toAdd.length+toUpdate.length+toTrash.length)===0 && (
                  <div style={{textAlign:"center",padding:"40px 20px",color:"var(--ink-soft)",fontStyle:"italic",fontFamily:"'Fraunces',Georgia,serif",fontSize:16}}>
                    Nothing to do — Wise and the portal are already in sync.
                  </div>
                )}
              </div>
              <div style={{padding:"16px 32px",borderTop:"1px solid var(--rule)",display:"flex",justifyContent:"flex-end",gap:10}}>
                <button onClick={()=>!committing && setWiseSync(null)} disabled={committing} style={{...mkBtn("transparent","var(--ink-soft)"),border:"1px solid var(--rule)",padding:"8px 16px",fontSize:12}}>
                  {committed ? "Close" : "Cancel"}
                </button>
                {!committed && (toAdd.length+toUpdate.length+toTrash.length)>0 && (
                  <button onClick={async()=>{
                    setWiseSync(prev=>({...prev,committing:true}));
                    try{
                      const fn = window.firebase.app().functions("us-central1").httpsCallable("syncStudentsFromWise");
                      const result = await fn({dryRun:false});
                      setWiseSync({...result.data, committed:true});
                      showToast(`Synced: +${result.data.summary.toAddCount} new, ~${result.data.summary.toUpdateCount} updated, -${result.data.summary.toTrashCount} trashed`);
                    }catch(e){
                      console.warn("[wise-sync] commit failed:", e);
                      alert("Sync failed: " + (e.message||e));
                      setWiseSync(prev=>({...prev,committing:false}));
                    }
                  }} disabled={committing} style={{...mkBtn(committing?"rgba(15,26,46,.2)":"#003258","#FAF7F2"),padding:"8px 18px",fontSize:12,fontWeight:600,letterSpacing:.4,textTransform:"uppercase"}}>
                    {committing ? "Applying…" : "Apply sync"}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {wiseImport && (()=>{
        const newCount = wiseImport.rows.filter(r=>!r.duplicate).length;
        const dupCount = wiseImport.rows.filter(r=>r.duplicate).length;
        const selCount = wiseImport.rows.filter(r=>r.selected).length;
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,26,46,.55)",zIndex:10000,display:"flex",alignItems:"center",justifyContent:"center",padding:"40px 24px"}} onClick={cancelWiseImport}>
            <div onClick={e=>e.stopPropagation()} style={{background:"var(--card)",border:"1px solid var(--rule)",borderRadius:14,boxShadow:"var(--shadow-lg)",maxWidth:1000,width:"100%",maxHeight:"88vh",display:"flex",flexDirection:"column",overflow:"hidden",position:"relative"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,var(--brand) 0,var(--brand) 72px,transparent 72px)"}}/>
              <div style={{padding:"28px 32px 20px",borderBottom:"1px solid var(--rule)"}}>
                <div style={{fontFamily:"var(--font-body)",fontSize:10,fontWeight:600,letterSpacing:"0.18em",textTransform:"uppercase",color:"var(--ink-mute)",marginBottom:6}}>Wise · Learner Report</div>
                <h2 style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 144, 'SOFT' 20",fontWeight:600,fontSize:26,letterSpacing:"-0.02em",margin:"0 0 10px",lineHeight:1.1}}>Import {newCount} new student{newCount!==1?"s":""}</h2>
                <div style={{fontSize:13,color:"var(--ink-soft)",lineHeight:1.55,maxWidth:680}}>
                  Parsed <span style={{fontFamily:"var(--font-mono)",fontSize:12.5,color:"var(--ink)"}}>{wiseImport.fileName}</span> — found <strong>{wiseImport.rows.length}</strong> rows, <strong>{newCount}</strong> new, <strong>{dupCount}</strong> already in PSM. Addresses, hourly rates, and accommodations are intentionally not imported.
                </div>
                <div style={{marginTop:14,display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                  <button onClick={()=>setWiseAll(true,true)} style={{...mkBtn("transparent","var(--brand)"),border:"1px solid rgba(0,74,121,.35)",padding:"5px 12px",fontSize:11}}>Select all new</button>
                  {/* Session 18C: SAT-only quick selector */}
                  <button onClick={()=>setWiseImport(w=>w?{...w, rows: w.rows.map(r=>({...r, selected: !!r.isSat && !r.duplicate}))}:w)} style={{...mkBtn("transparent","#4C7A4C"),border:"1px solid rgba(76,122,76,.4)",padding:"5px 12px",fontSize:11}}>Select SAT only</button>
                  <button onClick={()=>setWiseAll(true,false)} style={{...mkBtn("transparent","var(--ink-soft)"),border:"1px solid var(--rule)",padding:"5px 12px",fontSize:11}}>Select all</button>
                  <button onClick={()=>setWiseAll(false,false)} style={{...mkBtn("transparent","var(--ink-soft)"),border:"1px solid var(--rule)",padding:"5px 12px",fontSize:11}}>Clear</button>
                  <div style={{marginLeft:"auto",fontFamily:"var(--font-mono)",fontSize:10,color:"var(--ink-mute)",letterSpacing:"0.04em",textTransform:"uppercase"}}>{selCount} selected · {wiseImport.rows.filter(r=>r.isSat).length} SAT</div>
                </div>
              </div>
              <div style={{flex:1,overflowY:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead style={{position:"sticky",top:0,background:"var(--paper-alt)",zIndex:1}}>
                    <tr style={{borderBottom:"1px solid var(--rule)"}}>
                      {["","Name","Email","Phone","Grade","Level","Subject","Status"].map((h,i)=>(
                        <th key={i} style={{padding:"12px 14px",textAlign:"left",fontFamily:"var(--font-mono)",fontSize:9,fontWeight:600,color:"var(--ink-mute)",letterSpacing:"0.1em",textTransform:"uppercase"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {wiseImport.rows.map((r,i)=>(
                      <tr key={i} style={{borderBottom:i===wiseImport.rows.length-1?"none":"1px solid rgba(15,26,46,.06)",background:r.duplicate?"rgba(154,91,31,.04)":"transparent",opacity:r.selected?1:0.55}}>
                        <td style={{padding:"10px 14px",width:34}}>
                          <input type="checkbox" checked={r.selected} onChange={()=>toggleWiseRow(i)}/>
                        </td>
                        <td style={{padding:"10px 14px",fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 48",fontSize:13,fontWeight:500,color:"var(--ink)"}}>{r.name}</td>
                        <td style={{padding:"10px 14px",fontFamily:"var(--font-mono)",fontSize:11,color:"var(--ink-soft)"}}>{r.meta.email||"—"}</td>
                        <td style={{padding:"10px 14px",fontFamily:"var(--font-mono)",fontSize:11,color:"var(--ink-soft)"}}>{r.meta.phone||"—"}</td>
                        <td style={{padding:"10px 14px",color:"var(--ink-soft)"}}>{r.meta.gradeLevel||"—"}</td>
                        <td style={{padding:"10px 14px",color:"var(--ink-soft)"}}>{r.meta.levelOfTutoring||"—"}</td>
                        <td style={{padding:"10px 14px",color:"var(--ink-soft)"}}>{r.meta.subjectOfTutoring||"—"}{r.isSat&&<span style={{marginLeft:6,padding:"1px 6px",borderRadius:2,fontSize:9,fontWeight:700,letterSpacing:.4,background:"#E4F0E2",color:"#4C7A4C",fontFamily:"'IBM Plex Mono',monospace"}}>SAT</span>}</td>
                        <td style={{padding:"10px 14px",whiteSpace:"nowrap"}}>
                          {r.duplicate ? (
                            <span style={{display:"inline-block",padding:"2px 9px",borderRadius:999,border:"1px solid rgba(154,91,31,.35)",color:"var(--accent)",fontFamily:"var(--font-mono)",fontSize:9,fontWeight:600,letterSpacing:"0.06em",textTransform:"uppercase"}}>Already in PSM</span>
                          ) : (
                            <span style={{display:"inline-block",padding:"2px 9px",borderRadius:999,border:"1px solid rgba(0,74,121,.35)",color:"var(--brand)",fontFamily:"var(--font-mono)",fontSize:9,fontWeight:600,letterSpacing:"0.06em",textTransform:"uppercase"}}>New</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{padding:"18px 32px",borderTop:"1px solid var(--rule)",display:"flex",justifyContent:"flex-end",gap:10,background:"var(--paper-alt)"}}>
                <button onClick={cancelWiseImport} style={{...mkBtn("transparent","var(--ink-soft)"),border:"1px solid var(--rule)",padding:"9px 18px",fontSize:12}}>Cancel</button>
                <button onClick={confirmWiseImport} disabled={selCount===0} style={{...mkBtn(selCount===0?"var(--paper-alt)":"var(--brand)",selCount===0?"var(--ink-mute)":"var(--paper)"),border:`1px solid ${selCount===0?"var(--rule)":"var(--brand)"}`,padding:"9px 20px",fontSize:12,fontWeight:500,cursor:selCount===0?"default":"pointer"}}>
                  Import {selCount} student{selCount!==1?"s":""}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* HEADER — editorial wordmark + refined action rail */}
      <div data-psm-header style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",flexShrink:0,gap:24}}>
        <div data-psm-brand style={{display:"flex",alignItems:"center",gap:16}}>
          <img src="ats_logo.png" alt="ATS" data-psm-logo/>
          <div style={{display:"flex",flexDirection:"column"}}>
            <div data-psm-eyebrow>Affordable Tutoring Solutions · Est. 2023</div>
            <div data-psm-title>SAT Student <em>Portal</em></div>
          </div>
        </div>
        <div data-psm-actions style={{display:"flex",alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}>
          {/* Session 18C: SAT/PSAT toggle removed — only SAT supported now. */}
          <a href="https://tutor.thesatcrashcourse.com/" target="_blank" rel="noopener noreferrer">WellEd</a>
          <a href="https://ats.wise.live/get-started" target="_blank" rel="noopener noreferrer">Wise</a>
          <span data-psm-chip title="Enrolled students" style={{padding:"6px 10px",border:"1px solid var(--rule)",borderRadius:999,color:"var(--ink-soft)"}}>{visibleStudents.length.toString().padStart(2,"0")} students</span>
          <span data-psm-chip title="Total assigned worksheets" style={{padding:"6px 10px",border:"1px solid var(--rule)",borderRadius:999,color:"var(--ink-soft)"}}>{visibleStudents.reduce((n,st)=>n+(st.assignments||[]).reduce((m,a)=>m+(a.worksheets||[]).length,0),0)} assigned</span>
          <span data-psm-chip title={cloudStatus==="synced"?"Cloud synced — all tutors see changes in real-time":cloudStatus==="connecting"?"Connecting to cloud...":"Offline — changes saved locally"} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"6px 10px",border:"1px solid var(--rule)",borderRadius:999,color:cloudStatus==="synced"?"var(--ok)":cloudStatus==="connecting"?"var(--warn)":"var(--danger)"}}>
            <span style={{width:6,height:6,borderRadius:"50%",background:"currentColor"}}/>
            {cloudStatus==="synced"?"Synced":cloudStatus==="connecting"?"Syncing":"Offline"}
          </span>
          <button onClick={()=>setSearchOpen(true)} title="Search everything (⌘K)" style={{display:"inline-flex",alignItems:"center",gap:7}}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
            Search
            <span style={{fontFamily:"var(--font-mono)",fontSize:9,opacity:.6,letterSpacing:0,marginLeft:2}}>⌘K</span>
          </button>
          <button onClick={exportData} title="Export data">Export</button>
          <label title="Import data" style={{cursor:"pointer"}}>
            Import
            <input type="file" accept="application/json" onChange={importData} style={{display:"none"}}/>
          </label>
          {/* Session 18C: full API sync — pull all SAT students from
              Wise, auto-add to allowlist, soft-delete non-SAT students
              that were previously synced. Two-phase: preview → confirm. */}
          <button onClick={async()=>{
            if(!window.firebase || !window.firebase.app){ alert("Firebase not loaded"); return; }
            setWiseSync({loading:true});
            try{
              const fn = window.firebase.app().functions("us-central1").httpsCallable("syncStudentsFromWise");
              const result = await fn({dryRun:true});
              setWiseSync(result.data || {error:"empty response"});
            }catch(e){
              console.warn("[wise-sync] preview failed:", e);
              setWiseSync(null);
              alert("Wise sync preview failed: " + (e.message||e));
            }
          }} title="Pull all SAT students from Wise via API. Adds new ones, updates wise-metadata on existing (preserves all your scores/assignments), trashes ones no longer in a SAT class. Admin-only. Preview first." style={{cursor:"pointer",background:"none",border:"none",font:"inherit",color:"inherit",padding:0,fontWeight:600}}>
            Sync from Wise API
          </button>
          {/* Session 18C v11: broadcast an announcement to every active
              SAT student's wise class. Admin-only. Defaults to the
              "use the central portal link" message so old deep-links
              can be retired gracefully. */}
          <button onClick={()=> setBroadcastOpen(true)} title="Post a Wise discussion to every active SAT student. Useful for portal/url announcements. Admin-only." style={{cursor:"pointer",background:"none",border:"none",font:"inherit",color:"inherit",padding:0,fontWeight:600}}>
            Broadcast to SAT students
          </button>
          <div data-psm-user title={authUser.email} style={{
            display:"inline-flex",alignItems:"center",gap:8,
            padding:"4px 4px 4px 12px",border:"1px solid var(--rule)",borderRadius:999,
            marginLeft:4
          }}>
            <span style={{
              fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 48",
              fontSize:12,fontWeight:500,color:"var(--ink)",letterSpacing:"-0.005em",
              maxWidth:140,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"
            }}>{(authUser.displayName||authUser.email||"").split(" ")[0]||authUser.email}</span>
            {authUser.photoURL ? (
              <img src={authUser.photoURL} alt="" referrerPolicy="no-referrer" style={{
                width:24,height:24,borderRadius:"50%",
                boxShadow:"0 0 0 1px var(--rule-strong)"
              }}/>
            ) : (
              <span style={{
                width:24,height:24,borderRadius:"50%",background:"var(--brand-soft)",
                color:"var(--brand-dark)",display:"inline-flex",alignItems:"center",
                justifyContent:"center",fontSize:11,fontWeight:600,fontFamily:"var(--font-body)"
              }}>{(authUser.displayName||authUser.email||"?").charAt(0).toUpperCase()}</span>
            )}
            <button onClick={onSignOut} title="Sign out" aria-label="Sign out" style={{
              border:"none !important",background:"transparent !important",
              padding:"4px 8px 4px 2px",cursor:"pointer",color:"var(--ink-mute)",
              display:"inline-flex",alignItems:"center"
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                <path d="M10 5l3 3-3 3M13 8H6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* TABS — editorial nav with serif labels */}
      <div data-psm-tabs style={{display:"flex",flexShrink:0}}>
        {[
          {id:"generator",label:"Generator"},
          {id:"students",label:"Students"},
          {id:"heatmap",label:"Heat Map"},
          {id:"scores",label:"Score Tracking"},
          {id:"trash",label:"Trash"},
          ...(isAdmin ? [{id:"admins",label:"Admins"}] : []),
        ].map(t=>(
          <button key={t.id} data-active={tab===t.id} onClick={()=>{if(t.id!=="students")setProfile(null);setTab(t.id);}} style={{border:"none",background:"none",cursor:"pointer",position:"relative"}}>
            {t.label}
            {t.id==="trash"&&trashCount>0&&<span style={{marginLeft:8,padding:"1px 7px",borderRadius:999,background:"var(--accent-soft)",color:"var(--accent)",fontFamily:"var(--font-mono)",fontSize:9,fontWeight:600,verticalAlign:"middle"}}>{trashCount}</span>}
          </button>
        ))}
      </div>

      {/* BODY */}
      <div data-psm-body style={{flex:1,overflowY:"auto"}}>
        {tab==="generator"&&<GeneratorTab {...{
          students:visibleStudents,curStudent,selSt,setSelSt,openProfile,
          subjF,setSubjF,domF,setDomF,sdomF,setSdomF,diffF,setDiffF,srch,setSrch,
          availDoms,availSdoms,grouped,
          chk,setChk,evenOdd,setEvenOdd,weChk,setWeChk,vocabChk,setVocabChk,
          timeDrill,setTimeDrill,timeLims,setTimeLims,oneNote,setOneNote,
          weDomEn,setWeDomEn,vocabEn,setVocabEn,
          addBB,setAddBB,bbType,setBbType,bbCnt,setBbCnt,bbMode,setBbMode,bbPicks,setBbPicks,
          addWE,setAddWE,weType,setWeType,weCnt,setWeCnt,weMode,setWeMode,wePicks,setWePicks,
          selWS,selWeDom,selVocab,totalQs,examType,
          generate,output,copyOut,copyRichOut,downloadPdf,copied,
          lastAssignedDate,
          customAssignments,setCustomAssignments,showToast,
        }}/>}

        {tab==="students"&&!profile&&<StudentsList {...{students:visibleStudents,showAdd,setShowAdd,newS,setNewS,addStudent,openProfile,delStudent}}/>}

        {tab==="students"&&profile&&p&&<StudentProfile {...{p,setProfile,ptab,setPtab,
          paChk,setPaChk,paSubj,setPaSubj,paSrch,setPaSrch,savePreAssign,
          paDate,setPaDate,paWeChk,setPaWeChk,paBBPicks,setPaBBPicks,paWEPicks,setPaWEPicks,
          sfm,setSfm,addScore,delScore,delAsg,delWs,addWs,setExamScore,setWelledDomainScore,
          addWelledLog,delWelledLog,
          handleDiagUpload,clearDiagnostics,diagInputRef,diagProfile,showToast,
          students,setStudents,examType,
          handleWelledUpload,welledInputRef,
          customAssignments,setCustomAssignments,
        }}/>}

        {tab==="heatmap"&&<HeatMapTab {...{students:visibleStudents,openProfile}}/>}

        {tab==="scores"&&<ScoresTab {...{students:visibleStudents,openProfile}}/>}

        {tab==="trash"&&<TrashTab {...{students,restoreStudent,purgeStudent,restoreSubItem,purgeSubItem,emptyTrash,trashCount}}/>}

        {tab==="admins"&&isAdmin&&<AdminsTab {...{currentUserEntry, students:visibleStudents, showToast}}/>}
      </div>

      <div style={{background:B1,color:"#64748b",padding:"10px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:11,flexShrink:0}}>
        <span style={{fontWeight:700,color:"#94a3b8"}}>Affordable Tutoring Solutions Inc.</span>
        <span>Support: Aidan Meyers · ameyers@affordabletutoringsolutions.org · (321) 341-9820</span>
      </div>
    </div>
  );
}

/* ============ EXAM CHIP PICKER ============ */
// Renders a grid of clickable test-number chips. Used tests show a ✓ mark but
// stay clickable so tutors can assign re-dos. Shared by the Generator tab's
// Practice Exams card and the Student Profile pre-assign panel.
function ExamChipPicker({all, used, picks, setPicks, accent, accentSoft, accentBorder}){
  const pickSet = new Set(picks);
  const toggle = (n)=>{
    if(pickSet.has(n)) setPicks(picks.filter(x=>x!==n));
    else setPicks([...picks, n].sort((a,b)=>a-b));
  };
  return (
    <div>
      <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
        {all.map(n=>{
          const isPicked = pickSet.has(n);
          const isUsed = used.has(n);
          return (
            <button
              key={n}
              type="button"
              onClick={()=>toggle(n)}
              title={isUsed ? `Test ${n} — already assigned` : `Test ${n}`}
              style={{
                minWidth: 28, height: 24, padding: "0 6px", fontSize: 10, fontWeight: 700,
                fontFamily: "'IBM Plex Mono',monospace",
                borderRadius: 3, cursor: "pointer",
                background: isPicked ? accent : (isUsed ? "#fef3c7" : "#FAF7F2"),
                color: isPicked ? "#FAF7F2" : (isUsed ? "#a16207" : "#66708A"),
                border: `1px solid ${isPicked ? accentBorder : (isUsed ? "#fde68a" : "rgba(15,26,46,.12)")}`,
                transition: "background .15s, color .15s, border-color .15s",
              }}
            >
              {n}{isUsed && !isPicked ? " ✓" : ""}
            </button>
          );
        })}
      </div>
      <div style={{fontSize:9,color:"#66708A",marginTop:5,fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.6}}>
        {picks.length.toString().padStart(2,"0")} SELECTED
        {picks.length>0 ? ` · ${picks.join(", ")}` : ""}
      </div>
    </div>
  );
}

/* ============ GENERATOR TAB ============ */
function GeneratorTab(props){
  const {curStudent,selSt,setSelSt,students,openProfile,
    subjF,setSubjF,domF,setDomF,sdomF,setSdomF,diffF,setDiffF,srch,setSrch,
    availDoms,availSdoms,grouped,
    chk,setChk,evenOdd,setEvenOdd,weChk,setWeChk,vocabChk,setVocabChk,
    timeDrill,setTimeDrill,timeLims,setTimeLims,oneNote,setOneNote,
    weDomEn,setWeDomEn,vocabEn,setVocabEn,
    addBB,setAddBB,bbType,setBbType,bbCnt,setBbCnt,bbMode,setBbMode,bbPicks,setBbPicks,
    addWE,setAddWE,weType,setWeType,weCnt,setWeCnt,weMode,setWeMode,wePicks,setWePicks,
    selWS,selWeDom,selVocab,totalQs,examType,
    generate,output,copyOut,copyRichOut,downloadPdf,copied,lastAssignedDate,
    customAssignments,setCustomAssignments,showToast} = props;

  const[showCustomForm,setShowCustomForm]=useState(false);
  const[customName,setCustomName]=useState("");
  const[customSubj,setCustomSubj]=useState("Reading & Writing");
  const[customQs,setCustomQs]=useState(27);

  const totalSelected = selWS.length + selWeDom.length + selVocab.length + (addBB?1:0) + (addWE?1:0);

  // Most recent non-pre-assigned session for the selected student. Sorted by
  // date desc; ties broken by position in the assignments array (later wins).
  const lastSession = useMemo(()=>{
    if(!curStudent) return null;
    const eligible = (curStudent.assignments||[]).filter(a=>!a.preAssigned && !a.deleted);
    if(!eligible.length) return null;
    const indexed = eligible.map((a,i)=>({a,i}));
    indexed.sort((x,y)=>{
      const d = (y.a.date||"").localeCompare(x.a.date||"");
      return d !== 0 ? d : y.i - x.i;
    });
    return indexed[0].a;
  },[curStudent]);

  const copyLastSession = ()=>{
    if(!lastSession) return;
    if(totalSelected > 0 && !confirm(`Replace your current selection (${totalSelected} item${totalSelected!==1?"s":""}) with ${curStudent.name}'s last session from ${lastSession.date}?`)) return;

    const newChk = {};
    const newEvenOdd = {};
    const newTimeLims = {};
    (lastSession.worksheets||[]).forEach(ws=>{
      newChk[ws.id] = true;
      if(ws.evenOdd) newEvenOdd[ws.id] = ws.evenOdd;
      if(ws.timeLimit) newTimeLims[ws.id] = ws.timeLimit;
    });

    // WellEd Domain — reconstruct deterministic id from subject/domain/difficulty.
    // Custom assignments (missing domain) are skipped; they don't round-trip.
    const newWeChk = {};
    (lastSession.welledDomain||[]).forEach(w=>{
      if(!w.subject || !w.domain || !w.difficulty) return;
      newWeChk[`WED|${w.subject}|${w.domain}|${w.difficulty}`] = true;
    });

    // Vocab — deterministic id from kind/name/variant.
    const newVocabChk = {};
    (lastSession.vocab||[]).forEach(v=>{
      if(v.kind === "vocab_flash") newVocabChk[`VF|${v.name}`] = true;
      else if(v.kind === "vocab_quiz" && v.variant) newVocabChk[`VQ|${v.name}|${v.variant}`] = true;
    });

    // BlueBook / WellEd exam configs from practiceExams.
    const bb = (lastSession.practiceExams||[]).filter(x=>x.platform==="BlueBook");
    const we = (lastSession.practiceExams||[]).filter(x=>x.platform==="WellEd");

    setChk(newChk);
    setEvenOdd(newEvenOdd);
    setTimeLims(newTimeLims);
    setWeChk(newWeChk);
    setVocabChk(newVocabChk);
    setWeDomEn((lastSession.welledDomain||[]).length > 0);
    setVocabEn((lastSession.vocab||[]).length > 0);
    setTimeDrill(!!lastSession.timeDrill);
    setOneNote(!!lastSession.oneNote);
    setAddBB(bb.length > 0);
    if(bb.length > 0){
      setBbType(bb[0].type || "full");
      setBbCnt(bb.length);
      // Copy the exact test numbers so the tutor sees last session's picks.
      setBbMode("specific");
      setBbPicks(bb.map(x=>x.number).filter(n=>typeof n==="number").sort((a,b)=>a-b));
    }
    setAddWE(we.length > 0);
    if(we.length > 0){
      setWeType(we[0].type || "full");
      setWeCnt(we.length);
      setWeMode("specific");
      setWePicks(we.map(x=>x.number).filter(n=>typeof n==="number").sort((a,b)=>a-b));
    }

    showToast(`Copied ${curStudent.name}'s last session (${lastSession.date})`);
  };

  return(
    <div style={{display:"grid",gridTemplateColumns:"275px 1fr 345px",gap:14,minHeight:"calc(100vh - 140px)"}}>
      {/* LEFT SIDEBAR */}
      <div style={{display:"flex",flexDirection:"column",gap:10,paddingRight:2,overflowY:"auto",maxHeight:"calc(100vh - 140px)"}}>
        <div style={{...CARD}}>
          <SH>Assign To</SH>
          <select value={selSt} onChange={e=>setSelSt(e.target.value)} style={INP}>
            <option value="">— No Student —</option>
            {students.map(st=><option key={st.id} value={st.id}>{st.name}</option>)}
          </select>
          {selSt&&<button onClick={()=>openProfile(curStudent)} style={{...mkBtn("transparent",B2),border:"1px solid rgba(0,74,121,.28)",marginTop:10,width:"100%",fontSize:11}}>View Profile →</button>}
          {selSt&&(
            <button
              onClick={copyLastSession}
              disabled={!lastSession}
              title={lastSession?`Copy from ${lastSession.date}`:"No previous sessions for this student"}
              style={{
                ...mkBtn("transparent", lastSession?"#6E3F12":"#94a3b8"),
                border:`1px solid ${lastSession?"rgba(154,91,31,.35)":"rgba(15,26,46,.12)"}`,
                marginTop:6,width:"100%",fontSize:11,
                cursor:lastSession?"pointer":"default",
                opacity:lastSession?1:.6
              }}
            >
              Copy Last Session {lastSession ? `· ${lastSession.date}` : ""}
            </button>
          )}
        </div>

        <div style={{...CARD}}>
          <SH>Filters</SH>
          <div style={{marginBottom:12}}>
            <div style={{fontSize:9,color:"#66708A",marginBottom:6,letterSpacing:1.2,fontWeight:600,fontFamily:"'IBM Plex Mono',monospace"}}>SUBJECT</div>
            <div style={{display:"flex",gap:4}}>
              {["All","Reading & Writing","Math"].map(s=>(
                <button key={s} onClick={()=>{setSubjF(s);setDomF("All");setSdomF("All");}} style={{...mkBtn(subjF===s?B2:"transparent",subjF===s?"#FAF7F2":"#2E3A57"),border:subjF===s?"1px solid "+B2:"1px solid rgba(15,26,46,.15)",padding:"5px 10px",fontSize:11,flex:1}}>
                  {s==="All"?"All":s==="Reading & Writing"?"R&W":"Math"}
                </button>
              ))}
            </div>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:9,color:"#66708A",marginBottom:5,letterSpacing:1.2,fontWeight:600,fontFamily:"'IBM Plex Mono',monospace"}}>DOMAIN</div>
            <select value={domF} onChange={e=>{setDomF(e.target.value);setSdomF("All");}} style={{...INP,fontSize:12}}>
              <option value="All">All Domains</option>
              {availDoms.map(d=><option key={d}>{d}</option>)}
            </select>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:9,color:"#66708A",marginBottom:5,letterSpacing:1.2,fontWeight:600,fontFamily:"'IBM Plex Mono',monospace"}}>SUBSKILL</div>
            <select value={sdomF} onChange={e=>setSdomF(e.target.value)} style={{...INP,fontSize:12}}>
              <option value="All">All Subskills</option>
              {availSdoms.map(d=><option key={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <div style={{fontSize:9,color:"#66708A",marginBottom:6,letterSpacing:1.2,fontWeight:600,fontFamily:"'IBM Plex Mono',monospace"}}>DIFFICULTY</div>
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              {["All","easy","medium","hard","comprehensive"].map(d=>{
                const label = d==="All"?"All Difficulties":d[0].toUpperCase()+d.slice(1);
                const active = diffF===d;
                const accent = d==="All"?B2:DC[d];
                return(
                  <button key={d} onClick={()=>setDiffF(d)} style={{...mkBtn(active?accent:"transparent",active?"#FAF7F2":"#2E3A57"),border:active?"1px solid "+accent:"1px solid rgba(15,26,46,.15)",padding:"6px 12px",fontSize:11,textAlign:"left",fontWeight:active?600:500,display:"flex",alignItems:"center",gap:8}}>
                    {!active&&d!=="All"&&<span style={{width:6,height:6,borderRadius:"50%",background:accent,flexShrink:0}}/>}
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <input placeholder="Search worksheets…" value={srch} onChange={e=>setSrch(e.target.value)} style={{...INP,fontStyle:srch?"normal":"italic",boxShadow:"0 0 0 1px rgba(15,26,46,.05)"}}/>

        {/* TIME DRILL */}
        <div style={{...CARD,background:timeDrill?"#E9F0F6":"#fff",boxShadow:timeDrill?"0 0 0 1px "+B2+", 0 1px 2px rgba(0,74,121,.08)":CARD.boxShadow}}>
          <Toggle on={timeDrill} set={setTimeDrill} label="Time Drilling"/>
          {timeDrill&&<div style={{marginTop:12,padding:12,background:"rgba(255,255,255,.7)",borderRadius:4,fontSize:11,color:"#2E3A57",lineHeight:1.55,border:"1px solid rgba(0,74,121,.15)"}}>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:12,fontWeight:600,color:"#003258",marginBottom:6}}>Instructions</div>
            <div style={{color:"#2E3A57",marginBottom:8}}>Enter time limits in minutes for each selected worksheet. These appear in parentheses before the worksheet names in the assignment. Leave blank to omit.</div>
            <div style={{background:"#FAF7F2",padding:"8px 10px",borderRadius:3,fontSize:10,border:"1px solid rgba(15,26,46,.08)",fontFamily:"'IBM Plex Mono',monospace"}}>
              <div style={{fontWeight:600,marginBottom:3,color:"#003258",letterSpacing:.4}}>REFERENCE TIMING</div>
              <div>Reading &amp; Writing &nbsp;·&nbsp; ~71 sec / question</div>
              <div>Math &nbsp;·&nbsp; ~1 min 35 sec / question</div>
            </div>
          </div>}
        </div>

        {/* ONENOTE */}
        <div style={{...CARD,background:oneNote?"#E9F0F6":"#fff",boxShadow:oneNote?"0 0 0 1px "+B2+", 0 1px 2px rgba(0,74,121,.08)":CARD.boxShadow}}>
          <Toggle on={oneNote} set={setOneNote} label="PSMs on OneNote"/>
          {oneNote&&<div style={{marginTop:12,padding:12,background:"rgba(255,255,255,.7)",borderRadius:4,fontSize:11,color:"#2E3A57",lineHeight:1.55,border:"1px solid rgba(0,74,121,.15)"}}>
            Only answer keys will be included — no student worksheets. Special OneNote instructions are added for students completing work digitally.
          </div>}
        </div>

        {/* WELLED DOMAIN */}
        <div style={{...CARD,background:weDomEn?"#F5ECDF":"#fff",boxShadow:weDomEn?"0 0 0 1px #9A5B1F, 0 1px 2px rgba(154,91,31,.1)":CARD.boxShadow}}>
          <Toggle on={weDomEn} set={setWeDomEn} label="WellEd Domain Assignments"/>
          {weDomEn&&<div style={{marginTop:12}}>
            <div style={{padding:12,background:"rgba(255,255,255,.7)",borderRadius:4,fontSize:11,color:"#6E3F12",lineHeight:1.55,marginBottom:10,border:"1px solid rgba(154,91,31,.18)"}}>
              Select topic-specific assignments. R&amp;W assignments have 27 Qs each; Math have 22 Qs each. PSDA and Geometry only offer Easy and Hard.
            </div>
            <div style={{maxHeight:260,overflowY:"auto",border:"1px solid #d1fae5",borderRadius:6,padding:6}}>
              {WELLED_DOMAIN.map(e=>(
                <div key={e.subject+"|"+e.domain} style={{marginBottom:6}}>
                  <div style={{fontSize:10,fontWeight:800,color:DOMAIN_COLOR[e.domain]||B2,marginBottom:3}}>{e.domain}</div>
                  {e.diffs.map(d=>{
                    const it = WE_DOMAIN_ITEMS.find(x=>x.subject===e.subject&&x.domain===e.domain&&x.difficulty===d);
                    const ck=!!weChk[it.id];
                    const wedAssigned = curStudent && (curStudent.assignments||[]).some(a=>(a.welledDomain||[]).some(w=>w.subject===e.subject&&w.domain===e.domain&&w.difficulty===d));
                    return(
                      <label key={d} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,padding:"3px 6px",cursor:"pointer",background:ck?"#dcfce7":wedAssigned?"#fefce8":"transparent",borderRadius:4,marginBottom:2}}>
                        <input type="checkbox" checked={ck} onChange={()=>setWeChk(prev=>({...prev,[it.id]:!prev[it.id]}))}/>
                        <span style={{color:"#065f46",fontWeight:600}}>{d[0].toUpperCase()+d.slice(1)}</span>
                        {wedAssigned&&<span style={{fontSize:8,fontWeight:800,color:"#a16207",background:"#fef3c7",padding:"1px 5px",borderRadius:3}}>ASSIGNED</span>}
                        <span style={{color:"#94a3b8",marginLeft:"auto"}}>{e.qs}Qs</span>
                      </label>
                    );
                  })}
                </div>
              ))}
              {/* Custom assignments */}
              {customAssignments&&customAssignments.length>0&&<div style={{marginTop:8,borderTop:"1px solid #d1fae5",paddingTop:8}}>
                <div style={{fontSize:10,fontWeight:800,color:"#7c3aed",marginBottom:4}}>CUSTOM ASSIGNMENTS</div>
                {customAssignments.map(ca=>{
                  const caId=`CUSTOM|${ca.id}`;
                  const caCk=!!weChk[caId];
                  return(
                    <label key={ca.id} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,padding:"3px 6px",cursor:"pointer",background:caCk?"#dcfce7":"transparent",borderRadius:4,marginBottom:2}}>
                      <input type="checkbox" checked={caCk} onChange={()=>setWeChk(prev=>({...prev,[caId]:!prev[caId]}))}/>
                      <span style={{color:"#065f46",fontWeight:600}}>{ca.name}</span>
                      <span style={{color:"#94a3b8",marginLeft:"auto"}}>{ca.qs}Qs</span>
                      <button onClick={e=>{e.preventDefault();e.stopPropagation();setCustomAssignments(prev=>prev.filter(x=>x.id!==ca.id));}} style={{background:"none",border:"none",color:"#dc2626",cursor:"pointer",fontSize:10,padding:"0 2px"}}>✕</button>
                    </label>
                  );
                })}
              </div>}
              <div style={{marginTop:8,borderTop:"1px solid #d1fae5",paddingTop:6}}>
                {!showCustomForm ? (
                  <button onClick={()=>setShowCustomForm(true)} style={{...mkBtn("#f0fdf4","#065f46"),padding:"4px 10px",fontSize:10,width:"100%"}}>+ Add Custom Assignment</button>
                ) : (
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    <input placeholder="Assignment name" value={customName} onChange={e=>setCustomName(e.target.value)} style={{...INP,fontSize:11}}/>
                    <div style={{display:"flex",gap:4}}>
                      <select value={customSubj} onChange={e=>{setCustomSubj(e.target.value);setCustomQs(e.target.value==="Math"?22:27);}} style={{...INP,fontSize:11,flex:1}}>
                        <option value="Reading & Writing">R&W</option>
                        <option value="Math">Math</option>
                      </select>
                      <input type="number" min={1} value={customQs} onChange={e=>setCustomQs(Number(e.target.value))} placeholder="Qs" style={{...INP,fontSize:11,width:50,textAlign:"center"}}/>
                    </div>
                    <div style={{display:"flex",gap:4}}>
                      <button onClick={()=>{if(!customName.trim())return;setCustomAssignments(prev=>[...prev,{id:uid(),name:customName.trim(),subject:customSubj,qs:customQs}]);setCustomName("");setShowCustomForm(false);showToast("Custom assignment added");}} style={{...mkBtn("#065f46","#fff"),padding:"4px 10px",fontSize:10,flex:1}}>Save</button>
                      <button onClick={()=>{setShowCustomForm(false);setCustomName("");}} style={{...mkBtn("#f1f5f9","#475569"),padding:"4px 10px",fontSize:10}}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>}
        </div>

        {/* VOCAB */}
        <div style={{...CARD,background:vocabEn?"#EFEAE0":"#fff",boxShadow:vocabEn?"0 0 0 1px #5B4B8A, 0 1px 2px rgba(91,75,138,.08)":CARD.boxShadow}}>
          <Toggle on={vocabEn} set={setVocabEn} label="Vocabulary"/>
          {vocabEn&&<div style={{marginTop:12}}>
            <div style={{padding:12,background:"rgba(255,255,255,.7)",borderRadius:4,fontSize:11,color:"#3A305C",lineHeight:1.55,marginBottom:10,border:"1px solid rgba(91,75,138,.2)"}}>
              Select vocab flashcard sets or quizzes. Each set has 4 quiz variants. Question counts are not tracked for vocab.
            </div>
            <VocabPicker vocabChk={vocabChk} setVocabChk={setVocabChk}/>
          </div>}
        </div>

        {/* PRACTICE EXAMS */}
        {(()=>{
          // Used test numbers per platform for the current student — drives the "already assigned" chip styling.
          const bbUsed = new Set();
          const weUsed = new Set();
          if(curStudent){
            (curStudent.assignments||[]).forEach(a=>(a.practiceExams||[]).forEach(ex=>{
              if(ex.platform==="BlueBook" && typeof ex.number==="number") bbUsed.add(ex.number);
              if(ex.platform==="WellEd"  && typeof ex.number==="number") weUsed.add(ex.number);
            }));
          }
          // Little shared mode-toggle button factory.
          const modeBtn = (active, label, onClick, color)=>(
            <button type="button" onClick={onClick} style={{
              flex:1, padding:"5px 8px", fontSize:10, fontWeight:600, letterSpacing:.4, textTransform:"uppercase",
              fontFamily:"'IBM Plex Sans',system-ui,sans-serif",
              background: active ? color : "transparent",
              color: active ? "#FAF7F2" : "#66708A",
              border: `1px solid ${active ? color : "rgba(15,26,46,.18)"}`,
              borderRadius: 3, cursor:"pointer", transition:"background .15s, color .15s",
            }}>{label}</button>
          );
          return (
            <div style={{...CARD}}>
              <SH>Practice Exams</SH>

              {/* BlueBook */}
              <div style={{padding:12,background:"#F3EEE4",borderRadius:4,marginBottom:10,border:"1px solid rgba(15,26,46,.06)"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:addBB?10:0}}>
                  <span style={{fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:14,fontWeight:600,color:"#003258",letterSpacing:-.05}}>BlueBook</span>
                  <input type="checkbox" checked={addBB} onChange={e=>setAddBB(e.target.checked)} style={{cursor:"pointer",accentColor:B2}}/>
                </div>
                {addBB&&<div>
                  <select value={bbType} onChange={e=>setBbType(e.target.value)} style={{...INP,fontSize:11,marginBottom:6}}>
                    <option value="full">Full Test</option>
                    <option value="section">Section</option>
                  </select>
                  <div style={{display:"flex",gap:4,marginBottom:8}}>
                    {modeBtn(bbMode==="auto","Auto",()=>setBbMode("auto"),"#003258")}
                    {modeBtn(bbMode==="specific","Pick specific",()=>setBbMode("specific"),"#003258")}
                  </div>
                  {bbMode==="auto" ? (
                    <div>
                      <input type="number" min={1} max={BLUEBOOK_PRACTICE_TESTS.length} value={bbCnt} onChange={e=>setBbCnt(Number(e.target.value))} style={{...INP,fontSize:12,textAlign:"center"}}/>
                      {bbUsed.size>0 && (
                        <div style={{display:"flex",flexWrap:"wrap",gap:3,marginTop:6}}>
                          {BLUEBOOK_PRACTICE_TESTS.map(n=>(
                            <span key={n} style={{fontSize:9,padding:"1px 5px",borderRadius:3,fontWeight:700,background:bbUsed.has(n)?"#fef3c7":"#f1f5f9",color:bbUsed.has(n)?"#a16207":"#94a3b8",border:bbUsed.has(n)?"1px solid #fde68a":"1px solid #e2e8f0"}}>{n}{bbUsed.has(n)?" ✓":""}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <ExamChipPicker
                      all={BLUEBOOK_PRACTICE_TESTS}
                      used={bbUsed}
                      picks={bbPicks}
                      setPicks={setBbPicks}
                      accent="#003258"
                      accentBorder="#003258"
                    />
                  )}
                </div>}
              </div>

              {/* WellEd Labs */}
              <div style={{padding:12,background:"#F3EEE4",borderRadius:4,border:"1px solid rgba(15,26,46,.06)"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:addWE?10:0}}>
                  <span style={{fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:14,fontWeight:600,color:"#6E3F12",letterSpacing:-.05}}>WellEd Labs</span>
                  <input type="checkbox" checked={addWE} onChange={e=>setAddWE(e.target.checked)} style={{cursor:"pointer",accentColor:"#9A5B1F"}}/>
                </div>
                {addWE&&<div>
                  <select value={weType} onChange={e=>setWeType(e.target.value)} style={{...INP,fontSize:11,marginBottom:6}}>
                    <option value="full">Full Test</option>
                    <option value="section">Section</option>
                  </select>
                  <div style={{display:"flex",gap:4,marginBottom:8}}>
                    {modeBtn(weMode==="auto","Auto",()=>setWeMode("auto"),"#9A5B1F")}
                    {modeBtn(weMode==="specific","Pick specific",()=>setWeMode("specific"),"#9A5B1F")}
                  </div>
                  {weMode==="auto" ? (
                    <div>
                      <input type="number" min={1} max={WELLED_PRACTICE_TESTS.length} value={weCnt} onChange={e=>setWeCnt(Number(e.target.value))} style={{...INP,fontSize:12,textAlign:"center"}}/>
                      {weUsed.size>0 && (
                        <div style={{display:"flex",flexWrap:"wrap",gap:3,marginTop:6}}>
                          {WELLED_PRACTICE_TESTS.slice(0,20).map(n=>(
                            <span key={n} style={{fontSize:9,padding:"1px 5px",borderRadius:3,fontWeight:700,background:weUsed.has(n)?"#dcfce7":"#f1f5f9",color:weUsed.has(n)?"#065f46":"#94a3b8",border:weUsed.has(n)?"1px solid #86efac":"1px solid #e2e8f0"}}>{n}{weUsed.has(n)?" ✓":""}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <ExamChipPicker
                      all={WELLED_PRACTICE_TESTS}
                      used={weUsed}
                      picks={wePicks}
                      setPicks={setWePicks}
                      accent="#9A5B1F"
                      accentBorder="#9A5B1F"
                    />
                  )}
                </div>}
              </div>
            </div>
          );
        })()}

        {/* LIVE COUNTERS */}
        <div style={{background:totalSelected>0?"#0F1A2E":"#F3EEE4",borderRadius:6,padding:"14px 16px",fontSize:12,color:totalSelected>0?"#FAF7F2":"#66708A",fontWeight:500,boxShadow:totalSelected>0?"0 4px 14px -6px rgba(15,26,46,.3)":"0 0 0 1px rgba(15,26,46,.08)",transition:"background .3s, color .3s"}}>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,letterSpacing:1.4,opacity:.7,marginBottom:8}}>SELECTION</div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:5,fontFamily:"'IBM Plex Mono',monospace"}}>
            <span>Worksheets</span><span>{selWS.length.toString().padStart(2,"0")}</span>
          </div>
          {selWeDom.length>0&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:5,fontFamily:"'IBM Plex Mono',monospace"}}><span>WellEd Domain</span><span>{selWeDom.length.toString().padStart(2,"0")}</span></div>}
          {selVocab.length>0&&<div style={{display:"flex",justifyContent:"space-between",marginBottom:5,fontFamily:"'IBM Plex Mono',monospace"}}><span>Vocab Items</span><span>{selVocab.length.toString().padStart(2,"0")}</span></div>}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:8,marginTop:6,borderTop:"1px solid "+(totalSelected>0?"rgba(250,247,242,.2)":"rgba(15,26,46,.1)"),fontFamily:"'IBM Plex Mono',monospace"}}>
            <span style={{fontSize:9,letterSpacing:1.4,opacity:.7}}>TOTAL QUESTIONS</span>
            <span style={{fontSize:13,fontWeight:600,color:totalSelected>0?"#FAF7F2":"#0F1A2E"}}>{totalQs.toString().padStart(3,"0")}</span>
          </div>
        </div>
      </div>

      {/* MIDDLE: STUDENT SUMMARY (when selected) + WORKSHEET PICKER */}
      <div style={{display:"flex",flexDirection:"column",gap:12,overflow:"hidden",maxHeight:"calc(100vh - 140px)"}}>
      {curStudent && <StudentSummaryCard student={curStudent}/>}
      <div style={{...CARD,display:"flex",flexDirection:"column",overflow:"hidden",flex:1,minHeight:0,padding:20}}>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:16,flexShrink:0,paddingBottom:12,borderBottom:"1px solid rgba(15,26,46,.08)"}}>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:22,fontWeight:600,color:"#0F1A2E",letterSpacing:-.3}}>Worksheets <span style={{fontSize:11,fontWeight:500,color:"#66708A",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.3,marginLeft:8}}>{Object.values(grouped).reduce((n,doms)=>n+Object.values(doms).reduce((m,subs)=>m+Object.values(subs).reduce((k,arr)=>k+arr.length,0),0),0)} shown</span></div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={()=>{const a={};Object.values(grouped).forEach(doms=>Object.values(doms).forEach(subs=>Object.values(subs).forEach(arr=>arr.forEach(ws=>a[ws.id]=true))));setChk(prev=>({...prev,...a}));}} style={{...mkBtn("transparent","#2E3A57"),border:"1px solid rgba(15,26,46,.18)",padding:"5px 14px",fontSize:11}}>Select All</button>
            <button onClick={()=>setChk({})} style={{...mkBtn("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.3)",padding:"5px 14px",fontSize:11}}>Clear</button>
          </div>
        </div>
        <div style={{overflowY:"auto",flex:1}}>
          {Object.keys(grouped).length===0&&<div style={{color:"#94a3b8",textAlign:"center",paddingTop:40,fontSize:13}}>No worksheets match filters.</div>}
          {Object.entries(grouped).map(([subj,doms])=>{
            const sc = SUBJ_COLOR[subj]||{bg:"#F3EEE4",fg:"#2E3A57",accent:B2};
            return(
              <div key={subj} style={{marginBottom:24}}>
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12,paddingBottom:6,borderBottom:"1px solid rgba(15,26,46,.1)"}}>
                  <div style={{width:3,height:18,background:sc.accent}}/>
                  <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:15,fontWeight:600,color:sc.fg,letterSpacing:-.15}}>{subj}</div>
                </div>
                {Object.entries(doms).map(([dom,subs])=>(
                  <div key={dom} style={{marginBottom:16,marginLeft:4}}>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,fontWeight:600,color:DOMAIN_COLOR[dom]||B2,padding:"3px 0",marginBottom:8,letterSpacing:1,textTransform:"uppercase"}}>{dom}</div>
                    {Object.entries(subs).sort((a,b)=>{const ac=a[0].startsWith("Comprehensive ")?0:1;const bc=b[0].startsWith("Comprehensive ")?0:1;return ac-bc||a[0].localeCompare(b[0]);}).map(([sub,arr])=>(
                      <div key={sub} style={{marginBottom:10,marginLeft:4}}>
                        <div style={{fontSize:12,fontWeight:500,color:"#2E3A57",letterSpacing:.1,marginBottom:5,fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}}>{sub}</div>
                        {arr.map(ws=>{
                          const ck=!!chk[ws.id];
                          const cnt=curStudent?.assignments?.reduce((n,a)=>n+(a.worksheets||[]).filter(w=>(w.id||w.title)===(ws.id)||w.title===ws.title).length,0)||0;
                          const lastDate = curStudent?lastAssignedDate(curStudent,ws.id):null;
                          return(
                            <div key={ws.id} onClick={()=>setChk(prev=>({...prev,[ws.id]:!prev[ws.id]}))} style={{display:"flex",alignItems:"center",padding:"8px 12px",cursor:"pointer",borderRadius:4,marginBottom:2,background:ck?"#E9F0F6":"transparent",boxShadow:ck?"inset 0 0 0 1px "+B2:"none",transition:"background .15s"}}>
                              <input type="checkbox" checked={ck} onChange={()=>{}} onClick={e=>{e.stopPropagation();setChk(prev=>({...prev,[ws.id]:!prev[ws.id]}));}} style={{marginRight:11,cursor:"pointer",accentColor:B2}}/>
                              <div style={{flex:1,minWidth:0}}>
                                <div style={{fontSize:13,fontWeight:ck?600:400,color:"#0F1A2E",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}}>
                                  {ws.title}
                                  {lastDate&&<span style={{fontSize:8,color:"#FAF7F2",background:"#8C2E2E",padding:"2px 7px",borderRadius:2,marginLeft:8,fontWeight:600,letterSpacing:.5,fontFamily:"'IBM Plex Mono',monospace",textTransform:"uppercase"}}>Assigned {lastDate}</span>}
                                </div>
                              </div>
                              {ws.qs>0&&<span style={{...mkPill("transparent","#003258"),marginRight:6,border:"1px solid rgba(0,50,88,.2)"}}>{ws.qs}Q</span>}
                              {cnt>0&&<span style={{...mkPill("transparent","#A9761B"),marginRight:6,flexShrink:0,border:"1px solid rgba(169,118,27,.35)"}}>×{cnt}</span>}
                              <span style={{...mkPill(DC[ws.difficulty]+"18",DC[ws.difficulty]),flexShrink:0,border:"1px solid "+DC[ws.difficulty]+"44"}}>{ws.difficulty}</span>
                              {ck&&<select value={evenOdd[ws.id]||""} onChange={e=>{e.stopPropagation();setEvenOdd(prev=>({...prev,[ws.id]:e.target.value}));}} onClick={e=>e.stopPropagation()} style={{marginLeft:8,fontSize:10,padding:"3px 5px",border:"1px solid rgba(15,26,46,.18)",borderRadius:3,background:"#fff",fontFamily:"'IBM Plex Mono',monospace"}}>
                                <option value="">All</option>
                                <option value="EVEN">Even</option>
                                <option value="ODD">Odd</option>
                              </select>}
                              {timeDrill&&ck&&<input type="number" placeholder="min" min={1} max={120} value={timeLims[ws.id]||""} onChange={e=>{e.stopPropagation();setTimeLims(prev=>({...prev,[ws.id]:e.target.value}));}} onClick={e=>e.stopPropagation()} style={{width:50,marginLeft:8,border:"1px solid "+B2,borderRadius:3,padding:"3px 6px",fontSize:11,outline:"none",fontFamily:"'IBM Plex Mono',monospace"}}/>}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      </div>

      {/* RIGHT: OUTPUT */}
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <button onClick={generate} style={{...mkBtn(B2,"#FAF7F2"),padding:"14px 20px",fontSize:13,fontWeight:600,letterSpacing:.4,textTransform:"uppercase",boxShadow:"0 4px 14px -4px rgba(0,50,88,.45), inset 0 1px 0 rgba(255,255,255,.1)"}}>Generate Assignment →</button>
        <div style={{...CARD,flex:1,display:"flex",flexDirection:"column",padding:20}}>
          <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:14,flexShrink:0,flexWrap:"wrap",gap:8,paddingBottom:12,borderBottom:"1px solid rgba(15,26,46,.08)"}}>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:22,fontWeight:600,color:"#0F1A2E",letterSpacing:-.3}}>Output</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              <button onClick={copyRichOut} disabled={!output} title="Copy with bold formatting preserved" style={{...mkBtn(copied?"#4C7A4C":"transparent",copied?"#FAF7F2":"#003258"),border:"1px solid "+(copied?"#4C7A4C":"rgba(0,50,88,.3)"),padding:"5px 12px",fontSize:11,opacity:!output?.45:1}}>{copied?"✓ Copied":"Copy Rich"}</button>
              <button onClick={copyOut} disabled={!output} title="Copy plain text with asterisks" style={{...mkBtn("transparent","#2E3A57"),border:"1px solid rgba(15,26,46,.18)",padding:"5px 12px",fontSize:11,opacity:!output?.45:1}}>Plain</button>
              <button onClick={downloadPdf} disabled={!output} title="Download as PDF" style={{...mkBtn("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.3)",padding:"5px 12px",fontSize:11,opacity:!output?.45:1}}>PDF</button>
            </div>
          </div>
          {output ? (
            <div style={{flex:1,border:"1px solid rgba(15,26,46,.12)",borderRadius:4,padding:18,fontSize:12,color:"#0F1A2E",background:"#FDFBF6",lineHeight:1.65,minHeight:260,overflowY:"auto",fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}} dangerouslySetInnerHTML={{__html: mdBoldToHtml(output)}}/>
          ) : (
            <div style={{flex:1,border:"1.5px solid #e2e8f0",borderRadius:8,padding:14,fontSize:12,color:"#94a3b8",background:"#f8fafc",minHeight:260,display:"flex",alignItems:"center",justifyContent:"center"}}>Generate an assignment to see output here…</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============ STUDENT SUMMARY CARD (Generator) ============ */
function StudentSummaryCard({student}){
  const counts = buildHeatCounts(student);
  const diagProfile = useMemo(()=>student.diagnostics?.length?buildDiagnosticProfile(student.diagnostics):null,[student]);
  const lastAsg = [...(student.assignments||[])].reverse().find(a=>!a.preAssigned) || [...(student.assignments||[])].reverse()[0];
  const allAsg = (student.assignments||[]);
  // Latest practice exam score
  let latestPractice = null;
  allAsg.forEach(a=>(a.practiceExams||[]).forEach(ex=>{
    if(ex.score && (!latestPractice || (a.date||"")>=latestPractice.date)){
      latestPractice = {date:a.date,platform:ex.platform,number:ex.number,score:ex.score,type:ex.type};
    }
  }));

  // Recent score breakdown — most recent data point per domain and per subdomain
  // Session 18A: include graded submissions so the breakdown reflects portal grading.
  const {submissions: summarySubmissions} = useTutorSubmissions(student?.id);
  const scorePts = useMemo(()=>allScoreDataPoints(student, summarySubmissions),[student, summarySubmissions]);
  const latestDomainByKey = useMemo(()=>{
    const m = {};
    scorePts.forEach(pt=>{
      if(pt.level==="domain" || pt.source==="history_welled"){
        const key = pt.subcategory;
        if(!m[key] || (pt.date||"")>(m[key].date||"")) m[key] = pt;
      }
    });
    return m;
  },[scorePts]);
  const latestSubByKey = useMemo(()=>{
    const m = {};
    scorePts.forEach(pt=>{
      if(pt.level==="sub"){
        const key = pt.subcategory;
        if(!m[key] || (pt.date||"")>(m[key].date||"")) m[key] = pt;
      }
    });
    return m;
  },[scorePts]);
  const domainRows = Object.values(latestDomainByKey).sort((a,b)=>{
    const ap = a.max?Math.round((a.score/a.max)*100):(a.pct||0);
    const bp = b.max?Math.round((b.score/b.max)*100):(b.pct||0);
    return ap-bp;
  });
  const subRows = Object.values(latestSubByKey).sort((a,b)=>{
    const ap = a.max?Math.round((a.score/a.max)*100):(a.pct||0);
    const bp = b.max?Math.round((b.score/b.max)*100):(b.pct||0);
    return ap-bp;
  }).slice(0,6);

  const eyebrow = {fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",textTransform:"uppercase",letterSpacing:1.2,marginBottom:8};
  const hairline = {marginTop:14,paddingTop:14,borderTop:"1px solid rgba(15,26,46,.08)"};

  return(
    <div style={{...CARD,padding:18,background:"#fff"}}>
      <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16,paddingBottom:14,borderBottom:"1px solid rgba(15,26,46,.08)"}}>
        <div style={{width:44,height:44,borderRadius:4,background:B2,color:"#FAF7F2",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontWeight:600,fontSize:20,flexShrink:0,boxShadow:"0 2px 8px -4px rgba(0,74,121,.5)"}}>{student.name.charAt(0).toUpperCase()}</div>
        <div>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:20,fontWeight:600,color:"#0F1A2E",letterSpacing:-.3,lineHeight:1.1}}>{student.name}</div>
          <div style={{fontSize:10,color:"#66708A",fontStyle:"italic",marginTop:2}}>Quick reference while assigning</div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
          {diagProfile?.totalLower!=null && <span style={{...mkPill("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.3)"}}>Diag {diagProfile.totalLower}–{diagProfile.totalUpper}</span>}
          {latestPractice && <span style={{...mkPill("transparent","#003258"),border:"1px solid rgba(0,50,88,.28)"}}>Last {latestPractice.score}</span>}
          <span style={{...mkPill("transparent","#2E3A57"),border:"1px solid rgba(15,26,46,.18)"}}>{allAsg.length} session{allAsg.length!==1?"s":""}</span>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        {/* Left: mini heat map (worksheets+WellEd) */}
        <div>
          <div style={eyebrow}>Coverage · Worksheets + WellEd</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4}}>
            {ALL_DOMAINS.map(d=>{
              const total = DIFFS.reduce((n,diff)=>n+(counts[`${d}|${diff}`]||0),0);
              const short = d.replace(/Problem-Solving & Data Analysis/,"PSDA").replace(/Standard English Conventions/,"SEC").replace(/Information & Ideas/,"Info").replace(/Craft & Structure/,"C&S").replace(/Expression of Ideas/,"EOI").replace(/Advanced Math/,"Adv Math").replace(/Geometry & Trigonometry/,"Geo");
              const hot = total>=3;
              return(
                <div key={d} title={`${d}: ${total}`} style={{background:heatCellColor(total),borderRadius:3,padding:"6px 4px",textAlign:"center",border:"1px solid "+(total>0?"transparent":"rgba(15,26,46,.08)")}}>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:8,color:hot?"#FAF7F2":"#66708A",fontWeight:500,lineHeight:1,letterSpacing:.3}}>{short}</div>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:15,fontWeight:600,color:hot?"#FAF7F2":total>0?"#0F1A2E":"rgba(15,26,46,.25)",marginTop:2,fontVariantNumeric:"tabular-nums"}}>{total||"·"}</div>
                </div>
              );
            })}
          </div>
        </div>
        {/* Right: diagnostic weakest areas */}
        <div>
          <div style={eyebrow}>Diagnostic · Weakest Areas</div>
          {diagProfile?.subs?.length ? (
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              {[...diagProfile.subs].sort((a,b)=>(a.pct||0)-(b.pct||0)).slice(0,4).map(s=>(
                <div key={s.domain+s.name} style={{display:"flex",alignItems:"center",gap:8,fontSize:10}}>
                  <div style={{width:38,height:18,background:heatColorPct(s.pct),color:"#FAF7F2",borderRadius:2,fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,letterSpacing:.2}}>{s.pct}%</div>
                  <div style={{flex:1,color:"#2E3A57",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{fontSize:10,color:"#66708A",fontStyle:"italic"}}>No diagnostic uploaded yet</div>
          )}
        </div>
      </div>

      {/* Recent score breakdown by domain/subdomain */}
      {(domainRows.length>0 || subRows.length>0) && <div style={hairline}>
        <div style={eyebrow}>Recent Score Breakdown · latest per area</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
          <div>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:10,fontStyle:"italic",color:"#66708A",marginBottom:6}}>By Domain</div>
            {domainRows.length===0 ? <div style={{fontSize:10,color:"#66708A",fontStyle:"italic"}}>No domain scores yet</div> : (
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {domainRows.slice(0,6).map(pt=>{
                  const pct = pt.max?Math.round((pt.score/pt.max)*100):(pt.pct||0);
                  const label = pt.subcategory.replace(/^(Math|Reading & Writing) — /,"").replace(/\s*\(easy\)/i," (E)").replace(/\s*\(medium\)/i," (M)").replace(/\s*\(hard\)/i," (H)").replace(/\s*\(comprehensive\)/i," (C)");
                  return(
                    <div key={pt.subcategory} style={{display:"flex",alignItems:"center",gap:8,fontSize:10}}>
                      <div style={{width:38,height:18,background:heatColorPct(pct),color:"#FAF7F2",borderRadius:2,fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,letterSpacing:.2}}>{pct}%</div>
                      <div style={{flex:1,color:"#2E3A57",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={`${pt.subcategory} · ${pt.score}${pt.max?"/"+pt.max:""} · ${pt.date||""}`}>{label}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:10,fontStyle:"italic",color:"#66708A",marginBottom:6}}>Weakest Subskills</div>
            {subRows.length===0 ? <div style={{fontSize:10,color:"#66708A",fontStyle:"italic"}}>No subskill scores yet</div> : (
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {subRows.map(pt=>{
                  const pct = pt.max?Math.round((pt.score/pt.max)*100):(pt.pct||0);
                  const name = pt.subcategory.split(" — ").pop();
                  return(
                    <div key={pt.subcategory} style={{display:"flex",alignItems:"center",gap:8,fontSize:10}}>
                      <div style={{width:38,height:18,background:heatColorPct(pct),color:"#FAF7F2",borderRadius:2,fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,letterSpacing:.2}}>{pct}%</div>
                      <div style={{flex:1,color:"#2E3A57",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={`${pt.subcategory} · ${pt.score}${pt.max?"/"+pt.max:""} · ${pt.date||""}`}>{name}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>}

      {/* Last PSM set */}
      {lastAsg && <div style={hairline}>
        <div style={eyebrow}>Last PSM Set · {lastAsg.date}</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
          {(lastAsg.worksheets||[]).slice(0,6).map((w,i)=>(
            <span key={i} style={{background:"#FAF7F2",border:"1px solid rgba(15,26,46,.12)",borderRadius:2,padding:"3px 8px",fontSize:10,color:"#2E3A57",fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}}>{w.title}</span>
          ))}
          {(lastAsg.worksheets||[]).length>6 && <span style={{fontSize:10,color:"#66708A",fontStyle:"italic",padding:"3px 4px"}}>+{lastAsg.worksheets.length-6} more</span>}
          {(lastAsg.welledDomain||[]).map((w,i)=>(
            <span key={`w${i}`} style={{background:"#F5ECDF",border:"1px solid rgba(154,91,31,.25)",color:"#6E3F12",borderRadius:2,padding:"3px 8px",fontSize:10,fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}}>{w.label}</span>
          ))}
          {(lastAsg.practiceExams||[]).map((ex,i)=>(
            <span key={`p${i}`} style={{background:"#E9F0F6",border:"1px solid rgba(0,74,121,.25)",color:"#003258",borderRadius:2,padding:"3px 8px",fontSize:10,fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}}>{ex.platform} #{ex.number}</span>
          ))}
        </div>
      </div>}
    </div>
  );
}

function VocabPicker({vocabChk,setVocabChk}){
  const[search,setSearch]=useState("");
  const[show,setShow]=useState({}); // show quizzes for set
  const sets = useMemo(()=>VOCAB_SETS.filter(n=>n.toLowerCase().includes(search.toLowerCase())),[search]);
  return(
    <div>
      <input placeholder="Search vocab sets…" value={search} onChange={e=>setSearch(e.target.value)} style={{...INP,fontSize:11,marginBottom:8,fontStyle:search?"normal":"italic"}}/>
      <div style={{maxHeight:240,overflowY:"auto",border:"1px solid rgba(91,75,138,.22)",borderRadius:4,padding:6,background:"rgba(255,255,255,.5)"}}>
        {sets.map(name=>{
          const flashId = `VF|${name}`;
          const expanded = show[name];
          return(
            <div key={name} style={{marginBottom:4,background:expanded?"rgba(91,75,138,.06)":"transparent",borderRadius:3,padding:"5px 6px"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,fontSize:11}}>
                <input type="checkbox" checked={!!vocabChk[flashId]} onChange={()=>setVocabChk(prev=>({...prev,[flashId]:!prev[flashId]}))} style={{accentColor:"#5B4B8A"}}/>
                <span style={{flex:1,fontWeight:500,color:"#0F1A2E"}}>{name}</span>
                <button onClick={()=>setShow(prev=>({...prev,[name]:!prev[name]}))} style={{background:"transparent",border:"1px solid rgba(91,75,138,.35)",borderRadius:2,padding:"2px 8px",fontSize:9,color:"#5B4B8A",cursor:"pointer",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.4,textTransform:"uppercase",fontWeight:500}}>{expanded?"Hide":"Quiz"}</button>
              </div>
              {expanded&&<div style={{display:"flex",gap:4,marginTop:6,marginLeft:22}}>
                {[1,2,3,4].map(v=>{
                  const qid = `VQ|${name}|${v}`;
                  const ck=!!vocabChk[qid];
                  return <button key={v} onClick={()=>setVocabChk(prev=>({...prev,[qid]:!prev[qid]}))} style={{background:ck?"#5B4B8A":"transparent",color:ck?"#FAF7F2":"#5B4B8A",border:"1px solid "+(ck?"#5B4B8A":"rgba(91,75,138,.35)"),borderRadius:2,padding:"3px 12px",fontSize:10,fontWeight:500,cursor:"pointer",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.3}}>Q{v}</button>;
                })}
              </div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============ STUDENTS LIST ============ */
function StudentsList({students,showAdd,setShowAdd,newS,setNewS,addStudent,openProfile,delStudent}){
  const thStyle = {padding:"12px 16px",textAlign:"left",fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,letterSpacing:1.2,textTransform:"uppercase",color:"#66708A",borderBottom:"1px solid rgba(15,26,46,.15)"};
  return(
    <div>
      <div style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",marginBottom:24,paddingBottom:16,borderBottom:"1px solid rgba(15,26,46,.1)"}}>
        <div>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,fontWeight:600,letterSpacing:1.4,color:"#66708A",textTransform:"uppercase",marginBottom:6}}>Roster</div>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 144',fontSize:34,fontWeight:600,color:"#0F1A2E",letterSpacing:-.6,lineHeight:1}}>Students</div>
        </div>
        <button onClick={()=>setShowAdd(!showAdd)} style={{...mkBtn(B2,"#FAF7F2"),padding:"10px 18px",fontSize:12,fontWeight:600,letterSpacing:.3,textTransform:"uppercase",boxShadow:"0 4px 14px -4px rgba(0,50,88,.4)"}}>{showAdd?"Cancel":"+ New Student"}</button>
      </div>
      {showAdd&&(
        <div style={{...CARD,maxWidth:640,marginBottom:24,padding:24}}>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:20,fontWeight:600,color:"#0F1A2E",marginBottom:16,letterSpacing:-.3}}>New Student</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:18}}>
            {[["name","Student Name *","e.g. Jane Smith"],["grade","Grade Level","e.g. 11th"],["tutor","Assigned Tutor","Tutor name"],["notes","Notes","Optional info"]].map(([k,label,ph])=>(
              <div key={k}>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",marginBottom:5,fontWeight:600,letterSpacing:1.2,textTransform:"uppercase"}}>{label}</div>
                <input value={newS[k]} onChange={e=>setNewS(prev=>({...prev,[k]:e.target.value}))} placeholder={ph} style={INP}/>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={addStudent} style={{...mkBtn(B2,"#FAF7F2"),padding:"8px 18px",fontSize:12,fontWeight:600,letterSpacing:.3,textTransform:"uppercase"}}>Add Student</button>
            <button onClick={()=>setShowAdd(false)} style={{...mkBtn("transparent","#2E3A57"),border:"1px solid rgba(15,26,46,.18)",padding:"8px 18px",fontSize:12}}>Cancel</button>
          </div>
        </div>
      )}
      {students.length===0?(
        <div style={{...CARD,padding:"72px 40px",textAlign:"center"}}>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 144',fontStyle:"italic",fontSize:22,fontWeight:400,color:"#66708A",letterSpacing:-.2,marginBottom:8}}>No students enrolled yet.</div>
          <div style={{fontSize:11,color:"#66708A"}}>Click <span style={{fontWeight:600,color:"#0F1A2E"}}>+ New Student</span> to get started.</div>
        </div>
      ):(
        <div style={{...CARD,overflow:"hidden",padding:0}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>{["Name","Grade","Tutor","Enrolled","Worksheets","Diagnostics",""].map(h=><th key={h} style={thStyle}>{h}</th>)}</tr></thead>
            <tbody>
              {students.map((st,i)=>{
                const wsCnt=(st.assignments||[]).reduce((n,a)=>n+(a.worksheets||[]).length,0);
                const dCnt=(st.diagnostics||[]).length;
                return(
                  <tr key={st.id} style={{borderBottom:i===students.length-1?"none":"1px solid rgba(15,26,46,.06)"}}>
                    <td style={{padding:"14px 16px"}}>
                      <div style={{fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:14,fontWeight:600,color:"#0F1A2E",letterSpacing:-.05}}>{st.name}</div>
                    </td>
                    <td style={{padding:"14px 16px",fontSize:12,color:"#2E3A57"}}>{st.grade||<span style={{color:"#66708A"}}>—</span>}</td>
                    <td style={{padding:"14px 16px",fontSize:12,color:"#2E3A57"}}>{st.tutor||<span style={{color:"#66708A"}}>—</span>}</td>
                    <td style={{padding:"14px 16px",fontSize:11,color:"#66708A",fontFamily:"'IBM Plex Mono',monospace"}}>{st.dateAdded}</td>
                    <td style={{padding:"14px 16px"}}><span style={{...mkPill("transparent","#003258"),border:"1px solid rgba(0,50,88,.25)"}}>{wsCnt} sheets</span></td>
                    <td style={{padding:"14px 16px"}}><span style={{...mkPill("transparent",dCnt?"#4C7A4C":"#66708A"),border:"1px solid "+(dCnt?"rgba(76,122,76,.35)":"rgba(15,26,46,.15)")}}>{dCnt} reports</span></td>
                    <td style={{padding:"14px 16px",textAlign:"right"}}><div style={{display:"flex",gap:6,justifyContent:"flex-end"}}><button onClick={()=>openProfile(st)} style={{...mkBtn("transparent",B2),border:"1px solid rgba(0,74,121,.3)",padding:"5px 14px",fontSize:11}}>Profile →</button><button onClick={()=>delStudent(st.id)} title="Remove student" style={{...mkBtn("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.3)",padding:"5px 10px",fontSize:11}}>✕</button></div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============ STUDENT PROFILE ============ */
function StudentProfile({p,setProfile,ptab,setPtab,paChk,setPaChk,paSubj,setPaSubj,paSrch,setPaSrch,savePreAssign,paDate,setPaDate,paWeChk,setPaWeChk,paBBPicks,setPaBBPicks,paWEPicks,setPaWEPicks,sfm,setSfm,addScore,delScore,delAsg,delWs,addWs,setExamScore,setWelledDomainScore,addWelledLog,delWelledLog,handleDiagUpload,clearDiagnostics,diagInputRef,diagProfile,showToast,students,setStudents,examType,handleWelledUpload,welledInputRef,customAssignments,setCustomAssignments}){
  const[editDateId,setEditDateId]=useState(null);
  const[editDateVal,setEditDateVal]=useState("");
  // Session 18A: which assignment's "+ add worksheets" picker is open.
  // Only one at a time. Holds the assignment id.
  const[addWsAsgId,setAddWsAsgId]=useState(null);
  const[addWsSrch,setAddWsSrch]=useState("");
  const[addWsSubj,setAddWsSubj]=useState("All");
  const[addWsPicks,setAddWsPicks]=useState({});  // wsId -> bool
  const paFiltered = useMemo(()=>ALL_WS.filter(ws=>{
    if(paSubj!=="All"&&ws.subject!==paSubj)return false;
    if(paSrch&&!ws.title.toLowerCase().includes(paSrch.toLowerCase()))return false;
    return true;
  }),[paSubj,paSrch]);
  const paGrouped = useMemo(()=>{
    const g={};
    paFiltered.forEach(ws=>{
      const k=`${ws.subject}|${ws.domain}|${ws.subdomain}`;
      if(!g[k])g[k]={subject:ws.subject,domain:ws.domain,subdomain:ws.subdomain,sheets:[]};
      g[k].sheets.push(ws);
    });
    return Object.values(g);
  },[paFiltered]);

  return(
    <div>
      {/* HEADER — editorial masthead for a student profile */}
      <div style={{marginBottom:20,paddingBottom:18,borderBottom:"1px solid rgba(15,26,46,.1)"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,gap:12,flexWrap:"wrap"}}>
          <button onClick={()=>setProfile(null)} style={{...mkBtn("transparent","#66708A"),border:"none",padding:"0",fontSize:11,letterSpacing:.4,textTransform:"uppercase",cursor:"pointer"}}>← Back to Roster</button>
          {/* Session 18B: View as student → opens portal in tutor impersonation mode (read-only) */}
          <a href={`?impersonate=${encodeURIComponent(p.id)}`} target="_blank" rel="noopener noreferrer" title="Open this student's portal in a new tab (read-only)" style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,letterSpacing:.6,textTransform:"uppercase",color:"#0F1A2E",textDecoration:"none",border:"1px solid rgba(15,26,46,.25)",padding:"6px 12px",borderRadius:3,fontWeight:600,background:"#FAF7F2"}}>View as student ↗</a>
        </div>
        <div style={{display:"flex",alignItems:"flex-start",gap:20,flexWrap:"wrap"}}>
          <div style={{width:64,height:64,borderRadius:4,background:B2,display:"flex",alignItems:"center",justifyContent:"center",color:"#FAF7F2",fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 144',fontSize:32,fontWeight:600,flexShrink:0,boxShadow:"0 6px 18px -8px rgba(0,50,88,.5)"}}>{p.name.charAt(0).toUpperCase()}</div>
          <div style={{flex:"1 1 320px",minWidth:0}}>
            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,letterSpacing:1.4,color:"#66708A",textTransform:"uppercase",marginBottom:4}}>Student Profile</div>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 144',fontSize:36,fontWeight:600,color:"#0F1A2E",letterSpacing:-.6,lineHeight:1}}>{p.name}</div>
            <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap"}}>
              {p.grade&&<span style={{...mkPill("transparent","#003258"),border:"1px solid rgba(0,50,88,.28)"}}>Grade {p.grade}</span>}
              {p.tutor&&<span style={{...mkPill("transparent","#4C7A4C"),border:"1px solid rgba(76,122,76,.35)"}}>{p.tutor}</span>}
              <span style={{...mkPill("transparent","#2E3A57"),border:"1px solid rgba(15,26,46,.18)"}}>Since {p.dateAdded}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:0,borderLeft:"1px solid rgba(15,26,46,.1)"}}>
            {[[(p.assignments||[]).reduce((n,a)=>n+(a.worksheets||[]).length,0),"Worksheets"],[(p.diagnostics||[]).length,"Diagnostics"],[(p.assignments||[]).length,"Sessions"]].map(([v,l])=>(
              <div key={l} style={{textAlign:"center",padding:"0 24px",borderRight:"1px solid rgba(15,26,46,.1)"}}>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:30,fontWeight:600,color:"#0F1A2E",letterSpacing:-.4,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{v}</div>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",color:"#66708A",fontSize:9,letterSpacing:1.2,textTransform:"uppercase",marginTop:6,fontWeight:500}}>{l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* SUB-TABS — same editorial treatment as the main tab bar */}
      <div style={{display:"flex",gap:32,marginBottom:24,borderBottom:"1px solid rgba(15,26,46,.12)",flexWrap:"wrap"}}>
        {[{id:"history",label:"Assignment History"},{id:"submissions",label:"Submissions"},{id:"diagnostics",label:"Diagnostics"},{id:"preassign",label:"Pre-Assign"},{id:"scores",label:"Score History"}].map(pt=>{
          const active = ptab===pt.id;
          return(
            <button key={pt.id} onClick={()=>setPtab(pt.id)} style={{border:"none",background:"none",cursor:"pointer",padding:"14px 0",fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 48',fontSize:15,fontWeight:active?600:500,color:active?"#0F1A2E":"#66708A",borderBottom:active?"2px solid #0F1A2E":"2px solid transparent",marginBottom:-1,letterSpacing:-.1,position:"relative"}}>
              {pt.label}
              {active&&<span style={{position:"absolute",left:"50%",bottom:-2,width:5,height:5,transform:"translate(-50%,50%) rotate(45deg)",background:"#9A5B1F"}}/>}
            </button>
          );
        })}
      </div>

      {/* ASSIGNMENT HISTORY */}
      {ptab==="history"&&(
        <div>
          {(!p.assignments||p.assignments.length===0)?(
            <div style={{...CARD,padding:"60px 40px",textAlign:"center"}}>
              <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:20,color:"#66708A",letterSpacing:-.2}}>No assignments recorded yet.</div>
            </div>
          ):(
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              {[...p.assignments].reverse().map(asg=>(
                <div key={asg.id} style={{...CARD,padding:20}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14,paddingBottom:12,borderBottom:"1px solid rgba(15,26,46,.08)",gap:12,flexWrap:"wrap"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                      {editDateId===asg.id ? (
                        <span style={{display:"flex",alignItems:"center",gap:6}}>
                          <input type="date" value={editDateVal} onChange={e=>setEditDateVal(e.target.value)} style={{...INP,width:150,fontSize:12,padding:"4px 8px"}}/>
                          <button onClick={()=>{setStudents(prev=>prev.map(st=>st.id===p.id?{...st,assignments:(st.assignments||[]).map(a=>a.id===asg.id?{...a,date:editDateVal}:a)}:st));setEditDateId(null);showToast("Date updated");}} style={{...mkBtn("#4C7A4C","#FAF7F2"),padding:"4px 12px",fontSize:10}}>Save</button>
                          <button onClick={()=>setEditDateId(null)} style={{...mkBtn("transparent","#66708A"),border:"1px solid rgba(15,26,46,.18)",padding:"4px 12px",fontSize:10}}>Cancel</button>
                        </span>
                      ) : (
                        <span style={{display:"flex",alignItems:"center",gap:6}}>
                          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:14,fontWeight:600,color:"#0F1A2E",letterSpacing:.2,fontVariantNumeric:"tabular-nums"}}>{asg.date}</span>
                          <button onClick={()=>{setEditDateId(asg.id);setEditDateVal(asg.date||todayStr());}} title="Edit date" style={{background:"none",border:"1px solid rgba(15,26,46,.15)",borderRadius:2,cursor:"pointer",fontSize:9,color:"#66708A",padding:"2px 8px",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.4,textTransform:"uppercase",fontWeight:500}}>Edit</button>
                        </span>
                      )}
                      {asg.preAssigned&&<span style={{...mkPill("transparent","#6E3F12"),border:"1px solid rgba(154,91,31,.35)"}}>Pre-existing</span>}
                      {asg.examType&&asg.examType!=="SAT"&&<span style={{...mkPill("transparent","#5B4B8A"),border:"1px solid rgba(91,75,138,.35)"}}>{asg.examType}</span>}
                      {asg.timeDrill&&<span style={{...mkPill("transparent","#003258"),border:"1px solid rgba(0,50,88,.28)"}}>Timed</span>}
                      {asg.oneNote&&<span style={{...mkPill("transparent","#4C7A4C"),border:"1px solid rgba(76,122,76,.35)"}}>OneNote</span>}
                      <span style={{...mkPill("transparent","#66708A"),border:"1px solid rgba(15,26,46,.15)"}}>{(asg.worksheets||[]).length} worksheet{(asg.worksheets||[]).length!==1?"s":""}</span>
                    </div>
                    <button onClick={()=>delAsg(asg.id)} style={{...mkBtn("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.3)",padding:"4px 12px",fontSize:10}}>Remove</button>
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                    {(asg.worksheets||[]).filter(w=>!w.deleted).map(ws=>(
                      <span key={ws.id||ws.title} style={{background:"#FAF7F2",border:"1px solid rgba(15,26,46,.12)",borderRadius:2,padding:"4px 10px",fontSize:11,color:"#2E3A57",fontFamily:"'IBM Plex Sans',system-ui,sans-serif",display:"inline-flex",alignItems:"center",gap:6}}>
                        {ws.title||ws.name}
                        {ws.evenOdd&&<em style={{color:"#5B4B8A",fontSize:9,fontStyle:"italic"}}>{ws.evenOdd}</em>}
                        <span style={{color:DC[ws.difficulty],fontSize:9,fontWeight:600,letterSpacing:.3,textTransform:"uppercase",fontFamily:"'IBM Plex Mono',monospace"}}>{ws.difficulty}</span>
                        {/* Session 18A: per-worksheet × remove (blocks if submission exists) */}
                        {delWs&&ws.id&&<button onClick={()=>{if(confirm(`Remove "${ws.title}" from this PSM?`))delWs(asg.id,ws.id);}} title="Remove this worksheet from the PSM (only if no student submission yet)" style={{background:"none",border:"none",color:"#8C2E2E",cursor:"pointer",fontSize:13,lineHeight:1,padding:"0 2px",marginLeft:2,fontWeight:600}}>×</button>}
                      </span>
                    ))}
                    {/* Session 18A: "+ Add worksheets" toggle */}
                    {addWs&&(
                      <button onClick={()=>{setAddWsAsgId(addWsAsgId===asg.id?null:asg.id);setAddWsPicks({});setAddWsSrch("");}} style={{background:addWsAsgId===asg.id?"#003258":"transparent",color:addWsAsgId===asg.id?"#FAF7F2":"#003258",border:"1px dashed rgba(0,50,88,.4)",borderRadius:2,padding:"4px 10px",fontSize:11,cursor:"pointer",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.3}}>
                        {addWsAsgId===asg.id?"− Cancel":"+ Add worksheets"}
                      </button>
                    )}
                  </div>
                  {/* Session 18A: worksheet picker for "+ Add worksheets" */}
                  {addWs&&addWsAsgId===asg.id&&(
                    <div style={{marginTop:12,padding:14,background:"#F5F8FB",border:"1px solid rgba(0,50,88,.18)",borderRadius:4}}>
                      <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap",alignItems:"center"}}>
                        <input type="text" placeholder="Search worksheets…" value={addWsSrch} onChange={e=>setAddWsSrch(e.target.value)} style={{flex:"1 1 200px",padding:"6px 10px",fontSize:12,border:"1px solid rgba(15,26,46,.2)",borderRadius:2,fontFamily:"'IBM Plex Mono',monospace"}}/>
                        <select value={addWsSubj} onChange={e=>setAddWsSubj(e.target.value)} style={{padding:"6px 10px",fontSize:12,border:"1px solid rgba(15,26,46,.2)",borderRadius:2}}>
                          <option value="All">All subjects</option>
                          <option value="Reading & Writing">R&W</option>
                          <option value="Math">Math</option>
                        </select>
                        <button onClick={()=>{const picks=Object.keys(addWsPicks).filter(k=>addWsPicks[k]).map(id=>ALL_WS.find(w=>w.id===id)).filter(Boolean);if(picks.length){addWs(asg.id,picks);setAddWsAsgId(null);setAddWsPicks({});}}} disabled={!Object.values(addWsPicks).some(Boolean)} style={{...mkBtn(Object.values(addWsPicks).some(Boolean)?"#003258":"rgba(15,26,46,.15)","#FAF7F2"),padding:"6px 14px",fontSize:11,cursor:Object.values(addWsPicks).some(Boolean)?"pointer":"not-allowed"}}>
                          Add selected ({Object.values(addWsPicks).filter(Boolean).length})
                        </button>
                      </div>
                      <div style={{maxHeight:200,overflowY:"auto",fontSize:11}}>
                        {ALL_WS
                          .filter(ws=>addWsSubj==="All"||ws.subject===addWsSubj)
                          .filter(ws=>!addWsSrch||ws.title.toLowerCase().includes(addWsSrch.toLowerCase()))
                          .filter(ws=>!(asg.worksheets||[]).filter(w=>!w.deleted).find(w=>w.id===ws.id))
                          .slice(0,40)
                          .map(ws=>(
                            <label key={ws.id} style={{display:"flex",alignItems:"center",gap:8,padding:"4px 6px",cursor:"pointer",borderBottom:"1px solid rgba(15,26,46,.05)"}}>
                              <input type="checkbox" checked={!!addWsPicks[ws.id]} onChange={e=>setAddWsPicks(prev=>({...prev,[ws.id]:e.target.checked}))}/>
                              <span style={{flex:1,color:"#0F1A2E"}}>{ws.title}</span>
                              <span style={{color:"#66708A",fontSize:9,letterSpacing:.4,textTransform:"uppercase",fontFamily:"'IBM Plex Mono',monospace"}}>{ws.subject==="Math"?"Math":"R&W"}</span>
                              <span style={{color:DC[ws.difficulty],fontSize:9,fontWeight:600,letterSpacing:.3,textTransform:"uppercase",fontFamily:"'IBM Plex Mono',monospace"}}>{ws.difficulty}</span>
                            </label>
                          ))}
                      </div>
                    </div>
                  )}
                  {(asg.welledDomain||[]).length>0&&<div style={{marginTop:14,padding:14,background:"#F5ECDF",borderRadius:4,border:"1px solid rgba(154,91,31,.2)"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#6E3F12",letterSpacing:1.2,textTransform:"uppercase"}}>WellEd Domain Assignments</div>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:.4,textTransform:"uppercase",fontWeight:500}}>Auto-synced to Score Tracking</div>
                    </div>
                    {asg.welledDomain.map((i,idx)=>{
                      const wMax = i.subject==="Math"?22:27;
                      return(
                      <div key={idx} style={{display:"flex",alignItems:"center",gap:10,fontSize:11,marginBottom:4}}>
                        <span style={{flex:1,color:"#6E3F12",fontWeight:500}}>{i.label}</span>
                        <span style={{fontSize:9,color:"#66708A",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.4,textTransform:"uppercase"}}>Score</span>
                        <ScoreInput min="0" max={wMax} placeholder="0" value={i.score||""} onCommit={v=>setWelledDomainScore(asg.id,idx,v)} style={{width:54,padding:"4px 8px",border:"1px solid rgba(154,91,31,.35)",borderRadius:2,fontSize:11,textAlign:"right",fontFamily:"'IBM Plex Mono',monospace",background:"#fff"}}/>
                        <span style={{fontSize:10,color:"#6E3F12",fontWeight:600,minWidth:28,fontFamily:"'IBM Plex Mono',monospace"}}>/ {wMax}</span>
                      </div>
                    );})}
                  </div>}
                  {(asg.vocab||[]).length>0&&<div style={{marginTop:14,padding:14,background:"#EFEAE0",borderRadius:4,border:"1px solid rgba(91,75,138,.2)"}}>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#3A305C",marginBottom:8,letterSpacing:1.2,textTransform:"uppercase"}}>Vocabulary</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                      {asg.vocab.map((v,idx)=><span key={idx} style={{background:"#fff",color:"#3A305C",padding:"3px 10px",borderRadius:2,fontSize:11,border:"1px solid rgba(91,75,138,.25)"}}>{v.label}</span>)}
                    </div>
                  </div>}
                  {(asg.practiceExams||[]).length>0&&<div style={{marginTop:14,padding:14,background:"#E9F0F6",borderRadius:4,border:"1px solid rgba(0,74,121,.2)"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#003258",letterSpacing:1.2,textTransform:"uppercase"}}>Practice Exams</div>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:.4,textTransform:"uppercase",fontWeight:500}}>Auto-synced to Score Tracking</div>
                    </div>
                    {asg.practiceExams.map((ex,idx)=>{
                      const isFull = ex.type!=="section";
                      const rw = ex.rwScore||"", math = ex.mathScore||"";
                      const total = (Number(rw)||0)+(Number(math)||0);
                      const examInp = {width:60,padding:"4px 8px",border:"1px solid rgba(0,74,121,.35)",borderRadius:2,fontSize:11,textAlign:"right",fontFamily:"'IBM Plex Mono',monospace",background:"#fff"};
                      return(
                      <div key={idx} style={{display:"flex",alignItems:"center",gap:8,fontSize:11,marginBottom:6,flexWrap:"wrap"}}>
                        <span style={{flex:"1 1 200px",fontWeight:500,color:"#003258"}}>{ex.platform} Practice Test #{ex.number||"?"}{isFull?"":" (Section)"}</span>
                        {isFull ? (<>
                          <span style={{fontSize:9,color:"#66708A",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.4,textTransform:"uppercase"}}>R&amp;W</span>
                          <ScoreInput min="0" max="800" placeholder="0" value={rw} onCommit={v=>setExamScore(asg.id,idx,{rwScore:v})} style={examInp}/>
                          <span style={{fontSize:10,color:"#003258",fontWeight:600,fontFamily:"'IBM Plex Mono',monospace"}}>/ 800</span>
                          <span style={{fontSize:9,color:"#66708A",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.4,textTransform:"uppercase"}}>Math</span>
                          <ScoreInput min="0" max="800" placeholder="0" value={math} onCommit={v=>setExamScore(asg.id,idx,{mathScore:v})} style={examInp}/>
                          <span style={{fontSize:10,color:"#003258",fontWeight:600,fontFamily:"'IBM Plex Mono',monospace"}}>/ 800</span>
                          {(rw||math) && <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:13,fontWeight:600,color:"#003258",marginLeft:6,fontVariantNumeric:"tabular-nums"}}>= {total}/1600</span>}
                        </>) : (<>
                          <select value={ex.sectionSubject||""} onChange={e=>setExamScore(asg.id,idx,{sectionSubject:e.target.value})} style={{padding:"4px 10px",border:"1px solid rgba(0,74,121,.35)",borderRadius:2,fontSize:11,background:"#fff"}}>
                            <option value="">Section…</option>
                            <option value="R&W">R&amp;W</option>
                            <option value="Math">Math</option>
                          </select>
                          <span style={{fontSize:9,color:"#66708A",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.4,textTransform:"uppercase"}}>Score</span>
                          <ScoreInput min="0" max="800" placeholder="0" value={ex.score||""} onCommit={v=>setExamScore(asg.id,idx,{score:v})} style={examInp}/>
                          <span style={{fontSize:10,color:"#003258",fontWeight:600,fontFamily:"'IBM Plex Mono',monospace"}}>/ 800</span>
                        </>)}
                      </div>
                    );})}
                  </div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SUBMISSIONS (Phase 2 Session 6) */}
      {ptab==="submissions"&&<TutorSubmissionsPanel student={p}/>}

      {/* DIAGNOSTICS */}
      {ptab==="diagnostics"&&(
        <div>
          <div style={{...CARD,marginBottom:16,padding:20}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:16}}>
              <div style={{flex:"1 1 320px"}}>
                <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:20,fontWeight:600,color:"#0F1A2E",letterSpacing:-.3,marginBottom:6}}>Diagnostic Reports</div>
                <div style={{fontSize:12,color:"#66708A",lineHeight:1.55,maxWidth:520}}>Upload ZipGrade SAT Diagnostic PDFs (Reading, Math Mod 1, Math Mod 2). The parser extracts domain and subdomain scores automatically.</div>
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <input ref={diagInputRef} type="file" multiple accept="application/pdf" onChange={e=>handleDiagUpload(e.target.files)} style={{display:"none"}}/>
                <button onClick={()=>diagInputRef.current?.click()} style={{...mkBtn(B2,"#FAF7F2"),padding:"8px 16px",fontSize:11,fontWeight:600,letterSpacing:.3,textTransform:"uppercase"}}>Upload Diagnostic PDF</button>
                {/* Session 18C: WellEd report upload moved to Score History tab — different metric class. */}
                {(p.diagnostics||[]).length>0&&<button onClick={clearDiagnostics} style={{...mkBtn("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.3)",padding:"8px 14px",fontSize:11}}>Clear</button>}
              </div>
            </div>
          </div>

          {(!p.diagnostics||p.diagnostics.length===0)?(
            <div style={{...CARD,padding:"72px 40px",textAlign:"center"}}>
              <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:22,color:"#66708A",letterSpacing:-.2,marginBottom:8}}>No diagnostic reports uploaded yet.</div>
              <div style={{fontSize:11,color:"#66708A"}}>Upload the student's ZipGrade SAT Diagnostic PDFs to see their domain and subdomain breakdown.</div>
            </div>
          ):(<>
            {/* Report list */}
            <div style={{...CARD,marginBottom:16,padding:20}}>
              <SH>Uploaded Reports</SH>
              <div style={{display:"flex",flexDirection:"column",gap:2}}>
                {p.diagnostics.map((r,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 12px",borderRadius:2,fontSize:12,background:i%2===0?"rgba(15,26,46,.02)":"transparent"}}>
                    <span style={{fontWeight:500,color:"#0F1A2E",fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:13}}>{r.fileName}</span>
                    <span style={{...mkPill("transparent","#003258"),border:"1px solid rgba(0,50,88,.25)"}}>{r.subject}</span>
                    <span style={{marginLeft:"auto",color:"#2E3A57",fontFamily:"'IBM Plex Mono',monospace",fontSize:11}}>{r.earned}/{r.possible} · {r.percentCorrect}%</span>
                    <span style={{color:"#66708A",fontSize:10,fontFamily:"'IBM Plex Mono',monospace"}}>{r.tags?.length||0} tags</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Diagnostic Section & Total Scores — quiet data readout */}
            {diagProfile&&(diagProfile.rwScore||diagProfile.mathScore)&&<div style={{...CARD,marginBottom:16,padding:24}}>
              <SH>Baseline Scores · Estimated Scaled Range</SH>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:0,borderTop:"1px solid rgba(15,26,46,.08)"}}>
                {diagProfile.rwScore&&<div style={{padding:"16px 22px",borderRight:"1px solid rgba(15,26,46,.08)",borderBottom:"1px solid rgba(15,26,46,.08)"}}>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",textTransform:"uppercase",letterSpacing:1.4}}>R&amp;W Section</div>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:20,fontWeight:500,color:"#003258",marginTop:6,letterSpacing:.2,lineHeight:1.1}}>{diagProfile.rwScore.lower}<span style={{color:"rgba(0,50,88,.5)",margin:"0 2px"}}>–</span>{diagProfile.rwScore.upper}</div>
                  <div style={{fontSize:10,color:"#66708A",marginTop:6,fontFamily:"'IBM Plex Mono',monospace"}}>Raw {diagProfile.rwScore.earn}/{diagProfile.rwScore.poss}</div>
                </div>}
                {diagProfile.mathScore&&<div style={{padding:"16px 22px",borderRight:"1px solid rgba(15,26,46,.08)",borderBottom:"1px solid rgba(15,26,46,.08)"}}>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",textTransform:"uppercase",letterSpacing:1.4}}>Math Section</div>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:20,fontWeight:500,color:"#6E3F12",marginTop:6,letterSpacing:.2,lineHeight:1.1}}>{diagProfile.mathScore.lower}<span style={{color:"rgba(110,63,18,.5)",margin:"0 2px"}}>–</span>{diagProfile.mathScore.upper}</div>
                  <div style={{fontSize:10,color:"#66708A",marginTop:6,fontFamily:"'IBM Plex Mono',monospace"}}>Raw {diagProfile.mathScore.earn}/{diagProfile.mathScore.poss}</div>
                </div>}
                {diagProfile.totalLower!=null&&<div style={{padding:"16px 22px",borderBottom:"1px solid rgba(15,26,46,.08)"}}>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",textTransform:"uppercase",letterSpacing:1.4}}>Total SAT · Est.</div>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:22,fontWeight:600,color:"#0F1A2E",marginTop:6,letterSpacing:.2,lineHeight:1.1}}>{diagProfile.totalLower}<span style={{color:"rgba(15,26,46,.4)",margin:"0 2px"}}>–</span>{diagProfile.totalUpper}</div>
                  <div style={{fontSize:10,color:"#66708A",marginTop:6,fontFamily:"'IBM Plex Mono',monospace"}}>Out of 1600</div>
                </div>}
              </div>
            </div>}

            {/* Domain / Subskill performance */}
            {diagProfile&&<div style={{...CARD,marginBottom:16,padding:20}}>
              <SH>Performance Breakdown · Weakest First</SH>
              {diagProfile.domains.length>0&&<div style={{marginBottom:24}}>
                <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:14,fontStyle:"italic",color:"#2E3A57",marginBottom:12}}>By Domain</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:8}}>
                  {diagProfile.domains.sort((a,b)=>(a.pct||0)-(b.pct||0)).map(d=>(
                    <div key={d.name} style={{background:heatColorPct(d.pct),color:"#FAF7F2",padding:"14px 16px",borderRadius:3}}>
                      <div style={{fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:13,fontWeight:700,lineHeight:1.25,letterSpacing:-.1}}>{d.name}</div>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:24,fontWeight:600,letterSpacing:-.3,marginTop:6,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{d.pct}<span style={{fontSize:14,opacity:.7}}>%</span></div>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,opacity:.85,marginTop:5}}>{d.earn} / {d.poss}</div>
                    </div>
                  ))}
                </div>
              </div>}
              {diagProfile.subs.length>0&&<div>
                <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:14,fontStyle:"italic",color:"#2E3A57",marginBottom:12}}>By Subskill</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:6}}>
                  {diagProfile.subs.sort((a,b)=>(a.pct||0)-(b.pct||0)).map(s=>{
                    const c = heatColorPct(s.pct);
                    return(
                      <div key={s.domain+s.name} style={{background:"#fff",borderLeft:`3px solid ${c}`,padding:"10px 14px",borderRadius:2,boxShadow:"inset 0 0 0 1px rgba(15,26,46,.08)"}}>
                        <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",fontWeight:500,letterSpacing:.7,textTransform:"uppercase"}}>{s.domain}</div>
                        <div style={{fontSize:13,fontWeight:600,color:"#0F1A2E",marginTop:3,letterSpacing:-.1}}>{s.name}</div>
                        <div style={{display:"flex",alignItems:"baseline",gap:8,marginTop:6}}>
                          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:18,fontWeight:600,color:c,letterSpacing:-.2,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{s.pct}<span style={{fontSize:12}}>%</span></span>
                          <span style={{fontSize:11,color:"#66708A",fontFamily:"'IBM Plex Mono',monospace"}}>{s.earn}/{s.poss}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>}
            </div>}
          </>)}
        </div>
      )}

      {/* PRE-ASSIGN */}
      {ptab==="preassign"&&(
        <div>
          <div style={{background:"#F5ECDF",border:"1px solid rgba(154,91,31,.28)",borderRadius:4,padding:"14px 18px",marginBottom:16,fontSize:12,color:"#6E3F12",lineHeight:1.55}}>
            <span style={{fontFamily:"'Fraunces',Georgia,serif",fontWeight:600,fontSize:13}}>Pre-Assign Panel.</span> Mark worksheets already given before this student was added. Previously-assigned worksheets still show so you can assign them again.
          </div>
          <div style={{...CARD,marginBottom:16,padding:16,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <label style={{fontSize:11,fontFamily:"'IBM Plex Mono',monospace",fontWeight:600,color:"#66708A",letterSpacing:1.2,textTransform:"uppercase"}}>Date
              <input type="date" value={paDate} onChange={e=>setPaDate(e.target.value)} style={{...INP,marginLeft:10,width:160,display:"inline-block"}}/>
            </label>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
            {["All","Reading & Writing","Math"].map(s=>(
              <button key={s} onClick={()=>setPaSubj(s)} style={{...mkBtn(paSubj===s?B2:"transparent",paSubj===s?"#FAF7F2":"#2E3A57"),border:"1px solid "+(paSubj===s?B2:"rgba(15,26,46,.18)"),padding:"5px 14px",fontSize:11}}>{s==="Reading & Writing"?"R&W":s}</button>
            ))}
            <input placeholder="Search…" value={paSrch} onChange={e=>setPaSrch(e.target.value)} style={{...INP,width:200,fontStyle:paSrch?"normal":"italic"}}/>
            <span style={{fontSize:10,color:"#66708A",marginLeft:"auto",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.4,textTransform:"uppercase"}}>{Object.values(paChk).filter(Boolean).length.toString().padStart(2,"0")} selected</span>
          </div>
          <div style={{...CARD,maxHeight:500,overflowY:"auto",padding:20}}>
            {paGrouped.map(g=>(
              <div key={`${g.subject}|${g.domain}|${g.subdomain}`} style={{marginBottom:18}}>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:DOMAIN_COLOR[g.domain]||B2,textTransform:"uppercase",letterSpacing:1,padding:"4px 0",marginBottom:8,borderBottom:"1px solid rgba(15,26,46,.08)"}}>
                  {g.subject} · {g.domain} · {g.subdomain}
                </div>
                {g.sheets.map(ws=>{
                  const alreadyAsg = (p.assignments||[]).find(a=>(a.worksheets||[]).some(w=>(w.id||w.title)===ws.id||w.title===ws.title));
                  const lastDate = alreadyAsg?.date;
                  const ck = !!paChk[ws.id];
                  return(
                    <div key={ws.id} onClick={()=>setPaChk(prev=>({...prev,[ws.id]:!prev[ws.id]}))} style={{display:"flex",alignItems:"center",padding:"8px 12px",cursor:"pointer",borderRadius:3,marginBottom:2,background:ck?"#E9F0F6":alreadyAsg?"#F5ECDF":"transparent",boxShadow:ck?"inset 0 0 0 1px "+B2:alreadyAsg?"inset 0 0 0 1px rgba(154,91,31,.3)":"none",transition:"background .15s"}}>
                      <input type="checkbox" checked={ck} onChange={()=>{}} onClick={e=>{e.stopPropagation();setPaChk(prev=>({...prev,[ws.id]:!prev[ws.id]}));}} style={{marginRight:11,cursor:"pointer",accentColor:B2}}/>
                      <span style={{fontSize:12,flex:1,color:"#0F1A2E",fontWeight:ck?600:400}}>
                        {ws.title}
                        {alreadyAsg&&<span style={{fontSize:8,marginLeft:10,color:"#FAF7F2",fontWeight:600,background:"#9A5B1F",padding:"2px 7px",borderRadius:2,fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.5,textTransform:"uppercase"}}>Assigned {lastDate}</span>}
                      </span>
                      {ws.qs>0&&<span style={{...mkPill("transparent","#003258"),marginRight:6,border:"1px solid rgba(0,50,88,.22)"}}>{ws.qs}Q</span>}
                      <span style={{fontSize:9,color:DC[ws.difficulty],fontWeight:600,letterSpacing:.3,textTransform:"uppercase",fontFamily:"'IBM Plex Mono',monospace"}}>{ws.difficulty}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {/* WellEd Domain Pre-Assign */}
          <div style={{...CARD,marginTop:16,padding:18}}>
            <SH>WellEd Domain Assignments</SH>
            <div style={{maxHeight:220,overflowY:"auto",border:"1px solid rgba(154,91,31,.2)",borderRadius:3,padding:8,background:"rgba(245,236,223,.3)"}}>
              {WELLED_DOMAIN.map(e=>(
                <div key={e.subject+"|"+e.domain} style={{marginBottom:8}}>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:DOMAIN_COLOR[e.domain]||B2,marginBottom:4,letterSpacing:.8,textTransform:"uppercase"}}>{e.domain}</div>
                  {e.diffs.map(d=>{
                    const it = WE_DOMAIN_ITEMS.find(x=>x.subject===e.subject&&x.domain===e.domain&&x.difficulty===d);
                    const ck=!!paWeChk[it.id];
                    const alreadyAsg = (p.assignments||[]).some(a=>(a.welledDomain||[]).some(w=>w.subject===e.subject&&w.domain===e.domain&&w.difficulty===d));
                    return(
                      <label key={d} style={{display:"flex",alignItems:"center",gap:8,fontSize:11,padding:"4px 8px",cursor:"pointer",background:ck?"#F5ECDF":alreadyAsg?"rgba(154,91,31,.08)":"transparent",borderRadius:2,marginBottom:1,boxShadow:ck?"inset 0 0 0 1px #9A5B1F":"none"}}>
                        <input type="checkbox" checked={ck} onChange={()=>setPaWeChk(prev=>({...prev,[it.id]:!prev[it.id]}))} style={{accentColor:"#9A5B1F"}}/>
                        <span style={{color:"#0F1A2E",fontWeight:500}}>{d[0].toUpperCase()+d.slice(1)}</span>
                        {alreadyAsg&&<span style={{fontSize:8,fontWeight:600,color:"#FAF7F2",background:"#9A5B1F",padding:"2px 6px",borderRadius:2,fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.5,textTransform:"uppercase"}}>Assigned</span>}
                        <span style={{color:"#66708A",marginLeft:"auto",fontFamily:"'IBM Plex Mono',monospace",fontSize:10}}>{e.qs}Qs</span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
            <div style={{fontSize:10,color:"#66708A",marginTop:8,fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.4,textTransform:"uppercase"}}>{Object.values(paWeChk).filter(Boolean).length.toString().padStart(2,"0")} WellEd domains selected</div>
          </div>

          {/* Practice Exams Pre-Assign */}
          {(()=>{
            const bbUsed = new Set();
            const weUsed = new Set();
            (p.assignments||[]).forEach(a=>(a.practiceExams||[]).forEach(ex=>{
              if(ex.platform==="BlueBook" && typeof ex.number==="number") bbUsed.add(ex.number);
              if(ex.platform==="WellEd"  && typeof ex.number==="number") weUsed.add(ex.number);
            }));
            return (
              <div style={{...CARD,marginTop:16,padding:18}}>
                <SH>Practice Exams</SH>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                  <div>
                    <label style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",display:"block",marginBottom:8,letterSpacing:1.2,textTransform:"uppercase"}}>BlueBook Tests</label>
                    <ExamChipPicker
                      all={BLUEBOOK_PRACTICE_TESTS}
                      used={bbUsed}
                      picks={paBBPicks}
                      setPicks={setPaBBPicks}
                      accent="#003258"
                      accentBorder="#003258"
                    />
                  </div>
                  <div>
                    <label style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",display:"block",marginBottom:8,letterSpacing:1.2,textTransform:"uppercase"}}>WellEd Tests</label>
                    <ExamChipPicker
                      all={WELLED_PRACTICE_TESTS}
                      used={weUsed}
                      picks={paWEPicks}
                      setPicks={setPaWEPicks}
                      accent="#9A5B1F"
                      accentBorder="#9A5B1F"
                    />
                  </div>
                </div>
              </div>
            );
          })()}

          <div style={{marginTop:16,display:"flex",gap:8}}>
            <button onClick={savePreAssign} style={{...mkBtn(B2,"#FAF7F2"),padding:"10px 22px",fontSize:12,fontWeight:600,letterSpacing:.3,textTransform:"uppercase",boxShadow:"0 4px 14px -4px rgba(0,50,88,.4)"}}>Save Pre-Assigned · {Object.values(paChk).filter(Boolean).length + Object.values(paWeChk).filter(Boolean).length + paBBPicks.length + paWEPicks.length} items</button>
            <button onClick={()=>{setPaChk({});setPaWeChk({});setPaBBPicks([]);setPaWEPicks([]);}} style={{...mkBtn("transparent","#66708A"),border:"1px solid rgba(15,26,46,.18)",padding:"10px 20px",fontSize:11}}>Clear</button>
          </div>
        </div>
      )}

      {/* SCORE HISTORY (aggregated from all sources) */}
      {ptab==="scores"&&(
        <ScoreHistoryPanel p={p} sfm={sfm} setSfm={setSfm} addScore={addScore} delScore={delScore} addWelledLog={addWelledLog} delWelledLog={delWelledLog} handleWelledUpload={handleWelledUpload} welledInputRef={welledInputRef}/>
      )}
    </div>
  );
}

/* ============ STUDENT PORTAL (Phase 2 Session 3) ============ */
// Read-only view for student/parent roles. Subscribes to a single
// /students/{id} doc. Never reads the full collection or _private/info.
function StudentPortal({studentId, onSignOut, currentUserEntry, switcherSlot, impersonating}){
  const [tab, setTab] = useState("tracking");
  const {status, student} = usePortalStudent(studentId);
  // Session 15: listen to the student's own submissions so PortalHistoryTab
  // can show per-assignment done pills and PortalTrackingTab can list PSM
  // scores. The rules at firestore.rules:100 allow a linked student/parent to
  // list their own submissions via canReadStudent, so this is safe.
  // useTutorSubmissions is named historically (Phase 2 Session 3) but is a
  // plain listener on students/{sid}/submissions — no tutor-only semantics.
  const {submissions: portalSubmissions} = useTutorSubmissions(studentId);
  // Session 14: deep-link handoff — read once on mount, validate s===studentId,
  // then clear the key and force the history tab so SubmissionEditor opens directly.
  const [deepLinkAssignmentId] = useState(()=>{
    if(typeof sessionStorage === "undefined") return null;
    try{
      const raw = JSON.parse(sessionStorage.getItem(PENDING_ASSIGNMENT_KEY) || "null");
      if(raw && raw.a && raw.s && raw.s === studentId) return raw.a;
    }catch{}
    return null;
  });
  useEffect(()=>{
    if(deepLinkAssignmentId){
      try{ sessionStorage.removeItem(PENDING_ASSIGNMENT_KEY); }catch{}
      setTab("history");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if(status === "loading"){
    return (
      <div data-portal="student" style={{minHeight:"100vh",background:"var(--paper)",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{fontFamily:"var(--font-display)",fontSize:18,color:"var(--ink-mute)"}}>Loading…</div>
      </div>
    );
  }

  if(status === "error"){
    return (
      <PortalShell studentName="" onSignOut={onSignOut} currentUserEntry={currentUserEntry} switcherSlot={switcherSlot} impersonating={impersonating}>
        <div style={{...CARD, padding:"60px 40px", textAlign:"center", margin:"40px auto", maxWidth:520}}>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:22,color:"#8C2E2E",letterSpacing:-.2}}>
            Couldn't load your student record. Try reloading.
          </div>
        </div>
      </PortalShell>
    );
  }

  if(status === "not-found" || !student){
    return (
      <PortalShell studentName="" onSignOut={onSignOut} currentUserEntry={currentUserEntry} switcherSlot={switcherSlot} impersonating={impersonating}>
        <div style={{...CARD, padding:"60px 40px", textAlign:"center", margin:"40px auto", maxWidth:520}}>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:22,color:"#66708A",letterSpacing:-.2,marginBottom:10}}>
            No student record linked to this account.
          </div>
          <div style={{fontSize:13,color:"#66708A",lineHeight:1.55}}>
            If you believe this is a mistake, email your tutor or <span style={{fontFamily:"'IBM Plex Mono',monospace"}}>support@affordabletutoringsolutions.org</span>.
          </div>
        </div>
      </PortalShell>
    );
  }

  return (
    <PortalShell studentName={student.name} studentGrade={student.grade} onSignOut={onSignOut} currentUserEntry={currentUserEntry} switcherSlot={switcherSlot} impersonating={impersonating} studentEmail={(student.meta && student.meta.email) || (currentUserEntry && currentUserEntry.email) || ""}>
      {/* Session 18C v9: latest-PSM card with directly-clickable
          worksheets. Auto-renders below the logins on every tab so
          students don't have to hunt through assignment history to
          find what was just assigned. Per Aidan: 'They should be able
          to answer each worksheet individually not just one answer
          button' — each worksheet here opens its own SubmissionEditor. */}
      {!impersonating && (
        <LatestPsmCard
          student={student}
          studentId={studentId}
          submissions={portalSubmissions}
          canEdit={(currentUserEntry?.role) === "student"}
        />
      )}
      <div style={{display:"flex",gap:28,marginBottom:24,borderBottom:"1px solid rgba(15,26,46,.12)",flexWrap:"wrap"}}>
        {[
          {id:"tracking", label:"Score Tracking"},
          {id:"history",  label:"Assignment History"},
          {id:"trends",   label:"Score Trends"},
        ].map(t=>{
          const active = tab===t.id;
          return (
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              border:"none",background:"none",cursor:"pointer",padding:"14px 0",
              fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 48',
              fontSize:15,fontWeight:active?600:500,color:active?"#0F1A2E":"#66708A",
              borderBottom:active?"2px solid #0F1A2E":"2px solid transparent",marginBottom:-1,
              letterSpacing:-.1,position:"relative"
            }}>
              {t.label}
              {active&&<span style={{position:"absolute",left:"50%",bottom:-2,width:5,height:5,transform:"translate(-50%,50%) rotate(45deg)",background:"#9A5B1F"}}/>}
            </button>
          );
        })}
      </div>

      {tab==="tracking" && <PortalTrackingTab student={student} submissions={portalSubmissions}/>}
      {tab==="history"  && <PortalHistoryTab student={student} studentId={studentId} currentUserEntry={currentUserEntry} deepLinkAssignmentId={deepLinkAssignmentId} submissions={portalSubmissions}/>}
      {tab==="trends"   && <PortalTrendsTab student={student}/>}
    </PortalShell>
  );
}

// Session 18C v9: latest-PSM landing card. Shows the most recent
// non-deleted assignment as soon as the student lands. Each worksheet
// is a clickable button that opens the SubmissionEditor in single-WS
// mode (focusWorksheetId), so the student doesn't see one giant Answer
// button but instead picks each worksheet to do one at a time.
//
// "Most recent" = the assignment with the latest `date` (YYYY-MM-DD),
// soft-deleted ones filtered out. If there are no assignments yet,
// the card doesn't render.
function LatestPsmCard({student, studentId, submissions, canEdit}){
  const [openWorksheetId, setOpenWorksheetId] = useState(null);
  // Track per-WS status from both legacy submissions and per-worksheet
  // docs. useWorksheetSubmissions returns {byWorksheet} keyed by wsId.
  // For the latest PSM we resolve its id first, then subscribe to
  // that subcollection.
  const latest = useMemo(()=>{
    const list = (student.assignments||[]).filter(a => !a.deleted);
    if(list.length === 0) return null;
    // sort by date desc, then by array-index as a tiebreaker (newer
    // additions appended later)
    const sorted = [...list].sort((a,b)=>{
      const da = (a.date || a.dateAssigned || "");
      const db = (b.date || b.dateAssigned || "");
      if(da !== db) return db.localeCompare(da);
      return 0;
    });
    return sorted[0] || null;
  }, [student.assignments]);

  // Hooks always run; subscribe with the latest PSM id (or null).
  const perWs = useWorksheetSubmissions(studentId, latest && latest.id);
  const legacy = (submissions || []).find(s => s && s.assignmentId === (latest && latest.id)) || null;

  if(!latest) return null;
  if(openWorksheetId){
    return (
      <SubmissionEditor
        studentId={studentId}
        assignment={latest}
        focusWorksheetId={openWorksheetId}
        readOnly={!canEdit}
        onClose={()=>setOpenWorksheetId(null)}
      />
    );
  }

  const worksheets = (latest.worksheets || []).filter(w => !w.deleted);
  const welledDomain = (latest.welledDomain || []).filter(w => !w.deleted);
  const practiceExams = (latest.practiceExams || []).filter(e => !e.deleted);

  function statusFor(wsId){
    const perDoc = perWs.byWorksheet[wsId];
    if(perDoc){
      if(typeof perDoc.scoreCorrect === "number") return { kind: "graded", score: `${perDoc.scoreCorrect} / ${perDoc.scoreTotal}` };
      if(perDoc.status === "submitted") return { kind: "submitted" };
      const hasAnyAnswer = (perDoc.responses || []).some(r => (r.studentAnswer || "").trim() !== "");
      return hasAnyAnswer ? { kind: "in-progress" } : { kind: "not-started" };
    }
    // Session 18C v12: when legacy is submitted, only mark THIS worksheet
    // as submitted if it had data in responses. Otherwise treat it as
    // not-started — the student should be able to drill in and answer
    // it via the per-WS path. Fixes the case where a buggy whole-PSM
    // submit locked unfinished worksheets.
    if(legacy && legacy.status === "submitted"){
      const has = (legacy.responses || []).some(r => r && r.worksheetId === wsId && (r.studentAnswer || "").trim() !== "");
      return has ? { kind: "submitted" } : { kind: "not-started" };
    }
    if(legacy && Array.isArray(legacy.responses)){
      const has = legacy.responses.some(r => r && r.worksheetId === wsId && (r.studentAnswer || "").trim() !== "");
      return has ? { kind: "in-progress" } : { kind: "not-started" };
    }
    return { kind: "not-started" };
  }

  const STATUS_STYLE = {
    "not-started":  { bg: "transparent",  fg: "#66708A",  border: "rgba(15,26,46,.18)", label: "Not started"  },
    "in-progress":  { bg: "#FFF1DE",      fg: "#9A5B1F",  border: "rgba(154,91,31,.4)", label: "In progress"  },
    "submitted":    { bg: "#E9F0F6",      fg: "#003258",  border: "rgba(0,50,88,.35)",  label: "Submitted"    },
    "graded":       { bg: "#E4F0E2",      fg: "#4C7A4C",  border: "rgba(76,122,76,.4)", label: "Graded"       },
  };
  const statuses = worksheets.map(w => statusFor(w.id).kind);
  const doneCount = statuses.filter(k => k === "submitted" || k === "graded").length;

  return (
    <div style={{...CARD, padding:"22px 24px", marginBottom:24, borderLeft:"3px solid #9A5B1F"}}>
      <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:10,gap:12,flexWrap:"wrap"}}>
        <div>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:1.4,color:"#9A5B1F",textTransform:"uppercase",marginBottom:4}}>
            Latest PSM
          </div>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:22,fontWeight:600,color:"#0F1A2E",letterSpacing:-.2}}>
            {latest.date || latest.dateAssigned || "This week's assignment"}
          </div>
        </div>
        {worksheets.length > 0 && (
          <span style={{...mkPill("transparent","#003258"),border:"1px solid rgba(0,50,88,.28)"}}>
            {doneCount} / {worksheets.length} done
          </span>
        )}
      </div>
      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",letterSpacing:.5,textTransform:"uppercase",marginBottom:16}}>
        Click a worksheet to answer it. One at a time — submit, then pick the next.
      </div>

      {worksheets.length === 0 ? (
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:13,color:"#66708A"}}>
          No portal worksheets in this PSM — see WellEd / BlueBook items below.
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {worksheets.map(w => {
            const st = statusFor(w.id);
            const sty = STATUS_STYLE[st.kind] || STATUS_STYLE["not-started"];
            const isDone = st.kind === "submitted" || st.kind === "graded";
            const ctaLabel = isDone ? "Review →" : "Answer →";
            return (
              <button
                key={w.id}
                onClick={()=> canEdit && setOpenWorksheetId(w.id)}
                disabled={!canEdit && !isDone}
                style={{
                  textAlign:"left", padding:"14px 16px", borderRadius:6,
                  border:`1px solid ${sty.border}`, background:"#fff",
                  cursor: canEdit ? "pointer" : "default",
                  display:"flex", alignItems:"center", gap:14, flexWrap:"wrap",
                  fontFamily:"inherit",
                }}
              >
                <div style={{flex:"1 1 200px",minWidth:0}}>
                  <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:15,color:"#0F1A2E",fontWeight:600,letterSpacing:-.1}}>
                    {w.title || `${w.domain||""} — ${w.difficulty||""}`}
                  </div>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",marginTop:2}}>
                    {w.subject||""}{w.domain?` · ${w.domain}`:""}{w.difficulty?` · ${w.difficulty}`:""}{w.evenOdd?` · ${w.evenOdd}`:""}
                  </div>
                </div>
                <span style={{
                  fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,
                  letterSpacing:.6,textTransform:"uppercase",
                  padding:"4px 10px",borderRadius:3,
                  background:sty.bg, color:sty.fg, border:`1px solid ${sty.border}`,
                  flexShrink:0,
                }}>
                  {st.kind === "graded" ? `Graded · ${st.score}` : sty.label}
                </span>
                <span style={{
                  fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#0F1A2E",
                  letterSpacing:.6,textTransform:"uppercase",fontWeight:600,flexShrink:0,
                }}>{ctaLabel}</span>
              </button>
            );
          })}
        </div>
      )}

      {(welledDomain.length > 0 || practiceExams.length > 0) && (
        <div style={{marginTop:14,padding:"10px 12px",background:"#FAF7F2",borderRadius:6,border:"1px solid rgba(15,26,46,.08)",fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",lineHeight:1.6}}>
          This PSM also includes{" "}
          {welledDomain.length > 0 && <span><strong>{welledDomain.length}</strong> WellEd domain practice{welledDomain.length===1?"":"s"}</span>}
          {welledDomain.length > 0 && practiceExams.length > 0 && " and "}
          {practiceExams.length > 0 && <span><strong>{practiceExams.length}</strong> practice exam{practiceExams.length===1?"":"s"}</span>}
          {". Do those on WellEd / BlueBook (links above)."}
        </div>
      )}
    </div>
  );
}

// Session 18C: external-platform quick links + credentials. Shown at the
// top of every student-portal tab. WellEd has a shared institutional
// password ('Ats2025!') with the student's own email; Wise uses the
// student's own email + password (no shared password — they set their own).
// Studies-only — does not appear in tutor impersonation banner.
function StudentExternalLinksCard({studentEmail}){
  const [showWelledPw, setShowWelledPw] = useState(false);
  const copy = (txt) => {
    try { navigator.clipboard.writeText(txt); } catch { /* ignore */ }
  };
  const cardStyle = {
    border:"1px solid rgba(15,26,46,.12)", borderRadius:8,
    padding:"12px 14px", background:"#FAF7F2",
    display:"flex", flexDirection:"column", gap:6,
  };
  const labelStyle = {
    fontFamily:"'IBM Plex Mono',monospace", fontSize:8, fontWeight:700,
    letterSpacing:1.2, textTransform:"uppercase", color:"#66708A",
  };
  const credStyle = {
    fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#0F1A2E",
    fontWeight:600,
  };
  return (
    <div style={{
      marginBottom:24,
      display:"grid", gridTemplateColumns:"1fr 1fr", gap:14,
    }}>
      {/* WellEd */}
      <div style={cardStyle}>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:6}}>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:15,fontWeight:600,color:"#6E3F12",letterSpacing:-.1}}>WellEd Labs</div>
          <a href="https://ats.practicetest.io/sign-in" target="_blank" rel="noopener noreferrer" style={{...mkBtn("#6E3F12","#FAF7F2"),padding:"4px 10px",fontSize:10,letterSpacing:.4,textTransform:"uppercase",fontWeight:700,textDecoration:"none"}}>Open ↗</a>
        </div>
        <div style={{fontSize:10,color:"#66708A",lineHeight:1.45}}>
          For your assigned WellEd domain practices and full practice exams.
        </div>
        <div style={{display:"flex",gap:14,flexWrap:"wrap",marginTop:2}}>
          <div>
            <div style={labelStyle}>Email</div>
            <div style={credStyle}>{studentEmail||"—"}</div>
          </div>
          <div>
            <div style={labelStyle}>Password</div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <div style={credStyle}>{showWelledPw?"Ats2025!":"•••••••"}</div>
              <button onClick={()=>setShowWelledPw(s=>!s)} style={{border:"1px solid rgba(15,26,46,.18)",background:"#fff",borderRadius:3,padding:"1px 6px",fontSize:9,cursor:"pointer",letterSpacing:.3,textTransform:"uppercase",fontFamily:"'IBM Plex Mono',monospace",color:"#66708A"}}>{showWelledPw?"Hide":"Show"}</button>
              <button onClick={()=>copy("Ats2025!")} style={{border:"1px solid rgba(15,26,46,.18)",background:"#fff",borderRadius:3,padding:"1px 6px",fontSize:9,cursor:"pointer",letterSpacing:.3,textTransform:"uppercase",fontFamily:"'IBM Plex Mono',monospace",color:"#66708A"}}>Copy</button>
            </div>
          </div>
        </div>
      </div>
      {/* Wise */}
      <div style={cardStyle}>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:6}}>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:15,fontWeight:600,color:"#003258",letterSpacing:-.1}}>Wise</div>
          <a href="https://ats.wise.live/get-started" target="_blank" rel="noopener noreferrer" style={{...mkBtn("#003258","#FAF7F2"),padding:"4px 10px",fontSize:10,letterSpacing:.4,textTransform:"uppercase",fontWeight:700,textDecoration:"none"}}>Open ↗</a>
        </div>
        <div style={{fontSize:10,color:"#66708A",lineHeight:1.45}}>
          Session recordings, scheduling, and class discussions.
        </div>
        <div style={{display:"flex",gap:14,flexWrap:"wrap",marginTop:2}}>
          <div>
            <div style={labelStyle}>Email / Phone</div>
            <div style={credStyle}>{studentEmail||"—"}</div>
          </div>
          <div style={{flex:"1 1 200px",minWidth:0}}>
            <div style={labelStyle}>How to sign in</div>
            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#0F1A2E",lineHeight:1.5,maxWidth:260}}>
              One-time PIN via email or phone, <em>or</em> use the 4-digit login code Wise provided to you.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PortalShell({studentName, studentGrade, onSignOut, switcherSlot, children, impersonating, studentEmail}){
  return (
    <div data-portal="student" style={{minHeight:"100vh",background:"var(--paper)",padding:"28px 32px 80px"}}>
      {/* Session 18B: tutor/admin impersonation banner (read-only marker) */}
      {impersonating && (
        <div style={{position:"sticky",top:0,zIndex:9999,marginBottom:18,padding:"10px 16px",background:"#FFF1DE",border:"1px solid rgba(154,91,31,.45)",borderRadius:4,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8,fontFamily:"'IBM Plex Mono',monospace",fontSize:11,color:"#6E3F12",letterSpacing:.3}}>
          <div>
            <span style={{fontWeight:700,letterSpacing:.6,textTransform:"uppercase",marginRight:8}}>Tutor View</span>
            Reviewing <strong>{studentName || "this student"}</strong>'s portal. Writes are blocked.
          </div>
          <a href={typeof window!=="undefined"?window.location.pathname:"/"} style={{color:"#6E3F12",fontWeight:600,textDecoration:"underline",cursor:"pointer"}}>Exit student view →</a>
        </div>
      )}
      <div style={{maxWidth:960,margin:"0 auto"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:32,flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,letterSpacing:1.4,color:"#66708A",textTransform:"uppercase",marginBottom:4}}>
              Affordable Tutoring Solutions — Student Portal
            </div>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 144',fontSize:36,fontWeight:600,color:"#0F1A2E",letterSpacing:-.6,lineHeight:1.05}}>
              {studentName || "Welcome"}
            </div>
            {studentGrade && (
              <div style={{marginTop:8}}>
                <span style={{...mkPill("transparent","#003258"),border:"1px solid rgba(0,50,88,.28)"}}>Grade {studentGrade}</span>
              </div>
            )}
            {switcherSlot && (
              <div style={{marginTop:14}}>
                {switcherSlot}
              </div>
            )}
          </div>
          <button onClick={onSignOut} style={{
            border:"1px solid rgba(15,26,46,.2)",background:"#fff",color:"#0F1A2E",
            padding:"10px 16px",borderRadius:8,fontFamily:"'Fraunces',Georgia,serif",fontSize:13,
            fontWeight:500,cursor:"pointer"
          }}>Sign out</button>
        </div>
        {/* Session 18C: WellEd + Wise quick-access cards. Always shown.
            Renders shared institutional password for WellEd, prompts
            students to use their own Wise password. */}
        {studentEmail && !impersonating && <StudentExternalLinksCard studentEmail={studentEmail}/>}
        {children}
      </div>
    </div>
  );
}

// Segmented control for the parent portal. Controlled: ParentPortal owns
// selectedId and passes onSelect. Labels prefer student.name, fall back to
// "Child N" while meta is loading or when a per-child fetch failed.
function ChildSwitcher({children, selectedId, onSelect}){
  if(!children || children.length < 2) return null;
  return (
    <div role="tablist" aria-label="Choose a child" style={{
      display:"inline-flex", gap:6, padding:4,
      border:"1px solid rgba(15,26,46,.18)", borderRadius:10, background:"#fff",
      flexWrap:"wrap"
    }}>
      {children.map((c, i) => {
        const active = c.id === selectedId;
        const label = c.name || `Child ${i+1}`;
        return (
          <button
            key={c.id}
            role="tab"
            aria-selected={active}
            onClick={()=>onSelect(c.id)}
            style={{
              border:"none", cursor:"pointer", padding:"8px 14px", borderRadius:7,
              background: active ? "#0F1A2E" : "transparent",
              color: active ? "#fff" : "#0F1A2E",
              fontFamily:"'Fraunces',Georgia,serif", fontVariationSettings:'"opsz" 48',
              fontSize:13, fontWeight: active ? 600 : 500, letterSpacing:-.1,
              display:"flex", alignItems:"center", gap:8,
            }}
          >
            <span>{label}</span>
            {c.grade && (
              <span style={{
                fontFamily:"'IBM Plex Mono',monospace", fontSize:9, letterSpacing:.8,
                textTransform:"uppercase",
                color: active ? "rgba(255,255,255,.65)" : "#66708A",
              }}>
                G{c.grade}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Parent multi-child wrapper. Owns the selected-child state, persists it in
// localStorage, pre-fetches sibling labels, and hands one studentId to the
// existing StudentPortal. Only mounted when role === "parent" and the
// allowlist entry has ≥2 studentIds.
const PORTAL_SELECTED_CHILD_KEY = "psm-portal-selected-child";

function readStoredChildId(){
  try{ return localStorage.getItem(PORTAL_SELECTED_CHILD_KEY) || ""; }
  catch{ return ""; }
}
function writeStoredChildId(id){
  try{ localStorage.setItem(PORTAL_SELECTED_CHILD_KEY, id || ""); }
  catch{ /* private mode — ignore */ }
}

function ParentPortal({onSignOut, currentUserEntry}){
  const studentIds = Array.isArray(currentUserEntry?.studentIds) ? currentUserEntry.studentIds : [];
  const idsKey = studentIds.join(",");

  const [selectedId, setSelectedId] = useState(()=>
    pickParentSelectedChildId(currentUserEntry, readStoredChildId())
  );

  // Re-validate when linked ids change (allowlist updated mid-session).
  // Also self-heals localStorage so a stale stored id doesn't linger forever.
  useEffect(()=>{
    const next = pickParentSelectedChildId(currentUserEntry, selectedId || readStoredChildId());
    if(next !== selectedId){
      setSelectedId(next);
      writeStoredChildId(next);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const meta = usePortalChildrenMeta(studentIds);

  const handleSelect = (id)=>{
    setSelectedId(id);
    writeStoredChildId(id);
  };

  const switcherChildren = meta.children.length
    ? meta.children
    : studentIds.map(id=>({id, name:"", grade:""}));

  const switcher = (
    <ChildSwitcher
      children={switcherChildren}
      selectedId={selectedId}
      onSelect={handleSelect}
    />
  );

  return (
    <StudentPortal
      studentId={selectedId}
      onSignOut={onSignOut}
      currentUserEntry={currentUserEntry}
      switcherSlot={switcher}
    />
  );
}

function PortalTrackingTab({student, submissions}){
  // Session 18C v5: ScoreHistoryPanel in readOnly mode wraps fine for
  // tutors but caused blank-page crashes for student auth (likely a
  // hook ordering issue with useTutorSubmissions inside it under the
  // student's narrower Firestore permissions). Wrapped in an
  // ErrorBoundary so a render error falls through to the legacy view
  // instead of taking the whole portal down.
  return (
    <PortalErrorBoundary fallback={<_LegacyPortalTrackingTab student={student} submissions={submissions}/>}>
      <ScoreHistoryPanel
        p={student}
        readOnly={true}
        sfm={{date:"",testType:"",score:"",max:"",notes:""}}
        setSfm={()=>{}}
        addScore={()=>{}}
        delScore={()=>{}}
        addWelledLog={()=>{}}
        delWelledLog={()=>{}}
      />
    </PortalErrorBoundary>
  );
}

// Tiny class-component error boundary. Catches render errors in the
// readOnly ScoreHistoryPanel and falls back to the legacy view so
// students never see a blank portal.
class PortalErrorBoundary extends React.Component {
  constructor(props){ super(props); this.state = {hasError:false, error:null}; }
  static getDerivedStateFromError(error){ return {hasError:true, error}; }
  componentDidCatch(error, info){ console.warn("[PortalErrorBoundary]", error, info); }
  render(){
    if(this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

// Legacy compact view — was the portal tracking tab before v4. Kept as
// the ErrorBoundary fallback so students always see SOMETHING even if
// the new ScoreHistoryPanel mirror errors out.
function _LegacyPortalTrackingTab({student, submissions}){
  const pts = allScoreDataPoints(student, submissions);
  const diagProfile = (student.diagnostics||[]).length ? buildDiagnosticProfile(student.diagnostics) : null;
  const welled = (student.welledLogs||[]).filter(l=>!l.deleted);

  const fullPts = pts.filter(pt=>{
    const catStr = pt.category||"";
    const isFull = /Total SAT|R&W Section|Math Section|Full —|Section —|Practice|Official SAT|Full Practice|BlueBook|WellEd Full/i.test(catStr);
    return isFull && pt.level!=="domain" && pt.level!=="sub";
  }).sort((a,b)=>(a.date||"").localeCompare(b.date||""));

  // Session 15: PSM submissions with auto-grader scores. Listed newest-first,
  // joined to the assignment's first worksheet title for a human label.
  const psmRows = useMemo(()=>{
    const submitted = (submissions||[]).filter(s => s && s.status === "submitted");
    const assignmentsById = {};
    for(const a of (student.assignments||[])){ if(a && a.id) assignmentsById[a.id] = a; }
    const rows = submitted.map(s => {
      const asg = assignmentsById[s.assignmentId] || null;
      const worksheets = asg ? (asg.worksheets||[]).filter(w => !w.deleted) : [];
      const label = worksheets.length === 0
        ? (asg ? (asg.date || asg.dateAssigned || "Assignment") : "Assignment")
        : (worksheets.length === 1 ? worksheets[0].title : `${worksheets[0].title} + ${worksheets.length - 1} more`);
      const date = asg && (asg.date || asg.dateAssigned) ? (asg.date || asg.dateAssigned) : (s.submittedAt && s.submittedAt.toDate ? s.submittedAt.toDate().toISOString().slice(0,10) : "");
      return {
        id: s.id,
        label,
        date,
        scoreCorrect: typeof s.scoreCorrect === "number" ? s.scoreCorrect : null,
        scoreTotal:   typeof s.scoreTotal === "number" ? s.scoreTotal : null,
        skipReason:   s.gradeSkipReason || null,
        stale:        isSubmissionStaleUnscored(s),
      };
    });
    rows.sort((a,b)=> (b.date||"").localeCompare(a.date||""));
    return rows;
  }, [submissions, student]);

  const anyData = fullPts.length>0 || diagProfile || welled.length>0 || psmRows.length>0;

  if(!anyData){
    return (
      <div style={{...CARD, padding:"60px 40px", textAlign:"center"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:22,color:"#66708A",letterSpacing:-.2,marginBottom:10}}>
          No scores logged yet.
        </div>
        <div style={{fontSize:13,color:"#66708A",lineHeight:1.55}}>
          As you complete practice tests and sessions, your scores will appear here.
        </div>
      </div>
    );
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:24}}>
      <div style={CARD}>
        <PortalSectionHeading>PSM submissions</PortalSectionHeading>
        {psmRows.length===0 ? (
          <PortalEmptyInline copy="No PSMs submitted yet."/>
        ) : (
          <table style={{width:"100%",borderCollapse:"collapse",fontFamily:"'IBM Plex Mono',monospace",fontSize:12}}>
            <thead>
              <tr style={{textAlign:"left",color:"#66708A",fontSize:10,letterSpacing:1,textTransform:"uppercase"}}>
                <th style={{padding:"8px 8px 8px 0",borderBottom:"1px solid rgba(15,26,46,.12)"}}>Date</th>
                <th style={{padding:"8px",borderBottom:"1px solid rgba(15,26,46,.12)"}}>PSM</th>
                <th style={{padding:"8px",borderBottom:"1px solid rgba(15,26,46,.12)",textAlign:"right"}}>Score</th>
              </tr>
            </thead>
            <tbody>
              {psmRows.map(r => {
                const hasScore = r.scoreCorrect !== null && r.scoreTotal !== null;
                const tone = !hasScore ? "#66708A"
                  : r.scoreCorrect === r.scoreTotal ? "#4C7A4C"
                  : r.scoreCorrect === 0 ? "#8C2E2E" : "#9A5B1F";
                return (
                  <tr key={r.id}>
                    <td style={{padding:"10px 8px 10px 0",borderBottom:"1px solid rgba(15,26,46,.06)"}}>{r.date||"—"}</td>
                    <td style={{padding:"10px 8px",borderBottom:"1px solid rgba(15,26,46,.06)",fontFamily:"'Fraunces',Georgia,serif",fontSize:14}}>{r.label}</td>
                    <td style={{padding:"10px 8px",borderBottom:"1px solid rgba(15,26,46,.06)",textAlign:"right",fontWeight:600,color:tone}}>
                      {hasScore
                        ? `${r.scoreCorrect} / ${r.scoreTotal}`
                        : r.skipReason ? `— (${r.skipReason})`
                        : r.stale ? "not graded"
                        : "pending"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div style={CARD}>
        <PortalSectionHeading>Practice exam history</PortalSectionHeading>
        {fullPts.length===0 ? (
          <PortalEmptyInline copy="No practice exam scores recorded."/>
        ) : (
          <table style={{width:"100%",borderCollapse:"collapse",fontFamily:"'IBM Plex Mono',monospace",fontSize:12}}>
            <thead>
              <tr style={{textAlign:"left",color:"#66708A",fontSize:10,letterSpacing:1,textTransform:"uppercase"}}>
                <th style={{padding:"8px 8px 8px 0",borderBottom:"1px solid rgba(15,26,46,.12)"}}>Date</th>
                <th style={{padding:"8px",borderBottom:"1px solid rgba(15,26,46,.12)"}}>Exam</th>
                <th style={{padding:"8px",borderBottom:"1px solid rgba(15,26,46,.12)",textAlign:"right"}}>Score</th>
              </tr>
            </thead>
            <tbody>
              {fullPts.map((pt,i)=>(
                <tr key={i}>
                  <td style={{padding:"10px 8px 10px 0",borderBottom:"1px solid rgba(15,26,46,.06)"}}>{pt.date||"—"}</td>
                  <td style={{padding:"10px 8px",borderBottom:"1px solid rgba(15,26,46,.06)",fontFamily:"'Fraunces',Georgia,serif",fontSize:14}}>{pt.category||"Exam"}</td>
                  <td style={{padding:"10px 8px",borderBottom:"1px solid rgba(15,26,46,.06)",textAlign:"right",fontWeight:600}}>{pt.score ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={CARD}>
        <PortalSectionHeading>Diagnostic profile</PortalSectionHeading>
        {!diagProfile ? (
          <PortalEmptyInline copy="No diagnostic reports uploaded yet."/>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {Object.entries(diagProfile.byDomain||{}).map(([dom, v])=>(
              <div key={dom} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
                <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:14,color:"#0F1A2E"}}>{dom}</div>
                <PctBar value={typeof v?.accuracy==="number"?Math.round(v.accuracy):null} width={120}/>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={CARD}>
        <PortalSectionHeading>WellEd practice log</PortalSectionHeading>
        {welled.length===0 ? (
          <PortalEmptyInline copy="No WellEd practice logged yet."/>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {welled.slice().reverse().map(l=>(
              <div key={l.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:"1px solid rgba(15,26,46,.06)",gap:12,flexWrap:"wrap"}}>
                <div style={{display:"flex",flexDirection:"column",gap:2,minWidth:0}}>
                  <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:14,color:"#0F1A2E"}}>{l.domain||"Domain"} · <span style={{color:"#66708A",fontStyle:"italic"}}>{l.difficulty||""}</span></div>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A"}}>{l.date||""} · {l.subject||""}</div>
                </div>
                <div style={{minWidth:140,textAlign:"right"}}>
                  <PctBar value={typeof l.score==="number"?l.score:(parseInt(l.score,10)||null)} width={100}/>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PortalSectionHeading({children}){
  return (
    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,fontWeight:600,letterSpacing:1.4,color:"#66708A",textTransform:"uppercase",marginBottom:16}}>
      {children}
    </div>
  );
}
function PortalEmptyInline({copy}){
  return (
    <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:14,color:"#66708A",padding:"16px 0"}}>
      {copy}
    </div>
  );
}
function PortalHistoryTab({student, studentId, currentUserEntry, deepLinkAssignmentId, submissions}){
  const [openAssignmentId, setOpenAssignmentId] = useState(null);
  // Session 18A: per-worksheet click-through. When openWorksheetId is
  // set, SubmissionEditor renders ONLY that worksheet; submitting it
  // returns to the PSM detail list (openAssignmentId still set, but
  // openWorksheetId clears) so the student can pick the next worksheet.
  const [openWorksheetId, setOpenWorksheetId] = useState(null);
  const assignments = (student.assignments||[]).filter(a=>!a.deleted);
  // Session 15: build a quick {assignmentId → submission} map so each card
  // can render a done pill + auto-grade score in the header. If multiple
  // submissions exist for one assignment (shouldn't happen — submit is
  // terminal — but be defensive), keep the latest submitted one.
  const submittedByAssignment = useMemo(()=>{
    const out = {};
    for(const s of (submissions||[])){
      if(!s || s.status !== "submitted") continue;
      const prev = out[s.assignmentId];
      if(!prev){ out[s.assignmentId] = s; continue; }
      // Prefer the one with gradedAt set over one without; otherwise latest.
      const prevGraded = typeof prev.scoreCorrect === "number";
      const curGraded = typeof s.scoreCorrect === "number";
      if(curGraded && !prevGraded) out[s.assignmentId] = s;
    }
    return out;
  }, [submissions]);
  useEffect(()=>{
    if(!deepLinkAssignmentId) return;
    const exists = (student.assignments||[]).filter(a=>!a.deleted).some(a=>a.id===deepLinkAssignmentId);
    if(exists) setOpenAssignmentId(deepLinkAssignmentId);
  }, [deepLinkAssignmentId, student]);
  const role = currentUserEntry?.role || null;
  const canEdit = role === "student";

  if(openAssignmentId){
    const asg = assignments.find(a => a.id === openAssignmentId);
    if(!asg){
      setOpenAssignmentId(null);
      setOpenWorksheetId(null);
      return null;
    }
    // Session 18A: drill-down state machine.
    //   no openWorksheetId → render PSM detail (worksheet list with pills)
    //   openWorksheetId set → render SubmissionEditor in single-worksheet
    //                          mode for just that worksheet.
    if(openWorksheetId){
      return (
        <SubmissionEditor
          studentId={studentId}
          assignment={asg}
          focusWorksheetId={openWorksheetId}
          readOnly={!canEdit || !!impersonating}
          onClose={()=>setOpenWorksheetId(null)}
        />
      );
    }
    // PSM detail view — worksheet list with status pills + practice exam
    // / WellEd domain rows for everything else assigned.
    return (
      <AssignmentDetailView
        student={student}
        studentId={studentId}
        assignment={asg}
        submissions={submissions}
        canEdit={canEdit}
        impersonating={impersonating}
        onOpenWorksheet={(wsId)=>setOpenWorksheetId(wsId)}
        onClose={()=>setOpenAssignmentId(null)}
      />
    );
  }

  if(assignments.length===0){
    return (
      <div style={{...CARD, padding:"60px 40px", textAlign:"center"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:22,color:"#66708A",letterSpacing:-.2,marginBottom:10}}>
          No assignments yet.
        </div>
        <div style={{fontSize:13,color:"#66708A",lineHeight:1.55}}>
          Your tutor will start assigning practice here.
        </div>
      </div>
    );
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {assignments.slice().reverse().map(asg=>{
        const worksheets = (asg.worksheets||[]).filter(w=>!w.deleted);
        const welledDomain = (asg.welledDomain||[]).filter(w=>!w.deleted);
        const practiceExams = (asg.practiceExams||[]).filter(e=>!e.deleted);
        // Session 15: per-assignment submission lookup for the done pill.
        const sub = submittedByAssignment[asg.id] || null;
        const isDone = !!sub;
        const hasScore = sub && typeof sub.scoreCorrect === "number" && typeof sub.scoreTotal === "number";
        const scorePillTone = !hasScore ? "#66708A"
          : sub.scoreCorrect === sub.scoreTotal ? "#4C7A4C"
          : sub.scoreCorrect === 0 ? "#8C2E2E" : "#9A5B1F";
        const scorePillBorder = !hasScore ? "rgba(102,112,138,.35)"
          : sub.scoreCorrect === sub.scoreTotal ? "rgba(76,122,76,.4)"
          : sub.scoreCorrect === 0 ? "rgba(140,46,46,.4)" : "rgba(154,91,31,.4)";
        const isStale = isSubmissionStaleUnscored(sub);
        const scorePillLabel = !isDone ? null
          : hasScore ? `Done · ${sub.scoreCorrect} / ${sub.scoreTotal}`
          : isStale ? `Done · Not graded`
          : `Done · Score pending…`;
        return (
          <div key={asg.id} style={{...CARD, padding:20, opacity: isDone ? 0.94 : 1}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,paddingBottom:12,borderBottom:"1px solid rgba(15,26,46,.08)",gap:12,flexWrap:"wrap"}}>
              <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:18,color:"#0F1A2E",fontWeight:600,letterSpacing:-.2}}>
                {asg.date || asg.dateAssigned || "Undated session"}
              </div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {scorePillLabel && (
                  <span style={{...mkPill("transparent", scorePillTone), border:`1px solid ${scorePillBorder}`, fontWeight:600}}>{scorePillLabel}</span>
                )}
                {worksheets.length>0 && <span style={{...mkPill("transparent","#003258"),border:"1px solid rgba(0,50,88,.28)"}}>{worksheets.length} Worksheet{worksheets.length===1?"":"s"}</span>}
                {welledDomain.length>0 && <span style={{...mkPill("transparent","#4C7A4C"),border:"1px solid rgba(76,122,76,.35)"}}>{welledDomain.length} WellEd</span>}
                {practiceExams.length>0 && <span style={{...mkPill("transparent","#6E3F12"),border:"1px solid rgba(154,91,31,.35)"}}>{practiceExams.length} Exam{practiceExams.length===1?"":"s"}</span>}
              </div>
            </div>

            {worksheets.length>0 && (
              <div style={{marginBottom:welledDomain.length||practiceExams.length?14:0, display:"flex", flexDirection:"column", gap:6}}>
                {/* Session 18C v9: each worksheet inline-clickable. Skips
                    the old AssignmentDetailView intermediate page —
                    student picks a worksheet and goes straight to the
                    SubmissionEditor in single-WS mode. */}
                {worksheets.map(w=>{
                  return (
                    <button
                      key={w.id}
                      onClick={()=>{ if(canEdit){ setOpenAssignmentId(asg.id); setOpenWorksheetId(w.id); } }}
                      disabled={!canEdit}
                      style={{
                        textAlign:"left",
                        background:"#fff",
                        border:"1px solid rgba(15,26,46,.12)",
                        borderRadius:6,
                        padding:"10px 12px",
                        cursor: canEdit ? "pointer" : "default",
                        fontFamily:"inherit",
                        display:"flex",
                        alignItems:"center",
                        gap:10,
                        flexWrap:"wrap",
                      }}
                    >
                      <div style={{flex:"1 1 200px",minWidth:0}}>
                        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:14,color:"#0F1A2E",fontWeight:600,letterSpacing:-.1}}>
                          {w.title || `${w.domain||""} — ${w.difficulty||""}`}
                        </div>
                        <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",marginTop:2}}>
                          {w.subject||""} {w.domain?`· ${w.domain}`:""} {w.difficulty?`· ${w.difficulty}`:""}{w.evenOdd?` · ${w.evenOdd}`:""}
                        </div>
                      </div>
                      {canEdit && (
                        <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#9A5B1F",letterSpacing:.6,textTransform:"uppercase"}}>
                          Answer →
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {welledDomain.length>0 && (
              <div style={{marginBottom:practiceExams.length?14:0}}>
                {welledDomain.map(w=>(
                  <div key={w.id} style={{padding:"6px 0",fontFamily:"'Fraunces',Georgia,serif",fontSize:13,color:"#0F1A2E"}}>
                    WellEd · {w.domain} · <span style={{color:"#66708A",fontStyle:"italic"}}>{w.difficulty}</span>
                  </div>
                ))}
              </div>
            )}

            {practiceExams.length>0 && (
              <div>
                {practiceExams.map(e=>(
                  <div key={e.id} style={{padding:"6px 0",fontFamily:"'Fraunces',Georgia,serif",fontSize:13,color:"#0F1A2E"}}>
                    Practice Exam · <span style={{color:"#66708A",fontStyle:"italic"}}>{e.type||"full"}</span>
                  </div>
                ))}
              </div>
            )}
            {/* Session 18C v9: single Answer button removed — worksheets
                are now individually clickable above. Parents still get
                a "View" button to open AssignmentDetailView. */}
            {!canEdit && role === "parent" && (
              <div style={{marginTop:14, paddingTop:12, borderTop:"1px solid rgba(15,26,46,.08)", display:"flex", justifyContent:"flex-end"}}>
                <button
                  onClick={()=>setOpenAssignmentId(asg.id)}
                  style={{
                    border:"1px solid rgba(15,26,46,.2)", background:"#fff", color:"#0F1A2E",
                    padding:"8px 16px", borderRadius:6, cursor:"pointer",
                    fontFamily:"'IBM Plex Mono',monospace", fontSize:10, letterSpacing:1,
                    textTransform:"uppercase",
                  }}
                >View submission</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
function PortalTrendsTab({student}){
  const series = buildScoreTrendsSeries(student);
  return <ScoreTrendsChart series={series}/>;
}

const SUBMIT_EDITOR_BACK_BTN = {
  border:"none", background:"none", cursor:"pointer", padding:0,
  fontFamily:"'IBM Plex Mono',monospace", fontSize:10, letterSpacing:1,
  textTransform:"uppercase", color:"#9A5B1F",
};
const SUBMIT_BTN_STYLE = {
  border:"none", background:"#0F1A2E", color:"#fff", padding:"12px 22px",
  borderRadius:8, fontFamily:"'Fraunces',Georgia,serif", fontSize:14,
  fontWeight:600, cursor:"pointer", letterSpacing:-.1,
};
const SUBMIT_BTN_STYLE_DISABLED = {
  ...SUBMIT_BTN_STYLE, background:"#C9CEDC", cursor:"not-allowed",
};

// Inline PDF viewer using pdf.js (loaded globally by index.html). Fetches the
// URL client-side and rasterizes each page to a canvas. Renders a graceful
// "couldn't load" fallback on any error — CORS (OneDrive), 403 (Storage rules),
// network, or pdf.js not loaded. Answer rows always remain usable.
function InlinePdfViewer({url}){
  const containerRef = useRef(null);
  const [status, setStatus] = useState("loading");
  const [pageCount, setPageCount] = useState(0);

  useEffect(()=>{
    let cancelled = false;
    const container = containerRef.current;
    if(!container) return;
    if(!url){ setStatus("error"); return; }
    if(!window.pdfjsLib){ setStatus("error"); return; }

    // Clear any prior render if the URL changes.
    container.innerHTML = "";
    setStatus("loading");
    setPageCount(0);

    (async () => {
      try {
        const pdf = await window.pdfjsLib.getDocument({url}).promise;
        if(cancelled) return;
        setPageCount(pdf.numPages);
        for(let pageNum=1; pageNum<=pdf.numPages; pageNum++){
          if(cancelled) return;
          const page = await pdf.getPage(pageNum);
          // Session 18B: bumped scale 1.35 → 1.65 so the worksheet text
          // is readable when the PDF viewer is in a narrow column.
          const viewport = page.getViewport({scale: 1.65});
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.display = "block";
          canvas.style.marginBottom = "8px";
          canvas.style.maxWidth = "100%";
          canvas.style.height = "auto";
          canvas.style.boxShadow = "0 1px 3px rgba(15,26,46,.12)";
          container.appendChild(canvas);
          const ctx = canvas.getContext("2d");
          await page.render({canvasContext: ctx, viewport}).promise;
        }
        if(!cancelled) setStatus("ready");
      } catch(err){
        console.warn("[portal] pdf viewer error:", err);
        if(!cancelled) setStatus("error");
      }
    })();

    return ()=>{ cancelled = true; };
  }, [url]);

  return (
    <div style={{
      border:"1px solid rgba(15,26,46,.1)", borderRadius:8, padding:10,
      background:"#F7F5EF",
      // Session 18B: viewer pane now sticks to the top of its grid cell
      // and gets up to 88vh of vertical room. Was maxHeight:900 with no
      // sticky behavior — when a PSM had multiple worksheets the lower
      // PDFs scrolled out of view while the user was still answering.
      maxHeight:"88vh", overflowY:"auto", boxSizing:"border-box",
      position:"sticky", top:14,
    }}>
      {status === "loading" && (
        <div style={{textAlign:"center", padding:"40px 0", fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#66708A", letterSpacing:1, textTransform:"uppercase"}}>
          Loading PDF…
        </div>
      )}
      {status === "error" && (
        <div style={{textAlign:"center", padding:"40px 12px"}}>
          <div style={{fontFamily:"'Fraunces',Georgia,serif", fontStyle:"italic", color:"#8C2E2E", fontSize:14, marginBottom:8}}>
            Couldn't load the PDF here.
          </div>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" style={{
              fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#9A5B1F",
              letterSpacing:1, textTransform:"uppercase", textDecoration:"none",
              border:"1px solid rgba(154,91,31,.4)", padding:"6px 12px", borderRadius:4,
              display:"inline-block",
            }}>Open externally →</a>
          )}
        </div>
      )}
      <div ref={containerRef} style={{display: status==="ready" ? "block" : "none"}}/>
      {status === "ready" && pageCount > 0 && (
        <div style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:9, color:"#66708A", textAlign:"center", marginTop:4, letterSpacing:1}}>
          {pageCount} PAGE{pageCount===1?"":"S"}
        </div>
      )}
    </div>
  );
}

// Session 18A bug fix: a number input that does NOT round-trip every
// keystroke through global state. Internal state holds the in-progress
// value while the user is typing; the parent's onCommit fires on blur
// or after a 1.5s pause. This eliminates the race where Firestore
// listener ticks (from another tutor's writes, the consultation seed,
// dual-write to psm-data/main, or per-doc snapshot fan-out) clobber
// half-typed input. The previous design called setStudents on every
// keystroke, so each tick fired a listener that replaced state with
// Firestore's view — wiping the in-progress edit.
function ScoreInput({value, onCommit, min, max, placeholder, style, title}){
  const [local, setLocal] = useState(value == null ? "" : String(value));
  const dirtyRef = useRef(false);
  const lastCommittedRef = useRef(value == null ? "" : String(value));
  const debounceRef = useRef(null);
  // External value updates while NOT being edited should sync into local
  // state. While editing (dirty), we ignore external changes so they
  // can't clobber typing.
  useEffect(()=>{
    const incoming = value == null ? "" : String(value);
    if(dirtyRef.current) return;
    if(incoming !== local) setLocal(incoming);
    lastCommittedRef.current = incoming;
  }, [value]);
  const commit = (next) => {
    dirtyRef.current = false;
    if(next === lastCommittedRef.current) return;
    lastCommittedRef.current = next;
    onCommit(next);
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      placeholder={placeholder}
      value={local}
      title={title}
      onChange={(e)=>{
        dirtyRef.current = true;
        setLocal(e.target.value);
        if(debounceRef.current) clearTimeout(debounceRef.current);
        // Auto-commit 1.5s after the last keystroke so paste-and-tab-out
        // patterns work too. The blur handler will fire first if the
        // user clicks/tabs away sooner — the dirty flag prevents double
        // commits.
        debounceRef.current = setTimeout(()=>{
          if(dirtyRef.current) commit(local + ""); // ref of latest may lag — use closure
        }, 1500);
      }}
      onBlur={()=>{
        if(debounceRef.current){ clearTimeout(debounceRef.current); debounceRef.current = null; }
        commit(local);
      }}
      style={style}
    />
  );
}

// Session 18A: per-question flag toggle. Two small buttons next to each
// answer slot — star ("I had trouble but answered") and ? ("I had no
// clue, leaving blank intentionally"). Mutually exclusive; clicking the
// active flag clears it. Star is informational; ? causes the grader to
// treat the answer as blank.
function FlagToggle({flag, onToggle}){
  const btn = (active, color, bg) => ({
    width:22, height:22, borderRadius:4, padding:0,
    border:`1px solid ${active?color:"rgba(15,26,46,.18)"}`,
    background: active?bg:"transparent",
    color: active?color:"#9AA3B8",
    fontFamily:"'IBM Plex Mono',monospace", fontSize:13, fontWeight:700,
    cursor:"pointer", lineHeight:1,
    display:"inline-flex", alignItems:"center", justifyContent:"center",
  });
  const starOn = flag === "star";
  const qOn = flag === "question";
  return (
    <span style={{display:"inline-flex", gap:4, flexShrink:0}}>
      <button
        type="button"
        title={starOn ? "Clear star (you marked: had trouble)" : "Star: I had trouble on this question"}
        onClick={()=> onToggle("star")}
        style={btn(starOn, "#9A5B1F", "#FFF1DE")}
      >★</button>
      <button
        type="button"
        title={qOn ? "Clear ? (you marked: no clue, leave blank — counts as 0)" : "? : I had no clue — leave blank, counts as 0"}
        onClick={()=> onToggle("question")}
        style={btn(qOn, "#5C4178", "#EFE8F5")}
      >?</button>
    </span>
  );
}

// Read-only flag badge for the locked / submitted view. Shows whatever
// flag was on the response when it was submitted.
function FlagBadge({flag}){
  if(!flag) return <span style={{width:22, flexShrink:0}}/>;
  if(flag === "star"){
    return (
      <span title="Student starred: had trouble" style={{
        width:22, height:22, borderRadius:4, flexShrink:0,
        display:"inline-flex", alignItems:"center", justifyContent:"center",
        background:"#FFF1DE", color:"#9A5B1F",
        fontFamily:"'IBM Plex Mono',monospace", fontSize:13, fontWeight:700,
      }}>★</span>
    );
  }
  if(flag === "question"){
    return (
      <span title="Student marked ?: no clue, intentionally blank" style={{
        width:22, height:22, borderRadius:4, flexShrink:0,
        display:"inline-flex", alignItems:"center", justifyContent:"center",
        background:"#EFE8F5", color:"#5C4178",
        fontFamily:"'IBM Plex Mono',monospace", fontSize:13, fontWeight:700,
      }}>?</span>
    );
  }
  return <span style={{width:22, flexShrink:0}}/>;
}

// Session 15: per-question correctness indicator rendered to the right of
// each answer row when the submission is graded and locked. Receives the
// perQuestion[i] entry from the submission doc (may be null for skipped).
// Option C (Kiran directive): reveals the stored correct answer next to
// every graded question for pedagogical feedback. Skipped questions show
// only the "—" glyph with no reveal.
// Session 18C v6: compact summary review chip grid. Same visual
// vocabulary as the tutor's TutorSubmissionRow per-question chips:
// green=correct, red=wrong-with-correct-answer-in-parens, amber=skipped,
// flags overlaid as ★ / ?. Used at the top of student's locked
// SubmissionEditor so they can scan the whole PSM's results in one
// glance before drilling into per-question detail rows.
function SubmissionReviewGrid({worksheets, perQuestion, responses}){
  // Index perQuestion + responses for fast lookup by (worksheetId, idx).
  const pqByKey = new Map();
  for(const pq of (perQuestion || [])){
    if(pq && pq.worksheetId !== undefined && pq.questionIndex !== undefined){
      pqByKey.set(`${pq.worksheetId}|${pq.questionIndex}`, pq);
    }
  }
  const respByKey = new Map();
  for(const r of (responses || [])){
    if(r && r.worksheetId !== undefined && r.questionIndex !== undefined){
      respByKey.set(`${r.worksheetId}|${r.questionIndex}`, r);
    }
  }
  // Group by worksheet for the section headers.
  const wsList = (worksheets || []).filter(w => w && w.id);
  if(wsList.length === 0) return null;
  return (
    <div style={{margin:"4px 0 18px",display:"flex",flexDirection:"column",gap:10}}>
      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:1.4,color:"#66708A",textTransform:"uppercase"}}>
        Review Summary
      </div>
      {wsList.map((w, wIdx) => {
        // Gather all (responses + perQuestion entries) for this worksheet.
        // We render slots 0..max(seen index) so blanks at the end of a
        // worksheet still appear.
        const slots = [];
        for(let i = 0; i < 100; i++){
          const r = respByKey.get(`${w.id}|${i}`);
          const pq = pqByKey.get(`${w.id}|${i}`);
          if(r === undefined && pq === undefined) {
            // Heuristic: stop walking once we've passed the last response/result.
            // Look ahead 5 — if none found, break.
            let any = false;
            for(let k = 1; k <= 5; k++){
              if(respByKey.has(`${w.id}|${i+k}`) || pqByKey.has(`${w.id}|${i+k}`)){ any = true; break; }
            }
            if(!any) break;
          }
          slots.push({i, r, pq});
        }
        if(slots.length === 0) return null;
        const ok = slots.filter(s => s.pq && s.pq.correct === true).length;
        const wrong = slots.filter(s => s.pq && s.pq.correct === false).length;
        const ungraded = slots.length - ok - wrong;
        const hasAnyFlag = slots.some(s => s.r && s.r.flag);
        return (
          <div key={w.id} style={{padding:"10px 12px",background:"#FAF7F2",borderRadius:4,border:"1px solid rgba(15,26,46,.08)"}}>
            <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:8,gap:8,flexWrap:"wrap"}}>
              <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:13,fontWeight:600,color:"#0F1A2E",letterSpacing:-.1}}>
                {w.title || `Worksheet ${wIdx+1}`}
              </div>
              <div style={{display:"flex",gap:6,fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,letterSpacing:.6}}>
                <span style={{color:"#4C7A4C"}}>✓ {ok}</span>
                <span style={{color:"#8C2E2E"}}>✗ {wrong}</span>
                {ungraded > 0 && <span style={{color:"#9A5B1F"}}>— {ungraded}</span>}
              </div>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:"6px 8px",fontFamily:"'IBM Plex Mono',monospace",fontSize:12}}>
              {slots.map(({i, r, pq})=>{
                const ans = r && typeof r.studentAnswer === "string" ? r.studentAnswer.trim() : "";
                const isBlank = ans.length === 0;
                const flag = r && r.flag ? r.flag : null;
                const flagIcon = flag === "star" ? "★" : flag === "question" ? "?" : null;
                const flagColor = flag === "star" ? "#9A5B1F" : flag === "question" ? "#5C4178" : null;
                let bg="#fff", fg="#0F1A2E", border="rgba(15,26,46,.12)", reveal=null;
                if(pq){
                  if(pq.correct === true){
                    bg="#E4F0E2"; fg="#2D5A2D"; border="rgba(76,122,76,.4)";
                  } else if(pq.correct === false){
                    bg="#F4DADA"; fg="#7A2020"; border="rgba(140,46,46,.4)";
                    reveal = pq.correctAnswer;
                  } else {
                    bg="#FFF1DE"; fg="#7A5318"; border="rgba(154,91,31,.4)";
                  }
                }
                return (
                  <span key={i} style={{
                    display:"inline-flex",alignItems:"center",gap:4,
                    padding:"3px 8px",borderRadius:4,
                    background:bg, color:fg, border:`1px solid ${border}`,
                  }}>
                    <span style={{opacity:.7,fontWeight:500}}>{i+1}.</span>
                    <span style={{fontStyle:isBlank?"italic":"normal",fontWeight:isBlank?400:600,opacity:isBlank?.65:1}}>
                      {isBlank ? "blank" : ans}
                    </span>
                    {reveal && <span style={{opacity:.8,fontWeight:500}}>(✓ {reveal})</span>}
                    {flagIcon && (
                      <span style={{color:flagColor,fontWeight:700,marginLeft:2}} title={flag === "star" ? "I had trouble" : "I guessed / skipped"}>
                        {flagIcon}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
            {hasAnyFlag && (
              <div style={{marginTop:6,fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:.3,lineHeight:1.5}}>
                <span style={{color:"#9A5B1F",fontWeight:700,marginRight:3}}>★</span> had trouble
                <span style={{marginLeft:12,color:"#5C4178",fontWeight:700,marginRight:3}}>?</span> guessed / skipped
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AnswerResultIndicator({result}){
  if(!result){
    return <span style={{width:22, flexShrink:0}}/>;
  }
  const circleBase = {
    width:22, height:22, borderRadius:"50%", flexShrink:0,
    display:"inline-flex", alignItems:"center", justifyContent:"center",
    fontFamily:"'IBM Plex Mono',monospace", fontSize:14, fontWeight:700, lineHeight:1,
  };
  const revealBase = {
    fontFamily:"'IBM Plex Mono',monospace", fontSize:10,
    letterSpacing:.5, whiteSpace:"nowrap",
    maxWidth:140, overflow:"hidden", textOverflow:"ellipsis",
  };

  if(result.correct === true){
    return (
      <span style={{display:"inline-flex", alignItems:"center", gap:6, flexShrink:0}}>
        <span title="Correct" style={{...circleBase, background:"#E4F0E2", color:"#4C7A4C"}}>✓</span>
        {result.correctAnswer && (
          <span style={{...revealBase, color:"#4C7A4C"}} title={`Correct answer: ${result.correctAnswer}`}>
            {result.correctAnswer}
          </span>
        )}
      </span>
    );
  }
  if(result.correct === false){
    return (
      <span style={{display:"inline-flex", alignItems:"center", gap:6, flexShrink:0}}>
        <span title="Incorrect" style={{...circleBase, background:"#F4DADA", color:"#8C2E2E"}}>✗</span>
        {result.correctAnswer && (
          <span style={{...revealBase, color:"#8C2E2E"}} title={`Correct answer: ${result.correctAnswer}`}>
            {result.correctAnswer}
          </span>
        )}
      </span>
    );
  }
  // correct === null — skipped (missing-key / unsupported / out-of-range).
  const reason = result.skipReason || "not-graded";
  return (
    <span title={`Not graded: ${reason}`} style={{...circleBase, background:"#FFF1DE", color:"#9A5B1F"}}>—</span>
  );
}

// One block per worksheet inside an assignment. Reads catalogEntry via
// Session 14's catalog join to produce bubble-sheet inputs; falls through to
// a per-worksheet textarea when the catalog match or questionIds[] is missing.
// Answer state is owned by the parent SubmissionEditor — this component is
// a controlled view.
//
// Session 15: `results` is an optional per-question array from the graded
// submission doc, indexed by questionIndex. When present (and isLocked),
// each row renders a correctness glyph next to the answer.
// Session 18A: returns true when this question index is included in the
// assigned subset. Display numbers are 1-indexed; array indices are
// 0-indexed. ODD subset = display 1,3,5,... = i % 2 === 0. EVEN subset
// = display 2,4,6,... = i % 2 === 1. "ALL" / null / undefined / "" =
// every question is in the subset.
function isInSubset(i, subset){
  const s = (subset || "").toUpperCase();
  if(s === "EVEN") return i % 2 === 1;
  if(s === "ODD") return i % 2 === 0;
  return true;
}

function WorksheetBlock({worksheet, catalogEntry, answers, onAnswersChange, flags, onFlagsChange, isLocked, indexLabel, results, showResults}){
  const hasCatalog = !!(catalogEntry && Array.isArray(catalogEntry.questionIds) && catalogEntry.questionIds.length > 0);
  const format = hasCatalog ? catalogEntry.answerFormat : null;
  const pdfUrl = (catalogEntry && catalogEntry.stu) || worksheet.url || null;
  // Session 18A: subset = "EVEN" | "ODD" | null (= all). Render full list
  // but mark non-subset rows as inactive — the student sees the full
  // worksheet PDF (so question numbering matches) but can only answer
  // their assigned half.
  const subset = worksheet.evenOdd || null;

  const headerTitle = worksheet.title || `${worksheet.domain||""} — ${worksheet.difficulty||""}`;
  const subsetLabel = subset === "EVEN"
    ? "even questions only"
    : subset === "ODD"
      ? "odd questions only"
      : null;
  const headerSub = [worksheet.subject, worksheet.domain, worksheet.difficulty, subsetLabel].filter(Boolean).join(" · ");

  const setAnswerAt = (i, value) => {
    if(isLocked) return;
    const next = answers.slice();
    while(next.length <= i) next.push("");
    next[i] = value;
    onAnswersChange(next);
  };

  // Session 18A: per-question flag toggle. Click star → set/clear star;
  // click ? → set/clear question. Clicking the active flag clears it.
  // Both flags are mutually exclusive on a given question (toggling on
  // one clears the other).
  const setFlagAt = (i, value) => {
    if(isLocked) return;
    if(!onFlagsChange) return;
    const next = (flags || []).slice();
    while(next.length <= i) next.push(null);
    next[i] = next[i] === value ? null : value;
    onFlagsChange(next);
  };

  // Session 18C v10: per-question answer type. For "mixed" worksheets,
  // catalogEntry.questionTypes[i] tells us whether THIS specific question
  // is MC ("mc") or numeric ("fr"). When present we render the correct
  // input only — no more "bubbles AND numeric for every question."
  //
  // Backfilled by scripts/backfill_question_types.mjs from
  // extraction_output.json. Falls back to the both-shown mixed renderer
  // when questionTypes isn't present (legacy data).
  const perQuestionTypes = (catalogEntry && Array.isArray(catalogEntry.questionTypes))
    ? catalogEntry.questionTypes
    : null;
  const renderRow = (i) => {
    const value = answers[i] || "";
    if(format === "multiple-choice"){
      return renderMcRow(i, value, v => setAnswerAt(i, v), isLocked);
    }
    if(format === "free-response"){
      return renderFrRow(i, value, v => setAnswerAt(i, v), isLocked);
    }
    if(format === "mixed"){
      // Prefer per-question type when available.
      const t = perQuestionTypes ? perQuestionTypes[i] : null;
      if(t === "mc")  return renderMcRow(i, value, v => setAnswerAt(i, v), isLocked);
      if(t === "fr")  return renderFrRow(i, value, v => setAnswerAt(i, v), isLocked);
      // No per-question type known — fall back to both-shown.
      return renderMixedRow(i, value, v => setAnswerAt(i, v), isLocked);
    }
    return null;
  };

  return (
    <div style={{
      marginTop:20, paddingTop:20,
      borderTop:"1px solid rgba(15,26,46,.12)",
    }}>
      <div style={{marginBottom:12}}>
        <div style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:9, color:"#66708A", letterSpacing:1, textTransform:"uppercase", marginBottom:4}}>
          {indexLabel}
        </div>
        <div style={{fontFamily:"'Fraunces',Georgia,serif", fontSize:18, color:"#0F1A2E", fontWeight:600, letterSpacing:-.1}}>
          {headerTitle}
        </div>
        {headerSub && (
          <div style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#66708A", marginTop:2}}>
            {headerSub}
          </div>
        )}
      </div>

      {hasCatalog ? (
        // Session 15: widen the answer column when graded to accommodate
        // the per-row correctness indicator + correct-answer reveal.
        // Session 18A: widened a bit more to fit the star/? flag toggles.
        <div style={{display:"grid", gridTemplateColumns: (isLocked && results) ? "minmax(0, 1fr) 380px" : "minmax(0, 1fr) 300px", gap:20, alignItems:"start"}}>
          <InlinePdfViewer url={pdfUrl}/>
          <div style={{display:"flex", flexDirection:"column", gap:8}}>
            {catalogEntry.questionIds.map((_qid, i) => {
              const currentFlag = (flags && flags[i]) || null;
              // Session 18A: render the row only if the question is in
              // the assigned subset. Non-subset rows are shown as
              // muted "not assigned" placeholders so the student can
              // see which questions belong to a different half — but
              // can't type anything into them.
              const inSubset = isInSubset(i, subset);
              if(!inSubset){
                return (
                  <div key={i} style={{display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:"1px solid rgba(15,26,46,.05)", opacity:.35}}>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#66708A", width:24, flexShrink:0}}>
                      {i+1}.
                    </div>
                    <div style={{flex:1, minWidth:0, fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#9AA3B8", fontStyle:"italic"}}>
                      not assigned ({subset === "EVEN" ? "even" : "odd"}-only)
                    </div>
                    <span style={{width:22, flexShrink:0}}/>
                  </div>
                );
              }
              return (
                <div key={i} style={{display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:"1px solid rgba(15,26,46,.05)"}}>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#66708A", width:24, flexShrink:0}}>
                    {i+1}.
                  </div>
                  <div style={{flex:1, minWidth:0}}>
                    {renderRow(i)}
                  </div>
                  {!isLocked && (
                    <FlagToggle flag={currentFlag} onToggle={(v)=> setFlagAt(i, v)}/>
                  )}
                  {isLocked && (
                    <FlagBadge flag={(results && results[i] && results[i].flag) || currentFlag}/>
                  )}
                  {/* Session 18C v7: only reveal right/wrong + correct
                      answer AFTER the student submits. While drafting,
                      results is null anyway (grader hasn't fired); but
                      gate on showResults explicitly so a future
                      readOnly preview-while-drafting flow can't leak. */}
                  {showResults && results && (
                    <AnswerResultIndicator result={results[i]}/>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div>
          <div style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#8C6A2E", marginBottom:8, fontStyle:"italic"}}>
            No bubble sheet available for this worksheet — type your answers below.
          </div>
          {pdfUrl && <InlinePdfViewer url={pdfUrl}/>}
          <textarea
            value={answers[0] || ""}
            onChange={e => setAnswerAt(0, e.target.value)}
            disabled={isLocked}
            placeholder={"Type your answers here. Example:\n\n1. B\n2. C\n3. A"}
            style={{
              width:"100%", minHeight:160, padding:"12px 14px", borderRadius:8,
              border:"1px solid rgba(15,26,46,.2)", fontFamily:"'IBM Plex Mono',monospace",
              fontSize:14, lineHeight:1.6, color:"#0F1A2E", resize:"vertical",
              boxSizing:"border-box", marginTop:10,
            }}
          />
        </div>
      )}
    </div>
  );
}

// MC row: A/B/C/D chip row. Chip click sets answer to that letter; clicking
// the selected letter clears it.
function renderMcRow(i, value, onChange, isLocked){
  const letters = ["A","B","C","D"];
  return (
    <div style={{display:"flex", gap:6}}>
      {letters.map(L => {
        const selected = value === L;
        return (
          <button
            key={L}
            disabled={isLocked}
            onClick={()=> onChange(selected ? "" : L)}
            style={{
              width:36, height:32, borderRadius:6,
              border:`1px solid ${selected?"#0F1A2E":"rgba(15,26,46,.22)"}`,
              background: selected?"#0F1A2E":"#fff",
              color: selected?"#fff":"#0F1A2E",
              fontFamily:"'IBM Plex Mono',monospace", fontSize:13, fontWeight:600,
              cursor: isLocked?"not-allowed":"pointer",
            }}
          >{L}</button>
        );
      })}
    </div>
  );
}

// FR row: single numeric input. Text type (not number) so "3/4" and "0.25" both work.
function renderFrRow(i, value, onChange, isLocked){
  return (
    <input
      type="text"
      value={value}
      disabled={isLocked}
      onChange={e => onChange(e.target.value)}
      placeholder="Your answer"
      style={{
        width:"100%", maxWidth:220, padding:"8px 12px", borderRadius:6,
        border:"1px solid rgba(15,26,46,.22)",
        fontFamily:"'IBM Plex Mono',monospace", fontSize:13, color:"#0F1A2E",
        boxSizing:"border-box",
      }}
    />
  );
}

// Mixed row: both MC chips AND a numeric input, both live. Whichever the
// student fills wins. If both are filled, the text input takes precedence
// (last-write-wins on the shared answer slot).
function renderMixedRow(i, value, onChange, isLocked){
  const isMc = value === "A" || value === "B" || value === "C" || value === "D";
  return (
    <div style={{display:"flex", gap:10, alignItems:"center", flexWrap:"wrap"}}>
      {renderMcRow(i, isMc ? value : "", onChange, isLocked)}
      <span style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:9, color:"#66708A", letterSpacing:1}}>OR</span>
      <input
        type="text"
        value={isMc ? "" : value}
        disabled={isLocked}
        onChange={e => onChange(e.target.value)}
        placeholder="Numeric"
        style={{
          flex:"1 1 140px", maxWidth:180, padding:"8px 12px", borderRadius:6,
          border:"1px solid rgba(15,26,46,.22)",
          fontFamily:"'IBM Plex Mono',monospace", fontSize:13, color:"#0F1A2E",
          boxSizing:"border-box",
        }}
      />
    </div>
  );
}

// Session 18A: PSM detail view. Shown when the student opens a PSM from
// their history. Lists every worksheet in the PSM as a clickable card with
// per-worksheet status (Not started / In progress / Submitted / Graded).
// Clicking a card opens that worksheet's SubmissionEditor in single-WS
// mode. Submitting one comes back here so the student sees what's left.
function AssignmentDetailView({student, studentId, assignment, submissions, canEdit, impersonating, onOpenWorksheet, onClose}){
  // Per-worksheet status is derived from two sources:
  //   1. legacy submissions/{subId} — responses[] entries tagged by
  //      worksheetId (the existing whole-PSM submission model).
  //   2. assignments/{aid}/worksheetSubmissions/{wsId} — new per-WS docs
  //      from the 18A wire-up (live for users with the flag enabled).
  // We prefer the per-WS doc when it exists for a worksheet; fall back to
  // the legacy submission's responses[] for any worksheet without one.
  const perWs = useWorksheetSubmissions(studentId, assignment.id);
  const legacy = (submissions || []).find(s => s && s.assignmentId === assignment.id) || null;

  const worksheets = (assignment.worksheets || []).filter(w => !w.deleted);
  const welledDomain = (assignment.welledDomain || []).filter(w => !w.deleted);
  const practiceExams = (assignment.practiceExams || []).filter(e => !e.deleted);

  // Compute one of: not-started | in-progress | submitted | graded
  // per worksheet from whichever data source has the freshest info.
  function statusFor(wsId){
    const perDoc = perWs.byWorksheet[wsId];
    if(perDoc){
      if(typeof perDoc.scoreCorrect === "number") return { kind: "graded", score: `${perDoc.scoreCorrect} / ${perDoc.scoreTotal}` };
      if(perDoc.status === "submitted") return { kind: "submitted" };
      const hasAnyAnswer = (perDoc.responses || []).some(r => (r.studentAnswer || "").trim() !== "");
      return hasAnyAnswer ? { kind: "in-progress" } : { kind: "not-started" };
    }
    // Session 18C v12: when legacy is submitted, only mark THIS worksheet
    // as submitted if it had data in responses. Otherwise treat it as
    // not-started so the student can drill in and answer it via the
    // per-WS path. Fixes the case where a buggy whole-PSM submit locked
    // unfinished worksheets.
    if(legacy && legacy.status === "submitted"){
      const has = (legacy.responses || []).some(r => r && r.worksheetId === wsId && (r.studentAnswer || "").trim() !== "");
      return has ? { kind: "submitted" } : { kind: "not-started" };
    }
    if(legacy && Array.isArray(legacy.responses)){
      const has = legacy.responses.some(r => r && r.worksheetId === wsId && (r.studentAnswer || "").trim() !== "");
      return has ? { kind: "in-progress" } : { kind: "not-started" };
    }
    return { kind: "not-started" };
  }

  const STATUS_STYLE = {
    "not-started":  { bg: "transparent",  fg: "#66708A",  border: "rgba(15,26,46,.18)", label: "Not started"  },
    "in-progress":  { bg: "#FFF1DE",      fg: "#9A5B1F",  border: "rgba(154,91,31,.4)", label: "In progress"  },
    "submitted":    { bg: "#E9F0F6",      fg: "#003258",  border: "rgba(0,50,88,.35)",  label: "Submitted"    },
    "graded":       { bg: "#E4F0E2",      fg: "#4C7A4C",  border: "rgba(76,122,76,.4)", label: "Graded"       },
  };

  // Roll-up progress for the header pill.
  const statuses = worksheets.map(w => statusFor(w.id).kind);
  const doneCount = statuses.filter(k => k === "submitted" || k === "graded").length;

  return (
    <div style={{...CARD, padding:"24px 22px"}}>
      <button onClick={onClose} style={SUBMIT_EDITOR_BACK_BTN}>← Back to my assignments</button>
      <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginTop:14,gap:12,flexWrap:"wrap"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:24,fontWeight:600,color:"#0F1A2E",letterSpacing:-.2}}>
          {assignment.date || assignment.dateAssigned || "Assignment"}
        </div>
        {worksheets.length > 0 && (
          <span style={{...mkPill("transparent","#003258"),border:"1px solid rgba(0,50,88,.28)"}}>
            {doneCount} / {worksheets.length} done
          </span>
        )}
      </div>
      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",letterSpacing:.6,textTransform:"uppercase",marginTop:6,marginBottom:18}}>
        Click a worksheet to answer it. Submit each one and come back here for the next.
      </div>

      {worksheets.length > 0 && (
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:18}}>
          {worksheets.map(w => {
            const st = statusFor(w.id);
            const sty = STATUS_STYLE[st.kind] || STATUS_STYLE["not-started"];
            const isDone = st.kind === "submitted" || st.kind === "graded";
            const ctaLabel = isDone ? "Review →" : "Answer →";
            return (
              <button
                key={w.id}
                onClick={() => onOpenWorksheet(w.id)}
                disabled={!canEdit && !isDone}
                style={{
                  textAlign:"left",
                  padding:"14px 16px",
                  borderRadius:6,
                  border:`1px solid ${sty.border}`,
                  background:"#fff",
                  cursor:"pointer",
                  display:"flex",
                  alignItems:"center",
                  gap:14,
                  flexWrap:"wrap",
                  fontFamily:"inherit",
                }}
              >
                <div style={{flex:"1 1 200px",minWidth:0}}>
                  <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:15,color:"#0F1A2E",fontWeight:600,letterSpacing:-.1}}>
                    {w.title || `${w.domain||""} — ${w.difficulty||""}`}
                  </div>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",marginTop:2}}>
                    {w.subject||""}{w.domain?` · ${w.domain}`:""}{w.difficulty?` · ${w.difficulty}`:""}{w.evenOdd?` · ${w.evenOdd}`:""}
                  </div>
                </div>
                <span style={{
                  fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,
                  letterSpacing:.6,textTransform:"uppercase",
                  padding:"4px 10px",borderRadius:3,
                  background:sty.bg, color:sty.fg, border:`1px solid ${sty.border}`,
                  flexShrink:0,
                }}>
                  {st.kind === "graded" ? `Graded · ${st.score}` : sty.label}
                </span>
                <span style={{
                  fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#0F1A2E",
                  letterSpacing:.6,textTransform:"uppercase",fontWeight:600,flexShrink:0,
                }}>{ctaLabel}</span>
              </button>
            );
          })}
        </div>
      )}

      {(welledDomain.length > 0 || practiceExams.length > 0) && (
        <div style={{padding:"12px 14px",background:"#FAF7F2",borderRadius:6,border:"1px solid rgba(15,26,46,.08)",fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",lineHeight:1.6}}>
          This PSM also includes{" "}
          {welledDomain.length > 0 && <span><strong>{welledDomain.length}</strong> WellEd domain practice{welledDomain.length===1?"":"s"}</span>}
          {welledDomain.length > 0 && practiceExams.length > 0 && " and "}
          {practiceExams.length > 0 && <span><strong>{practiceExams.length}</strong> practice exam{practiceExams.length===1?"":"s"}</span>}
          {". Do those on WellEd / BlueBook — tutor logs the scores."}
        </div>
      )}
    </div>
  );
}

// Per-assignment submission entry. Drill-in from PortalHistoryTab. Parents
// reach this in readOnly mode — never editable. Students in editable mode
// autosave drafts to /students/{id}/submissions/{subId} on a 750ms debounce
// and lock to "submitted" via a single write when they click Submit.
// Session 18C v12: per-worksheet editor for focus-mode (drill-in from
// LatestPsmCard or AssignmentDetailView). Writes ONLY to the per-WS doc
// at students/{sid}/assignments/{aid}/worksheetSubmissions/{wsId} — does
// NOT touch the legacy whole-PSM submissions/{subId} doc.
//
// Bug being fixed: previously SubmissionEditor in focus mode wrote to
// the legacy submission and flipped its status to "submitted" when the
// student hit Submit on a single worksheet. That marked the WHOLE PSM
// as submitted, locking all other worksheets the student hadn't done
// yet (E. Camerucci's session — submitted worksheet 1, the rest got
// auto-locked).
//
// This component is intentionally self-contained — no useSubmissionDraft,
// no writeDraftRef wiring through the larger SubmissionEditor. Each
// worksheet drill-in opens a fresh per-WS doc lifecycle.
function SingleWorksheetEditor({studentId, assignment, worksheetId, readOnly, onClose}){
  const {catalog, status: catalogStatus} = useWorksheetCatalog();
  // Session 18C v13: internal currentWsId allows switching worksheets
  // without unmounting the editor. Initial value is the worksheetId
  // prop; user can change it via the nav pane above the worksheet,
  // which flushes the current draft before switching.
  const [currentWsId, setCurrentWsId] = useState(worksheetId);
  // Keep currentWsId in sync if parent re-mounts with a different
  // initial worksheetId (rare — parent should change key instead).
  useEffect(()=>{ setCurrentWsId(worksheetId); }, [worksheetId]);

  const [doc, setDoc] = useState(null);       // current per-WS doc snapshot
  const [docLoaded, setDocLoaded] = useState(false);
  const [answers, setAnswers] = useState([]); // [string]
  const [flags, setFlags] = useState([]);     // ["star"|"question"|null]
  const [localStatus, setLocalStatus] = useState("draft");
  const [submittedAt, setSubmittedAt] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingExit, setSavingExit] = useState(false);
  const dirtyRef = useRef(false);
  const debounceRef = useRef(null);
  // All non-deleted worksheets in this PSM, for the nav pane.
  const allWorksheets = useMemo(()=>
    (assignment.worksheets || []).filter(w => w && !w.deleted),
    [assignment.worksheets]);
  // Live per-WS doc map for the nav-pane status badges.
  const perWs = useWorksheetSubmissions(studentId, assignment.id);

  const worksheet = useMemo(()=>
    allWorksheets.find(w => w.id === currentWsId),
    [allWorksheets, currentWsId]);
  const catalogEntry = useMemo(()=>{
    if(catalogStatus !== "ready" || !catalog || !worksheet) return null;
    const row = catalog.find(c => c.title === worksheet.title);
    return (row && Array.isArray(row.questionIds) && row.questionIds.length > 0) ? row : null;
  }, [catalogStatus, catalog, worksheet]);

  // Subscribe to the per-WS doc; seed local state from it on every change
  // (but skip seeding while user is typing — preserves in-progress edits).
  useEffect(()=>{
    const col = studentAssignmentWorksheetSubmissionsCollection(studentId, assignment.id);
    if(!col){
      setDocLoaded(true);
      return;
    }
    // Session 18C v13: reset local state when switching worksheets,
    // so we don't see stale answers/flags from the previous worksheet
    // while waiting for the new snapshot to fire.
    setDoc(null);
    setDocLoaded(false);
    setAnswers([]);
    setFlags([]);
    setLocalStatus("draft");
    setSubmittedAt(null);
    dirtyRef.current = false;
    const unsub = col.doc(currentWsId).onSnapshot((snap)=>{
      if(snap.exists){
        const data = snap.data() || {};
        setDoc(data);
        if(!dirtyRef.current){
          const expected = catalogEntry?.questionIds?.length || 0;
          const a = new Array(expected).fill("");
          const f = new Array(expected).fill(null);
          for(const r of (data.responses || [])){
            const qi = Number(r.questionIndex);
            if(Number.isFinite(qi) && qi >= 0 && qi < expected){
              a[qi] = typeof r.studentAnswer === "string" ? r.studentAnswer : "";
              f[qi] = r.flag || null;
            }
          }
          setAnswers(a);
          setFlags(f);
          setLocalStatus(data.status || "draft");
          setSubmittedAt(data.submittedAt || null);
        }
      } else {
        // Brand-new — seed empty array based on catalog length.
        const expected = catalogEntry?.questionIds?.length || 0;
        if(!dirtyRef.current){
          setAnswers(new Array(expected).fill(""));
          setFlags(new Array(expected).fill(null));
          setLocalStatus("draft");
        }
      }
      setDocLoaded(true);
    }, (err)=>{
      console.warn("[SingleWorksheetEditor] snapshot error:", err);
      setDocLoaded(true);
    });
    return ()=>unsub();
  }, [studentId, assignment.id, currentWsId, catalogEntry]);

  const isLocked = readOnly || localStatus === "submitted";

  const writeDraft = async (overrideAnswers, overrideFlags) => {
    if(isLocked) return;
    const col = studentAssignmentWorksheetSubmissionsCollection(studentId, assignment.id);
    if(!col) return;
    const aArr = overrideAnswers || answers;
    const fArr = overrideFlags  || flags;
    const responses = aArr.map((v, i) => {
      const obj = {
        questionIndex: i,
        studentAnswer: typeof v === "string" ? v : "",
      };
      if(fArr[i]) obj.flag = fArr[i];
      return obj;
    });
    try{
      const FV = firebase.firestore.FieldValue;
      await col.doc(currentWsId).set({
        worksheetId: currentWsId,
        responses,
        status: "draft",
        updatedAt: FV.serverTimestamp(),
        createdAt: FV.serverTimestamp(), // server merges; only sets first time
      }, {merge: true});
      dirtyRef.current = false;
    } catch(e){
      console.warn("[SingleWorksheetEditor] draft write failed:", e);
    }
  };

  // Debounced autosave on answer/flag changes.
  useEffect(()=>{
    if(isLocked || !docLoaded) return;
    if(!dirtyRef.current) return;
    if(debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(()=> writeDraft(), 750);
    return ()=>{ if(debounceRef.current) clearTimeout(debounceRef.current); };
  }, [answers, flags, isLocked, docLoaded]);

  const setAnswerAt = (i, v) => {
    if(isLocked) return;
    dirtyRef.current = true;
    setAnswers(prev => {
      const next = prev.slice();
      while(next.length <= i) next.push("");
      next[i] = v;
      return next;
    });
  };
  const setFlagAt = (i, v) => {
    if(isLocked) return;
    dirtyRef.current = true;
    setFlags(prev => {
      const next = prev.slice();
      while(next.length <= i) next.push(null);
      next[i] = v;
      return next;
    });
  };

  const canSubmit = useMemo(()=>{
    if(isLocked) return false;
    // At least one answered slot (any non-empty).
    return answers.some(a => typeof a === "string" && a.trim().length > 0);
  }, [answers, isLocked]);

  const onSubmit = async () => {
    if(submitting || !canSubmit) return;
    setSubmitting(true);
    try{
      if(debounceRef.current){ clearTimeout(debounceRef.current); debounceRef.current = null; }
      await writeDraft(); // flush latest draft first
      const col = studentAssignmentWorksheetSubmissionsCollection(studentId, assignment.id);
      const FV = firebase.firestore.FieldValue;
      await col.doc(currentWsId).update({
        status: "submitted",
        submittedAt: FV.serverTimestamp(),
      });
      setLocalStatus("submitted");
      setSubmittedAt(new Date().toISOString());
    } catch(e){
      console.warn("[SingleWorksheetEditor] submit failed:", e);
      alert("Couldn't submit. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const onSaveAndExit = async () => {
    if(savingExit || isLocked) {
      // If already submitted/readOnly, just exit.
      onClose && onClose();
      return;
    }
    setSavingExit(true);
    try{
      if(debounceRef.current){ clearTimeout(debounceRef.current); debounceRef.current = null; }
      await writeDraft();
    } finally {
      setSavingExit(false);
      onClose && onClose();
    }
  };

  // Session 18C v13: switch between worksheets without leaving the
  // editor. Flushes the current draft before changing currentWsId so
  // no in-progress answers are lost. The snapshot subscription re-fires
  // for the new worksheet, seeding its state.
  const switchWorksheet = async (newWsId) => {
    if(!newWsId || newWsId === currentWsId) return;
    if(!isLocked){
      // Flush any pending debounced write + the current state.
      try{
        if(debounceRef.current){ clearTimeout(debounceRef.current); debounceRef.current = null; }
        await writeDraft();
      } catch { /* ignore — switch anyway so user isn't stuck */ }
    }
    setCurrentWsId(newWsId);
  };

  // Derive status pill kind for a worksheet in the nav. Uses the live
  // per-WS doc when available, otherwise legacy fallback.
  function navStatusFor(wsId){
    const perDoc = perWs.byWorksheet[wsId];
    if(perDoc){
      if(typeof perDoc.scoreCorrect === "number") return { kind: "graded", score: `${perDoc.scoreCorrect}/${perDoc.scoreTotal}` };
      if(perDoc.status === "submitted") return { kind: "submitted" };
      const hasAns = (perDoc.responses || []).some(r => (r.studentAnswer || "").trim() !== "");
      return hasAns ? { kind: "in-progress" } : { kind: "not-started" };
    }
    return { kind: "not-started" };
  }
  const NAV_STATUS_STYLE = {
    "not-started":  { bg: "transparent",  fg: "#66708A",  border: "rgba(15,26,46,.18)" },
    "in-progress":  { bg: "#FFF1DE",      fg: "#9A5B1F",  border: "rgba(154,91,31,.4)" },
    "submitted":    { bg: "#E9F0F6",      fg: "#003258",  border: "rgba(0,50,88,.35)"  },
    "graded":       { bg: "#E4F0E2",      fg: "#4C7A4C",  border: "rgba(76,122,76,.4)" },
  };

  if(!worksheet){
    return (
      <div style={{...CARD, padding:"40px 24px", textAlign:"center"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",color:"#8C2E2E",fontSize:18,marginBottom:14}}>
          Worksheet not found.
        </div>
        <button onClick={onClose} style={SUBMIT_EDITOR_BACK_BTN}>← Back to PSM</button>
      </div>
    );
  }
  if(catalogStatus === "loading" || !docLoaded){
    return (
      <div style={{...CARD, padding:"40px 24px", textAlign:"center"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",color:"#66708A"}}>Loading…</div>
      </div>
    );
  }

  // Banner: graded? submitted? draft?
  let banner = null;
  if(localStatus === "submitted"){
    if(typeof doc?.scoreCorrect === "number"){
      const correct = doc.scoreCorrect, total = doc.scoreTotal;
      banner = {
        text: `Submitted · Graded: ${correct} / ${total}`,
        color: correct === total ? "#4C7A4C" : correct === 0 ? "#8C2E2E" : "#9A5B1F",
        border: correct === total ? "rgba(76,122,76,.4)" : correct === 0 ? "rgba(140,46,46,.4)" : "rgba(154,91,31,.4)",
      };
    } else if(doc?.gradeSkipReason){
      banner = { text: `Submitted · Not auto-graded (${doc.gradeSkipReason})`, color: "#9A5B1F", border: "rgba(154,91,31,.4)" };
    } else {
      banner = { text: "Submitted · Score pending…", color: "#66708A", border: "rgba(102,112,138,.35)" };
    }
  }

  return (
    <div style={{...CARD, padding:"24px 22px"}}>
      <button onClick={onSaveAndExit} style={SUBMIT_EDITOR_BACK_BTN}>
        ← {isLocked ? "Back to PSM" : (savingExit ? "Saving…" : "Save & back to PSM")}
      </button>
      <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:22,fontWeight:600,color:"#0F1A2E",marginTop:14,marginBottom:6,letterSpacing:-.2}}>
        {assignment.date || assignment.dateAssigned || "Assignment"}
      </div>
      {banner && (
        <div style={{
          display:"inline-block",fontFamily:"'IBM Plex Mono',monospace",fontSize:11,fontWeight:600,
          color:banner.color,border:`1px solid ${banner.border}`,
          padding:"6px 12px",borderRadius:4,textTransform:"uppercase",letterSpacing:.6,marginBottom:14,
        }}>
          {banner.text}
        </div>
      )}

      {/* Session 18C v13: PSM nav strip. Lists every worksheet in the
          PSM with its status pill. Clicking one auto-saves the current
          draft and switches. Lets students jump around without leaving
          the editor. */}
      {allWorksheets.length > 1 && (
        <div style={{
          marginBottom:16, padding:"10px 12px",
          background:"#FAF7F2", border:"1px solid rgba(15,26,46,.08)",
          borderRadius:6,
        }}>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:1.2,color:"#66708A",textTransform:"uppercase",marginBottom:8}}>
            PSM Worksheets ({allWorksheets.length}) · click to switch
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {allWorksheets.map((w, idx)=>{
              const st = navStatusFor(w.id);
              const sty = NAV_STATUS_STYLE[st.kind] || NAV_STATUS_STYLE["not-started"];
              const active = w.id === currentWsId;
              return (
                <button
                  key={w.id}
                  onClick={()=> switchWorksheet(w.id)}
                  disabled={active}
                  title={w.title || `Worksheet ${idx+1}`}
                  style={{
                    cursor: active ? "default" : "pointer",
                    border: active ? "2px solid #0F1A2E" : `1px solid ${sty.border}`,
                    background: active ? "#0F1A2E" : "#fff",
                    color: active ? "#FAF7F2" : "#0F1A2E",
                    padding:"6px 12px", borderRadius:4,
                    fontFamily:"inherit", fontSize:12,
                    display:"inline-flex", alignItems:"center", gap:8,
                    maxWidth: 280,
                  }}
                >
                  <span style={{
                    fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:700,
                    color: active ? "rgba(250,247,242,.7)" : "#66708A",
                    letterSpacing:.6, textTransform:"uppercase",
                  }}>{idx+1}.</span>
                  <span style={{
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                    fontWeight: active ? 600 : 500,
                  }}>{w.title || `Worksheet ${idx+1}`}</span>
                  {!active && (
                    <span style={{
                      fontFamily:"'IBM Plex Mono',monospace", fontSize:8, fontWeight:700,
                      letterSpacing:.6, textTransform:"uppercase",
                      padding:"2px 6px", borderRadius:2,
                      background:sty.bg, color:sty.fg, border:`1px solid ${sty.border}`,
                    }}>
                      {st.kind === "graded" ? `✓ ${st.score}` :
                       st.kind === "submitted" ? "Done" :
                       st.kind === "in-progress" ? "Draft" :
                       "—"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Review chip grid only after submission, like SubmissionEditor */}
      {localStatus === "submitted" && Array.isArray(doc?.perQuestion) && doc.perQuestion.length > 0 && (
        <SubmissionReviewGrid
          worksheets={[worksheet]}
          perQuestion={(doc.perQuestion || []).map(p => ({...p, worksheetId: currentWsId}))}
          responses={(doc.responses || []).map(r => ({...r, worksheetId: currentWsId}))}
        />
      )}

      <WorksheetBlock
        worksheet={worksheet}
        catalogEntry={catalogEntry}
        answers={answers}
        onAnswersChange={(next)=>{ dirtyRef.current = true; setAnswers(next); }}
        flags={flags}
        onFlagsChange={(next)=>{ dirtyRef.current = true; setFlags(next); }}
        isLocked={isLocked}
        indexLabel={`Worksheet · ${worksheet.title || ""}`}
        results={localStatus === "submitted" ? (() => {
          const out = [];
          for(const pq of (doc?.perQuestion || [])){
            if(pq && typeof pq.questionIndex === "number") out[pq.questionIndex] = pq;
          }
          return out;
        })() : null}
        showResults={localStatus === "submitted"}
      />

      {!isLocked && (
        <div style={{marginTop:24, display:"flex", justifyContent:"flex-end", gap:10, flexWrap:"wrap"}}>
          <button onClick={onSaveAndExit} disabled={savingExit} style={{...mkBtn("transparent","#0F1A2E"),border:"1px solid rgba(15,26,46,.22)",padding:"10px 18px",fontSize:12,letterSpacing:.4,textTransform:"uppercase",fontWeight:600}}>
            {savingExit ? "Saving…" : "Save & exit"}
          </button>
          <button onClick={onSubmit} disabled={!canSubmit || submitting} style={canSubmit ? SUBMIT_BTN_STYLE : SUBMIT_BTN_STYLE_DISABLED}>
            {submitting ? "Submitting…" : "Submit worksheet"}
          </button>
        </div>
      )}
    </div>
  );
}

function SubmissionEditor({studentId, assignment, readOnly, onClose, focusWorksheetId}){
  // Session 18C v12: focus mode delegates to a separate per-WS editor
  // that writes to worksheetSubmissions/{wsId} ONLY (never touches the
  // legacy whole-PSM submission). Fixes the bug where submitting one
  // worksheet locked all the others.
  if(focusWorksheetId){
    return <SingleWorksheetEditor
      studentId={studentId}
      assignment={assignment}
      worksheetId={focusWorksheetId}
      readOnly={readOnly}
      onClose={onClose}
    />;
  }
  const {status, submission} = useSubmissionDraft(studentId, assignment.id);
  const {status: catalogStatus, catalog} = useWorksheetCatalog();

  const welledCount = (assignment.welledDomain||[]).filter(w => !w.deleted).length;
  const examCount = (assignment.practiceExams||[]).filter(e => !e.deleted).length;

  // Dedupe worksheet ids defensively — if the assignment doc has collisions
  // or missing ids, suffix with the positional index. Memoized on
  // assignment.worksheets to keep the array reference stable across renders,
  // which keeps catalogByWorksheetId and the seed effect from firing on every
  // render (which would infinite-loop via setAnswersByWorksheet).
  //
  // Session 18A: when focusWorksheetId is set (drill-down from PSM detail),
  // filter to just that one worksheet so the student answers one at a time.
  const worksheetsStable = useMemo(()=>{
    const seen = new Set();
    let list = (assignment.worksheets||[]).filter(w => !w.deleted).map((w, idx) => {
      let id = w.id;
      if(!id || seen.has(id)){
        const newId = `${id || "w"}-${idx}`;
        console.warn("[portal] worksheet id collision or missing, rekey", id, "->", newId);
        id = newId;
      }
      seen.add(id);
      return {...w, id};
    });
    if(focusWorksheetId){
      list = list.filter(w => w.id === focusWorksheetId);
    }
    return list;
  }, [assignment.worksheets, focusWorksheetId]);

  // Build catalogByWorksheetId once per catalog/worksheets change.
  const catalogByWorksheetId = useMemo(()=>{
    if(catalogStatus !== "ready" || !catalog) return {};
    const out = {};
    for(const w of worksheetsStable){
      const entry = catalog.find(c => c.title === w.title);
      if(entry && Array.isArray(entry.questionIds) && entry.questionIds.length > 0){
        out[w.id] = entry;
      }
    }
    return out;
  }, [catalogStatus, catalog, worksheetsStable]);

  // Legacy mode: zero worksheets on the assignment (only WellEd / practice exams).
  const hasAnyWorksheets = worksheetsStable.length > 0;
  const legacyMode = !hasAnyWorksheets;

  // State
  const [answersByWorksheet, setAnswersByWorksheet] = useState({});
  // Session 18A: parallel-shape state for per-question flags.
  // flagsByWorksheet[wId][i] ∈ {"star", "question", null}.
  const [flagsByWorksheet, setFlagsByWorksheet] = useState({});
  const [legacyText, setLegacyText] = useState("");
  const submissionIdRef = useRef(null);
  const [localStatus, setLocalStatus] = useState("draft");
  const [submittedAt, setSubmittedAt] = useState(null);
  const [submittingState, setSubmittingState] = useState(false);
  const pendingTimerRef = useRef(null);
  const writeDraftRef = useRef(null);

  // Seed from loaded submission.
  useEffect(()=>{
    if(status !== "ready" || !submission) return;
    submissionIdRef.current = submission.id;
    setLocalStatus(submission.status || "draft");
    setSubmittedAt(submission.submittedAt || null);

    if(legacyMode){
      const r = Array.isArray(submission.responses) ? submission.responses[0] : null;
      setLegacyText((r && r.studentAnswer) || "");
      return;
    }

    // Group existing responses + flags by worksheetId.
    const groupedAns = {};
    const groupedFlags = {};
    if(Array.isArray(submission.responses)){
      for(const r of submission.responses){
        const wId = r.worksheetId;
        if(!wId) continue;
        if(!groupedAns[wId]) groupedAns[wId] = [];
        if(!groupedFlags[wId]) groupedFlags[wId] = [];
        groupedAns[wId][r.questionIndex] = r.studentAnswer || "";
        groupedFlags[wId][r.questionIndex] = (r.flag === "star" || r.flag === "question") ? r.flag : null;
      }
    }
    // Pad each worksheet's array to its expected length.
    const nextAns = {};
    const nextFlags = {};
    for(const w of worksheetsStable){
      const entry = catalogByWorksheetId[w.id];
      const expected = entry?.questionIds?.length || 1;
      const existingAns = groupedAns[w.id] || [];
      const existingFlags = groupedFlags[w.id] || [];
      const paddedAns = [];
      const paddedFlags = [];
      for(let i=0; i<expected; i++){
        paddedAns.push(existingAns[i] || "");
        paddedFlags.push(existingFlags[i] || null);
      }
      nextAns[w.id] = paddedAns;
      nextFlags[w.id] = paddedFlags;
    }
    setAnswersByWorksheet(nextAns);
    setFlagsByWorksheet(nextFlags);
  }, [status, submission, legacyMode, catalogByWorksheetId, worksheetsStable]);

  const isLockedNow = readOnly || localStatus === "submitted";

  // Session 18A wire-up: when PER_WORKSHEET_SUBMIT_ENABLED is flipped on
  // (localStorage flag for opt-in smoke testing), write to per-worksheet
  // docs at students/{sid}/assignments/{aid}/worksheetSubmissions/{wsId}
  // instead of (or in addition to) the legacy submissions collection.
  // Flag default OFF — legacy path unchanged for everyone until flipped.
  const _perWsWriteEnabled = perWorksheetSubmitEnabled();
  const writePerWsDraft = async () => {
    const col = studentAssignmentWorksheetSubmissionsCollection(studentId, assignment.id);
    if(!col) return;
    const FV = firebase.firestore.FieldValue;
    const writes = [];
    for(const wId of Object.keys(answersByWorksheet)){
      const answers = answersByWorksheet[wId] || [];
      const flags = (flagsByWorksheetRef => flagsByWorksheetRef && flagsByWorksheetRef[wId])(flagsByWorksheet) || [];
      const entry = catalogByWorksheetId[wId];
      const expected = entry?.questionIds?.length ?? answers.length;
      const responses = [];
      for(let i = 0; i < expected; i++){
        const flag = flags[i] === "star" || flags[i] === "question" ? flags[i] : null;
        responses.push({
          questionIndex: i,
          studentAnswer: typeof answers[i] === "string" ? answers[i] : "",
          flag,
        });
      }
      writes.push(col.doc(wId).set({
        worksheetId: wId,
        responses,
        status: "draft",
        updatedAt: FV.serverTimestamp(),
        createdAt: FV.serverTimestamp(),
      }, { merge: true }));
    }
    await Promise.all(writes).catch(e => console.warn("[portal] per-ws draft write error:", e));
  };

  writeDraftRef.current = async () => {
    if(isLockedNow) return;
    const col = studentSubmissionsCollection(studentId);
    if(!col) return;
    const payload = legacyMode
      ? makeDraftPayload({
          assignmentId: assignment.id,
          answersText: legacyText,
          isCreate: !submissionIdRef.current,
        })
      : makeDraftPayload({
          assignmentId: assignment.id,
          answersByWorksheet,
          flagsByWorksheet,
          catalogByWorksheetId,
          isCreate: !submissionIdRef.current,
        });
    // Session 18A wire-up: dual-write to per-WS path when flag on.
    // Legacy write is kept as the canonical until the flag is flipped
    // globally; this lets us validate per-WS reads alongside legacy.
    if(_perWsWriteEnabled && !legacyMode){
      writePerWsDraft();
    }
    try{
      if(!submissionIdRef.current){
        const newRef = col.doc();
        submissionIdRef.current = newRef.id;
        await newRef.set(payload);
      } else {
        // Drop createdAt from update (it's only set on create).
        const {createdAt: _drop, ...updatePayload} = payload;
        await col.doc(submissionIdRef.current).update(updatePayload);
      }
    } catch(err){
      console.warn("[portal] draft write error:", err);
    }
  };

  const handleSubmit = async () => {
    if(isLockedNow || submittingState) return;
    const fakeResponses = legacyMode
      ? [{worksheetId: null, questionIndex: 0, studentAnswer: legacyText}]
      : (()=>{
          const out = [];
          for(const wId of Object.keys(answersByWorksheet)){
            (answersByWorksheet[wId]||[]).forEach((a, i) => out.push({worksheetId: wId, questionIndex: i, studentAnswer: a}));
          }
          return out;
        })();
    if(!canSubmitDraft({status:"draft", responses: fakeResponses})) return;
    setSubmittingState(true);
    try{
      if(pendingTimerRef.current){ clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
      if(writeDraftRef.current) await writeDraftRef.current();
      const id = submissionIdRef.current;
      if(!id) throw new Error("no submission id after flush");
      await studentSubmissionsCollection(studentId).doc(id).update({
        status: "submitted",
        submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      setLocalStatus("submitted");
      setSubmittedAt(new Date().toISOString());
    } catch(err){
      console.warn("[portal] submit error:", err);
      alert("Could not submit. Try again.");
    } finally {
      setSubmittingState(false);
    }
  };

  // Debounced autosave on any answer or flag change.
  useEffect(()=>{
    if(isLockedNow) return;
    if(status !== "ready" && status !== "not-found") return;
    if(pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(()=>{
      if(writeDraftRef.current) writeDraftRef.current();
    }, 750);
    return ()=>{ if(pendingTimerRef.current) clearTimeout(pendingTimerRef.current); };
  }, [answersByWorksheet, flagsByWorksheet, legacyText, status, isLockedNow]);

  // Session 15: auto-grade data from the onSubmissionSubmit trigger.
  // Group submission.perQuestion[] by worksheetId → array indexed by questionIndex.
  // Must be defined BEFORE the early returns below to keep the hook order
  // stable across loading/error/ready transitions (rules of hooks).
  const perQuestionByWorksheet = useMemo(()=>{
    const out = {};
    const pq = submission && Array.isArray(submission.perQuestion) ? submission.perQuestion : null;
    if(!pq) return out;
    for(const e of pq){
      if(!e || !e.worksheetId) continue;
      if(!out[e.worksheetId]) out[e.worksheetId] = [];
      out[e.worksheetId][e.questionIndex] = e;
    }
    return out;
  }, [submission]);

  // Status rendering
  if(status === "loading" || (catalogStatus === "loading" && hasAnyWorksheets)){
    return (
      <div style={{...CARD, padding:"40px 24px", textAlign:"center"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif", color:"#66708A"}}>Loading…</div>
      </div>
    );
  }
  if(status === "error"){
    return (
      <div style={{...CARD, padding:"40px 24px", textAlign:"center"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif", fontStyle:"italic", color:"#8C2E2E", marginBottom:16}}>
          Couldn't load this submission. Try reloading.
        </div>
        <button onClick={onClose} style={SUBMIT_EDITOR_BACK_BTN}>← Back</button>
      </div>
    );
  }

  const isLocked = isLockedNow;
  const displayDate = (()=>{
    if(!submittedAt) return "";
    if(typeof submittedAt === "string") return submittedAt.slice(0,10);
    if(submittedAt.toDate){ try { return submittedAt.toDate().toISOString().slice(0,10); } catch { return ""; } }
    return "";
  })();

  // Banner state: graded / skipped / awaiting. Only shown when isLocked.
  // Not a hook — plain derived value — so it can live after early returns.
  // Mirrors the trigger's three outcomes:
  //   - scoreCorrect/scoreTotal set          → graded
  //   - gradeSkipReason set                  → skipped
  //   - neither set but status === submitted → awaiting (trigger in flight)
  const gradeBanner = (()=>{
    if(!isLocked || !submission) return null;
    if(typeof submission.scoreCorrect === "number" && typeof submission.scoreTotal === "number"){
      const total = submission.scoreTotal;
      const correct = submission.scoreCorrect;
      const missed = total - correct;
      const tone = total === 0 ? "#66708A" : (missed === 0 ? "#4C7A4C" : (correct === 0 ? "#8C2E2E" : "#9A5B1F"));
      const border = total === 0 ? "rgba(102,112,138,.35)" : (missed === 0 ? "rgba(76,122,76,.4)" : (correct === 0 ? "rgba(140,46,46,.4)" : "rgba(154,91,31,.4)"));
      return {
        kind: "graded",
        label: `Auto-graded: ${correct} / ${total}`,
        tone, border,
      };
    }
    if(submission.gradeSkipReason){
      return {
        kind: "skipped",
        label: `Not auto-graded (${submission.gradeSkipReason})`,
        tone: "#9A5B1F",
        border: "rgba(154,91,31,.4)",
      };
    }
    return {
      kind: "awaiting",
      label: "Score pending…",
      tone: "#66708A",
      border: "rgba(102,112,138,.35)",
    };
  })();

  // Submit-enabled check against current in-memory state.
  const fakeResponses = legacyMode
    ? [{worksheetId: null, questionIndex: 0, studentAnswer: legacyText}]
    : (()=>{
        const out = [];
        for(const wId of Object.keys(answersByWorksheet)){
          (answersByWorksheet[wId]||[]).forEach((a, i) => out.push({worksheetId: wId, questionIndex: i, studentAnswer: a}));
        }
        return out;
      })();
  const submitEnabled = !isLocked && canSubmitDraft({status:"draft", responses: fakeResponses}) && !submittingState;

  return (
    <div style={{...CARD, padding:"24px 22px"}}>
      <button onClick={onClose} style={SUBMIT_EDITOR_BACK_BTN}>← {focusWorksheetId ? "Back to PSM" : "Back to my assignments"}</button>
      <div style={{fontFamily:"'Fraunces',Georgia,serif", fontSize:22, fontWeight:600, color:"#0F1A2E", marginTop:14, marginBottom:6, letterSpacing:-.2}}>
        {assignment.date || assignment.dateAssigned || "Assignment"}
      </div>
      {isLocked && displayDate && (
        <div style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#66708A", textTransform:"uppercase", letterSpacing:1, marginBottom:8}}>
          Submitted {displayDate}
        </div>
      )}
      {gradeBanner && (
        <div style={{
          display:"inline-block",
          fontFamily:"'IBM Plex Mono',monospace", fontSize:11, fontWeight:600,
          color: gradeBanner.tone,
          background:"transparent",
          border: `1px solid ${gradeBanner.border}`,
          padding:"6px 12px", borderRadius:4,
          textTransform:"uppercase", letterSpacing:.6,
          marginBottom:14,
        }}>
          {gradeBanner.label}
        </div>
      )}

      {/* Session 18C v7: review grid is gated on submission.status ===
          "submitted" specifically, not the broader isLocked. Per Aidan:
          'I don't want them to see if it is right and wrong as they
          answer, only after they submit.' isLocked also covers readOnly
          (parent/impersonation) views where the submission could still
          be in draft state — we want no result-leakage there either. */}
      {submission && submission.status === "submitted" && Array.isArray(submission.perQuestion) && submission.perQuestion.length > 0 && (
        <SubmissionReviewGrid
          worksheets={worksheetsStable}
          perQuestion={submission.perQuestion}
          responses={Array.isArray(submission.responses) ? submission.responses : []}
        />
      )}

      {catalogStatus === "error" && hasAnyWorksheets && (
        <div style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#8C6A2E", background:"#FFF4E0", border:"1px solid rgba(140,106,46,.25)", borderRadius:6, padding:"8px 12px", marginTop:10}}>
          Couldn't load worksheet metadata — using simple mode.
        </div>
      )}

      {(welledCount > 0 || examCount > 0) && !legacyMode && (
        <div style={{fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#66708A", marginTop:12, padding:"8px 12px", background:"rgba(15,26,46,.04)", borderRadius:6, lineHeight:1.5}}>
          This assignment also includes{" "}
          {welledCount > 0 && <span>{welledCount} WellEd item{welledCount===1?"":"s"}</span>}
          {welledCount > 0 && examCount > 0 && " and "}
          {examCount > 0 && <span>{examCount} practice exam{examCount===1?"":"s"}</span>}
          . Engage with those outside the portal.
        </div>
      )}

      {legacyMode ? (
        <div style={{marginTop:14}}>
          {isLocked ? (
            <div style={{whiteSpace:"pre-wrap", fontFamily:"'Fraunces',Georgia,serif", fontSize:15, color:"#0F1A2E", lineHeight:1.55, padding:"14px 0", borderTop:"1px solid rgba(15,26,46,.08)", borderBottom:"1px solid rgba(15,26,46,.08)"}}>
              {legacyText || <span style={{color:"#66708A", fontStyle:"italic"}}>No answer recorded.</span>}
            </div>
          ) : (
            <textarea
              value={legacyText}
              onChange={e => setLegacyText(e.target.value)}
              placeholder={"Type your answers here. Example:\n\n1. B\n2. C\n3. A"}
              style={{
                width:"100%", minHeight:260, padding:"14px 16px", borderRadius:8,
                border:"1px solid rgba(15,26,46,.2)", fontFamily:"'IBM Plex Mono',monospace",
                fontSize:14, lineHeight:1.6, color:"#0F1A2E", resize:"vertical", boxSizing:"border-box",
              }}
            />
          )}
        </div>
      ) : (
        worksheetsStable.map((w, idx) => (
          <WorksheetBlock
            key={w.id}
            worksheet={w}
            catalogEntry={catalogByWorksheetId[w.id]}
            answers={answersByWorksheet[w.id] || []}
            onAnswersChange={(next)=> setAnswersByWorksheet(prev => ({...prev, [w.id]: next}))}
            flags={flagsByWorksheet[w.id] || []}
            onFlagsChange={(next)=> setFlagsByWorksheet(prev => ({...prev, [w.id]: next}))}
            isLocked={isLocked}
            indexLabel={`Worksheet ${idx+1} of ${worksheetsStable.length}`}
            results={perQuestionByWorksheet[w.id]}
            showResults={submission && submission.status === "submitted"}
          />
        ))
      )}

      {!isLocked && (
        <div style={{marginTop:24, display:"flex", justifyContent:"flex-end"}}>
          <button
            disabled={!submitEnabled}
            onClick={handleSubmit}
            style={submitEnabled ? SUBMIT_BTN_STYLE : SUBMIT_BTN_STYLE_DISABLED}
          >
            {submittingState ? "Submitting…" : (focusWorksheetId ? "Submit worksheet" : "Submit")}
          </button>
        </div>
      )}
    </div>
  );
}

function ScoreTrendsChart({series}){
  const W = 640, H = 280;
  const PAD = {top:20, right:24, bottom:48, left:56};
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  if(!series || series.length===0){
    return (
      <div style={{...CARD, padding:"60px 40px", textAlign:"center"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:22,color:"#66708A",letterSpacing:-.2,marginBottom:10}}>
          Not enough data to draw a trend yet.
        </div>
        <div style={{fontSize:13,color:"#66708A",lineHeight:1.55}}>
          Your practice test scores will plot here once you have at least one on file.
        </div>
      </div>
    );
  }

  const scores = series.map(p=>p.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const pad = (maxScore - minScore) || 40;
  const yLo = Math.max(0, Math.floor((minScore - pad*0.1)/10)*10);
  const yHi = Math.ceil((maxScore + pad*0.1)/10)*10;
  const yRange = Math.max(1, yHi - yLo);

  const x = (i)=> series.length===1
    ? PAD.left + innerW/2
    : PAD.left + (i/(series.length-1)) * innerW;
  const y = (v)=> PAD.top + innerH - ((v - yLo)/yRange) * innerH;

  const pathD = series.map((p,i)=> `${i===0?"M":"L"} ${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`).join(" ");
  const ticks = [0,1,2,3,4].map(k => yLo + (yRange*k/4));

  return (
    <div style={{...CARD, padding:"24px 20px"}}>
      <PortalSectionHeading>Practice test scores over time</PortalSectionHeading>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",display:"block",fontFamily:"'IBM Plex Mono',monospace"}} role="img" aria-label="Score trend chart">
        {ticks.map((t,i)=>(
          <g key={i}>
            <line x1={PAD.left} x2={W-PAD.right} y1={y(t)} y2={y(t)} stroke="rgba(15,26,46,.08)" strokeWidth="1"/>
            <text x={PAD.left-10} y={y(t)+4} textAnchor="end" fontSize="10" fill="#66708A">{Math.round(t)}</text>
          </g>
        ))}
        <path d={pathD} fill="none" stroke="#0F1A2E" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
        {series.map((p,i)=>(
          <g key={i}>
            <circle cx={x(i)} cy={y(p.score)} r="4.5" fill="#9A5B1F" stroke="#FAF7F2" strokeWidth="2"/>
            <title>{p.date} · {p.label} · {p.score}</title>
          </g>
        ))}
        {series.map((p,i)=>{
          const stride = Math.max(1, Math.ceil(series.length/6));
          if(i % stride !== 0 && i !== series.length-1) return null;
          return (
            <text key={i} x={x(i)} y={H-PAD.bottom+18} textAnchor="middle" fontSize="10" fill="#66708A">{p.date}</text>
          );
        })}
      </svg>
    </div>
  );
}

/* ============ HEAT MAP HELPERS ============ */
// Count worksheet + WellEd Domain assignments per {domain, difficulty}
// Only worksheets and WellEd domain assignments count toward the heat map (not practice exams, not vocab).
function buildHeatCounts(student){
  const counts = {}; // key: domain|difficulty → count
  (student?.assignments||[]).forEach(a=>{
    (a.worksheets||[]).forEach(w=>{
      const k = `${w.domain}|${w.difficulty}`;
      counts[k] = (counts[k]||0)+1;
    });
    (a.welledDomain||[]).forEach(w=>{
      const k = `${w.domain}|${w.difficulty}`;
      counts[k] = (counts[k]||0)+1;
    });
  });
  return counts;
}
// Count practice exams — non-colored breakdown
function buildPracticeCounts(student){
  const out = {full:0, math:0, reading:0};
  (student?.assignments||[]).forEach(a=>{
    (a.practiceExams||[]).forEach(ex=>{
      if(ex.type==="full") out.full++;
      else if(ex.type==="math") out.math++;
      else if(ex.type==="reading"||ex.type==="rw") out.reading++;
      else out.full++;
    });
  });
  return out;
}
/* Editorial coverage heat ramp — paper → navy progression matching the ATS brand. */
const heatCellColor = (v)=>{
  if(!v) return "#F3EEE4";
  if(v>=10) return "#003258";
  if(v>=6)  return "#004A79";
  if(v>=3)  return "#2F6B9A";
  return "#C7D8E5";
};

/* Editorial threshold palette + inline progress bar — used across ScoreHistory, Scores, Heat Map. */
const pctColor = (v)=> v==null?"#66708A":v>=80?"#4C7A4C":v>=65?"#A9761B":"#8C2E2E";
const pctBg = (v)=> v==null?"#F3EEE4":v>=80?"rgba(76,122,76,.1)":v>=65?"rgba(169,118,27,.12)":"rgba(140,46,46,.1)";
function PctBar({value, width=72, inline=false}){
  if(value==null) return <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A"}}>—</span>;
  const c = pctColor(value);
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:8,verticalAlign:"middle"}}>
      <span style={{display:"inline-block",width,height:5,background:"rgba(15,26,46,.08)",borderRadius:1,overflow:"hidden",position:"relative",flexShrink:0}}>
        <span style={{position:"absolute",left:0,top:0,bottom:0,width:clamped+"%",background:c,borderRadius:1}}/>
      </span>
      <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:inline?10:11,fontWeight:600,color:c,letterSpacing:.2,minWidth:inline?24:30,textAlign:"right"}}>{value}%</span>
    </span>
  );
}
const DOMAINS_RW = ["Information & Ideas","Craft & Structure","Expression of Ideas","Standard English Conventions"];
const DOMAINS_M  = ["Algebra","Advanced Math","Problem-Solving & Data Analysis","Geometry & Trigonometry"];
const ALL_DOMAINS = [...DOMAINS_RW, ...DOMAINS_M];
const DIFFS = ["easy","medium","hard","comprehensive"];

/* ============ HEAT MAP TAB ============ */
function HeatMapTab({students,openProfile}){
  const[selSt,setSelSt]=useState(students[0]?.id||"");
  const st = students.find(s=>s.id===selSt) || students[0];
  const counts = st ? buildHeatCounts(st) : {};
  const pract = st ? buildPracticeCounts(st) : {full:0,math:0,reading:0};

  const diffLabel = {easy:"Easy",medium:"Medium",hard:"Hard",comprehensive:"Comprehensive"};

  return(
    <div>
      <div style={{marginBottom:24,paddingBottom:16,borderBottom:"1px solid rgba(15,26,46,.1)"}}>
        <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,fontWeight:600,letterSpacing:1.4,color:"#66708A",textTransform:"uppercase",marginBottom:6}}>Coverage</div>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 144',fontSize:34,fontWeight:600,color:"#0F1A2E",letterSpacing:-.6,lineHeight:1}}>Assignment Heat Map</div>
        <div style={{fontSize:12,color:"#66708A",marginTop:8,fontStyle:"italic",fontFamily:"'Fraunces',Georgia,serif"}}>Worksheet and WellEd domain assignments, split by difficulty tier.</div>
      </div>

      {students.length===0 ? (
        <div style={{...CARD,padding:"72px 40px",textAlign:"center"}}>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:22,color:"#66708A",letterSpacing:-.2}}>No students enrolled yet.</div>
        </div>
      ) : (<>
        <div style={{...CARD,marginBottom:16,padding:16,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",letterSpacing:1.2,textTransform:"uppercase"}}>Student</div>
          <select value={selSt} onChange={e=>setSelSt(e.target.value)} style={{...INP,width:280,flexShrink:0}}>
            {students.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {st && <button onClick={()=>openProfile(st)} style={{...mkBtn("transparent",B2),border:"1px solid rgba(0,74,121,.3)",padding:"7px 14px",fontSize:11}}>View Profile →</button>}
          <div style={{marginLeft:"auto",display:"flex",gap:10,alignItems:"center"}}>
            <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:1,textTransform:"uppercase"}}>Low</span>
            <div style={{display:"flex",gap:2}}>{["#F3EEE4","#C7D8E5","#2F6B9A","#004A79","#003258"].map((c,i)=><div key={i} style={{width:18,height:18,background:c,border:"1px solid rgba(15,26,46,.08)"}}/>)}</div>
            <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:1,textTransform:"uppercase"}}>High</span>
          </div>
        </div>

        {/* Practice Exam counts */}
        <div style={{...CARD,marginBottom:16,padding:20}}>
          <SH>Practice Exams Assigned</SH>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:0,borderTop:"1px solid rgba(15,26,46,.08)"}}>
            {[["Full",pract.full],["Math Only",pract.math],["Reading Only",pract.reading]].map(([l,v],i,arr)=>(
              <div key={l} style={{padding:"18px 22px",borderRight:i===arr.length-1?"none":"1px solid rgba(15,26,46,.08)",borderBottom:"1px solid rgba(15,26,46,.08)"}}>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",fontWeight:600,letterSpacing:1.2,textTransform:"uppercase"}}>{l}</div>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:26,fontWeight:600,color:"#0F1A2E",marginTop:8,letterSpacing:.2,lineHeight:1}}>{v.toString().padStart(2,"0")}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 4 heat maps by difficulty */}
        {DIFFS.map(d=>{
          const total = ALL_DOMAINS.reduce((n,dom)=>n+(counts[`${dom}|${d}`]||0),0);
          return(
            <div key={d} style={{...CARD,marginBottom:14,padding:20}}>
              <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:16,paddingBottom:10,borderBottom:"1px solid rgba(15,26,46,.08)"}}>
                <div style={{width:3,height:18,background:DC[d]}}/>
                <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:18,fontWeight:600,color:"#0F1A2E",letterSpacing:-.25,flex:1}}>{diffLabel[d]}</div>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",letterSpacing:.8,textTransform:"uppercase",fontWeight:500}}>{total.toString().padStart(2,"0")} Assigned</div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(8, 1fr)",gap:4}}>
                {ALL_DOMAINS.map(dom=>{
                  const v = counts[`${dom}|${d}`]||0;
                  const hot = v>=3;
                  return(
                    <div key={dom} style={{background:heatCellColor(v),padding:"12px 8px",textAlign:"center",minHeight:80,display:"flex",flexDirection:"column",justifyContent:"space-between",borderRadius:2,border:v===0?"1px solid rgba(15,26,46,.08)":"none"}}>
                      <div style={{fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:10,fontWeight:600,color:hot?"#FAF7F2":"#2E3A57",lineHeight:1.2,letterSpacing:-.05}}>{dom}</div>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:22,fontWeight:600,color:hot?"#FAF7F2":v>0?"#0F1A2E":"rgba(15,26,46,.25)",letterSpacing:-.3,marginTop:8,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{v||"·"}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </>)}
    </div>
  );
}

/* ============ EDITORIAL SVG LINE CHART ============ */
// Session 18A: legend that explains what each numbered point on a chart
// is. The user's exact ask was "a list below each graph just explaining
// what the numbered time points are too." Takes the same `pts` array
// the chart is built from (already sorted by date) and renders a small
// table-like list: "1. 2025-09-15 · Diagnostic (32/54)".
//
// Compact mode (compact: true) renders one-line entries; otherwise it's
// a two-line block per point.
function TimelineLegend({points, compact, max}){
  if(!points || points.length === 0) return null;
  return (
    <div style={{
      marginTop: 8,
      paddingTop: 8,
      borderTop: "1px dashed rgba(15,26,46,.12)",
      fontFamily: "'IBM Plex Mono',monospace",
      fontSize: 9,
      color: "#0F1A2E",
      letterSpacing: 0.15,
      lineHeight: 1.5,
    }}>
      <div style={{
        color:"#66708A", fontWeight:600, letterSpacing:.8, textTransform:"uppercase",
        fontSize:8, marginBottom:5,
      }}>Time-points (in order)</div>
      <div style={{display:"flex", flexDirection: compact?"row":"column", flexWrap:"wrap", gap: compact?"4px 12px":4}}>
        {points.map((pt, i) => {
          const label = pt._label || pt.subcategory || pt.category || "Score";
          const scorePart = pt.max ? `${pt.score}/${pt.max}` : (pt.score!=null?String(pt.score):"");
          const pctPart = pt.pct!=null ? `${pt.pct}%` : (pt.max?`${Math.round((pt.score/pt.max)*100)}%`:"");
          const date = (pt.date||"").slice(0,10);
          return (
            <div key={i} style={{display:"flex", gap:6, alignItems:"baseline"}}>
              <span style={{fontWeight:700, color:"#66708A", minWidth:16, textAlign:"right"}}>{i+1}.</span>
              <span style={{color:"#66708A"}}>{date}</span>
              <span style={{color:"#0F1A2E", fontWeight:500}}>{label}</span>
              {scorePart && <span style={{color:"#66708A"}}>·</span>}
              {scorePart && <span style={{fontVariantNumeric:"tabular-nums", color:"#0F1A2E"}}>{scorePart}</span>}
              {pctPart && <span style={{color:"#4C7A4C", fontWeight:600, fontVariantNumeric:"tabular-nums"}}>({pctPart})</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LineChart({points, color="#004A79", max, height=80, width=260}){
  // points: [{x:number, y:number, label?:string}]  x = 0..N-1 typically
  if(!points || points.length===0) return <div style={{fontSize:10,color:"#66708A",fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic"}}>No data</div>;
  const pad = 10;
  const w = width - pad*2, h = height - pad*2;
  const maxY = max!=null ? max : Math.max(...points.map(p=>p.y));
  const minY = 0;
  const range = maxY-minY || 1;
  const stepX = points.length>1 ? w/(points.length-1) : 0;
  const coords = points.map((p,i)=>({
    cx: pad + (points.length>1?i*stepX:w/2),
    cy: pad + h - ((p.y-minY)/range)*h,
    raw: p
  }));
  const path = coords.map((c,i)=>`${i===0?"M":"L"}${c.cx.toFixed(1)},${c.cy.toFixed(1)}`).join(" ");
  const area = `${path} L${coords[coords.length-1].cx.toFixed(1)},${(pad+h).toFixed(1)} L${coords[0].cx.toFixed(1)},${(pad+h).toFixed(1)} Z`;
  return (
    <svg width={width} height={height} style={{display:"block"}}>
      <rect x={0} y={0} width={width} height={height} fill="#FDFBF6" stroke="rgba(15,26,46,.08)"/>
      {[0.25,0.5,0.75].map(f=>(
        <line key={f} x1={pad} y1={pad+h*f} x2={pad+w} y2={pad+h*f} stroke="rgba(15,26,46,.08)" strokeWidth={1} strokeDasharray="2,4"/>
      ))}
      <path d={area} fill={color} fillOpacity={0.08}/>
      <path d={path} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"/>
      {coords.map((c,i)=>(
        <circle key={i} cx={c.cx} cy={c.cy} r={2.5} fill="#FAF7F2" stroke={color} strokeWidth={1.5}>
          <title>{c.raw.label||""}: {c.raw.y}{max?`/${max}`:""}</title>
        </circle>
      ))}
    </svg>
  );
}

/* ============ TUTOR SUBMISSIONS PANEL (Phase 2 Session 6) ============ */
function TutorSummaryStat({value, label, tone}){
  return (
    <div style={{textAlign:"left"}}>
      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:26,fontWeight:600,color:tone||"#0F1A2E",letterSpacing:-.3,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{value}</div>
      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:1.2,textTransform:"uppercase",marginTop:6,fontWeight:500}}>{label}</div>
    </div>
  );
}

function TutorSubmissionsPanel({student}){
  const {status, submissions, error} = useTutorSubmissions(student.id);
  const groups = useMemo(
    ()=>groupSubmissionsByAssignment(submissions, student.assignments||[]),
    [submissions, student.assignments]
  );
  const summary = useMemo(()=>summarizeSubmissions(submissions), [submissions]);

  if(status === "loading"){
    return (
      <div style={{...CARD, padding:"60px 40px", textAlign:"center"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:20,color:"#66708A"}}>Loading submissions…</div>
      </div>
    );
  }
  if(status === "error"){
    return (
      <div style={{...CARD, padding:"60px 40px", textAlign:"center"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:20,color:"#8C2E2E"}}>Couldn't load submissions.</div>
        <div style={{fontSize:12,color:"#66708A",marginTop:8}}>{error?.message||""}</div>
      </div>
    );
  }
  if(!submissions.length){
    return (
      <div style={{...CARD, padding:"60px 40px", textAlign:"center"}}>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:20,color:"#66708A",letterSpacing:-.2}}>No submissions yet.</div>
        <div style={{fontSize:12,color:"#66708A",marginTop:10,lineHeight:1.55}}>When this student answers assignments in the portal, they'll show up here.</div>
      </div>
    );
  }

  return (
    <div>
      {/* Summary header — missed-question report lives here by design (see plan) */}
      <div style={{...CARD, padding:"20px 22px", marginBottom:16}}>
        <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,letterSpacing:1.4,color:"#66708A",textTransform:"uppercase",marginBottom:12}}>Missed-Question Report</div>
        <div style={{display:"flex",gap:28,flexWrap:"wrap",alignItems:"baseline"}}>
          <TutorSummaryStat value={summary.totalCorrect} label="Questions correct" tone="#4C7A4C"/>
          <TutorSummaryStat value={summary.totalMissed} label="Questions missed" tone="#8C2E2E"/>
          <TutorSummaryStat value={summary.totalQuestions} label="Questions attempted"/>
          <TutorSummaryStat value={summary.percentCorrect===null?"—":`${summary.percentCorrect}%`} label="Percent correct"/>
          <TutorSummaryStat value={summary.unreviewedCount} label="Unreviewed attempts" tone="#9A5B1F"/>
          {summary.draftCount>0 && <TutorSummaryStat value={summary.draftCount} label="In progress" tone="#66708A"/>}
        </div>
        {summary.reviewedCount===0 && summary.submittedCount>0 && (
          <div style={{marginTop:14,fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:13,color:"#66708A"}}>
            No attempts reviewed yet — enter a score on each submission below to populate this report.
          </div>
        )}
      </div>

      {/* Grouped list */}
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        {groups.map(group => (
          <div key={group.assignmentId} style={{...CARD, padding:20}}>
            <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:14,paddingBottom:12,borderBottom:"1px solid rgba(15,26,46,.08)",gap:12,flexWrap:"wrap"}}>
              <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:18,fontWeight:600,color:"#0F1A2E",letterSpacing:-.2}}>
                {group.assignment
                  ? (group.assignment.date || group.assignment.dateAssigned || "Undated session")
                  : "Orphaned submissions (assignment deleted)"}
              </div>
              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:1,textTransform:"uppercase"}}>
                {group.submissions.length} attempt{group.submissions.length===1?"":"s"}
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              {group.submissions.map(sub => (
                <TutorSubmissionRow key={sub.id} studentId={student.id} submission={sub}/>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TutorSubmissionRow({studentId, submission}){
  const isDraft = submission.status === "draft";
  const isReviewed = isSubmissionReviewed(submission);
  // Session 18A bug fix: previously this returned only responses[0]'s
  // studentAnswer — broken for any submission with multiple worksheets
  // or more than one response (the nested shape introduced in Phase 2
  // Session 4). Now we render all responses grouped by worksheetId so
  // the tutor can see every answer the student submitted.
  //
  // Two shapes to support:
  //   - Legacy single-blob: 1 response with worksheetId === null and
  //     studentAnswer holds the whole free-text answer block.
  //   - Nested per-question: responses[i] = {worksheetId, questionIndex,
  //     studentAnswer, flag?}. We bucket by worksheetId, sort by
  //     questionIndex, and render "1. B  2. C  3. blank" per worksheet.
  const answerDisplay = (()=>{
    const responses = Array.isArray(submission.responses) ? submission.responses : [];
    if(responses.length === 0) return null;
    // Legacy single-blob
    if(responses.length === 1 && (responses[0].worksheetId === null || responses[0].worksheetId === undefined)){
      const a = typeof responses[0].studentAnswer === "string" ? responses[0].studentAnswer : "";
      return { kind: "legacy", text: a };
    }
    // Nested — group by worksheetId
    const groups = {};
    for(const r of responses){
      const wId = r.worksheetId || "(unknown)";
      if(!groups[wId]) groups[wId] = [];
      groups[wId][Number(r.questionIndex) || 0] = {
        ans: typeof r.studentAnswer === "string" ? r.studentAnswer : "",
        flag: r.flag || null,
      };
    }
    return { kind: "nested", groups };
  })();

  // Local inputs seed from the doc. Empty string is the "unset" sentinel so
  // the placeholder shows through.
  const [correctInput, setCorrectInput] = useState(
    typeof submission.scoreCorrect === "number" ? String(submission.scoreCorrect) : ""
  );
  const [totalInput, setTotalInput] = useState(
    typeof submission.scoreTotal === "number" ? String(submission.scoreTotal) : ""
  );
  const [notes, setNotes] = useState(submission.reviewerNotes || "");
  const [saving, setSaving] = useState(false);

  // Reseed from the live doc if another session updated it while open.
  const lastSyncRef = useRef({
    sc: submission.scoreCorrect,
    st: submission.scoreTotal,
    notes: submission.reviewerNotes || "",
  });
  useEffect(()=>{
    const prev = lastSyncRef.current;
    const incomingNotes = submission.reviewerNotes || "";
    if(prev.sc !== submission.scoreCorrect){
      setCorrectInput(typeof submission.scoreCorrect === "number" ? String(submission.scoreCorrect) : "");
    }
    if(prev.st !== submission.scoreTotal){
      setTotalInput(typeof submission.scoreTotal === "number" ? String(submission.scoreTotal) : "");
    }
    if(prev.notes !== incomingNotes){
      setNotes(incomingNotes);
    }
    lastSyncRef.current = {sc:submission.scoreCorrect, st:submission.scoreTotal, notes:incomingNotes};
  }, [submission.scoreCorrect, submission.scoreTotal, submission.reviewerNotes]);

  const parsedCorrect = correctInput === "" ? null : Number(correctInput);
  const parsedTotal = totalInput === "" ? null : Number(totalInput);
  const canSaveScore = parsedCorrect !== null
    && parsedTotal !== null
    && Number.isFinite(parsedCorrect)
    && Number.isFinite(parsedTotal)
    && parsedTotal > 0
    && parsedCorrect >= 0
    && parsedCorrect <= parsedTotal;

  const saveReview = async () => {
    if(saving || !canSaveScore) return;
    setSaving(true);
    try{
      await studentSubmissionsCollection(studentId).doc(submission.id).update(
        makeReviewPayload({
          scoreCorrect: parsedCorrect,
          scoreTotal: parsedTotal,
          reviewerNotes: notes,
        })
      );
    } catch(err){
      console.warn("[tutor] review write error:", err);
      alert("Couldn't save review. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const clearReview = async () => {
    if(saving) return;
    setSaving(true);
    try{
      await studentSubmissionsCollection(studentId).doc(submission.id).update(
        makeReviewPayload({scoreCorrect:null, scoreTotal:null, reviewerNotes: notes})
      );
      setCorrectInput("");
      setTotalInput("");
    } catch(err){
      console.warn("[tutor] clear review error:", err);
      alert("Couldn't clear review. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const saveNotesOnly = async () => {
    if(saving) return;
    setSaving(true);
    try{
      // Preserve the existing score on notes-only saves.
      const keepCorrect = isReviewed ? submission.scoreCorrect : null;
      const keepTotal = isReviewed ? submission.scoreTotal : null;
      await studentSubmissionsCollection(studentId).doc(submission.id).update(
        makeReviewPayload({scoreCorrect:keepCorrect, scoreTotal:keepTotal, reviewerNotes: notes})
      );
    } catch(err){
      console.warn("[tutor] notes save error:", err);
      alert("Couldn't save notes. Try again.");
    } finally {
      setSaving(false);
    }
  };

  // Pill: draft = gray, perfect = green, any miss = red, unreviewed = orange.
  const missedCount = isReviewed ? (submission.scoreTotal - submission.scoreCorrect) : 0;
  const pillTone = isDraft
    ? "#66708A"
    : isReviewed
      ? (missedCount === 0 ? "#4C7A4C" : "#8C2E2E")
      : "#9A5B1F";
  const pillBorder = isDraft
    ? "rgba(102,112,138,.35)"
    : isReviewed
      ? (missedCount === 0 ? "rgba(76,122,76,.4)" : "rgba(140,46,46,.4)")
      : "rgba(154,91,31,.4)";
  const pillLabel = isDraft
    ? "Draft — in progress"
    : isReviewed
      ? `${submission.scoreCorrect} / ${submission.scoreTotal} — ${formatSubmittedAt(submission.submittedAt)||"submitted"}`
      : `Unreviewed — ${formatSubmittedAt(submission.submittedAt)||"submitted"}`;

  const numInputStyle = {
    width:64, padding:"6px 8px", borderRadius:3,
    border:"1px solid rgba(15,26,46,.2)", fontFamily:"'IBM Plex Mono',monospace",
    fontSize:13, textAlign:"right", fontVariantNumeric:"tabular-nums",
    background:"#fff",
  };

  return (
    <div style={{padding:"14px 0",borderTop:"1px solid rgba(15,26,46,.06)",opacity:isDraft?0.65:1}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
        <span style={{...mkPill("transparent",pillTone),border:`1px solid ${pillBorder}`}}>{pillLabel}</span>
        {isReviewed && missedCount > 0 && (
          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#8C2E2E",letterSpacing:.4,textTransform:"uppercase"}}>
            {missedCount} missed
          </span>
        )}
      </div>
      {/* Session 18A: render all submitted answers (was previously
          showing only responses[0] which truncated multi-question/multi-
          worksheet submissions to a single value). */}
      {!answerDisplay && (
        <div style={{padding:"10px 14px",background:"#FAF7F2",borderRadius:4,border:"1px solid rgba(15,26,46,.08)",color:"#66708A",fontStyle:"italic",fontFamily:"'Fraunces',Georgia,serif"}}>
          No answer text.
        </div>
      )}
      {answerDisplay && answerDisplay.kind === "legacy" && (
        <div style={{whiteSpace:"pre-wrap",fontFamily:"'Fraunces',Georgia,serif",fontSize:14,color:"#0F1A2E",lineHeight:1.55,padding:"10px 14px",background:"#FAF7F2",borderRadius:4,border:"1px solid rgba(15,26,46,.08)"}}>
          {answerDisplay.text || <span style={{color:"#66708A",fontStyle:"italic"}}>No answer text.</span>}
        </div>
      )}
      {answerDisplay && answerDisplay.kind === "nested" && (() => {
        // Session 18C v5: per-question grading overlay. The submission
        // doc carries perQuestion:[{worksheetId, questionIndex, correct,
        // correctAnswer, ...}] populated by onSubmissionSubmit. We
        // index it by (worksheetId, questionIndex) so each rendered
        // answer chip can be colored green (correct), red (wrong, with
        // correct answer in parens), or gray (skipped / ungraded).
        const perQByKey = new Map();
        if(Array.isArray(submission.perQuestion)){
          for(const pq of submission.perQuestion){
            if(!pq) continue;
            perQByKey.set(`${pq.worksheetId}|${pq.questionIndex}`, pq);
          }
        }
        return (
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {Object.keys(answerDisplay.groups).map(wId => {
            const entries = answerDisplay.groups[wId];
            return (
              <div key={wId} style={{padding:"10px 14px",background:"#FAF7F2",borderRadius:4,border:"1px solid rgba(15,26,46,.08)"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,gap:8,flexWrap:"wrap"}}>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",letterSpacing:1.2,textTransform:"uppercase"}}>
                    {wId === "(unknown)" ? "Unknown worksheet" : `Worksheet ${wId}`}
                  </div>
                  {/* Per-worksheet right/wrong tally derived from perQuestion */}
                  {(()=>{
                    const wsResults = (submission.perQuestion||[]).filter(pq => pq && pq.worksheetId === wId);
                    if(wsResults.length === 0) return null;
                    const ok = wsResults.filter(pq => pq.correct === true).length;
                    const wrong = wsResults.filter(pq => pq.correct === false).length;
                    const ungraded = wsResults.filter(pq => pq.correct === null || pq.correct === undefined).length;
                    return (
                      <div style={{display:"flex",gap:6,fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,letterSpacing:.6}}>
                        <span style={{color:"#4C7A4C"}}>✓ {ok}</span>
                        <span style={{color:"#8C2E2E"}}>✗ {wrong}</span>
                        {ungraded > 0 && <span style={{color:"#9A5B1F"}}>— {ungraded}</span>}
                      </div>
                    );
                  })()}
                </div>
                {/* Color-coded per-question grid */}
                <div style={{display:"flex",flexWrap:"wrap",gap:"6px 12px",fontFamily:"'IBM Plex Mono',monospace",fontSize:13}}>
                  {entries.map((e, i) => {
                    if(!e) return null;
                    const ans = (e.ans || "").trim();
                    const isBlank = ans.length === 0;
                    const flagIcon = e.flag === "star" ? "★" : e.flag === "question" ? "?" : null;
                    const flagColor = e.flag === "star" ? "#9A5B1F" : e.flag === "question" ? "#5C4178" : null;
                    // Look up grading result for this exact slot.
                    const pq = perQByKey.get(`${wId}|${i}`);
                    let bg = "#fff", fg = "#0F1A2E", border = "rgba(15,26,46,.12)", reveal = null;
                    if(pq){
                      if(pq.correct === true){
                        bg = "#E4F0E2"; fg = "#2D5A2D"; border = "rgba(76,122,76,.4)";
                      } else if(pq.correct === false){
                        bg = "#F4DADA"; fg = "#7A2020"; border = "rgba(140,46,46,.4)";
                        reveal = pq.correctAnswer; // show the right answer in parens
                      } else {
                        bg = "#FFF1DE"; fg = "#7A5318"; border = "rgba(154,91,31,.4)";
                      }
                    }
                    return (
                      <span key={i} style={{
                        display:"inline-flex",alignItems:"center",gap:4,
                        padding:"3px 8px",borderRadius:4,
                        background:bg, color:fg, border:`1px solid ${border}`,
                      }}>
                        <span style={{opacity:.7,fontWeight:500}}>{i+1}.</span>
                        <span style={{fontStyle:isBlank?"italic":"normal",fontWeight:isBlank?400:600,opacity:isBlank?.65:1}}>
                          {isBlank ? "blank" : ans}
                        </span>
                        {reveal && (
                          <span style={{opacity:.8,fontWeight:500}}>
                            (✓ {reveal})
                          </span>
                        )}
                        {flagIcon && (
                          <span style={{color:flagColor,fontWeight:700,marginLeft:2}} title={e.flag === "star" ? "Student starred — had trouble" : "Student question mark — guessed/skipped"}>
                            {flagIcon}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
                {/* Legend hint — only render when we have flagged questions */}
                {entries.some(e => e && e.flag) && (
                  <div style={{marginTop:8,fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:.4,lineHeight:1.5}}>
                    <span style={{color:"#9A5B1F",fontWeight:700,marginRight:4}}>★</span> student starred (had trouble)
                    <span style={{marginLeft:14,color:"#5C4178",fontWeight:700,marginRight:4}}>?</span> student question mark (guessed)
                  </div>
                )}
              </div>
            );
          })}
        </div>
        );
      })()}
      {!isDraft && (
        <div style={{marginTop:12,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:1.2,textTransform:"uppercase"}}>Score</span>
          <input
            type="number" min="0" step="1" placeholder="0"
            value={correctInput}
            onChange={e=>setCorrectInput(e.target.value)}
            disabled={saving}
            style={numInputStyle}
          />
          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:14,color:"#66708A"}}>/</span>
          <input
            type="number" min="1" step="1" placeholder="10"
            value={totalInput}
            onChange={e=>setTotalInput(e.target.value)}
            disabled={saving}
            style={numInputStyle}
          />
          <button
            disabled={saving || !canSaveScore}
            onClick={saveReview}
            style={{...mkBtn(B2,"#FAF7F2"),padding:"6px 14px",fontSize:10,letterSpacing:.4,textTransform:"uppercase",opacity:(saving||!canSaveScore)?0.5:1}}
          >Save review</button>
          {isReviewed && (
            <button
              disabled={saving}
              onClick={clearReview}
              style={{...mkBtn("transparent","#66708A"),border:"1px solid rgba(15,26,46,.18)",padding:"6px 14px",fontSize:10,letterSpacing:.4,textTransform:"uppercase"}}
            >Clear</button>
          )}
        </div>
      )}
      {!isDraft && (
        <div style={{marginTop:12}}>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:1.2,textTransform:"uppercase",marginBottom:6}}>Tutor notes</div>
          <textarea
            value={notes}
            onChange={e=>setNotes(e.target.value)}
            placeholder="Which questions were missed? What to work on next?"
            style={{width:"100%",minHeight:68,padding:"10px 12px",borderRadius:4,border:"1px solid rgba(15,26,46,.18)",fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:12,lineHeight:1.5,color:"#0F1A2E",resize:"vertical",boxSizing:"border-box"}}
          />
          <div style={{marginTop:8,display:"flex",justifyContent:"flex-end"}}>
            <button
              disabled={saving || notes === (submission.reviewerNotes||"")}
              onClick={saveNotesOnly}
              style={{...mkBtn("transparent","#0F1A2E"),border:"1px solid rgba(15,26,46,.25)",padding:"6px 14px",fontSize:10,letterSpacing:.4,textTransform:"uppercase",opacity:(saving||notes===(submission.reviewerNotes||""))?0.5:1}}
            >Save notes</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============ SCORE HISTORY PANEL (inside StudentProfile) ============ */
function ScoreHistoryPanel({p, sfm, setSfm, addScore, delScore, addWelledLog, delWelledLog, handleWelledUpload, welledInputRef, readOnly}){
  // Session 18A: submissions feed graded-submission time-points into the
  // score-tracking pipeline. Wired through useTutorSubmissions which is
  // a live snapshot — the panel updates the moment a student submits.
  //
  // Session 18C v5: useTutorSubmissions catches its own errors and
  // returns {submissions:[], error}, so an auth-timing failure on the
  // student-portal path won't propagate up and blank the portal.
  const {submissions: panelSubmissions} = useTutorSubmissions(p?.id);
  const pts = allScoreDataPoints(p, panelSubmissions || []);
  const [expanded,setExpanded] = useState({}); // {domainKey: true}
  const [diffFilter,setDiffFilter] = useState("all"); // all|easy|medium|hard|comprehensive
  const [wlog,setWlog] = useState({date:todayStr(),subject:"Reading & Writing",domain:"Information & Ideas",difficulty:"medium",score:"",notes:""});

  // Split points into (A) full practice, (B) domain-level, (C) subskill-level, (D) other
  const { fullPts, domainPts, subPts, otherPts } = useMemo(()=>{
    const full=[], dom=[], sub=[], oth=[];
    pts.forEach(pt=>{
      const catStr = pt.category||"";
      const isFull = /Total SAT|R&W Section|Math Section|Full —|Section —|Practice|Official SAT|Full Practice|BlueBook|WellEd Full/i.test(catStr);
      if(isFull && pt.level!=="domain" && pt.level!=="sub") full.push(pt);
      else if(pt.level==="sub") sub.push(pt);
      else if(pt.level==="domain") dom.push(pt);
      else oth.push(pt);
    });
    return {fullPts:full,domainPts:dom,subPts:sub,otherPts:oth};
  },[pts]);

  // Group full practice by subcategory
  const fullGroups = useMemo(()=>{
    const g={};
    fullPts.forEach(pt=>{
      const key = pt.subcategory||pt.category;
      if(!g[key]) g[key]={key,pts:[]};
      g[key].pts.push(pt);
    });
    Object.values(g).forEach(grp=>grp.pts.sort((a,b)=>(a.date||"").localeCompare(b.date||"")));
    return Object.values(g);
  },[fullPts]);

  // Build domain structure: {subject|domain: {subject, domain, pts, byDiff:{easy:[],...}, subskills:{name:[pts]}}}
  const domainCards = useMemo(()=>{
    const m = {};
    const addDomain = (subject,domain)=>{
      const k = `${subject}|${domain}`;
      if(!m[k]) m[k]={subject,domain,key:k,pts:[],byDiff:{easy:[],medium:[],hard:[],comprehensive:[]},subskills:{}};
      return m[k];
    };
    domainPts.forEach(pt=>{
      const subj = pt.subject || (pt.category||"").split(" — ")[0] || "Unknown";
      const dom = pt.domain || pt.subcategory;
      const d = addDomain(subj,dom);
      d.pts.push(pt);
      const diff = (pt.difficulty||"").toLowerCase();
      if(d.byDiff[diff]) d.byDiff[diff].push(pt);
    });
    subPts.forEach(pt=>{
      const subj = pt.subject || "Unknown";
      const dom = pt.domain || "Unknown";
      const name = pt.subskill || pt.subcategory;
      const d = addDomain(subj,dom);
      if(!d.subskills[name]) d.subskills[name]=[];
      d.subskills[name].push(pt);
    });
    // Sort pts in each
    Object.values(m).forEach(d=>{
      d.pts.sort((a,b)=>(a.date||"").localeCompare(b.date||""));
      Object.values(d.byDiff).forEach(arr=>arr.sort((a,b)=>(a.date||"").localeCompare(b.date||"")));
      Object.values(d.subskills).forEach(arr=>arr.sort((a,b)=>(a.date||"").localeCompare(b.date||"")));
    });
    // Order: R&W first, then Math, then alpha by domain within
    return Object.values(m).sort((a,b)=>{
      if(a.subject!==b.subject) return a.subject==="Reading & Writing"?-1:1;
      return a.domain.localeCompare(b.domain);
    });
  },[domainPts,subPts]);

  // Filtered by difficulty
  const filterPts = (arr)=>{
    if(diffFilter==="all") return arr;
    return arr.filter(pt=>(pt.difficulty||"").toLowerCase()===diffFilter);
  };

  const pctOf = (pt)=> pt.max?Math.round((pt.score/pt.max)*100):(pt.pct??null);
  const avgPct = (arr)=>{
    const vals = arr.map(pctOf).filter(v=>v!=null);
    if(!vals.length) return null;
    return Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
  };
  // pctColor / pctBg / PctBar are defined at module scope above.
  // Small sparkline card (used for full practice & subskills)
  const miniCard = (key,title,ptsArr,accent)=>{
    if(!ptsArr.length) return null;
    const last = ptsArr[ptsArr.length-1], first=ptsArr[0];
    const lastPct = pctOf(last), firstPct = pctOf(first);
    const delta = lastPct!=null&&firstPct!=null?lastPct-firstPct:null;
    const chartPoints = ptsArr.map((pt,i)=>({x:i,y:pctOf(pt)??0,label:`${pt.date}${pt.source==="diagnostic"?" (Diagnostic)":""}`}));
    const hasDiag = ptsArr.some(p=>p.source==="diagnostic");
    const srcLabels = [...new Set(ptsArr.map(p=>({diagnostic:"Diagnostic",manual:"Manual",history_exam:"Practice",history_welled:"WellEd Asg",welled_log:"WellEd Log"}[p.source]||p.source)))];
    return(
      <div key={key} style={{background:"#fff",borderRadius:3,padding:14,boxShadow:"0 0 0 1px rgba(15,26,46,.08)",borderLeft:`3px solid ${accent}`}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
          <div style={{fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:12,fontWeight:600,color:"#0F1A2E",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,letterSpacing:-.1}} title={title}>{title}</div>
          {hasDiag&&<span style={{...mkPill("transparent","#6E3F12"),border:"1px solid rgba(154,91,31,.35)",fontSize:8}}>Diag</span>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <div style={{display:"flex",alignItems:"baseline",gap:4}}>
            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:20,fontWeight:600,color:accent,letterSpacing:.2,lineHeight:1}}>{last.score}</div>
            {last.max && <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,color:"#66708A",fontWeight:500}}>/ {last.max}</div>}
          </div>
          {delta!=null&&ptsArr.length>1&&<div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:delta>0?"#4C7A4C":delta<0?"#8C2E2E":"#66708A",fontWeight:600,marginLeft:"auto",letterSpacing:.2}}>{delta>0?"+":delta<0?"−":"·"}{Math.abs(delta)}%</div>}
        </div>
        {lastPct!=null && <div style={{marginBottom:8}}><PctBar value={lastPct} width={150}/></div>}
        <LineChart points={chartPoints} color={accent} max={100} height={60} width={230}/>
        <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",marginTop:6,letterSpacing:.2}}>{ptsArr.length} pt{ptsArr.length!==1?"s":""} · {last.date} · {srcLabels.join(", ")}</div>
        {/* Session 18A: legend below the subskill mini-chart */}
        <TimelineLegend points={ptsArr} compact={false}/>
      </div>
    );
  };

  // Big domain card — editorial treatment
  const renderDomainCard = (d)=>{
    const color = DOMAIN_COLOR[d.domain]||B2;
    const filtered = filterPts(d.pts);
    if(filtered.length===0 && diffFilter!=="all") return null;
    const avg = avgPct(filtered);
    const last = filtered[filtered.length-1];
    const first = filtered[0];
    const delta = last && first && filtered.length>1 ? pctOf(last)-pctOf(first) : null;
    const chartPoints = filtered.map((pt,i)=>({x:i,y:pctOf(pt)??0,label:`${pt.date} (${pt.difficulty||"—"})`}));
    const isOpen = expanded[d.key];
    const subskillNames = Object.keys(d.subskills);

    return(
      <div key={d.key} style={{background:"#fff",borderRadius:4,boxShadow:"0 0 0 1px rgba(15,26,46,.1)",borderLeft:`3px solid ${color}`,overflow:"hidden"}}>
        {/* Header bar — editorial hairline row */}
        <div style={{padding:"16px 20px",borderBottom:"1px solid rgba(15,26,46,.08)",display:"flex",alignItems:"center",gap:14}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",textTransform:"uppercase",letterSpacing:1.2}}>{d.subject}</div>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:19,fontWeight:600,color:"#0F1A2E",letterSpacing:-.25,marginTop:3}}>{d.domain}</div>
          </div>
          {avg!=null && <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:5}}>
            <PctBar value={avg} width={140}/>
            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",fontWeight:500,letterSpacing:.4,textTransform:"uppercase"}}>Avg · {filtered.length} pt{filtered.length!==1?"s":""}</div>
          </div>}
          {delta!=null && <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:delta>0?"#4C7A4C":delta<0?"#8C2E2E":"#66708A",fontWeight:600,padding:"5px 10px",border:"1px solid "+(delta>0?"rgba(76,122,76,.35)":delta<0?"rgba(140,46,46,.35)":"rgba(15,26,46,.18)"),borderRadius:2,letterSpacing:.3}}>{delta>0?"+":delta<0?"−":"·"}{Math.abs(delta)}%</div>}
        </div>

        {/* Body: chart + difficulty breakdown */}
        <div style={{padding:20}}>
          {filtered.length>0 ? (
            <div style={{display:"grid",gridTemplateColumns:"1fr 200px",gap:20,alignItems:"start"}}>
              <div>
                <LineChart points={chartPoints} color={color} max={100} height={110} width={400}/>
                {/* Session 18A: legend below the main domain chart */}
                <TimelineLegend points={filtered} compact={false}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:11,fontStyle:"italic",color:"#66708A",marginBottom:2}}>By Difficulty</div>
                {DIFF_ORDER.map(diff=>{
                  const diffPts = d.byDiff[diff]||[];
                  if(diffPts.length===0) return null;
                  const a = avgPct(diffPts);
                  const lastD = diffPts[diffPts.length-1];
                  return(
                    <div key={diff} style={{display:"flex",flexDirection:"column",gap:3,fontSize:11}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <div style={{width:8,height:8,background:DC[diff],flexShrink:0}}/>
                        <div style={{flex:1,color:"#2E3A57",fontWeight:500,textTransform:"capitalize"}}>{diff}</div>
                        <div style={{fontSize:10,color:"#66708A",fontFamily:"'IBM Plex Mono',monospace"}}>{lastD.score}/{lastD.max}</div>
                      </div>
                      <div style={{paddingLeft:16}}><PctBar value={a} width={130}/></div>
                    </div>
                  );
                })}
                {DIFF_ORDER.every(diff=>(d.byDiff[diff]||[]).length===0) && <div style={{fontSize:10,color:"#66708A",fontStyle:"italic"}}>No difficulty breakdown (diagnostic only)</div>}
              </div>
            </div>
          ) : <div style={{fontSize:11,color:"#66708A",fontStyle:"italic",textAlign:"center",padding:16,fontFamily:"'Fraunces',Georgia,serif"}}>No data at this difficulty filter</div>}

          {/* Expand subskills toggle */}
          {subskillNames.length>0 && <button onClick={()=>setExpanded(prev=>({...prev,[d.key]:!prev[d.key]}))} style={{...mkBtn("transparent",color),border:"1px solid "+color+"55",marginTop:16,width:"100%",padding:"8px 14px",fontSize:11,letterSpacing:.3,textTransform:"uppercase",fontWeight:600}}>
            {isOpen?"Hide":"Show"} · {subskillNames.length} Subskill{subskillNames.length!==1?"s":""}
          </button>}

          {isOpen && subskillNames.length>0 && <div style={{marginTop:14,padding:16,background:"rgba(15,26,46,.02)",borderRadius:3,border:"1px solid rgba(15,26,46,.08)"}}>
            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",textTransform:"uppercase",letterSpacing:1.2,marginBottom:10}}>Subskill Performance Over Time</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:10}}>
              {subskillNames.map(name=>miniCard(`${d.key}|${name}`,name,d.subskills[name],color))}
            </div>
          </div>}
        </div>
      </div>
    );
  };

  // WellEd log form helpers
  const wlogDomainOptions = WELLED_DOMAIN.filter(e=>e.subject===wlog.subject);
  const wlogCurrentEntry = WELLED_DOMAIN.find(e=>e.subject===wlog.subject && e.domain===wlog.domain);
  const wlogMax = wlog.subject==="Math"?22:27;
  const wlogSubmit = ()=>{
    if(!wlog.score || !wlog.domain){return;}
    addWelledLog({date:wlog.date,subject:wlog.subject,domain:wlog.domain,difficulty:wlog.difficulty,score:Number(wlog.score),max:wlogMax,notes:wlog.notes});
    setWlog({...wlog,score:"",notes:""});
  };

  const fieldLabel = {fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",marginBottom:4,fontWeight:600,letterSpacing:1.2,textTransform:"uppercase"};

  return(
    <div>
      {/* Session 18C: WellEd Practice Exam Report upload — moved from
          Diagnostics tab. Different metric class from ZipGrade diagnostics
          (which measure baseline subskill mastery); WellEd reports are
          scored practice tests that produce per-section + per-subskill
          time-points. */}
      {!readOnly && handleWelledUpload && welledInputRef && (
        <div style={{...CARD,marginBottom:16,padding:18,borderLeft:`3px solid #6E3F12`}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
            <div style={{flex:"1 1 320px"}}>
              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,letterSpacing:1.4,color:"#6E3F12",textTransform:"uppercase",marginBottom:6}}>WellEd Practice Exam Report</div>
              <div style={{fontFamily:"'Fraunces',Georgia,serif",fontSize:18,fontWeight:600,color:"#0F1A2E",letterSpacing:-.2,marginBottom:6}}>Upload a scored practice test</div>
              <div style={{fontSize:12,color:"#66708A",lineHeight:1.55,maxWidth:520}}>
                For full / Reading-only / Math-only WellEd practice exam PDFs. The parser extracts
                scaled section scores + per-subskill breakdown. <em>Different from the Diagnostics
                tab</em> — diagnostics are baseline (one-time mastery snapshots), these are scored
                practice tests that show progress over time.
              </div>
            </div>
            <input ref={welledInputRef} type="file" multiple accept="application/pdf" onChange={e=>handleWelledUpload(e.target.files)} style={{display:"none"}}/>
            <button onClick={()=>welledInputRef.current?.click()} style={{...mkBtn("#6E3F12","#FAF7F2"),padding:"10px 18px",fontSize:11,fontWeight:600,letterSpacing:.4,textTransform:"uppercase",flexShrink:0}}>Upload WellEd Report</button>
          </div>
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns: readOnly ? "1fr" : "340px 1fr",gap:20}}>
        {/* ========== LEFT: Quick Add — hidden on student/portal side ========== */}
        {!readOnly && <div style={{display:"flex",flexDirection:"column",gap:16}}>
          {/* WellEd domain logger */}
          <div style={{...CARD,padding:20,borderLeft:`3px solid ${B2}`}}>
            <SH>Log WellEd Domain Score</SH>
            <div style={{display:"flex",flexDirection:"column",gap:11}}>
              <div><div style={fieldLabel}>Date</div><input type="date" value={wlog.date} onChange={e=>setWlog({...wlog,date:e.target.value})} style={INP}/></div>
              <div><div style={fieldLabel}>Subject</div>
                <select value={wlog.subject} onChange={e=>{
                  const subj = e.target.value;
                  const firstDom = WELLED_DOMAIN.find(x=>x.subject===subj);
                  setWlog({...wlog,subject:subj,domain:firstDom?.domain||"",difficulty:firstDom?.diffs[0]||"easy"});
                }} style={INP}>
                  <option>Reading & Writing</option>
                  <option>Math</option>
                </select>
              </div>
              <div><div style={fieldLabel}>Domain</div>
                <select value={wlog.domain} onChange={e=>{
                  const entry = WELLED_DOMAIN.find(x=>x.subject===wlog.subject && x.domain===e.target.value);
                  setWlog({...wlog,domain:e.target.value,difficulty:entry?.diffs.includes(wlog.difficulty)?wlog.difficulty:entry?.diffs[0]||"easy"});
                }} style={INP}>
                  {wlogDomainOptions.map(e=><option key={e.domain}>{e.domain}</option>)}
                </select>
              </div>
              <div><div style={fieldLabel}>Difficulty</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:5}}>
                  {(wlogCurrentEntry?.diffs||["easy","medium","hard","comprehensive"]).concat(["comprehensive"]).filter((v,i,a)=>a.indexOf(v)===i).map(diff=>{
                    const active = wlog.difficulty===diff;
                    return <button key={diff} onClick={()=>setWlog({...wlog,difficulty:diff})} style={{...mkBtn(active?DC[diff]:"transparent",active?"#FAF7F2":"#2E3A57"),border:"1px solid "+(active?DC[diff]:"rgba(15,26,46,.15)"),padding:"6px 10px",fontSize:10,textTransform:"capitalize"}}>{diff}</button>;
                  })}
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:8,alignItems:"end"}}>
                <div><div style={fieldLabel}>Score</div><input type="number" value={wlog.score} onChange={e=>setWlog({...wlog,score:e.target.value})} placeholder={`0-${wlogMax}`} max={wlogMax} min={0} style={INP}/></div>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,color:"#66708A",fontWeight:500,paddingBottom:10}}>/ {wlogMax}</div>
              </div>
              <div><div style={fieldLabel}>Notes</div><input value={wlog.notes} onChange={e=>setWlog({...wlog,notes:e.target.value})} placeholder="Optional…" style={{...INP,fontStyle:wlog.notes?"normal":"italic"}}/></div>
              <button onClick={wlogSubmit} disabled={!wlog.score} style={{...mkBtn(wlog.score?B2:"rgba(15,26,46,.12)",wlog.score?"#FAF7F2":"#66708A"),padding:"10px 16px",fontSize:11,fontWeight:600,letterSpacing:.3,textTransform:"uppercase",cursor:wlog.score?"pointer":"not-allowed"}}>+ Log Score</button>
            </div>
          </div>

          {/* Manual full-test score */}
          <div style={{...CARD,padding:20,borderLeft:"3px solid #5B4B8A"}}>
            <SH>Log Full Test Score</SH>
            <div style={{display:"flex",flexDirection:"column",gap:11}}>
              <div><div style={fieldLabel}>Date</div><input type="date" value={sfm.date} onChange={e=>setSfm(prev=>({...prev,date:e.target.value}))} style={INP}/></div>
              <div>
                <div style={fieldLabel}>Test / Section</div>
                <select value={sfm.testType} onChange={e=>setSfm(prev=>({...prev,testType:e.target.value}))} style={INP}>
                  <option value="">Select…</option>
                  <optgroup label="Full Practice Tests">
                    <option>WellEd Full Practice Test</option>
                    <option>BlueBook Full Practice Test</option>
                    <option>Official SAT / PSAT</option>
                  </optgroup>
                  <optgroup label="Sections">
                    <option>R&amp;W Section</option>
                    <option>Math Section</option>
                  </optgroup>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <div><div style={fieldLabel}>Score</div><input type="number" value={sfm.score} onChange={e=>setSfm(prev=>({...prev,score:e.target.value}))} placeholder="1250" style={INP}/></div>
                <div><div style={fieldLabel}>Max</div><input type="number" value={sfm.maxScore} onChange={e=>setSfm(prev=>({...prev,maxScore:e.target.value}))} placeholder="1600" style={INP}/></div>
              </div>
              <div><div style={fieldLabel}>Notes</div><input value={sfm.notes} onChange={e=>setSfm(prev=>({...prev,notes:e.target.value}))} placeholder="Optional…" style={{...INP,fontStyle:sfm.notes?"normal":"italic"}}/></div>
              <button onClick={addScore} style={{...mkBtn("#5B4B8A","#FAF7F2"),padding:"10px 16px",fontSize:11,fontWeight:600,letterSpacing:.3,textTransform:"uppercase"}}>+ Add Score</button>
            </div>
          </div>

          <div style={{fontSize:11,color:"#66708A",lineHeight:1.55,padding:14,background:"#F3EEE4",borderRadius:3,border:"1px solid rgba(15,26,46,.06)",fontStyle:"italic",fontFamily:"'Fraunces',Georgia,serif"}}>Scores from Assignment History and diagnostic PDFs are automatically aggregated here. WellEd logs and manual scores persist independently.</div>
        </div>}

        {/* ========== RIGHT: Aggregated view ========== */}
        <div style={{display:"flex",flexDirection:"column",gap:20}}>
          {pts.length===0 && <div style={{...CARD,padding:"72px 40px",textAlign:"center"}}>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:22,color:"#66708A",letterSpacing:-.2,marginBottom:8}}>No scores recorded yet.</div>
            <div style={{fontSize:11,color:"#66708A"}}>Upload a diagnostic PDF, log a WellEd score, or enter scores in Assignment History.</div>
          </div>}

          {/* SECTION 1: Full practice tests */}
          {fullGroups.length>0 && <div style={{...CARD,padding:20}}>
            <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:14,paddingBottom:10,borderBottom:"1px solid rgba(15,26,46,.08)"}}>
              <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:19,fontWeight:600,color:"#0F1A2E",letterSpacing:-.25}}>Full Practice Tests &amp; Section Scores</div>
              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",fontWeight:500,letterSpacing:1,textTransform:"uppercase"}}>{fullGroups.length} track{fullGroups.length!==1?"s":""}</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
              {fullGroups.map(g=>miniCard(g.key,g.key,g.pts,"#5B4B8A"))}
            </div>
          </div>}

          {/* SECTION 2: Domain Performance */}
          {domainCards.length>0 && <div style={{...CARD,padding:20}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16,flexWrap:"wrap",paddingBottom:12,borderBottom:"1px solid rgba(15,26,46,.08)"}}>
              <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 96',fontSize:19,fontWeight:600,color:"#0F1A2E",letterSpacing:-.25,flex:1}}>Domain Performance</div>
              <div style={{display:"flex",gap:5,alignItems:"center"}}>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",fontWeight:500,textTransform:"uppercase",letterSpacing:1,marginRight:4}}>Filter</div>
                {["all","easy","medium","hard","comprehensive"].map(d=>{
                  const active = diffFilter===d;
                  const c = d==="all"?B2:DC[d];
                  return <button key={d} onClick={()=>setDiffFilter(d)} style={{...mkBtn(active?c:"transparent",active?"#FAF7F2":"#2E3A57"),border:"1px solid "+(active?c:"rgba(15,26,46,.15)"),padding:"4px 10px",fontSize:10,textTransform:"capitalize"}}>{d==="all"?"All":d}</button>;
                })}
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              {domainCards.map(renderDomainCard)}
            </div>
          </div>}

          {/* SECTION 3: Orphan subskills (no parent domain data) */}
          {domainCards.length===0 && subPts.length>0 && <div style={{...CARD,padding:20}}>
            <SH>Subskill Data</SH>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12}}>
              {(()=>{
                const sg={};
                subPts.forEach(pt=>{const k=pt.subskill||pt.subcategory; if(!sg[k])sg[k]=[]; sg[k].push(pt);});
                return Object.entries(sg).map(([k,arr])=>miniCard(k,k,arr.sort((a,b)=>(a.date||"").localeCompare(b.date||"")),B2));
              })()}
            </div>
          </div>}

          {/* SECTION 4: Manual entries table */}
          {!readOnly && (p.scores||[]).filter(sc=>!sc.deleted).length>0 && <div style={{...CARD,padding:20}}>
            <SH>Manual Entry Log</SH>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <thead><tr>{["Date","Test","Score","Max","%","Notes",""].map(h=><th key={h} style={{padding:"10px 12px",textAlign:"left",fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",fontWeight:600,letterSpacing:1.2,textTransform:"uppercase",borderBottom:"1px solid rgba(15,26,46,.15)"}}>{h}</th>)}</tr></thead>
                <tbody>
                  {/* Session 18C v3: filter deleted entries — previously
                      ✕ button soft-deleted but the row stayed visible. */}
                  {[...p.scores].filter(sc=>!sc.deleted).sort((a,b)=>b.date.localeCompare(a.date)).map((sc,i,arr)=>{
                    const pct=sc.maxScore?Math.round((Number(sc.score)/Number(sc.maxScore))*100):null;
                    return(
                      <tr key={sc.id} style={{borderBottom:i===arr.length-1?"none":"1px solid rgba(15,26,46,.06)"}}>
                        <td style={{padding:"10px 12px",color:"#2E3A57",fontFamily:"'IBM Plex Mono',monospace",fontSize:11}}>{sc.date}</td>
                        <td style={{padding:"10px 12px",fontWeight:500,color:"#0F1A2E",fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:13}}>{sc.testType}</td>
                        <td style={{padding:"10px 12px",fontWeight:600,color:"#0F1A2E",fontFamily:"'IBM Plex Mono',monospace",fontSize:12}}>{sc.score}</td>
                        <td style={{padding:"10px 12px",color:"#66708A",fontFamily:"'IBM Plex Mono',monospace"}}>{sc.maxScore||<span style={{color:"rgba(15,26,46,.25)"}}>—</span>}</td>
                        <td style={{padding:"10px 12px"}}>{pct!==null?<PctBar value={pct} width={80}/>:<span style={{color:"rgba(15,26,46,.25)"}}>—</span>}</td>
                        <td style={{padding:"10px 12px",color:"#66708A",fontStyle:"italic"}}>{sc.notes||<span style={{color:"rgba(15,26,46,.25)",fontStyle:"normal"}}>—</span>}</td>
                        <td style={{padding:"10px 12px",textAlign:"right"}}><button onClick={()=>delScore(sc.id)} style={{...mkBtn("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.3)",padding:"3px 10px",fontSize:10}}>✕</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>}

          {/* SECTION 5: WellEd log table */}
          {(p.welledLogs||[]).length>0 && <div style={{...CARD,padding:20}}>
            <SH>WellEd Domain Log</SH>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <thead><tr>{["Date","Subject","Domain","Difficulty","Score","%","Notes",""].map(h=><th key={h} style={{padding:"10px 12px",textAlign:"left",fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",fontWeight:600,letterSpacing:1.2,textTransform:"uppercase",borderBottom:"1px solid rgba(15,26,46,.15)"}}>{h}</th>)}</tr></thead>
                <tbody>
                  {[...(p.welledLogs||[])].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map((lg,i,arr)=>{
                    const mx = lg.max||(lg.subject==="Math"?22:27);
                    const pct = Math.round((Number(lg.score)/mx)*100);
                    const dc = DOMAIN_COLOR[lg.domain]||B2;
                    return(
                      <tr key={lg.id} style={{borderBottom:i===arr.length-1?"none":"1px solid rgba(15,26,46,.06)"}}>
                        <td style={{padding:"10px 12px",color:"#2E3A57",fontFamily:"'IBM Plex Mono',monospace",fontSize:11}}>{lg.date}</td>
                        <td style={{padding:"10px 12px",color:"#2E3A57"}}>{lg.subject}</td>
                        <td style={{padding:"10px 12px",fontWeight:500,color:dc,fontFamily:"'IBM Plex Sans',system-ui,sans-serif",fontSize:13}}>{lg.domain}</td>
                        <td style={{padding:"10px 12px"}}><span style={{...mkPill("transparent",DC[lg.difficulty]||"#66708A"),border:"1px solid "+(DC[lg.difficulty]||"#66708A")+"55"}}>{lg.difficulty}</span></td>
                        <td style={{padding:"10px 12px",fontWeight:600,color:"#0F1A2E",fontFamily:"'IBM Plex Mono',monospace"}}>{lg.score}/{mx}</td>
                        <td style={{padding:"10px 12px"}}><PctBar value={pct} width={80}/></td>
                        <td style={{padding:"10px 12px",color:"#66708A",fontStyle:"italic"}}>{lg.notes||<span style={{color:"rgba(15,26,46,.25)",fontStyle:"normal"}}>—</span>}</td>
                        <td style={{padding:"10px 12px",textAlign:"right"}}><button onClick={()=>delWelledLog(lg.id)} style={{...mkBtn("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.3)",padding:"3px 10px",fontSize:10}}>✕</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>}
        </div>
      </div>
    </div>
  );
}

/* ============ SCORE DATA AGGREGATOR ============ */
// Merges all score sources for a student into one flat list:
//   1. Diagnostic section scores + total (first, at parsedAt date)
//   2. Manual scores from student.scores
//   3. Practice exam scores from assignment history
//   4. WellEd Domain scores from assignment history (split by E/M/H)
// Each point: {date, category, subcategory, score, max, source, note, difficulty?}
function allScoreDataPoints(student, submissions = []){
  const pts = [];
  // 1. Diagnostic → section + total + domain + subskill scores. Diagnostic
  // is the anchor "day-0" baseline — it should be the first time-point in
  // every domain and subskill series. Uses the parsedAt date (when the
  // tutor uploaded the PDF) — if uploaded late, drop the day by 1ms below
  // any same-date assignment so sort order puts the diagnostic first.
  if(student.diagnostics?.length){
    const diag = buildDiagnosticProfile(student.diagnostics);
    const dd = student.diagnostics[0]?.parsedAt || todayStr();
    if(diag.rwScore)   pts.push({date:dd,category:"R&W Section",subcategory:"R&W Section",section:"rw",score:Math.round((diag.rwScore.lower+diag.rwScore.upper)/2),max:800,source:"diagnostic",note:`Range: ${diag.rwScore.lower}–${diag.rwScore.upper}`,_label:"Diagnostic — R&W"});
    if(diag.mathScore) pts.push({date:dd,category:"Math Section",subcategory:"Math Section",section:"math",score:Math.round((diag.mathScore.lower+diag.mathScore.upper)/2),max:800,source:"diagnostic",note:`Range: ${diag.mathScore.lower}–${diag.mathScore.upper}`,_label:"Diagnostic — Math"});
    if(diag.totalLower!=null) pts.push({date:dd,category:"Total SAT",subcategory:"Total SAT",section:"full",score:Math.round((diag.totalLower+diag.totalUpper)/2),max:1600,source:"diagnostic",note:`Range: ${diag.totalLower}–${diag.totalUpper}`,_label:"Diagnostic — Total"});
    // Domain-level diagnostic %s — these populate the domain card's chart.
    (diag.domains||[]).forEach(d=>{
      pts.push({date:dd,category:`${d.subject} — ${d.name}`,subcategory:d.name,subject:d.subject,domain:d.name,score:d.earn,max:d.poss,source:"diagnostic",pct:d.pct,level:"domain",_label:"Diagnostic"});
    });
    // Subdomain-level diagnostic %s — these populate the subskill expansion.
    (diag.subs||[]).forEach(s=>{
      pts.push({date:dd,category:`${s.subject} — ${s.domain} — ${s.name}`,subcategory:s.name,subject:s.subject,domain:s.domain,subskill:s.name,score:s.earn,max:s.poss,source:"diagnostic",pct:s.pct,level:"sub",_label:"Diagnostic"});
    });
  }
  // 2. Manual scores + WellEd report-parsed scores
  // Session 18C v3: filter soft-deleted entries so removed scores
  // actually disappear from charts + legend (previously delScore
  // marked deleted:true but allScoreDataPoints still processed them).
  (student.scores||[]).filter(sc=>!sc.deleted).forEach(sc=>{
    // ── WellEd report → section + domain time-points (Session 18C v2) ────
    // WellEd reports are scored practice tests. Their data flows into:
    //   - The diagnostic-shared "R&W Section" / "Math Section" / "Total
    //     SAT" cards (so they appear on the same line as the diagnostic
    //     baseline, not as separate per-test cards).
    //   - The per-domain cards (one DOMAIN-level point per category in
    //     welledReport.domains).
    //   - NOT subskill cards — WellEd reports don't have subskill
    //     granularity that aligns with the catalog subdomains. Per
    //     Aidan's directive, subskills are reserved for diagnostic +
    //     scored worksheets only.
    if(sc.welledReport){
      const wr = sc.welledReport;
      const testDate = wr.testedOn || sc.date || todayStr();
      const testNum = wr.testNumber;
      const labelPrefix = testNum ? `WellEd PT #${testNum}` : "WellEd Report";
      // Section + Total points — aggregated by category with diagnostic.
      // Full report: emits R&W, Math, AND Total. Section-only: emits
      // only the relevant section.
      if(wr.rwScore){
        pts.push({
          date: testDate,
          category: "R&W Section",
          subcategory: "R&W Section",
          section: "rw",
          score: wr.rwScore, max: 800,
          source: "welled_report",
          _label: `${labelPrefix} — R&W`,
          _scoreId: sc.id,
        });
      }
      if(wr.mathScore){
        pts.push({
          date: testDate,
          category: "Math Section",
          subcategory: "Math Section",
          section: "math",
          score: wr.mathScore, max: 800,
          source: "welled_report",
          _label: `${labelPrefix} — Math`,
          _scoreId: sc.id,
        });
      }
      if(wr.type === "full" && (wr.totalScore || (wr.rwScore && wr.mathScore))){
        pts.push({
          date: testDate,
          category: "Total SAT",
          subcategory: "Total SAT",
          section: "full",
          score: wr.totalScore || (wr.rwScore + wr.mathScore),
          max: 1600,
          source: "welled_report",
          _label: `${labelPrefix} — Total`,
          _scoreId: sc.id,
        });
      }
      // Domain time-points — one per category score (8 for full report,
      // 4 for section-only). Earn/poss come straight from the report so
      // they reflect per-test variation in question distribution.
      (wr.domains || []).forEach(d=>{
        if(!d || !d.name || !d.poss) return;
        const pct = Math.round((d.earn/d.poss)*100);
        pts.push({
          date: testDate,
          category: `${d.subject} — ${d.name}`,
          subcategory: d.name,
          subject: d.subject,
          domain: d.name,
          score: d.earn, max: d.poss, pct,
          source: "welled_report",
          level: "domain",
          _scoreId: sc.id,
          _label: labelPrefix,
        });
      });
      // Do NOT also push the legacy manual point for this score —
      // its data is fully covered by the section + domain emissions above.
      return;
    }
    // ── Plain manual score (not from a parsed WellEd report) ─────────────
    pts.push({date:sc.date,category:sc.testType,subcategory:sc.testType,score:Number(sc.score)||0,max:Number(sc.maxScore)||null,source:"manual",note:sc.notes||"",_id:sc.id,_label:sc.testType||"Manual"});
  });
  // 3 & 4. Assignment history — practice exam scores + WellEd domain scores
  (student.assignments||[]).forEach(a=>{
    (a.practiceExams||[]).forEach(ex=>{
      const isFull = ex.type!=="section";
      // ── Gap #3: explicit `section` field on every history_exam point ───
      // Previously section was encoded only in the category string; filtering
      // required regex. Now stored as section: "rw" | "math" | "full".
      const examNumberLabel = ex.number ? `${ex.platform} #${ex.number}` : ex.platform;
      if(isFull){
        const rw = Number(ex.rwScore)||0, math = Number(ex.mathScore)||0;
        if(ex.rwScore || ex.mathScore){
          if(ex.rwScore)   pts.push({date:a.date,category:`${ex.platform} Practice #${ex.number||"?"} — R&W`,subcategory:`${ex.platform} Full — R&W`,section:"rw",score:rw,max:800,source:"history_exam",_label:`${examNumberLabel} R&W`});
          if(ex.mathScore) pts.push({date:a.date,category:`${ex.platform} Practice #${ex.number||"?"} — Math`,subcategory:`${ex.platform} Full — Math`,section:"math",score:math,max:800,source:"history_exam",_label:`${examNumberLabel} Math`});
          if(ex.rwScore && ex.mathScore) pts.push({date:a.date,category:`${ex.platform} Practice #${ex.number||"?"} — Total`,subcategory:`${ex.platform} Full — Total`,section:"full",score:rw+math,max:1600,source:"history_exam",_label:`${examNumberLabel} Total`});
        } else if(ex.score){
          pts.push({date:a.date,category:`${ex.platform} Practice #${ex.number||"?"}`,subcategory:`${ex.platform} Full — Total`,section:"full",score:Number(ex.score)||0,max:1600,source:"history_exam",_label:examNumberLabel});
        }
      } else if(ex.score && ex.score!==""){
        const subj = ex.sectionSubject ? ` — ${ex.sectionSubject}` : "";
        const sectionField = ex.sectionSubject === "Math" ? "math" : ex.sectionSubject === "R&W" ? "rw" : "full";
        pts.push({date:a.date,category:`${ex.platform} Practice #${ex.number||"?"} Section${subj}`,subcategory:`${ex.platform} Section${subj}`,section:sectionField,score:Number(ex.score)||0,max:800,source:"history_exam",_label:`${examNumberLabel} ${ex.sectionSubject||"Section"}`});
      }
    });
    (a.welledDomain||[]).forEach(w=>{
      if(w.score && w.score!==""){
        const cat = `${w.subject} — ${w.domain}`;
        const diffLabel = w.difficulty ? ` ${w.difficulty[0].toUpperCase()+w.difficulty.slice(1)}` : "";
        pts.push({date:a.date,category:cat,subcategory:w.domain,subject:w.subject,domain:w.domain,score:Number(w.score)||0,max:w.qs||(w.subject==="Math"?22:27),source:"history_welled",difficulty:w.difficulty,level:"domain",_label:`WellEd Domain${diffLabel}`});
      }
    });
  });
  // 5. Standalone WellEd domain logs (continuous tracking, not tied to an assignment)
  (student.welledLogs||[]).forEach(log=>{
    const diffLabel = log.difficulty ? ` ${log.difficulty[0].toUpperCase()+log.difficulty.slice(1)}` : "";
    pts.push({
      date:log.date,
      category:`${log.subject} — ${log.domain}`,
      subcategory:log.domain,
      subject:log.subject,
      domain:log.domain,
      score:Number(log.score)||0,
      max:Number(log.max)||(log.subject==="Math"?22:27),
      source:"welled_log",
      difficulty:log.difficulty,
      level:"domain",
      _id:log.id,
      note:log.notes||"",
      _label:`WellEd Log${diffLabel}`,
    });
  });
  // ── Gap #2: graded portal submissions → time-points ─────────────────────
  // Each submitted+graded submission contributes one time-point per worksheet
  // at BOTH level:"domain" (for the domain-card aggregate chart) and
  // level:"sub" (for the subskill expansion). Worksheet metadata
  // (subject/domain/subdomain/difficulty) comes from the assignment row
  // since the catalog isn't always available at aggregation time.
  // Source value distinguishes graded-submission points from manual entry.
  (submissions || []).forEach(sub=>{
    if(!sub || sub.status !== "submitted") return;
    if(typeof sub.scoreCorrect !== "number" || typeof sub.scoreTotal !== "number") return;
    if(!Array.isArray(sub.perQuestion)) return;
    // Find the matching assignment to pull worksheet metadata.
    const asg = (student.assignments||[]).find(a => a && a.id === sub.assignmentId);
    if(!asg) return;
    const worksheetsById = new Map((asg.worksheets||[]).map(w => [w.id, w]));
    // Group perQuestion entries by worksheetId.
    const byWs = new Map();
    for(const pq of sub.perQuestion){
      if(!pq || !pq.worksheetId) continue;
      if(!byWs.has(pq.worksheetId)) byWs.set(pq.worksheetId, []);
      byWs.get(pq.worksheetId).push(pq);
    }
    const dateStr = (() => {
      if(typeof sub.submittedAt === "string") return sub.submittedAt.slice(0,10);
      if(sub.submittedAt && sub.submittedAt.toDate){
        try { return sub.submittedAt.toDate().toISOString().slice(0,10); } catch { /**/ }
      }
      return asg.date || todayStr();
    })();
    byWs.forEach((pqs, wsId)=>{
      const w = worksheetsById.get(wsId);
      if(!w) return;
      const correct = pqs.filter(p => p.correct === true).length;
      const total   = pqs.filter(p => p.correct === true || p.correct === false).length;
      if(total === 0) return;
      const pct = Math.round((correct/total)*100);
      const wsLabel = w.title || `${w.domain||""} ${w.difficulty||""}`;
      // domain-level point (for domain card)
      pts.push({
        date: dateStr,
        category: `${w.subject||"Unknown"} — ${w.domain||"Unknown"}`,
        subcategory: w.domain,
        subject: w.subject,
        domain: w.domain,
        score: correct,
        max: total,
        pct,
        source: "submission_graded",
        difficulty: w.difficulty,
        level: "domain",
        _label: `${wsLabel} (submitted)`,
        _subId: sub.id,
        _wsId: wsId,
      });
      // sub-level point (for subskill expansion)
      if(w.subdomain){
        pts.push({
          date: dateStr,
          category: `${w.subject} — ${w.domain} — ${w.subdomain}`,
          subcategory: w.subdomain,
          subject: w.subject,
          domain: w.domain,
          subskill: w.subdomain,
          score: correct,
          max: total,
          pct,
          source: "submission_graded",
          difficulty: w.difficulty,
          level: "sub",
          _label: `${wsLabel} (submitted)`,
          _subId: sub.id,
          _wsId: wsId,
        });
      }
    });
  });
  return pts.sort((a,b)=>(a.date||"").localeCompare(b.date||""));
}

/* ============ SCORES TAB ============ */
function ScoresTab({students,openProfile}){
  const[selSt,setSelSt]=useState(students[0]?.id||"");
  const st = students.find(s=>s.id===selSt)||students[0];
  const pts = st?allScoreDataPoints(st):[];

  // Group by subcategory. For WellEd domain entries, further split by difficulty.
  const groups = useMemo(()=>{
    const g = {};
    pts.forEach(p=>{
      const key = p.source==="history_welled" && p.difficulty ? `${p.subcategory} (${p.difficulty})` : p.subcategory;
      if(!g[key]) g[key]={key,points:[],source:p.source,difficulty:p.difficulty};
      g[key].points.push(p);
    });
    return g;
  },[pts]);

  return(
    <div>
      <div style={{marginBottom:24,paddingBottom:16,borderBottom:"1px solid rgba(15,26,46,.1)"}}>
        <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,fontWeight:600,letterSpacing:1.4,color:"#66708A",textTransform:"uppercase",marginBottom:6}}>Performance</div>
        <div style={{fontFamily:"'Fraunces',Georgia,serif",fontVariationSettings:'"opsz" 144',fontSize:34,fontWeight:600,color:"#0F1A2E",letterSpacing:-.6,lineHeight:1}}>Score Tracking</div>
        <div style={{fontSize:12,color:"#66708A",marginTop:8,fontStyle:"italic",fontFamily:"'Fraunces',Georgia,serif"}}>Diagnostic results, manual scores, and scores from assignment history. Domains split by difficulty.</div>
      </div>

      {students.length===0 ? (
        <div style={{...CARD,padding:"72px 40px",textAlign:"center"}}>
          <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:22,color:"#66708A",letterSpacing:-.2}}>No students enrolled yet.</div>
        </div>
      ) : (<>
        <div style={{...CARD,marginBottom:16,padding:16,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",letterSpacing:1.2,textTransform:"uppercase"}}>Student</div>
          <select value={selSt} onChange={e=>setSelSt(e.target.value)} style={{...INP,width:280,flexShrink:0}}>
            {students.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {st && <button onClick={()=>openProfile(st)} style={{...mkBtn("transparent",B2),border:"1px solid rgba(0,74,121,.3)",padding:"7px 14px",fontSize:11}}>View Profile →</button>}
          <div style={{marginLeft:"auto",fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:"#66708A",letterSpacing:.4,textTransform:"uppercase"}}>{pts.length.toString().padStart(3,"0")} Data Points</div>
        </div>

        {pts.length===0 ? (
          <div style={{...CARD,padding:"72px 40px",textAlign:"center"}}>
            <div style={{fontFamily:"'Fraunces',Georgia,serif",fontStyle:"italic",fontSize:22,color:"#66708A",letterSpacing:-.2,marginBottom:8}}>No scores recorded yet for {st?.name||"this student"}.</div>
            <div style={{fontSize:11,color:"#66708A"}}>Upload a diagnostic PDF or enter scores in Assignment History to populate this view.</div>
          </div>
        ) : (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
            {Object.values(groups).sort((a,b)=>a.key.localeCompare(b.key)).map(grp=>{
              const sorted = [...grp.points].sort((a,b)=>(a.date||"").localeCompare(b.date||""));
              const first = sorted[0];
              const last  = sorted[sorted.length-1];
              const firstPct = first.max?Math.round((first.score/first.max)*100):first.pct||null;
              const lastPct  = last.max?Math.round((last.score/last.max)*100):last.pct||null;
              const delta = firstPct!=null && lastPct!=null ? (lastPct-firstPct) : null;
              const accent = grp.difficulty && DC[grp.difficulty] ? DC[grp.difficulty] : B2;
              return(
                <div key={grp.key} style={{background:"#fff",padding:16,boxShadow:"0 0 0 1px rgba(15,26,46,.08)",borderRadius:3,borderLeft:`3px solid ${accent}`}}>
                  <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,fontWeight:600,color:"#66708A",textTransform:"uppercase",letterSpacing:1.2,marginBottom:8,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={grp.key}>{grp.key}</div>
                  <div style={{display:"flex",alignItems:"baseline",gap:4,marginBottom:10}}>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:22,fontWeight:600,color:"#0F1A2E",lineHeight:1,letterSpacing:.2}}>{last.score}</div>
                    {last.max&&<div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,color:"#66708A",fontWeight:500}}>/ {last.max}</div>}
                    {delta!=null && sorted.length>1 && <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:delta>0?"#4C7A4C":delta<0?"#8C2E2E":"#66708A",fontWeight:600,marginLeft:"auto",letterSpacing:.2}}>{delta>0?"+":delta<0?"−":"·"}{Math.abs(delta)}%</div>}
                  </div>
                  {lastPct!=null && <div style={{marginBottom:10}}><PctBar value={lastPct} width={180}/></div>}
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:"#66708A",letterSpacing:.2}}>
                    <span>{sorted.length} pt{sorted.length!==1?"s":""}</span>
                    <span style={{opacity:.4}}>·</span>
                    <span>Latest {last.date}</span>
                    {grp.source==="diagnostic" && first===last && <span style={{marginLeft:"auto",...mkPill("transparent","#6E3F12"),border:"1px solid rgba(154,91,31,.35)"}}>Baseline</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </>)}
    </div>
  );
}

/* ============ TRASH TAB ============ */
function TrashTab({students,restoreStudent,purgeStudent,restoreSubItem,purgeSubItem,emptyTrash,trashCount}){
  // Flatten every deleted thing into a single timeline sorted by deletedAt desc.
  const rows = useMemo(()=>{
    const out = [];
    const fmt = (ts)=> ts ? new Date(ts).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : "—";
    for(const st of students){
      if(st.deleted){
        out.push({
          kind:"student", id:st.id, parentId:null, deletedAt:st.deletedAt||0,
          label: st.name || "(unnamed student)",
          detail: `${(st.assignments||[]).length} assignments · ${(st.scores||[]).length} scores`,
          restore: ()=>restoreStudent(st.id),
          purge: ()=>purgeStudent(st.id),
        });
      }
      // Sub-items only surface under LIVE students. If the parent student is
      // itself deleted, restoring the student brings them back whole.
      if(!st.deleted){
        for(const a of trashed(st.assignments)){
          out.push({
            kind:"assignment", id:a.id, parentId:st.id, deletedAt:a.deletedAt||0,
            label: `${st.name} — Assignment ${a.date||""}`.trim(),
            detail: `${(a.worksheets||[]).length} worksheet${(a.worksheets||[]).length!==1?"s":""}`,
            restore: ()=>restoreSubItem(st.id,"assignments",a.id),
            purge: ()=>purgeSubItem(st.id,"assignments",a.id),
          });
        }
        for(const sc of trashed(st.scores)){
          out.push({
            kind:"score", id:sc.id, parentId:st.id, deletedAt:sc.deletedAt||0,
            label: `${st.name} — ${sc.testType||"Score"}`,
            detail: `${sc.score||"—"}${sc.maxScore?` / ${sc.maxScore}`:""} · ${sc.date||""}`,
            restore: ()=>restoreSubItem(st.id,"scores",sc.id),
            purge: ()=>purgeSubItem(st.id,"scores",sc.id),
          });
        }
        for(const lg of trashed(st.welledLogs)){
          out.push({
            kind:"welledLog", id:lg.id, parentId:st.id, deletedAt:lg.deletedAt||0,
            label: `${st.name} — WellEd ${lg.domain||lg.subdomain||""}`,
            detail: `${lg.score||"—"} · ${lg.date||""}`,
            restore: ()=>restoreSubItem(st.id,"welledLogs",lg.id),
            purge: ()=>purgeSubItem(st.id,"welledLogs",lg.id),
          });
        }
        for(const d of trashed(st.diagnostics)){
          out.push({
            kind:"diagnostic", id:d.id, parentId:st.id, deletedAt:d.deletedAt||0,
            label: `${st.name} — Diagnostic`,
            detail: d.testName || d.dateTaken || "—",
            restore: ()=>restoreSubItem(st.id,"diagnostics",d.id),
            purge: ()=>purgeSubItem(st.id,"diagnostics",d.id),
          });
        }
      }
    }
    out.sort((a,b)=>(b.deletedAt||0)-(a.deletedAt||0));
    return out.map(r=>({...r, deletedAtLabel: fmt(r.deletedAt)}));
  },[students,restoreStudent,purgeStudent,restoreSubItem,purgeSubItem]);

  const kindLabel = {student:"Student",assignment:"Assignment",score:"Score",welledLog:"WellEd Log",diagnostic:"Diagnostic"};
  const kindAccent = {student:"var(--brand)",assignment:"var(--ink-soft)",score:"var(--ok)",welledLog:"var(--accent)",diagnostic:"var(--brand-light)"};

  return (
    <div style={{maxWidth:1100,margin:"0 auto"}}>
      <div style={{marginBottom:22,display:"flex",alignItems:"flex-end",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
        <div>
          <div style={{fontFamily:"var(--font-body)",fontSize:10,fontWeight:600,letterSpacing:"0.18em",textTransform:"uppercase",color:"var(--ink-mute)",marginBottom:6}}>Recoverable</div>
          <h1 style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 144, 'SOFT' 20",fontWeight:600,fontSize:32,letterSpacing:"-0.02em",margin:0,lineHeight:1.05}}>Trash</h1>
          <div style={{marginTop:8,fontSize:13,color:"var(--ink-soft)",maxWidth:560,lineHeight:1.55}}>
            Deleted students, assignments, scores, logs, and diagnostics live here until you restore or permanently delete them. Nothing in this list has been removed from Firestore.
          </div>
        </div>
        {rows.length>0 && (
          <button onClick={emptyTrash} style={{
            ...mkBtn("transparent","#8C2E2E"),
            border:"1px solid rgba(140,46,46,.35)",
            padding:"9px 18px",fontSize:11,letterSpacing:"0.04em",textTransform:"uppercase",fontWeight:600
          }}>Empty Trash</button>
        )}
      </div>

      {rows.length===0 ? (
        <div style={{...CARD,padding:"72px 40px",textAlign:"center"}}>
          <div style={{fontFamily:"var(--font-display)",fontStyle:"italic",fontSize:22,color:"var(--ink-mute)",letterSpacing:"-0.01em",marginBottom:8}}>Trash is empty.</div>
          <div style={{fontSize:12,color:"var(--ink-mute)"}}>Deleted items appear here and can be restored with one click.</div>
        </div>
      ) : (
        <div style={{...CARD,padding:0,overflow:"hidden"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead>
              <tr style={{background:"var(--paper-alt)",borderBottom:"1px solid var(--rule)"}}>
                <th style={{padding:"12px 16px",textAlign:"left",fontFamily:"var(--font-mono)",fontSize:9,fontWeight:600,color:"var(--ink-mute)",letterSpacing:"0.1em",textTransform:"uppercase"}}>Type</th>
                <th style={{padding:"12px 16px",textAlign:"left",fontFamily:"var(--font-mono)",fontSize:9,fontWeight:600,color:"var(--ink-mute)",letterSpacing:"0.1em",textTransform:"uppercase"}}>Item</th>
                <th style={{padding:"12px 16px",textAlign:"left",fontFamily:"var(--font-mono)",fontSize:9,fontWeight:600,color:"var(--ink-mute)",letterSpacing:"0.1em",textTransform:"uppercase"}}>Deleted</th>
                <th style={{padding:"12px 16px",textAlign:"right",fontFamily:"var(--font-mono)",fontSize:9,fontWeight:600,color:"var(--ink-mute)",letterSpacing:"0.1em",textTransform:"uppercase"}}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r,i)=>(
                <tr key={`${r.kind}-${r.id}-${r.parentId||""}`} style={{borderBottom:i===rows.length-1?"none":"1px solid rgba(15,26,46,.06)"}}>
                  <td style={{padding:"14px 16px",whiteSpace:"nowrap"}}>
                    <span style={{display:"inline-block",padding:"3px 10px",borderRadius:999,border:`1px solid ${kindAccent[r.kind]}`,color:kindAccent[r.kind],fontFamily:"var(--font-mono)",fontSize:9,fontWeight:600,letterSpacing:"0.06em",textTransform:"uppercase"}}>{kindLabel[r.kind]}</span>
                  </td>
                  <td style={{padding:"14px 16px"}}>
                    <div style={{fontFamily:"var(--font-display)",fontVariationSettings:"'opsz' 48",fontSize:14,fontWeight:500,color:"var(--ink)"}}>{r.label}</div>
                    {r.detail&&<div style={{fontSize:11,color:"var(--ink-mute)",marginTop:2}}>{r.detail}</div>}
                  </td>
                  <td style={{padding:"14px 16px",fontFamily:"var(--font-mono)",fontSize:11,color:"var(--ink-soft)",whiteSpace:"nowrap"}}>{r.deletedAtLabel}</td>
                  <td style={{padding:"14px 16px",textAlign:"right",whiteSpace:"nowrap"}}>
                    <div style={{display:"inline-flex",gap:6}}>
                      <button onClick={r.restore} style={{...mkBtn("transparent","#004A79"),border:"1px solid rgba(0,74,121,.35)",padding:"5px 12px",fontSize:11}}>Restore</button>
                      <button onClick={r.purge} title="Delete forever" style={{...mkBtn("transparent","#8C2E2E"),border:"1px solid rgba(140,46,46,.3)",padding:"5px 10px",fontSize:11}}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
