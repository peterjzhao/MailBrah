/**
 * Heads-up bars: a multi-day all-day event ahead of each exam or big
 * assignment, so it shows up in Calendar's week view long before the week
 * it's due (week view only ever shows the current week).
 *
 * This is one reconcile pass rather than a hook in every place items get
 * created: each sync reads what is actually upcoming — open Google Tasks
 * plus events on CONFIG.CALENDAR_ID, whatever added them (email,
 * Brightspace, Gradescope, a reply, or you by hand) — works out which bars
 * should exist, then creates, moves or deletes bars to match.
 *
 * Each bar carries a private tag naming its item, so bars are found again
 * even after resetAllState(). A bar MailBrah made that later goes missing
 * was deleted by hand: it's remembered in PROPS.LEADUP_MADE and never put
 * back.
 */

var LEADUP_TAG = 'mailbrahLeadUp';
var LEADUP_DUE_SUFFIX = /\s+—\s+due\s+\d{1,2}:\d{2}\s*[AP]M\s*$/i; // "… — due 11:59 PM" (Deadlines.js)

/** Days ahead to look for items; longer than LEADUP_DAYS so a bar exists before it starts. */
function leadUpHorizonDays_() {
  return Math.max(45, CONFIG.LEADUP_DAYS + 14);
}

/** Called from the scan: at most hourly, or right away when this run added or changed something. */
function maybeSyncLeadUpBars_(stats) {
  if (!CONFIG.LEADUP_ENABLED) return;
  var last = Number(PropertiesService.getScriptProperties().getProperty(PROPS.LEADUP_LAST) || 0);
  var changed = stats && (stats.added.length || stats.updated.length || (stats.completed || []).length);
  if (!changed && Date.now() - last < 3600 * 1000) return;
  syncLeadUpBars_();
}

/**
 * Make the calendar's bars match what's upcoming.
 * Reads everything before writing anything: if Tasks or Calendar can't be
 * read it throws without touching a single bar, so a flaky API can never
 * wipe them.
 * @param {Object=} opts {dryRun: true} logs the plan and changes nothing
 * @return {Object} {created, updated, removed, kept}
 */
function syncLeadUpBars_(opts) {
  var dryRun = !!(opts && opts.dryRun);
  var props = PropertiesService.getScriptProperties();
  var cal = getCalendar_();
  var today = stripTime_(new Date());
  var horizonEnd = new Date(today.getFullYear(), today.getMonth(),
    today.getDate() + leadUpHorizonDays_() + 1); // exclusive

  // 1. Read: calendar window (sources AND existing bars), then tasks.
  var calEvents = cal.getEvents(today, horizonEnd);
  var wanted = leadUpFromEvents_(calEvents, today).concat(leadUpFromTasks_(today, horizonEnd));
  var bars = {};
  var extras = [];
  calEvents.forEach(function (ev) {
    var src = leadUpSourceOf_(ev);
    if (!src) return;
    if (bars[src]) extras.push(ev); else bars[src] = ev;
  });
  var made = leadUpLoadMade_(props, today);

  // 2. Reconcile.
  var result = { created: 0, updated: 0, removed: 0, kept: 0 };
  var verb = dryRun ? 'would ' : '';
  var wantedSrc = {};
  wanted.forEach(function (w) {
    if (wantedSrc[w.src]) return;
    wantedSrc[w.src] = true;
    var key = leadUpHash_(w.src);
    var bar = bars[w.src];
    if (bar) {
      made[key] = w.dueYmd;
      if (bar.getTitle() === w.title &&
          leadUpYmd_(bar.getAllDayStartDate()) === leadUpYmd_(w.first) &&
          leadUpYmd_(bar.getAllDayEndDate()) === leadUpYmd_(w.endExcl)) {
        result.kept++;
        return;
      }
      result.updated++;
      Logger.log('Heads-up bar: %supdate "%s"', verb, w.title);
      if (!dryRun) {
        bar.setTitle(w.title);
        bar.setAllDayDates(w.first, w.endExcl);
      }
      return;
    }
    if (made[key]) return; // you deleted this bar — it stays gone
    result.created++;
    Logger.log('Heads-up bar: %sadd "%s" (%s – %s)', verb, w.title,
      Utilities.formatDate(w.first, CONFIG.TIMEZONE, 'MMM d'), w.dueLabel);
    if (!dryRun) {
      leadUpCreateBar_(cal, w);
      made[key] = w.dueYmd;
    }
  });
  Object.keys(bars).forEach(function (src) {
    if (wantedSrc[src]) return;
    // Its item was ticked off, deleted, or moved out of range.
    result.removed++;
    Logger.log('Heads-up bar: %sremove "%s"', verb, bars[src].getTitle());
    if (!dryRun) {
      bars[src].deleteEvent();
      delete made[leadUpHash_(src)];
    }
  });
  if (!dryRun) {
    extras.forEach(function (ev) { ev.deleteEvent(); });
    props.setProperty(PROPS.LEADUP_MADE, JSON.stringify(made));
    props.setProperty(PROPS.LEADUP_LAST, String(Date.now()));
  }
  Logger.log('Heads-up bars: %s added, %s updated, %s removed, %s unchanged%s.',
    result.created, result.updated, result.removed, result.kept,
    dryRun ? ' (dry run — nothing changed)' : '');
  return result;
}

