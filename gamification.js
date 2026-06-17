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
  let _kxMe       = null;
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

  // ── 5. Render authenticated user state ───────────────────────
  async function loadAuthUser(accessToken) {
    try {
      const me = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.ok ? r.json() : null);

      if (!me) return showGuestWidget();

      _kxMe = me;
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
        body: JSON.stringify({ token: signedToken, article_id: articleId }),
      })
        .then(r => r.json())
        .then(d => { if (d.xp_earned > 0) window.kxSpawnXP(d.xp_earned); })
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
            body: JSON.stringify({ token: vtRes.token, video_id: articleId }),
          })
            .then(r => r.json())
            .then(d => { if (d.xp_earned > 0) window.kxSpawnXP(d.xp_earned); })
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
