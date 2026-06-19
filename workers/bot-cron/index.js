// Pitchos bot cron worker
// Fires the /api/bot/tick endpoint 4× daily to simulate bot activity.
// Deploy: cd workers/bot-cron && wrangler deploy
// Secret: wrangler secret put XP_TOKEN_SECRET

const TICK_URL = 'https://kartalix.com/api/bot/tick';

const CRON_WINDOWS = {
  '0 4 * * *':   'morning',    // 07:00 TRT
  '10 10 * * *': 'afternoon',  // 13:10 TRT
  '0 15 * * *':  'evening',    // 18:00 TRT
  '0 19 * * *':  'night',      // 22:00 TRT
};

export default {
  async scheduled(event, env) {
    const window = CRON_WINDOWS[event.cron];
    if (!window) return;

    const res = await fetch(TICK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': env.XP_TOKEN_SECRET,
      },
      body: JSON.stringify({ window }),
    });

    if (!res.ok) {
      console.error(`bot-cron ${window} failed: ${res.status}`);
    }
  },
};
