import { sendMessage } from './telegram.js';
import { saveSession, getLastClose, getActivePause, isoWeek } from './sessions.js';

// ─── ENTRY POINT ─────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const now = new Date();
    const dayUTC  = now.getUTCDay();   // 0=Sun 1=Mon ... 5=Fri
    const hourUTC = now.getUTCHours();

    // Check for active pause first
    const pause = await getActivePause(env);
    if (pause) {
      console.log(`PM agent paused until ${pause.pause_until} — skipping`);
      return;
    }

    if (dayUTC === 1 && hourUTC === 6) {
      ctx.waitUntil(sendKickoff(env));
    } else if (dayUTC === 5 && hourUTC === 14) {
      ctx.waitUntil(sendClose(env));         // stub — Slice 0 wires this next
    } else {
      ctx.waitUntil(runDriftDetector(env));  // stub — Slice 0 wires this next
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

    return new Response('Kartalix PM Agent — OK', { status: 200 });
  },
};

// ─── MONDAY KICKOFF ───────────────────────────────────────────
async function sendKickoff(env) {
  const week    = isoWeek();
  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul' });

  // Pull last Friday close for context
  const lastClose = await getLastClose(env);
  const shipped   = lastClose?.shipped  || [];
  const slips     = lastClose?.slips    || [];
  const nextAction = lastClose?.next_action || null;

  const shippedLines = shipped.length
    ? shipped.map(s => `✅ ${s.text || s}`).join('\n')
    : '— no close logged last week';

  const slipLines = slips.length
    ? slips.map(s => `⚠️ ${s.text || s}${s.reason ? ' — ' + s.reason : ''}`).join('\n')
    : '— nothing slipped';

  const nextLine = nextAction
    ? `\n<b>NEXT ACTION (from last session):</b>\n${nextAction}`
    : '';

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
    `<b>IN FLIGHT</b>`,
    `Slice 0 — PM Agent (this is it)`,
    ``,
    `<b>THIS WEEK</b>`,
    `What are you committing to? Reply to this message with your deliverables (one per line). I'll track them until Friday.`,
    ``,
    `<b>BLOCKERS</b>`,
    `• Create @kartalix-pm Telegram channel (in progress)`,
    `• Turkish IP lawyer ✅ resolved`,
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

// ─── FRIDAY CLOSE (stub) ─────────────────────────────────────
async function sendClose(env) {
  const week = isoWeek();
  const message = `🦅 <b>KARTALIX — WEEK CLOSE</b>\n${week}\n\nWhat shipped this week? Reply with:\n1. Shipped items (one per line)\n2. Anything that slipped and why\n\n<i>Close cadence wiring coming next in Slice 0.</i>`;

  await sendMessage(env, message);
  await saveSession(env, { type: 'close', week_ref: week, message_out: message, triggered_by: 'cron' });
}

// ─── DAILY DRIFT DETECTOR (stub) ─────────────────────────────
async function runDriftDetector(env) {
  // Silent unless a drift condition is met.
  // Full drift logic wired in next Slice 0 step.
  console.log('Drift detector: no conditions triggered (stub)');
}

// ─── PAUSE COMMAND ────────────────────────────────────────────
async function handlePause(env, weeks) {
  const pauseUntil = new Date();
  pauseUntil.setDate(pauseUntil.getDate() + weeks * 7);
  const untilStr = pauseUntil.toISOString().slice(0, 10);

  const message = `⏸ <b>PM Agent paused for ${weeks} week(s).</b>\nReturning: ${untilStr}\n\nSend /pm-back to resume early.`;

  await sendMessage(env, message);
  await saveSession(env, {
    type:        'pause',
    week_ref:    isoWeek(),
    message_out: message,
    pause_until: untilStr,
    triggered_by: 'user',
  });
}
