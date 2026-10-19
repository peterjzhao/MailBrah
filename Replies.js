/**
 * Reply commands: answer a "[MailBrah] ... need your decision" email in plain
 * words and MailBrah acts on it during the next scan.
 *
 *   "add the career fair, decline the rest"
 *   "decline everything"
 *   "add the first two. also add dinner with Alex Friday 7pm"
 *
 * Decisions apply to pending items (same shared logic as the card's buttons);
 * anything else the reply asks to add is created directly. MailBrah answers
 * in-thread with a confirmation of what it did.
 *
 * Loop safety: every MailBrah-authored message has a first line of exactly
 * "MailBrah" (isMailBrahMessage_) and is skipped; every processed message id
 * goes into the seen cache. A command that fails still gets an answer —
 * silence is never an outcome.
 */

function processReplies_(stats) {
  var threads = GmailApp.search('subject:mailbrah newer_than:3d', 0, 10);
  var seenIds = getSeenMessageIds_();
  var handled = 0;

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (seenIds.indexOf(msg.getId()) !== -1) continue;

      var text = extractReplyText_(msg.getPlainBody());
      if (!text || isMailBrahMessage_(text)) {
        // Our own notification/confirmation — just remember it.
        seenIds.push(msg.getId());
        saveSeenMessageIds_(seenIds);
        continue;
      }
      if (handled >= CONFIG.MAX_REPLY_COMMANDS_PER_RUN) continue; // NOT marked seen: retried next run

      // The nearest earlier MailBrah message in this thread is what the user
      // is replying to — context for "these two" / "both" references.
      var repliedTo = '';
      for (var back = m - 1; back >= 0; back--) {
        var priorBody = String(messages[back].getPlainBody() || '').trim();
        if (isMailBrahMessage_(priorBody)) {
          repliedTo = priorBody.slice(0, 1500);
          break;
        }
      }

      handled++;
      try {
        handleReplyCommand_(msg, text, repliedTo, stats);
      } catch (err) {
        stats.errors++;
        Logger.log('Reply command failed ("%s…"): %s', text.slice(0, 60), err);
        // Never go quiet: say it failed instead of dropping the command.
        sendReplySafely_(msg, 'MailBrah\n\n- Sorry — I couldn\'t process that (' +
          String(err).slice(0, 120) + '). Send it again in a few minutes, or use ' +
          'the buttons on the MailBrah card.');
      } finally {
        // One attempt per command: marked seen even on failure so a broken
        // reply can't loop forever.
        seenIds.push(msg.getId());
        saveSeenMessageIds_(seenIds);
      }
    }
  }
  if (handled) Logger.log('Processed %s reply command(s).', handled);
}

/**
 * True for messages MailBrah itself sent: their first line is exactly
 * "MailBrah" (see the digest, urgent notification, and confirmations). The
 * user's replies come from the same address, so the body is the only tell.
 */
function isMailBrahMessage_(body) {
  var text = String(body || '').trim();
  if (/^MailBrah[ \t]*(\r?\n|$)/.test(text)) return true;
  // First lines used by older versions; only matters for messages still
  // inside the 3-day search window. Safe to delete a few days after deploying.
  return /^(MailBrah just found |Good morning — (\d+ decision|nothing is waiting))/.test(text);
}

/** Reply in-thread; a send failure is logged, never thrown (run state is already saved). */
function sendReplySafely_(msg, body) {
  try {
    msg.reply(body);
  } catch (err) {
    Logger.log('Could not send reply: %s', err);
  }
}

