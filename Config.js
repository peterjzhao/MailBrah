/**
 * MailBrah configuration. Everything user-tunable lives here.
 *
 * The Gemini API key is NOT stored here — set it once via Script Properties:
 *   Project Settings (gear icon) > Script Properties > add GEMINI_API_KEY
 * or run setApiKey() in Setup.js.
 */
var CONFIG = {
  // Label applied to Gradescope receipt threads once read (also referenced
  // in GS_RECEIPT_QUERY).
  PROCESSED_LABEL: 'mailbrah-processed',

  // 'primary' uses your default calendar; otherwise a calendar ID like
  // 'xxxx@group.calendar.google.com'.
  CALENDAR_ID: 'primary',

  // Used for parsing LLM-returned local times and formatting card text.
  // Keep in sync with "timeZone" in appsscript.json.
  TIMEZONE: 'America/Los_Angeles',

  // Gemini models, tried top to bottom on every call: the newest Flash first,
  // older ones only when it is overloaded (HTTP 503) or rate-limited (429) —
  // and it moves on immediately instead of sleeping, so a busy model never
  // stalls a run. Free tier, no billing needed (as of Sep 2026):
  // gemini-3.8-flash (GA Sep 2, 2026), gemini-3.7-flash, gemini-3.5-flash-lite.
  // Check your limits at https://aistudio.google.com/rate-limit
  // The key lives in Script Properties as GEMINI_API_KEY (see Setup.js).
  LLM_CHAIN: [
    { provider: 'gemini', model: 'gemini-3.8-flash' },
    { provider: 'gemini', model: 'gemini-3.7-flash' },
    { provider: 'gemini', model: 'gemini-3.5-flash-lite' }
  ],

  // How hard Gemini 3.x thinks before answering: 'low' | 'medium' | 'high'.
  // 'low' is the lowest-latency setting and is plenty for reading a reply
  // command; 'medium' is Google's default and waits longer for an answer.
  // Thinking can't be switched off entirely on Gemini 3 Flash models.
  // ('' omits the setting and lets the model use its default.)
  GEMINI_THINKING_LEVEL: 'low',

  // Brightspace and Gradescope items further out than this are skipped as
  // likely stale or wrong-year entries.
  MAX_EVENT_HORIZON_DAYS: 370,

  // Your waking window. When a reply command gives no clock time ("get
  // altoids tomorrow"), the event is slotted into the EARLIEST free gap on
  // your calendar inside this window — never before you're up.
  DAY_START_HOUR: 9,
  DAY_END_HOUR: 22,

  // Master switch for notification emails. When true you get:
  //  - ONE morning digest (below) every day, listing everything awaiting a
  //    decision (or confirming nothing is), and
  //  - an immediate email only when a newly found item happens TODAY.
  // REPLYING to either in plain words ("add the career fair, decline the
  // rest") is a command — Gemini interprets it and acts on the next scan.
  SEND_DECISION_NOTIFICATIONS: true,

  // When the daily digest goes out (script timezone). nearMinute means
  // Google fires it within ±15 min of DIGEST_HOUR:DIGEST_MINUTE.
  DIGEST_HOUR: 8,
  DIGEST_MINUTE: 30,

  // Max reply-command messages interpreted per scan (1 Gemini call each).
  MAX_REPLY_COMMANDS_PER_RUN: 5,

  // An undecided item is dropped after this long in the queue (and always
  // once its event has passed) — keeps the card and emails concise. If a
  // later sync finds the same item again, it gets asked anew.
  PENDING_MAX_AGE_HOURS: 48,

  // Trigger frequency in minutes (used by setup()). Valid: 1, 5, 10, 15, 30.
  // 5 is the sweet spot: near-realtime replies/receipts at ~20% of the free
  // tier's 90-min/day trigger-runtime quota. Every-1-minute would spend most
  // of that quota on idle runs and risk dead runs late in the day.
  TRIGGER_EVERY_MINUTES: 5,

  // Gradescope deadline sync (active once setGradescopeCredentials() is run).
  // Kept at hours, not minutes, on purpose: this is screen-scraping a login-
  // protected site — hammering it risks rate limiting or bot protection
  // flagging your account. Assignments post a few times a week anyway.
  GS_SCAN_EVERY_HOURS: 3,
  GS_MAX_COURSES: 8,

  // Gradescope emails a receipt after each submission (from
  // no-reply@gradescope.com). MailBrah uses one as a trigger to re-check
  // that course immediately and tick off the matching task; the email text
  // itself is never sent to Gemini. Receipts must land in THIS inbox.
  GS_RECEIPT_QUERY: 'from:gradescope.com newer_than:3d -label:mailbrah-processed',

  // Brightspace (D2L) deadline sync. Get your personal calendar-feed URL:
  // Brightspace > Calendar > Settings (gear) > Enable Calendar Feed >
  // Subscribe > All Calendars and Tasks > copy URL — then store it as the
  // Script Property BRIGHTSPACE_ICS_URL (or run setBrightspaceFeedUrl()).
  // It contains a private token, so it does NOT belong in this file — this
  // field is only a legacy fallback. A single cheap fetch — hourly is fine.
  BRIGHTSPACE_ICS_URL: '',
  BS_SCAN_EVERY_HOURS: 1,

  // Heads-up bars. Calendar's week view only shows the current week, so a
  // midterm or project two weeks out stays invisible until the week it's
  // due. Exams and big assignments therefore also get a multi-day all-day
  // bar (purple, no notifications) that starts LEADUP_DAYS early and ends on
  // the due/exam day. Homework and quizzes stay single-day tasks.
  // A bar follows its item: a new due date moves it; ticking off or deleting
  // the item removes it. Delete a bar by hand and it stays gone.
  // Looks at your Google Tasks and at events on CALENDAR_ID (including ones
  // you added yourself), but not at recurring events.
  LEADUP_ENABLED: true,
  LEADUP_DAYS: 14,
  // A title matching any of these (case-insensitive regex) gets a bar…
  LEADUP_PATTERNS: [
    '\\b(midterm|exam|final|test)s?\\b',
    '\\b(project|paper|essay|portfolio|presentation|proposal|report|thesis|capstone)s?\\b',
    '\\bWP ?\\d'                                       // writing projects: WP1, WP2…
  ],
  // …unless it also matches one of these.
  LEADUP_SKIP_PATTERNS: [
    '\\breview session\\b', '\\boffice hours?\\b', '\\bstudy (group|session)\\b',
    '\\bmeeting\\b', '\\binfo session\\b'
  ],
  // true = a bar for EVERY task/deadline, homework included.
  LEADUP_ALL_DEADLINES: false
};

