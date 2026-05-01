import { sendMessage } from './telegram.js';
import { saveSession, getLastSession, getActivePause, isoWeek, getCurrentWeekSessions, getTodayChats, getConfig } from './sessions.js';
import { chatWithPM } from './claude.js';

// ─── ENTRY POINT ─────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const now = new Date();
    const dayUTC  = now.getUTCDay();
    const hourUTC = now.getUTCHours();

    const pause = await getActivePause(env);
    if (pause) {
      console.log(`PM agent paused until ${pause.pause_until} — skipping`);
      return;
    }

    if (dayUTC === 1 && hourUTC === 6) {
      ctx.waitUntil(sendKickoff(env));
    } else if (dayUTC === 5 && hourUTC === 14) {
      ctx.waitUntil(sendClose(env));
    } else {
      ctx.waitUntil(runDriftDetector(env));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/kickoff') {
      await sendKickoff(env);
      return new Response('Kickoff sent', { status: 200 });
    }
    if (url.pathname === '/close') {
      await sendClose(env);
      return new Response('Close sent', { status: 200 });
    }
    if (url.pathname === '/drift') {
      await runDriftDetector(env);
      return new Response('Drift check run', { status: 200 });
    }
    if (url.pathname === '/pause') {
      const weeks = parseInt(url.searchParams.get('weeks') || '1');
      await handlePause(env, weeks);
      return new Response(`Paused for ${weeks} week(s)`, { status: 200 });
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(env, update));
      return new Response('OK', { status: 200 });
    }
    if (url.pathname === '/setup-webhook') {
      const webhookUrl = `${url.protocol}//${url.host}/webhook`;
      const result = await setupWebhook(env, webhookUrl);
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Kartalix PM Agent — OK', { status: 200 });
  },
};

// ─── MONDAY KICKOFF ───────────────────────────────────────────
async function sendKickoff(env) {
  const week    = isoWeek();
  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul' });

  const lastCloseResponse = await getLastSession(env, 'close_response');
  const shipped    = lastCloseResponse?.shipped   || [];
  const slips      = lastCloseResponse?.slips     || [];
  const nextAction = lastCloseResponse?.next_action || null;

  const shippedLines = shipped.length
    ? shipped.map(s => `✅ ${s.text || s}`).join('\n')
    : '— no close logged last week';

  const slipLines = slips.length
    ? slips.map(s => `⚠️ ${s.text || s}${s.reason ? ' — ' + s.reason : ''}`).join('\n')
    : '— nothing slipped';

  const nextLine = nextAction ? `\n<b>NEXT ACTION (from last session):</b>\n${nextAction}` : '';

  const message = [
    `🦅 <b>KARTALIX — WEEK KICKOFF</b>`,
    `${week} · ${dateStr}`,
    ``,
    `<b>LAST WEEK</b>`,
    shippedLines,
    ``,
    `<b>SLIPPED</b>`,
    slipLines,
    nextLine,
    ``,
    `<b>THIS WEEK</b>`,
    `What are you committing to? Reply with your deliverables (one per line).`,
  ].filter(l => l !== null && l !== undefined).join('\n');

  await sendMessage(env, message);
  await saveSession(env, {
    type:         'kickoff',
    week_ref:     week,
    message_out:  message,
    triggered_by: 'cron',
  });

  console.log(`PM kickoff sent for ${week}`);
}

// ─── FRIDAY CLOSE ─────────────────────────────────────────────
async function sendClose(env) {
  const week = isoWeek();
  const sessions = await getCurrentWeekSessions(env);
  const commitmentSession = sessions.find(s => s.type === 'commitments');
  const commitments = commitmentSession?.commitments || [];

  const commitmentLines = commitments.length
    ? commitments.map(c => `• ${c.text || c}`).join('\n')
    : '— no commitments logged this week';

  const message = [
    `🦅 <b>KARTALIX — WEEK CLOSE</b>`,
    `${week}`,
    ``,
    `<b>COMMITTED THIS WEEK</b>`,
    commitmentLines,
    ``,
    `<b>Reply with your update. Example:</b>`,
    `<code>Shipped X`,
    `Shipped Y`,
    `Slipped: Z — reason`,
    `Next: first action for next week</code>`,
    ``,
    `<i>Slips and next action carry to Monday's kickoff.</i>`,
  ].join('\n');

  await sendMessage(env, message);
  await saveSession(env, { type: 'close', week_ref: week, message_out: message, triggered_by: 'cron' });
}