function handleReplyCommand_(msg, text, repliedTo, stats) {
  Logger.log('Reply command: "%s"', text.slice(0, 200));
  var pending = listPending_();
  var result = interpretReplyWithGemini_(text, pending, repliedTo);
  var lines = [];

  if (!result) {
    lines.push('Sorry — I couldn\'t interpret that. Try e.g. "add the career fair, decline the rest".');
  } else {
    (result.decisions || []).forEach(function (d) {
      var r = decidePending_(d.id, !!d.accept);
      lines.push(r.message);
      if (r.ok && d.accept) stats.added.push('(reply) accepted');
    });
    (result.newEvents || []).forEach(function (evt) {
      lines.push(executeCommandedEvent_(evt, msg, stats));
    });
    if (!lines.length && !result.wantsPendingList) {
      lines.push(result.note || 'Nothing actionable found in your reply.');
    } else if (result.note && /couldn|unclear|ambigu|not match|unsure/i.test(result.note)) {
      lines.push(result.note);
    }
    if (result.wantsPendingList) {
      var pendingNow = listPending_();
      lines.push(pendingNow.length ? 'Currently pending:' : 'Nothing else is pending.');
      pendingNow.forEach(function (p) {
        lines.push('    ' + (p.kind === 'deadline' ? 'Due ' : '') +
          Utilities.formatDate(new Date(p.startIso), CONFIG.TIMEZONE, 'EEE MMM d h:mm a') +
          ' — ' + p.title);
      });
    }
  }

  // First line exactly "MailBrah": that's how the next scan knows this is
  // ours and not a new command (isMailBrahMessage_).
  sendReplySafely_(msg, 'MailBrah\n\n' +
    lines.map(function (l) { return '- ' + l; }).join('\n') +
    '\n\nStill pending: ' + listPending_().length);
}

/** The user explicitly asked for this — create it (dup check still applies). */
function executeCommandedEvent_(evt, msg, stats) {
  var title = evt.title || 'Untitled';
  var start = parseLocalIso_(evt.startLocal);
  if (!start) return 'Couldn\'t work out a date for "' + title + '" — try including an explicit date/time.';
  var end = parseLocalIso_(evt.endLocal);
  var isDeadline = evt.kind === 'deadline';

  if (evt.allDay) {
    start = stripTime_(start);
    end = (end && stripTime_(end) > start)
      ? stripTime_(end)
      : new Date(start.getTime() + 24 * 60 * 60 * 1000);
  } else if (!evt.timeGiven) {
    // No clock time stated: deadlines default to end of day; events get the
    // earliest free slot in the waking window ("just make it smart").
    if (isDeadline) {
      start = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 0);
      end = new Date(start.getTime() + 60 * 60 * 1000);
    } else {
      var duration = (end && end > start) ? Math.min(end - start, 4 * 3600 * 1000) : 3600 * 1000;
      start = findEarliestFreeSlot_(start, duration);
      end = new Date(start.getTime() + duration);
    }
  } else if (!end || end <= start) {
    end = new Date(start.getTime() + 60 * 60 * 1000);
  }

  var whenStr = evt.allDay
    ? Utilities.formatDate(start, CONFIG.TIMEZONE, 'EEE, MMM d')
    : Utilities.formatDate(start, CONFIG.TIMEZONE, 'EEE, MMM d · h:mm a');

  // Same title, same day, different time = a correction ("no, 2pm") — move
  // the existing item instead of creating a second one.
  if (tryReschedule_(title, start, end)) {
    stats.updated.push(title);
    return 'Moved: ' + title + ' — now ' + whenStr;
  }
  if (isDuplicate_(title, start, end)) return 'Already handled: ' + title + ' (' + whenStr + ')';

  if (isDeadline) {
    createDeadlineTask_({
      title: title, start: start,
      description: evt.description || '', sourceSubject: 'Reply command'
    });
    stats.added.push(title);
    return 'Task added: ' + title + ' — due ' + whenStr;
  }

  var conflicts = evt.allDay ? [] : findConflicts_(start, end);
  createCalendarEvent_({
    title: title, start: start, end: end, allDay: !!evt.allDay,
    location: evt.location || '', description: evt.description || '',
    sourceSubject: 'Reply command', sourceMsgId: msg.getId()
  });
  stats.added.push(title);
  return 'Added: ' + title + ' — ' + whenStr +
    (conflicts.length ? ' (heads up: overlaps ' + conflicts[0].label + ')' : '');
}

/** The user's words only: cut quoted original text and ">"-prefixed lines. */
function extractReplyText_(body) {
  var text = String(body || '');
  var cut = text.search(/\r?\n\s*On .{1,160}wrote:\s*/);
  if (cut !== -1) text = text.slice(0, cut);
  text = text.split(/\r?\n/)
    .filter(function (line) { return line.indexOf('>') !== 0; })
    .join('\n');
  return text.trim().slice(0, 2000);
}