/**
 * Script Properties keys (internal). Two more families of keys exist as one
 * property per entry: 'MB_P_<id>' (pending decisions, PendingStore.js) and
 * 'MB_D_<fingerprint>' (added/declined decisions, CalendarSync.js).
 */
var PROPS = {
  API_KEY: 'GEMINI_API_KEY',
  SEEN_MESSAGES: 'MB_SEEN_MSGS',   // JSON array of handled Gmail message IDs (replies, receipts)
  LAST_RUN: 'MB_LAST_RUN',         // epoch ms of last successful scan
  GS_EMAIL: 'GS_EMAIL',            // Gradescope login (set via setGradescopeCredentials)
  GS_PASSWORD: 'GS_PASSWORD',
  GS_COOKIES: 'MB_GS_COOKIES',     // cached Gradescope session cookies
  GS_LAST: 'MB_GS_LAST',           // epoch ms of last Gradescope scan
  BS_LAST: 'MB_BS_LAST',           // epoch ms of last Brightspace feed scan
  PRUNE_LAST: 'MB_PRUNE_LAST',     // epoch ms of last decided-store pruning
  LEADUP_LAST: 'MB_LEADUP_LAST',   // epoch ms of last heads-up bar sync
  LEADUP_MADE: 'MB_LEADUP_MADE'    // JSON map of bars MailBrah made (a hand-deleted one stays gone)
};