// ─── DRIFT DETECTOR ───────────────────────────────────────────
async function runDriftDetector(env) {
  const now    = new Date();
  const dayUTC = now.getUTCDay();
  const week   = isoWeek();
  const today  = now.toISOString().slice(0, 10);

  const sessions = await getCurrentWeekSessions(env);
  const hasKickoff     = sessions.some(s => s.type === 'kickoff');
  const hasCommitments = sessions.some(s => s.type === 'commitments');
  const hasDriftToday  = sessions.some(s => s.type === 'drift' && s.created_at?.slice(0, 10) === today);

  if (hasDriftToday) {
    console.log('Drift: already nudged today');
    return;
  }

  if ((dayUTC === 3 || dayUTC === 4) && hasKickoff && !hasCommitments) {
    const message = `⚠️ <b>DRIFT CHECK — ${week}</b>\n\nNo commitments logged this week. What are you working on? Reply with your deliverables.`;
    await sendMessage(env, message);
    await saveSession(env, { type: 'drift', week_ref: week, message_out: message, triggered_by: 'cron' });
    console.log('Drift: nudged for missing commitments');
    return;
  }

  console.log(`Drift: ok (kickoff=${hasKickoff}, commitments=${hasCommitments})`);
}

// ─── TELEGRAM WEBHOOK HANDLER ─────────────────────────────────
async function handleTelegramUpdate(env, update) {
  const message = update.message;
  if (!message?.text) return;

  const text = message.text.trim();
  const week = isoWeek();

  // Telegram slash commands — trigger anything without opening a browser
  if (text.startsWith('/')) {
    const [cmd, ...args] = text.split(' ');
    if (cmd === '/kickoff') { await sendKickoff(env); return; }
    if (cmd === '/close')   { await sendClose(env);   return; }
    if (cmd === '/drift')   { await runDriftDetector(env); return; }
    if (cmd === '/pause') {
      const weeks = parseInt(args[0] || '1');
      await handlePause(env, weeks);
      return;
    }
    if (cmd === '/commit') {
      const body = args.join(' ').trim();
      if (!body) {
        await sendMessage(env, `Send your commitments after the command:\n<code>/commit Finish facts migration\nWire firewall\nGolden fixtures</code>`);
        return;
      }
      const commitments = body.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ text: l }));
      await saveSession(env, { type: 'commitments', week_ref: week, message_in: body, commitments, triggered_by: 'user' });
      await sendMessage(env, `✅ <b>Commitments logged — ${week}</b>\n\n${commitments.map(c => `• ${c.text}`).join('\n')}\n\nShip it. 🦅`);
      return;
    }
    if (cmd === '/log-close') {
      const body = args.join(' ').trim();
      if (!body) {
        await sendMessage(env, `Send your close update after the command:\n<code>/log-close Shipped X\nSlipped: Y — reason\nNext: Z</code>`);
        return;
      }
      const { shipped, slips, nextAction } = parseCloseResponse(body);
      await saveSession(env, { type: 'close_response', week_ref: week, message_in: body, shipped, slips, next_action: nextAction, triggered_by: 'user' });
      const lines = [
        `✅ <b>Week closed — ${week}</b>`,
        shipped.length ? `\nShipped:\n${shipped.map(s => `• ${s.text}`).join('\n')}` : null,
        slips.length   ? `\nSlipped:\n${slips.map(s => `• ${s.text}`).join('\n')}` : null,
        nextAction     ? `\nNext: ${nextAction}` : null,
        `\nSee you Monday. 🦅`,
      ].filter(Boolean);
      await sendMessage(env, lines.join(''));
      return;
    }
    if (cmd === '/status') {
      const sessions = await getCurrentWeekSessions(env);
      const hasKickoff     = sessions.some(s => s.type === 'kickoff');
      const hasCommitments = sessions.some(s => s.type === 'commitments');
      const hasClose       = sessions.some(s => s.type === 'close_response');
      await sendMessage(env, `📊 <b>Week status — ${week}</b>\n\nKickoff: ${hasKickoff ? '✅' : '❌'}\nCommitments: ${hasCommitments ? '✅' : '❌'}\nClose: ${hasClose ? '✅' : '❌'}`);
      return;
    }
    await sendMessage(env, `Unknown command.\n\n<b>Commands:</b>\n/kickoff — trigger Monday kickoff\n/close — trigger Friday close\n/commit [items] — log this week's commitments\n/log-close [update] — log shipped/slipped/next\n/status — week status\n/drift — run drift check\n/pause [weeks] — pause agent`);
    return;
  }

  // Everything that isn't a slash command goes to Claude.
  // Use /commit or /log-close to save structured data explicitly.

  // Free-form chat — PM responds via Claude with full context
  const [sessions, todayChats, sliceContext, architecture, configNextAction] = await Promise.all([
    getCurrentWeekSessions(env),
    getTodayChats(env),
    getConfig(env, 'slice_context'),
    getConfig(env, 'architecture'),
    getConfig(env, 'next_action'),
  ]);

  const commitmentSession = sessions.find(s => s.type === 'commitments');
  const lastCloseResp     = await getLastSession(env, 'close_response');

  const context = {
    week,
    commitments:  commitmentSession?.commitments || [],
    slips:        lastCloseResp?.slips || [],
    nextAction:   lastCloseResp?.next_action || configNextAction,
    sliceContext,
    architecture,
  };

  // Build conversation history from today's chats
  const history = todayChats.flatMap(s => {
    const turns = [];
    if (s.message_in)  turns.push({ role: 'user',      content: s.message_in });
    if (s.message_out) turns.push({ role: 'assistant',  content: s.message_out });
    return turns;
  });

  const reply = await chatWithPM(env, text, context, history);

  await sendMessage(env, reply);
  await saveSession(env, {
    type:        'session',
    week_ref:    week,
    message_in:  text,
    message_out: reply,
    triggered_by: 'user',
  });
}

