const SUPABASE_TABLE = '/rest/v1/pm_sessions';

async function supabase(env, method, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function saveSession(env, data) {
  return supabase(env, 'POST', SUPABASE_TABLE, data);
}

export async function getLastSession(env, type) {
  const rows = await supabase(env, 'GET',
    `${SUPABASE_TABLE}?type=eq.${type}&order=created_at.desc&limit=1`
  );
  return rows?.[0] || null;
}

export async function getLastClose(env) {
  return getLastSession(env, 'close');
}

export async function getActivePause(env) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await supabase(env, 'GET',
    `${SUPABASE_TABLE}?type=eq.pause&pause_until=gte.${today}&order=created_at.desc&limit=1`
  );
  return rows?.[0] || null;
}

export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
