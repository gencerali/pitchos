// Kartalix Gamification — Auth & XP Frontend
// Initialises Supabase auth, manages user widget, daily check-in,
// XP particle animations, and login/register modals.

(async function kxGamification() {
  // ── 1. Public config (Supabase credentials + site_id) ────────
  const config = await fetch('/api/config')
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);

  if (!config?.supabase_url || !config?.supabase_anon_key) return;

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
    setTimeout(() => el.remove(), 520);
  };

  // ── 4. Widget elements ────────────────────────────────────────
  const widget    = document.getElementById('userWidget');
  const avatarEl  = document.getElementById('userAvatar');
  const nameEl    = document.getElementById('userNameLabel');
  const rankEl    = document.getElementById('userRankLabel');
  const flameEl   = document.getElementById('kxStreakFlame');
  const flameNum  = document.getElementById('kxStreakCount');
  const loginBtn  = document.getElementById('kxLoginBtn');

  // ── 5. Render authenticated user state ───────────────────────
  async function loadAuthUser(accessToken) {
    try {
      const me = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.ok ? r.json() : null);

      if (!me) return showGuestWidget();

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
      if (nameEl) nameEl.textContent = profile.display_name || profile.username;
      if (rankEl) rankEl.textContent = `${xp.tier_name} • Lvl ${xp.level} • ${xp.total} XP`;
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
          headers: { Authorization: `Bearer ${accessToken}` },
        })
          .then(r => r.json())
          .then(data => {
            if (data.xp_earned > 0) {
              window.kxSpawnXP(data.xp_earned, flameEl);
            }
          })
          .catch(() => {});
      }

      // Expose token for other scripts (article XP, etc.)
      window.kxToken = accessToken;
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
    if (avatarEl) avatarEl.textContent = '?';
    if (nameEl) nameEl.textContent = gs.name;
    if (rankEl) rankEl.textContent = `Lvl 1 • Kartal • ${gs.xp || 0} XP`;
    if (widget) { widget.classList.add('visible'); widget.dataset.auth = 'false'; }
    if (loginBtn) loginBtn.style.display = 'flex';
    if (flameEl) flameEl.style.display = 'none';
    window.kxToken = null;
  }

  // ── 6. Auth state listener ────────────────────────────────────
  sb.auth.onAuthStateChange(async (event, session) => {
    if (session?.access_token) {
      await loadAuthUser(session.access_token);
    } else {
      showGuestWidget();
    }
  });

  // Also check immediately (onAuthStateChange fires async)
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

      const { error } = await sb.auth.signUp({
        email: fd.get('email'),
        password: fd.get('password'),
        options: {
          data: {
            site_id: config.site_id,
            full_name: fd.get('username'),
          },
        },
      });

      if (error) {
        errEl.textContent = error.message;
        btn.disabled = false; btn.textContent = 'Üye Ol';
        return;
      }

      // Claim guest XP after registration
      if (guestXp > 0) {
        const { data: { session: newSession } } = await sb.auth.getSession();
        if (newSession?.access_token) {
          fetch('/api/xp/guest-claim', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${newSession.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ guest_xp: guestXp }),
          }).catch(() => {});
        }
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

  // ── 8. Wire up login button ───────────────────────────────────
  if (loginBtn) {
    loginBtn.addEventListener('click', () => window.kxAuth.showLogin());
  }

  // Wire up widget click for auth users (show dropdown or logout)
  if (widget) {
    widget.addEventListener('click', () => {
      if (widget.dataset.auth === 'true') {
        showProfileDropdown();
      } else {
        window.kxAuth.showLogin();
      }
    });
  }

  function showProfileDropdown() {
    if (document.getElementById('kxProfileDrop')) return;
    const drop = document.createElement('div');
    drop.id = 'kxProfileDrop';
    drop.className = 'kx-profile-drop';
    drop.innerHTML = `
      <button id="kxLogoutBtn">Çıkış Yap</button>
    `;
    document.body.appendChild(drop);

    const wr = widget.getBoundingClientRect();
    drop.style.top = (wr.bottom + window.scrollY + 6) + 'px';
    drop.style.right = (window.innerWidth - wr.right) + 'px';

    const close = () => drop.remove();
    setTimeout(() => document.addEventListener('click', close, { once: true }), 10);
    drop.querySelector('#kxLogoutBtn').addEventListener('click', async () => {
      close();
      await sb.auth.signOut();
    });
  }

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
  // When an article is opened, fire the article-read XP if user is logged in.
  // The completion token is generated here and posted after 30s dwell.
  document.addEventListener('kx:articleOpen', async (e) => {
    const token = window.kxToken;
    const articleId = e.detail?.slug || e.detail?.id;
    if (!token || !articleId) return;

    let scrollPct = 0;
    const startTime = Date.now();

    const onScroll = () => {
      const body = document.getElementById('articleBody') || document.body;
      const scrolled = window.scrollY + window.innerHeight;
      const total = body.scrollHeight;
      scrollPct = Math.max(scrollPct, scrolled / total);
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    setTimeout(async () => {
      window.removeEventListener('scroll', onScroll);
      if (scrollPct < 0.70) return; // <70% scroll depth — no XP

      // Generate HMAC completion token
      const ts = Date.now();
      const msg = `${(await sb.auth.getUser()).data.user?.id}:${articleId}:${ts}`;

      // Token signing requires XP_TOKEN_SECRET on the client side too.
      // For now, post directly — backend will validate scroll/dwell on its own endpoint.
      // Full HMAC signing will be added when XP_TOKEN_SECRET is exposed via /api/config.
      fetch('/api/xp/article-read', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: btoa(JSON.stringify({ uid: msg.split(':')[0], aid: articleId, ts, sig: '' })), article_id: articleId }),
      })
        .then(r => r.json())
        .then(d => { if (d.xp_earned > 0) window.kxSpawnXP(d.xp_earned); })
        .catch(() => {});
    }, 30_000);
  });

})();
