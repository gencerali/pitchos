// Kartalix Gamification — Auth & XP Frontend
// Initialises Supabase auth, manages user widget, daily check-in,
// XP particle animations, and login/register modals.

(async function kxGamification() {
  // Detect email confirmation redirect before SDK clears the URL hash
  const isEmailConfirmation = window.location.hash.includes('type=signup') ||
    new URLSearchParams(window.location.search).get('type') === 'signup';

  // ── 0. Wire DOM elements immediately (before any async work) ──
  const widget    = document.getElementById('userWidget');
  const avatarEl  = document.getElementById('userAvatar');
  const flameEl   = document.getElementById('kxStreakFlame');
  let _kxMe          = null;
  let _currentUserSub = null;
  let _soundEnabled  = false;
  let _audioCtx      = null;
  const flameNum  = document.getElementById('kxStreakCount');
  const loginBtn  = document.getElementById('kxLoginBtn');

  // Button opens modal immediately; modal init happens below once Supabase is ready
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      if (window.kxAuth) { window.kxAuth.showLogin(); return; }
      // Supabase not ready yet — show a loading state on the button
      loginBtn.textContent = 'Yükleniyor…';
    });
  }
  if (widget) {
    widget.addEventListener('click', () => {
      if (widget.dataset.auth === 'true' && window.kxAuth) showProfileDropdown(widget);
      else if (window.kxAuth) window.kxAuth.showLogin();
    });
  }

  // ── 1. Public config (Supabase credentials + site_id) ────────
  const config = await fetch('/api/config')
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);

  if (!config?.supabase_url || !config?.supabase_anon_key) {
    // Restore button text if config failed
    if (loginBtn) loginBtn.textContent = 'Giriş Yap';
    return;
  }

  // ── 2. Load Supabase JS SDK ───────────────────────────────────
  await new Promise((resolve, reject) => {
    if (window.supabase) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });

  const sb = window.supabase.createClient(config.supabase_url, config.supabase_anon_key);

  // ── 3. XP Particle animation ──────────────────────────────────
  // Returns UTC ISO string of the user's local midnight — used for timezone-aware daily caps
  window._kxLDS = function() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  };

  // UTC offset label for the browser's local timezone, e.g. "UTC+3", "UTC+2", "UTC-5"
  window._kxTZLabel = (function() {
    const off = -new Date().getTimezoneOffset(); // minutes east of UTC
    const sign = off >= 0 ? '+' : '-';
    const h = Math.floor(Math.abs(off) / 60);
    const m = Math.abs(off) % 60;
    return 'UTC' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '');
  })();

  window.kxSpawnXP = function(amount, sourceEl) {
    if (!amount || amount <= 0) return;
    const el = document.createElement('div');
    el.className = 'kx-xp-particle';
    el.textContent = `+${amount} XP`;

    if (sourceEl) {
      const r = sourceEl.getBoundingClientRect();
      el.style.left = (r.left + r.width / 2 - 24) + 'px';
      el.style.top  = (r.top + window.scrollY - 8) + 'px';
    } else {
      el.style.right = '1rem';
      el.style.top   = '70px';
    }

    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('kx-xp-particle--rise'));
    setTimeout(() => el.remove(), 1500);
    _kxPlayCoin();
  };

  // ── Audio engine ──────────────────────────────────────────────
  // iOS Safari requires audio to start synchronously inside a user gesture.
  // We queue sounds and drain them on first touch/click.
  let _pendingCoins   = 0;
  let _pendingLevelUp = false;
  let _audioUnlocked  = false;

  function _unlockAudio() {
    if (_audioUnlocked || !_soundEnabled) return;
    _audioUnlocked = true; // set before oscillator so a throw can't block unlocking
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // iOS Safari: must start a real oscillator synchronously inside the gesture handler
      const osc = _audioCtx.createOscillator();
      const g   = _audioCtx.createGain();
      g.gain.value = 0.001;
      osc.connect(g); g.connect(_audioCtx.destination);
      osc.start();
      osc.stop(_audioCtx.currentTime + 0.05); // relative time — never in the past
      // Chrome starts AudioContext suspended; resume then drain the pending queue
      const drain = () => {
        if (_pendingCoins > 0) { _kxTonesCoin(); _pendingCoins = 0; }
        if (_pendingLevelUp)   { _kxTonesLevelUp(); _pendingLevelUp = false; }
      };
      if (_audioCtx.state === 'suspended') _audioCtx.resume().then(drain);
      else drain();
    } catch {}
  }

  ['touchstart', 'touchend', 'click'].forEach(evt =>
    document.addEventListener(evt, _unlockAudio, { passive: true })
  );

  // Festive 3-note ascending sparkle — A5 → C#6 → E6 (major arpeggio)
  function _kxTonesCoin() {
    if (!_audioCtx) return;
    try {
      const ctx = _audioCtx;
      [[880, 0], [1109, 0.07], [1319, 0.14]].forEach(([freq, delay]) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        osc.connect(gain); gain.connect(ctx.destination);
        const t = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.28, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.start(t); osc.stop(t + 0.18);
      });
    } catch {}
  }

  // Festive fanfare — C-E-G staccato burst then sustained high C with shimmer
  function _kxTonesLevelUp() {
    if (!_audioCtx) return;
    try {
      const ctx = _audioCtx;
      // [freq, startOffset, duration, volume]
      [[523, 0, 0.12, 0.28], [659, 0.11, 0.12, 0.28], [784, 0.22, 0.12, 0.28],
       [523, 0.35, 0.08, 0.2], [1047, 0.43, 0.6, 0.32]].forEach(([freq, s, dur, vol]) => {
        ['triangle', 'sine'].forEach((type, layer) => {
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = type; osc.frequency.value = freq;
          osc.connect(gain); gain.connect(ctx.destination);
          const t = ctx.currentTime + s;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(vol * (layer === 0 ? 1 : 0.45), t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
          osc.start(t); osc.stop(t + dur);
        });
      });
      // High shimmer on the final note (C7)
      const sh = ctx.createOscillator(); const shg = ctx.createGain();
      sh.type = 'sine'; sh.frequency.value = 2094;
      sh.connect(shg); shg.connect(ctx.destination);
      const ts = ctx.currentTime + 0.43;
      shg.gain.setValueAtTime(0, ts);
      shg.gain.linearRampToValueAtTime(0.09, ts + 0.05);
      shg.gain.exponentialRampToValueAtTime(0.001, ts + 0.55);
      sh.start(ts); sh.stop(ts + 0.55);
    } catch {}
  }

  function _kxPlayCoin() {
    if (!_soundEnabled) return;
    if (_audioUnlocked) { _kxTonesCoin(); }
    else { _pendingCoins++; }
  }

  function _kxPlayLevelUp() {
    if (!_soundEnabled) return;
    if (_audioUnlocked) { _kxTonesLevelUp(); }
    else { _pendingLevelUp = true; }
  }

  // ── 4. Level-up notification ─────────────────────────────────
  window._kxGetLevel = () => _kxMe?.xp?.level ?? 0;

  window.kxShowLevelUp = function(level, tierName) {
    if (document.getElementById('kxLevelUpModal')) return;
    if (!document.getElementById('kxLevelUpStyle')) {
      const s = document.createElement('style');
      s.id = 'kxLevelUpStyle';
      s.textContent = '@keyframes kxLvlIn{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:scale(1)}}';
      document.head.appendChild(s);
    }
    const modal = document.createElement('div');
    modal.id = 'kxLevelUpModal';
    modal.style.cssText = `position:fixed;inset:0;z-index:800;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);backdrop-filter:blur(6px)`;
    modal.innerHTML = `<div style="text-align:center;padding:2rem 1.5rem;max-width:300px;width:90%;background:#111;border:1px solid #2a2a2a;border-radius:12px;display:flex;flex-direction:column;align-items:center;gap:.85rem;animation:kxLvlIn .28s ease">
      <div style="font-size:2.8rem">🏆</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:.65rem;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#F5A623">SEVİYE ATLADIN!</div>
      <div style="font-family:'Oswald',sans-serif;font-size:2.2rem;font-weight:700;color:#fff">Seviye ${level}</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:1rem;font-weight:600;color:#F5A623;letter-spacing:.04em">${tierName}</div>
      <button id="kxLvlClose" style="margin-top:.2rem;padding:.7rem 0;width:100%;background:#D90414;border:none;border-radius:4px;color:#fff;font-family:'Oswald',sans-serif;font-size:.95rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer">Harika!</button>
    </div>`;
    document.body.appendChild(modal);
    _kxPlayLevelUp();
    const close = () => modal.remove();
    modal.querySelector('#kxLvlClose').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    setTimeout(close, 8000);
  };

  // ── 4b. Badge unlock toast queue ─────────────────────────────
  const _kxBadgeQueue = [];
  let _kxBadgeBusy = false;
  function _kxDrainBadge() {
    if (!_kxBadgeQueue.length) { _kxBadgeBusy = false; return; }
    _kxBadgeBusy = true;
    const b = _kxBadgeQueue.shift();
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:80px;right:1rem;z-index:9100;background:#141414;border:1px solid rgba(245,166,35,0.5);border-radius:8px;padding:.7rem .9rem;max-width:230px;display:flex;align-items:center;gap:.6rem;transform:translateX(130%);transition:transform .28s ease;box-shadow:0 4px 16px rgba(0,0,0,0.5)`;
    t.innerHTML = `<div style="font-size:1.4rem;flex-shrink:0">${b.icon ?? '🏅'}</div><div><div style="font-family:'Barlow Condensed',sans-serif;font-size:.55rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#F5A623;margin-bottom:.1rem">Rozet Kazandın!</div><div style="font-family:'Barlow Condensed',sans-serif;font-size:.82rem;font-weight:700;color:#fff">${b.name ?? b.id}</div></div>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.transform = 'translateX(0)'; });
    setTimeout(() => {
      t.style.transform = 'translateX(130%)';
      setTimeout(() => { t.remove(); _kxDrainBadge(); }, 300);
    }, 2800);
  }
  window.kxShowBadge = function(badge) {
    if (!badge) return;
    _kxBadgeQueue.push(badge);
    if (!_kxBadgeBusy) _kxDrainBadge();
  };

  // ── 5. Render authenticated user state ───────────────────────
  async function loadAuthUser(accessToken) {
    try {
      // Detect account switch — reload so page-level state resets for the new user
      const newSub = (() => {
        try { return JSON.parse(atob(accessToken.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).sub ?? null; }
        catch { return null; }
      })();
      if (newSub && _currentUserSub && newSub !== _currentUserSub) {
        location.reload();
        return;
      }
      _currentUserSub = newSub;

      const me = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.ok ? r.json() : null);

      if (!me) return showGuestWidget();

      _kxMe = me;
      _soundEnabled = !!me.profile?.sound_enabled;
      const { profile, xp, streak } = me;
      const initial = (profile.display_name || profile.username || 'K').charAt(0).toUpperCase();

      if (avatarEl) {
        avatarEl.textContent = '';
        if (profile.avatar_url) {
          const img = document.createElement('img');
          img.src = profile.avatar_url;
          img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover';
          avatarEl.appendChild(img);
        } else {
          avatarEl.textContent = initial;
        }
      }
      if (widget) { widget.classList.add('visible'); widget.dataset.auth = 'true'; }
      if (loginBtn) loginBtn.style.display = 'none';

      // Streak flame
      const s = streak.current ?? 0;
      if (flameEl && s > 0) {
        flameEl.style.display = 'flex';
        if (flameNum) flameNum.textContent = s;
        flameEl.classList.toggle('kx-flame--hot', s >= 10);
      } else if (flameEl) {
        flameEl.style.display = 'none';
      }

      // Daily check-in (once per session)
      if (!sessionStorage.getItem('kx_checkin')) {
        sessionStorage.setItem('kx_checkin', '1');
        fetch('/api/xp/checkin', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ local_date: new Date().toLocaleDateString('sv-SE'), local_day_start: window._kxLDS() }),
        })
          .then(r => r.json())
          .then(data => {
            if (data.xp_earned > 0) window.kxSpawnXP(data.xp_earned, flameEl);
            // Update flame counter immediately after checkin
            if (!data.already_checked_in && data.current_streak > 0 && flameEl && flameNum) {
              flameEl.style.display = 'flex';
              flameNum.textContent = data.current_streak;
              flameEl.classList.toggle('kx-flame--hot', data.current_streak >= 10);
            }
            if (_kxMe?.streak) {
              _kxMe.streak.current  = data.current_streak  ?? _kxMe.streak.current;
              _kxMe.streak.longest  = data.longest_streak  ?? _kxMe.streak.longest;
              _kxMe.streak.shield_active = data.shield_awarded
                ? true
                : data.shield_consumed
                  ? false
                  : _kxMe.streak.shield_active;
            }
            if (data.level > (_kxMe?.xp?.level ?? 0)) window.kxShowLevelUp(data.level, data.tier_name);
            (data.badge_unlocks ?? []).forEach(b => window.kxShowBadge(b));
            if (data.streak_broken && data.prev_streak >= 2) {
              setTimeout(() => showStreakRevivalModal(data.prev_streak, accessToken), 1200);
            }
          })
          .catch(() => {});
      }

      // Clear stale guest session so index.html's initUserWidget doesn't show guest sheet
      try { localStorage.removeItem('kx_user'); } catch {}

      // Expose token + auth flag (checked by initUserWidget's addXP and showGuestSheet)
      window.kxToken = accessToken;
      window.__kxLoggedIn = true;
      document.dispatchEvent(new CustomEvent('kx:authReady', { detail: { me } }));

    } catch {
      showGuestWidget();
    }
  }

  function showGuestWidget() {
    let gs;
    try { gs = JSON.parse(localStorage.getItem('kx_user') || 'null'); } catch { gs = null; }
    if (!gs || !gs.isGuest) {
      gs = { name: 'Misafir Kartal', isGuest: true, xp: 0, ts: Date.now() };
      try { localStorage.setItem('kx_user', JSON.stringify(gs)); } catch {}
    }
    _kxMe = null;
    if (avatarEl) avatarEl.textContent = '?';
    if (widget) { widget.classList.add('visible'); widget.dataset.auth = 'false'; }
    if (loginBtn) loginBtn.style.display = 'flex';
    if (flameEl) flameEl.style.display = 'none';
    window.kxToken = null;
  }

  // ── 6. Auth state listener ────────────────────────────────────
  sb.auth.onAuthStateChange(async (event, session) => {
    if (session?.access_token) {
      await loadAuthUser(session.access_token);
      if (event === 'SIGNED_IN' && isEmailConfirmation) {
        history.replaceState(null, '', window.location.pathname);
        showWelcomeScreen();
      }
    } else if (event === 'SIGNED_OUT') {
      // Only transition to guest on explicit sign-out.
      // INITIAL_SESSION with null means the access token may be expired but refresh is pending —
      // getSession() below will refresh it. Calling showGuestWidget() here causes a visible flash.
      showGuestWidget();
    }
  });

  // Authoritative session check: refreshes expired tokens automatically.
  // Handles both the logged-in fast-path and the truly-logged-out guest path.
  const { data: { session: existing } } = await sb.auth.getSession();
  if (existing?.access_token) {
    await loadAuthUser(existing.access_token);
  } else {
    showGuestWidget();
  }

  // ── 7. Auth Modal ─────────────────────────────────────────────
  function buildAuthModal() {
    if (document.getElementById('kxAuthModal')) return;

    const modal = document.createElement('div');
    modal.id = 'kxAuthModal';
    modal.className = 'kx-auth-modal';
    modal.innerHTML = `
      <div class="kx-auth-backdrop"></div>
      <div class="kx-auth-panel" role="dialog" aria-modal="true" aria-label="Giriş / Kayıt">
        <button class="kx-auth-close" aria-label="Kapat">✕</button>

        <div class="kx-auth-logo">🦅</div>
        <h2 class="kx-auth-title" id="kxAuthTitle">Kartalix'e Giriş Yap</h2>

        <!-- Tab bar -->
        <div class="kx-auth-tabs">
          <button class="kx-auth-tab kx-auth-tab--active" data-tab="login">Giriş Yap</button>
          <button class="kx-auth-tab" data-tab="register">Üye Ol</button>
        </div>

        <!-- Login form -->
        <form class="kx-auth-form" id="kxLoginForm" data-panel="login">
          <div class="kx-auth-field">
            <label>E-posta</label>
            <input type="email" name="email" autocomplete="email" required placeholder="ornek@email.com">
          </div>
          <div class="kx-auth-field">
            <label>Şifre</label>
            <input type="password" name="password" autocomplete="current-password" required placeholder="••••••••">
          </div>
          <div class="kx-auth-error" id="kxLoginErr"></div>
          <button type="submit" class="kx-auth-btn">Giriş Yap</button>
          <button type="button" class="kx-auth-link" id="kxForgotLink">Şifremi unuttum</button>
        </form>

        <!-- Register form -->
        <form class="kx-auth-form kx-auth-form--hidden" id="kxRegisterForm" data-panel="register">
          <div class="kx-auth-field">
            <label>Kullanıcı Adı</label>
            <input type="text" name="username" autocomplete="username" required
              placeholder="kartal_99" minlength="3" maxlength="20"
              pattern="[a-zA-Z0-9_]+" title="Harf, rakam ve _ kullanabilirsiniz">
          </div>
          <div class="kx-auth-field">
            <label>E-posta</label>
            <input type="email" name="email" autocomplete="email" required placeholder="ornek@email.com">
          </div>
          <div class="kx-auth-field">
            <label>Şifre</label>
            <input type="password" name="password" autocomplete="new-password" required
              placeholder="Min 8 karakter" minlength="8">
          </div>
          <label class="kx-auth-check">
            <input type="checkbox" name="kvkk" required>
            <span><a href="/gizlilik" target="_blank">KVKK ve Gizlilik Politikası</a>'nı okudum, kabul ediyorum.</span>
          </label>
          <div class="kx-auth-error" id="kxRegErr"></div>
          <button type="submit" class="kx-auth-btn">Üye Ol</button>
        </form>

        <!-- Forgot password form -->
        <form class="kx-auth-form kx-auth-form--hidden" id="kxForgotForm" data-panel="forgot">
          <p class="kx-auth-hint">E-posta adresinizi girin, şifre sıfırlama bağlantısı gönderelim.</p>
          <div class="kx-auth-field">
            <label>E-posta</label>
            <input type="email" name="email" autocomplete="email" required placeholder="ornek@email.com">
          </div>
          <div class="kx-auth-error" id="kxForgotErr"></div>
          <button type="submit" class="kx-auth-btn">Bağlantı Gönder</button>
          <button type="button" class="kx-auth-link" id="kxBackToLogin">← Geri dön</button>
        </form>

      </div>`;

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('kx-auth-modal--open'));

    // Close
    const close = () => {
      modal.classList.remove('kx-auth-modal--open');
      setTimeout(() => modal.remove(), 260);
    };
    modal.querySelector('.kx-auth-close').addEventListener('click', close);
    modal.querySelector('.kx-auth-backdrop').addEventListener('click', close);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    // Tab switching
    const tabs = modal.querySelectorAll('.kx-auth-tab');
    const forms = modal.querySelectorAll('.kx-auth-form');
    function switchTab(name) {
      tabs.forEach(t => t.classList.toggle('kx-auth-tab--active', t.dataset.tab === name));
      forms.forEach(f => f.classList.toggle('kx-auth-form--hidden', f.dataset.panel !== name));
      modal.querySelector('#kxAuthTitle').textContent =
        name === 'login' ? 'Kartalix\'e Giriş Yap' :
        name === 'register' ? 'Kartalix\'e Üye Ol' : 'Şifre Sıfırla';
    }
    tabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

    // Forgot password link
    modal.querySelector('#kxForgotLink').addEventListener('click', () => switchTab('forgot'));
    modal.querySelector('#kxBackToLogin').addEventListener('click', () => switchTab('login'));

    // ── Login submit ──────────────────────────────────────────
    modal.querySelector('#kxLoginForm').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = modal.querySelector('#kxLoginErr');
      errEl.textContent = '';
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Giriş yapılıyor…';

      const { error } = await sb.auth.signInWithPassword({
        email: fd.get('email'),
        password: fd.get('password'),
      });

      if (error) {
        errEl.textContent = error.message === 'Invalid login credentials'
          ? 'E-posta veya şifre hatalı.'
          : error.message;
        btn.disabled = false; btn.textContent = 'Giriş Yap';
      } else {
        close();
      }
    });

    // ── Register submit ───────────────────────────────────────
    modal.querySelector('#kxRegisterForm').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = modal.querySelector('#kxRegErr');
      errEl.textContent = '';
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Kaydediliyor…';

      // Transfer guest XP
      let guestXp = 0;
      try { guestXp = JSON.parse(localStorage.getItem('kx_user') || '{}').xp || 0; } catch {}

      const { data, error } = await sb.auth.signUp({
        email: fd.get('email'),
        password: fd.get('password'),
        options: {
          data: {
            site_id: config.site_id,
            full_name: fd.get('username'),
          },
          emailRedirectTo: 'https://kartalix.com',
        },
      });

      if (error) {
        errEl.textContent = error.message.toLowerCase().includes('already')
          ? 'Bu e-posta adresi zaten kayıtlı. Giriş yapmayı dene.'
          : error.message;
        btn.disabled = false; btn.textContent = 'Üye Ol';
        return;
      }

      // Supabase returns user with empty identities when email already exists
      // (enumeration protection — no explicit error is thrown)
      if (data?.user?.identities?.length === 0) {
        errEl.textContent = 'Bu e-posta adresi zaten kayıtlı. Giriş yapmayı dene.';
        btn.disabled = false; btn.textContent = 'Üye Ol';
        return;
      }

      // Check if email confirmation is required (session won't exist yet if so)
      const { data: { session: newSession } } = await sb.auth.getSession();

      if (!newSession) {
        // Email confirmation required — replace form with a clear success screen
        const panel = modal.querySelector('.kx-auth-panel');
        panel.innerHTML = `
          <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:1rem;padding:.5rem 0">
            <div style="font-size:2.5rem">📬</div>
            <div style="font-family:'Oswald',sans-serif;font-size:1.2rem;font-weight:700;
              text-transform:uppercase;letter-spacing:.04em;color:#fff">
              E-postanı Kontrol Et
            </div>
            <div style="font-size:.85rem;color:#9ca3af;line-height:1.6;max-width:300px;text-align:center">
              <strong style="color:#fff">${fd.get('email')}</strong> adresine onay bağlantısı gönderdik.
              Bağlantıya tıklayarak hesabını aktifleştir ve Kartalix'e giriş yap.
            </div>
            <div style="font-size:.75rem;color:#555;margin-top:.25rem">
              E-posta gelmediyse spam klasörünü kontrol et.
            </div>
            <button onclick="this.closest('.kx-auth-modal').remove()" style="
              margin-top:.5rem;padding:.7rem 2rem;
              background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;
              color:#9ca3af;font-family:'Barlow Condensed',sans-serif;
              font-size:.85rem;font-weight:700;letter-spacing:.06em;
              text-transform:uppercase;cursor:pointer;width:100%;
            ">Tamam</button>
          </div>`;
        return;
      }

      // Auto-confirmed — claim guest XP immediately
      if (guestXp > 0 && newSession?.access_token) {
        fetch('/api/xp/guest-claim', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${newSession.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ guest_xp: guestXp }),
        }).catch(() => {});
        try { localStorage.removeItem('kx_user'); } catch {}
      }

      close();
    });

    // ── Forgot password submit ────────────────────────────────
    modal.querySelector('#kxForgotForm').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = modal.querySelector('#kxForgotErr');
      errEl.textContent = '';
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Gönderiliyor…';

      await sb.auth.resetPasswordForEmail(fd.get('email'), {
        redirectTo: window.location.origin + '/reset-password',
      });

      // Always show success (avoids email enumeration)
      errEl.style.color = '#22c55e';
      errEl.textContent = 'Eğer bu e-posta kayıtlıysa bağlantı gönderildi.';
      btn.disabled = false; btn.textContent = 'Bağlantı Gönder';
    });

    return modal;
  }

  // Expose modal functions globally (used by guest conversion sheet and login button)
  window.kxAuth = {
    showLogin() { buildAuthModal(); },
    showRegister() {
      const m = buildAuthModal();
      const tab = m?.querySelector('[data-tab="register"]');
      if (tab) tab.click();
    },
    signOut: () => sb.auth.signOut(),
    supabase: sb,
    config,
  };

  // ── 8. Update button text now that kxAuth is ready ───────────
  if (loginBtn) loginBtn.textContent = 'Giriş Yap';

  function showProfileDropdown(anchorEl) {
    const existing = document.getElementById('kxProfileDrop');
    if (existing) { existing.remove(); return; }
    const drop = document.createElement('div');
    drop.id = 'kxProfileDrop';
    drop.className = 'kx-profile-drop';
    const summaryHtml = _kxMe ? `
      <div class="kx-drop-summary">
        <div class="kx-drop-name">${_kxMe.profile.display_name || _kxMe.profile.username || 'Taraftar'}</div>
        <div class="kx-drop-rank">${_kxMe.xp.tier_name} · Lvl ${_kxMe.xp.level} · ${(_kxMe.xp.total || 0).toLocaleString('tr-TR')} XP</div>
      </div>` : '';
    drop.innerHTML = `${summaryHtml}
      <a href="/profil">Profilim</a>
      <a href="/liderlik">Liderlik</a>
      <button id="kxLogoutBtn">Çıkış Yap</button>`;
    document.body.appendChild(drop);
    const anchor = anchorEl || widget;
    const wr = anchor.getBoundingClientRect();
    drop.style.top = (wr.bottom + 6) + 'px';
    drop.style.right = (window.innerWidth - wr.right) + 'px';
    const close = () => drop.remove();
    setTimeout(() => document.addEventListener('click', close, { once: true }), 10);
    drop.querySelector('#kxLogoutBtn').addEventListener('click', async () => {
      close();
      await sb.auth.signOut();
    });
  }
  window.kxShowProfileDrop = (el) => showProfileDropdown(el);

  function showWelcomeScreen() {
    if (document.getElementById('kxWelcome')) return;
    const el = document.createElement('div');
    el.id = 'kxWelcome';
    el.style.cssText = `
      position:fixed;inset:0;z-index:700;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.88);backdrop-filter:blur(8px);
    `;
    el.innerHTML = `
      <div style="
        text-align:center;padding:2.5rem 2rem;max-width:380px;
        background:#111;border:1px solid #242424;border-radius:12px;
        display:flex;flex-direction:column;align-items:center;gap:1rem;
      ">
        <div style="font-size:3rem">🦅</div>
        <div style="font-family:'Oswald',sans-serif;font-size:1.5rem;font-weight:700;
          text-transform:uppercase;letter-spacing:.05em;color:#fff">
          Hoş Geldin, Kartal!
        </div>
        <div style="font-size:.88rem;color:#9ca3af;line-height:1.55;max-width:280px">
          E-posta adresin doğrulandı. Artık Kartalix'in tam üyesisin —
          XP kazan, liderlik tablosuna gir ve Tribün'e erişimini aç.
        </div>
        <button id="kxWelcomeClose" style="
          margin-top:.5rem;padding:.8rem 2rem;
          background:#D90414;border:none;border-radius:4px;
          color:#fff;font-family:'Oswald',sans-serif;
          font-size:.95rem;font-weight:700;letter-spacing:.08em;
          text-transform:uppercase;cursor:pointer;width:100%;
        ">Keşfet</button>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#kxWelcomeClose').addEventListener('click', () => el.remove());
    el.addEventListener('click', e => { if (e.target === el) el.remove(); });
  }

  function showStreakRevivalModal(prevStreak, accessToken) {
    if (document.getElementById('kxRevivalModal')) return;
    if (!document.getElementById('kxLevelUpStyle')) {
      const s = document.createElement('style');
      s.id = 'kxLevelUpStyle';
      s.textContent = '@keyframes kxLvlIn{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:scale(1)}}';
      document.head.appendChild(s);
    }
    const modal = document.createElement('div');
    modal.id = 'kxRevivalModal';
    modal.style.cssText = `position:fixed;inset:0;z-index:800;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);backdrop-filter:blur(6px)`;
    modal.innerHTML = `<div style="text-align:center;padding:2rem 1.5rem;max-width:300px;width:90%;background:#111;border:1px solid #2a2a2a;border-radius:12px;display:flex;flex-direction:column;align-items:center;gap:.85rem;animation:kxLvlIn .28s ease">
      <div style="font-size:2.5rem">💔</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:.65rem;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#ef4444">SERİN KOPTU!</div>
      <div style="font-family:'Oswald',sans-serif;font-size:1.6rem;font-weight:700;color:#fff">${prevStreak} Günlük Seri</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:.85rem;color:#9ca3af;line-height:1.45;max-width:230px">Kaybettiğin seriyi 100 XP karşılığında geri alabilirsin.</div>
      <button id="kxReviveBtn" style="width:100%;padding:.8rem;background:#D90414;border:none;border-radius:4px;color:#fff;font-family:'Oswald',sans-serif;font-size:.9rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer">🔥 Seriyi Geri Getir — 100 XP</button>
      <div id="kxReviveMsg" style="font-family:'Barlow Condensed',sans-serif;font-size:.75rem;color:#9ca3af;min-height:1rem"></div>
      <button id="kxReviveSkip" style="background:none;border:none;color:#6b7280;font-family:'Barlow Condensed',sans-serif;font-size:.78rem;cursor:pointer;padding:.25rem">Hayır, geçiver</button>
    </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    const msgEl = modal.querySelector('#kxReviveMsg');
    const reviveBtn = modal.querySelector('#kxReviveBtn');

    modal.querySelector('#kxReviveSkip').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    setTimeout(close, 30000);

    reviveBtn.addEventListener('click', async () => {
      reviveBtn.disabled = true;
      reviveBtn.textContent = 'İşleniyor…';
      try {
        const res = await fetch('/api/xp/streak-revival', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prev_streak: prevStreak }),
        }).then(r => r.json());

        if (res.ok) {
          reviveBtn.style.background = '#22c55e';
          reviveBtn.textContent = `✓ Seri ${res.restored_streak} güne döndü!`;
          if (_kxMe?.streak) _kxMe.streak.current = res.restored_streak;
          if (flameEl && flameNum) {
            flameNum.textContent = res.restored_streak;
            flameEl.style.display = 'flex';
          }
          setTimeout(close, 2500);
        } else if (res.reason === 'insufficient_xp') {
          msgEl.textContent = `Yeterli XP yok. (${res.total_xp ?? 0} XP mevcut)`;
          reviveBtn.disabled = false;
          reviveBtn.textContent = '🔥 Seriyi Geri Getir — 100 XP';
        } else if (res.reason === 'cooldown') {
          msgEl.textContent = 'Canlanma hakkı 7 günde bir kullanılabilir.';
          reviveBtn.disabled = false;
          reviveBtn.textContent = '🔥 Seriyi Geri Getir — 100 XP';
        }
      } catch {
        msgEl.textContent = 'Bir hata oluştu. Lütfen tekrar dene.';
        reviveBtn.disabled = false;
        reviveBtn.textContent = '🔥 Seriyi Geri Getir — 100 XP';
      }
    });
  }

  // Expose sound control globally for profil.html toggle
  window.kxGamification = {
    setSoundEnabled: (v) => { _soundEnabled = !!v; },
    // Called synchronously from the toggle's change handler (a real user gesture)
    warmUpAudio: () => { _unlockAudio(); _kxPlayCoin(); },
  };

  // ── 9. Patch guest conversion sheet CTA ──────────────────────
  // Override the "Üye Ol" CTA in the existing guest sheet
  document.addEventListener('click', e => {
    if (e.target.matches('.guest-conv-cta')) {
      e.stopPropagation();
      const sheet = document.getElementById('guestConvSheet');
      if (sheet) { sheet.classList.remove('open'); setTimeout(() => sheet.remove(), 300); }
      window.kxAuth.showRegister();
    }
  }, true);

  // ── 10. Article XP on authenticated reads ────────────────────
  // When an article is opened, fetch a server-signed token then award XP after 30s dwell + 70% scroll.
  document.addEventListener('kx:articleOpen', async (e) => {
    const authToken = window.kxToken;
    const articleId = e.detail?.id || e.detail?.slug;
    if (!authToken || !articleId) return;

    // Get a signed completion token from the server (keeps XP_TOKEN_SECRET off the client)
    const tokenRes = await fetch(`/api/xp/article-token?article_id=${encodeURIComponent(articleId)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    }).then(r => r.json()).catch(() => null);
    if (!tokenRes?.token) return;

    const signedToken = tokenRes.token;

    setTimeout(async () => {
      fetch('/api/xp/article-read', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: signedToken, article_id: articleId, local_day_start: window._kxLDS() }),
      })
        .then(r => r.json())
        .then(d => {
          if (d.xp_earned > 0) window.kxSpawnXP(d.xp_earned);
          if (d.level > (_kxMe?.xp?.level ?? 0)) window.kxShowLevelUp(d.level, d.tier_name);
          (d.badge_unlocks ?? []).forEach(b => window.kxShowBadge(b));
        })
        .catch(() => {});
    }, 10_000);

    // Video XP: award watch_video_30s if this article is a video embed
    const pm = e.detail?.publish_mode || '';
    const isVideo = pm.startsWith('youtube') || pm === 'video_embed';
    if (isVideo) {
      const vtRes = await fetch(`/api/xp/video-token?video_id=${encodeURIComponent(articleId)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }).then(r => r.json()).catch(() => null);
      if (vtRes?.token) {
        setTimeout(async () => {
          fetch('/api/xp/video-watch', {
            method: 'POST',
            headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: vtRes.token, video_id: articleId, local_day_start: window._kxLDS() }),
          })
            .then(r => r.json())
            .then(d => {
              if (d.xp_earned > 0) window.kxSpawnXP(d.xp_earned);
              if (d.level > (_kxMe?.xp?.level ?? 0)) window.kxShowLevelUp(d.level, d.tier_name);
              (d.badge_unlocks ?? []).forEach(b => window.kxShowBadge(b));
            })
            .catch(() => {});
        }, 30_000);
      }
    }
  });

  // ── 11. Central XP trigger from page meta tag ─────────────────
  // Worker-rendered pages embed <meta name="kx-context"> instead of
  // per-page inline scripts. To enable XP on a new page type, add its
  // template and a case here — no other wiring needed.
  // Runs AFTER all listeners above are registered and auth is complete.
  const _kxMeta = document.querySelector('meta[name="kx-context"]');
  if (_kxMeta && window.kxToken) {
    try {
      const _ctx = JSON.parse(_kxMeta.getAttribute('content') || '{}');
      if (_ctx.xp_type === 'article') {
        document.dispatchEvent(new CustomEvent('kx:articleOpen', {
          detail: { slug: _ctx.slug || '', id: _ctx.id || '', publish_mode: _ctx.publish_mode || '' }
        }));
      }
      // Future: else if (_ctx.xp_type === 'author_profile') { ... }
    } catch {}
  }

})();