function parseCloseResponse(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const shipped = [];
  const slips   = [];
  let nextAction = null;
  let mode = 'shipped';

  for (const line of lines) {
    if (/^(2\.|slipped?:?)\s*/i.test(line)) {
      mode = 'slips';
      const content = line.replace(/^(2\.|slipped?:?)\s*/i, '').trim();
      if (content) slips.push({ text: content });
    } else if (/^(3\.|next:?)\s*/i.test(line)) {
      mode = 'next';
      nextAction = line.replace(/^(3\.|next:?)\s*/i, '').trim() || null;
    } else if (/^1\.\s*/i.test(line)) {
      mode = 'shipped';
      const content = line.replace(/^1\.\s*/, '').trim();
      if (content) shipped.push({ text: content });
    } else {
      if (mode === 'shipped') shipped.push({ text: line });
      else if (mode === 'slips') slips.push({ text: line });
      else if (mode === 'next' && nextAction) nextAction += ' ' + line;
      else if (mode === 'next') nextAction = line;
    }
  }

  return { shipped, slips, nextAction };
}

// ─── WEBHOOK SETUP ────────────────────────────────────────────
async function setupWebhook(env, webhookUrl) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });
  return res.json();
}

// ─── PAUSE COMMAND ────────────────────────────────────────────
async function handlePause(env, weeks) {
  const pauseUntil = new Date();
  pauseUntil.setDate(pauseUntil.getDate() + weeks * 7);
  const untilStr = pauseUntil.toISOString().slice(0, 10);

  const message = `⏸ <b>PM Agent paused for ${weeks} week(s).</b>\nReturning: ${untilStr}\n\nHit /resume to come back early.`;
  await sendMessage(env, message);
  await saveSession(env, {
    type:        'pause',
    week_ref:    isoWeek(),
    message_out: message,
    pause_until: untilStr,
    triggered_by: 'user',
  });
}