/** Timed or all-day events that deserve a bar. Recurring events never do. */
function leadUpFromEvents_(events, today) {
  var out = [];
  events.forEach(function (ev) {
    if (leadUpSourceOf_(ev) || ev.isRecurringEvent()) return;
    var title = String(ev.getTitle() || '');
    if (title.indexOf('✓ ') === 0) return; // submitted (Gradescope's all-day fallback)
    var day = stripTime_(ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime());
    if (day < today) return; // already under way
    var isDeadline = LEADUP_DUE_SUFFIX.test(title); // all-day fallback for a task
    var name = title.replace(LEADUP_DUE_SUFFIX, '').trim();
    if (leadUpWanted_(name, isDeadline)) out.push(leadUpPlan_('c:' + ev.getId(), name, day, isDeadline));
  });
  return out;
}

/** Open Google Tasks due inside the window that deserve a bar. */
function leadUpFromTasks_(today, horizonEnd) {
  var out = [];
  var pageToken = null;
  do {
    var query = {
      showCompleted: false,
      dueMin: Utilities.formatDate(today, CONFIG.TIMEZONE, 'yyyy-MM-dd') + 'T00:00:00.000Z',
      dueMax: Utilities.formatDate(horizonEnd, CONFIG.TIMEZONE, 'yyyy-MM-dd') + 'T00:00:00.000Z',
      maxResults: 100
    };
    if (pageToken) query.pageToken = pageToken;
    var page = Tasks.Tasks.list('@default', query);
    (page.items || []).forEach(function (t) {
      // `due` is the local due DATE at 00:00Z (Deadlines.js) — read the date
      // part; converting it to a Date would land on the previous day here.
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t.due || '');
      if (!m || t.status === 'completed' || t.deleted) return;
      var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (day < today || day >= horizonEnd) return;
      var name = String(t.title || '').replace(LEADUP_DUE_SUFFIX, '').trim();
      if (leadUpWanted_(name, true)) out.push(leadUpPlan_('t:' + t.id, name, day, true));
    });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

function leadUpWanted_(name, isDeadline) {
  var matches = function (patterns) {
    return (patterns || []).some(function (p) { return new RegExp(p, 'i').test(name); });
  };
  if (!name || matches(CONFIG.LEADUP_SKIP_PATTERNS)) return false;
  return (isDeadline && CONFIG.LEADUP_ALL_DEADLINES) || matches(CONFIG.LEADUP_PATTERNS);
}

/** The bar an item should have: LEADUP_DAYS before through the day itself. */
function leadUpPlan_(src, name, day, isDeadline) {
  var dueLabel = (isDeadline ? 'due ' : '') + Utilities.formatDate(day, CONFIG.TIMEZONE, 'EEE MMM d');
  return {
    src: src,
    name: name,
    title: name + ' · ' + dueLabel,
    dueLabel: dueLabel,
    dueYmd: leadUpYmd_(day),
    // Calendar-date arithmetic (not ±24h) so DST can't shift a day.
    first: new Date(day.getFullYear(), day.getMonth(), day.getDate() - CONFIG.LEADUP_DAYS),
    endExcl: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  };
}

function leadUpCreateBar_(cal, w) {
  var bar = cal.createAllDayEvent(w.title, w.first, w.endExcl, {
    description: 'Heads-up from MailBrah: "' + w.name + '" — ' + w.dueLabel + '.\n' +
      'This bar follows it: it moves if the date changes and disappears once the item is ' +
      'ticked off or deleted. Delete the bar itself and MailBrah won\'t put it back.'
  });
  bar.setTag(LEADUP_TAG, w.src);
  bar.setColor(CalendarApp.EventColor.MAUVE); // purple ("Grape" in the Calendar UI)
  bar.removeAllReminders();                   // a visual heads-up, not another notification
  return bar;
}

/** The item a bar belongs to ('t:<taskId>' / 'c:<eventId>'), or '' if ev isn't a bar. */
function leadUpSourceOf_(ev) {
  return ev.isAllDayEvent() ? (ev.getTag(LEADUP_TAG) || '') : '';
}

/** Bars made so far ({hash: due yyyy-MM-dd}), minus ones whose day has passed. */
function leadUpLoadMade_(props, today) {
  var made = {};
  try { made = JSON.parse(props.getProperty(PROPS.LEADUP_MADE) || '{}'); } catch (err) { made = {}; }
  var todayYmd = leadUpYmd_(today);
  Object.keys(made).forEach(function (k) { if (made[k] < todayYmd) delete made[k]; });
  return made;
}

function leadUpHash_(src) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(src))
    .map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); })
    .join('').slice(0, 16);
}

function leadUpYmd_(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}
