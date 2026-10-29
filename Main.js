/**
 * Main pipeline, run by the time-driven trigger (see Setup.js).
 *
 * Each run acts on reply commands, then syncs Gradescope and Brightspace
 * deadlines and the heads-up bars. Optional or conflicting items wait in the
 * pending queue (Gmail add-on card, morning digest).
 */
function processInbox() {
  // Never let a manual run overlap the trigger (Properties aren't transactional).
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(120 * 1000)) {
    Logger.log('Another run didn\'t finish within 2 minutes. Try again shortly.');
    return null;
  }
  try {
    return processInboxLocked_();
  } finally {
    lock.releaseLock();
  }
}

function processInboxLocked_() {
  // Stay well under the 6-min execution cap even if Gemini retries slowly;
  // whatever doesn't fit is picked up on the next run.
  var deadline = Date.now() + 3.5 * 60 * 1000;
  var props = PropertiesService.getScriptProperties();
  var stats = { added: [], updated: [], completed: [], pendingNew: [], errors: 0 };

  // Act on reply commands first, so decisions land before new pending items
  // pile on top of them. A failure here never blocks the syncs.
  try {
    processReplies_(stats);
  } catch (err) {
    Logger.log('Reply processing failed (syncs continue): %s', err);
  }

  // Gradescope + Brightspace deadline syncs (every few hours; cheap, no LLM
  // calls). A Gradescope submission receipt in the inbox re-checks that
  // course right away so its task gets ticked off. A failure in one never
  // affects the others.
  if (gradescopeConfigured_() && Date.now() < deadline) {
    try {
      processGradescopeReceipts_(stats);
      processGradescope_(stats);
    } catch (err) {
      Logger.log('Gradescope sync failed: %s', err);
    }
  }
  if (brightspaceConfigured_() && Date.now() < deadline) {
    try {
      processBrightspace_(stats);
    } catch (err) {
      Logger.log('Brightspace sync failed: %s', err);
    }
  }
  // Heads-up bars ahead of exams and big assignments (no LLM calls).
  if (Date.now() < deadline) {
    try {
      maybeSyncLeadUpBars_(stats);
    } catch (err) {
      Logger.log('Heads-up bar sync failed: %s', err);
    }
  }

  // Pruning reads the whole property store — a few times a day is plenty.
  var lastPrune = Number(props.getProperty(PROPS.PRUNE_LAST) || 0);
  if (Date.now() - lastPrune > 6 * 3600 * 1000) {
    pruneDecided_();
    props.setProperty(PROPS.PRUNE_LAST, String(Date.now()));
  }
  props.setProperty(PROPS.LAST_RUN, String(Date.now()));

  // Everything else waits for the morning digest; only newly discovered
  // items happening TODAY warrant an immediate email.
  var urgent = stats.pendingNew.filter(function (p) { return p.startsToday; });
  if (urgent.length && CONFIG.SEND_DECISION_NOTIFICATIONS) {
    try {
      sendUrgentNotification_(urgent.map(function (p) { return p.title; }));
    } catch (err) {
      Logger.log('Urgent notification failed (run state already saved): %s', err);
    }
  }
  Logger.log('MailBrah run: %s added, %s time-updated, %s ticked off, %s pending, %s errors',
    stats.added.length, stats.updated.length, stats.completed.length,
    stats.pendingNew.length, stats.errors);
  return stats;
}

/**
 * Immediate email — only for newly discovered items happening TODAY.
 * Every email MailBrah sends starts with a line that is exactly "MailBrah":
 * that's how processReplies_ tells our own messages from the user's replies
 * (same address either way — see isMailBrahMessage_ in Replies.js).
 */
function sendUrgentNotification_(titles) {
  var me = notificationRecipient_();
  if (!me) return;
  var body = [
    'MailBrah',
    '',
    'Just found ' + (titles.length === 1 ? 'something' : titles.length + ' things') +
      ' happening TODAY:',
    '',
    titles.map(function (t) { return '  • ' + t; }).join('\n'),
    '',
    replyHint_(),
    'Everything else waits for the morning digest. Total awaiting decision: ' +
      listPending_().length
  ].join('\n');
  GmailApp.sendEmail(me, '[MailBrah] Happening today — ' + titles.length + ' decision(s)', body);
}

/**
 * Daily digest, fired by its own ~8:30 AM trigger (installed by setup()).
 * Sends every morning, listing pending decisions or confirming nothing is waiting.
 */
function sendDailyDigest() {
  if (!CONFIG.SEND_DECISION_NOTIFICATIONS) return;
  var pending = listPending_();
  var me = notificationRecipient_();
  if (!me) return;
  if (!pending.length) {
    var lastRun = PropertiesService.getScriptProperties().getProperty(PROPS.LAST_RUN);
    var lastScan = lastRun
      ? 'Last inbox scan: ' + Utilities.formatDate(new Date(Number(lastRun)), CONFIG.TIMEZONE, 'EEE, MMM d · h:mm a')
      : 'Last inbox scan: never — run processInbox()';
    var emptyBody = [
      'MailBrah', // first line must stay exactly this — see sendUrgentNotification_
      '',
      'Good morning — nothing is waiting for a decision.',
      '',
      lastScan,
      '',
      replyHint_()
    ].join('\n');
    GmailApp.sendEmail(me, '[MailBrah] Morning digest — nothing waiting', emptyBody);
    return;
  }
  var lines = pending.map(function (p) {
    var when = p.kind === 'deadline'
      ? 'Due ' + Utilities.formatDate(new Date(p.startIso), CONFIG.TIMEZONE, 'EEE, MMM d · h:mm a')
      : formatEventWhen_(new Date(p.startIso), new Date(p.endIso), p.allDay);
    return '  • ' + when + ' — ' + p.title +
      (p.conflicts && p.conflicts.length ? '  [conflicts with ' + p.conflicts[0] + ']' : '');
  });
  var body = [
    'MailBrah', // first line must stay exactly this — see sendUrgentNotification_
    '',
    'Good morning — ' + pending.length + ' decision(s) waiting:',
    '',
    lines.join('\n'),
    '',
    replyHint_()
  ].join('\n');
  GmailApp.sendEmail(me, '[MailBrah] Morning digest — ' + pending.length + ' decision(s) waiting', body);
}

function notificationRecipient_() {
  var me = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
  if (!me) Logger.log('No user email available; skipping notification.');
  return me;
}

function replyHint_() {
  return 'Just REPLY to this email in plain words and it happens within minutes —\n' +
    'e.g. "add the career fair, decline the rest" or "also add lunch with Sam\n' +
    'Friday noon". Or tap the MailBrah icon at the bottom of this message for\n' +
    'the buttons.';
}

// ---- Seen-message-ID cache: replies and Gradescope receipts (trigger-only, under lock) ----

function getSeenMessageIds_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROPS.SEEN_MESSAGES);
  return raw ? JSON.parse(raw) : [];
}

function saveSeenMessageIds_(ids) {
  // Newest last; keep the most recent 300, comfortably > 3 days of replies and receipts.
  PropertiesService.getScriptProperties()
    .setProperty(PROPS.SEEN_MESSAGES, JSON.stringify(ids.slice(-300)));
}
