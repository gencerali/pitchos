import React, { useState } from "react";

// ===== DATA =====

const TIERS = {
  P1: { color: "#7dd3a8", name: "Official" },
  P2: { color: "#7dd3a8", name: "Licensed" },
  P3: { color: "#d4c47d", name: "Social/Video" },
  P4: { color: "#d4a87d", name: "Commercial" },
  P5: { color: "#d47d7d", name: "Unofficial" },
  P6: { color: "#7da8d4", name: "Original" },
};

const SOURCES = [
  { tier: "P1", name: "bjk.com.tr", mech: "RSS + scrape", trust: 1.0, mode: "auto", legal: "Free reuse" },
  { tier: "P1", name: "KAP", mech: "Disclosure API", trust: 1.0, mode: "locked", legal: "Public legal" },
  { tier: "P1", name: "TFF", mech: "RSS + fixtures API", trust: 1.0, mode: "locked", legal: "Federation public" },
  { tier: "P1", name: "UEFA.com", mech: "RSS + comp API", trust: 1.0, mode: "auto", legal: "Public competition" },
  { tier: "P2", name: "Sportmonks", mech: "Licensed REST", trust: 0.95, mode: "auto", legal: "Licensed (paid)" },
  { tier: "P2", name: "Opta", mech: "Licensed API", trust: 0.95, mode: "auto", legal: "Licensed (paid)" },
  { tier: "P2", name: "Transfermarkt", mech: "Licensed API", trust: 0.85, mode: "auto", legal: "License pending" },
  { tier: "P3", name: "BJK YouTube", mech: "YT Data API · embed", trust: 1.0, mode: "locked", legal: "Embed allowed" },
  { tier: "P3", name: "beIN Sports YT", mech: "YT API · transcript", trust: 0.7, mode: "hybrid", legal: "Facts-only" },
  { tier: "P3", name: "Journalist channels", mech: "YT API · transcript", trust: 0.65, mode: "hybrid", legal: "15-word ceiling" },
  { tier: "P3", name: "BJK official X", mech: "X API v2", trust: 0.95, mode: "locked", legal: "Embed-friendly" },
  { tier: "P3", name: "Player/coach X+IG", mech: "X+IG API · translate", trust: 0.85, mode: "auto", legal: "Personal-public" },
  { tier: "P4", name: "Fotomaç", mech: "RSS via Render proxy", trust: 0.6, mode: "hybrid", legal: "FSEK · facts-only" },
  { tier: "P4", name: "Sabah", mech: "RSS via Render", trust: 0.65, mode: "hybrid", legal: "FSEK · Turkuvaz" },
  { tier: "P4", name: "A Spor", mech: "RSS via Render proxy", trust: 0.6, mode: "hybrid", legal: "FSEK · facts-only" },
  { tier: "P4", name: "Hürriyet", mech: "RSS via proxy", trust: 0.7, mode: "hybrid", legal: "FSEK · Demirören" },
  { tier: "P4", name: "Fanatik", mech: "RSS via proxy", trust: 0.5, mode: "locked", legal: "FSEK · tabloid" },
  { tier: "P4", name: "Milliyet", mech: "RSS via proxy", trust: 0.65, mode: "hybrid", legal: "FSEK · Demirören" },
  { tier: "P5", name: "Fabrizio Romano", mech: "X API", trust: 0.8, mode: "locked", legal: "Public X" },
  { tier: "P5", name: "David Ornstein", mech: "X + Athletic", trust: 0.8, mode: "locked", legal: "Public + licensed" },
  { tier: "P5", name: "Forums (Reddit)", mech: "Reddit API", trust: 0.0, mode: "locked", legal: "Sentiment only" },
  { tier: "P6", name: "Kartalix-original", mech: "Internal CMS", trust: 1.0, mode: "locked", legal: "Owned IP" },
];

const AGENTS = [
  { num: "01", name: "Intake", role: "Source-adapter registry. Polls, normalizes, partitions by site_id." },
  { num: "02", name: "Qualify", role: "4 sub-judges: Relevance, Sentiment, Value, Type. Story attach." },
  { num: "03", name: "Facts Firewall", role: "Atomic fact extraction. Source text destroyed.", critical: true, building: true },
  { num: "04", name: "Produce", role: "Original article from facts only. Type-aware templates." },
  { num: "05", name: "Visual Asset", role: "6-tier image strategy. IT3 blocked. IT6 templates first.", building: true },
  { num: "06", name: "Editorial QA", role: "Typo, plagiarism, fact-check, sensitivity. Author-first review.", building: true },
  { num: "07", name: "Distribute", role: "Publish to Pages + social. Respects HITL hold." },
  { num: "08", name: "Engage", role: "Track performance. Origin of feedback loops." },
];

const STORY_TYPES = [
  { name: "Match", scope: "Extended: pre/live/post phases. Sub-stories for non-routine.", lifecycle: "Signal-driven open/close", v1: true },
  { name: "Transfer", scope: "rumor → negotiation → agreed → official", lifecycle: "Days to weeks. P1 closes.", v1: true },
  { name: "Injury", scope: "minor / significant / serious", lifecycle: "Hours to weeks. Official closes.", v1: true },
  { name: "Disciplinary", scope: "TFF/UEFA rulings, bans", lifecycle: "Days. Official ruling closes.", v1: false },
  { name: "Financial", scope: "KAP-driven", lifecycle: "Hours to days. KAP closes.", v1: false },
  { name: "Management", scope: "Coach/board decisions", lifecycle: "Days. Announcement closes.", v1: false },
  { name: "Commentary", scope: "Pundit transcripts", lifecycle: "24-48h", v1: false },
  { name: "Editorial", scope: "Kartalix-original", lifecycle: "Scheduled", v1: false },
];

const IMAGE_TIERS = [
  { id: "IT1", name: "Licensed photography", source: "AA, DHA, Getty", cost: "₺3-5k/mo", v1: false, blocked: false },
  { id: "IT2", name: "Official club imagery", source: "bjk.com.tr, BJK socials", cost: "Free (embed)", v1: true, blocked: false },
  { id: "IT3", name: "Wire/RSS images", source: "P4 outlet images", cost: "—", v1: false, blocked: true },
  { id: "IT4", name: "Stock photography", source: "Unsplash, Pexels", cost: "Free / low", v1: true, blocked: false },
  { id: "IT5", name: "AI-generated", source: "DALL·E, Flux", cost: "$0.02-0.10/img", v1: true, blocked: false, limited: "Abstract only" },
  { id: "IT6", name: "Kartalix-templated", source: "SVG templates + data", cost: "₺0 marginal", v1: true, blocked: false, primary: true },
];

const HITL_GATES = [
  { id: "A", name: "Qualify Override", state: "off" },
  { id: "B", name: "Facts Dispute", state: "off" },
  { id: "C", name: "Pre-Publish Review", state: "on" },
  { id: "D", name: "Story Closure", state: "off" },
];

const TELEGRAM_CHANNELS = [
  { handle: "@kartalix-ops", urgency: "silent", color: "#7dd3a8" },
  { handle: "@kartalix-alerts", urgency: "notify", color: "#d4c47d" },
  { handle: "@kartalix-decisions", urgency: "respond", color: "#e30a17" },
  { handle: "@kartalix-editorial-author", urgency: "author-only", color: "#7da8d4" },
  { handle: "@kartalix-pm", urgency: "build-tracking", color: "#a78bfa" },
];

const SLICES = [
  { num: "0", name: "Build Scaffold + PM", weeks: "1-2", purpose: "PM agent + tracking files before any code" },
  { num: "1", name: "Facts Firewall", weeks: "2-4", purpose: "Legal core. Everything depends on this." },
  { num: "2", name: "Story-Centric Foundation", weeks: "2-3", purpose: "Story tables, matching, state machine" },
  { num: "3", name: "Story Types Narrow", weeks: "3-4", purpose: "Match-extended + Transfer + Injury" },
  { num: "4", name: "Operational Control", weeks: "2", purpose: "Telegram + HITL Gate C only" },
  { num: "5", name: "Visual Asset Agent", weeks: "2-3", purpose: "IT2 + IT6 only (IT1 → v2)" },
  { num: "6", name: "Editorial QA + Authors", weeks: "2-3", purpose: "Two-stage author flow" },
  { num: "7", name: "Governance Layer", weeks: "2", purpose: "CLO + CFO synchronous mode" },
  { num: "8", name: "Self-Learning Loops", weeks: "3", purpose: "Engage feedback, trust modes" },
];

// ===== MAIN =====

export default function App() {
  const [view, setView] = useState("executive");
  const [filterTier, setFilterTier] = useState(null);

  return (
    <div style={{ fontFamily: "ui-monospace, 'SF Mono', monospace", background: "#0d0d0d", color: "#e8e8e8", minHeight: "100vh", padding: "28px 24px" }}>
      <Header view={view} setView={setView} />
      {view === "executive" ? <Executive /> : <Engineering filterTier={filterTier} setFilterTier={setFilterTier} />}
      <Footer />
    </div>
  );
}

function Header({ view, setView }) {
  return (
    <header style={{ borderBottom: "1px solid #2a2a2a", paddingBottom: "20px", marginBottom: "32px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "16px", alignItems: "baseline" }}>
        <div>
          <div style={{ fontSize: "10px", letterSpacing: "0.2em", color: "#888", marginBottom: "8px", textTransform: "uppercase" }}>Pitchos · Kartalix · v1</div>
          <h1 style={{ fontFamily: "Georgia, serif", fontWeight: 300, fontSize: "38px", margin: 0, letterSpacing: "-0.02em" }}>Architecture & Workflow</h1>
          <div style={{ fontSize: "11px", color: "#888", marginTop: "8px" }}>Story-centric · Multi-tenant · Build-disciplined · 28 Apr 2026</div>
        </div>
        <div style={{ display: "flex", border: "1px solid #3a3a3a" }}>
          {["executive", "engineering"].map(v => (
            <button key={v} onClick={() => setView(v)} style={{ background: view === v ? "#e8e8e8" : "transparent", color: view === v ? "#0d0d0d" : "#aaa", border: "none", padding: "8px 14px", fontSize: "10px", letterSpacing: "0.1em", cursor: "pointer", textTransform: "uppercase", fontFamily: "inherit" }}>{v}</button>
          ))}
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer style={{ marginTop: "48px", paddingTop: "20px", borderTop: "1px solid #2a2a2a", display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#666", letterSpacing: "0.1em", textTransform: "uppercase", flexWrap: "wrap", gap: "8px" }}>
      <div>kartalix.com</div>
      <div>v1 · 28 apr 2026</div>
      <div>single source of truth</div>
    </footer>
  );
}

function ST({ num, title, sub }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "14px", marginBottom: "16px", flexWrap: "wrap" }}>
      <span style={{ fontFamily: "Georgia, serif", fontSize: "12px", color: "#e30a17", letterSpacing: "0.2em" }}>{num}</span>
      <h2 style={{ fontFamily: "Georgia, serif", fontWeight: 400, fontSize: "22px", margin: 0, letterSpacing: "-0.01em" }}>{title}</h2>
      {sub && <span style={{ fontSize: "11px", color: "#777" }}>{sub}</span>}
    </div>
  );
}

// ===== EXECUTIVE =====

function Executive() {
  return (
    <>
      <div style={{ maxWidth: "740px", marginBottom: "40px" }}>
        <div style={{ fontSize: "10px", color: "#e30a17", letterSpacing: "0.25em", marginBottom: "12px", textTransform: "uppercase" }}>The Story</div>
        <p style={{ fontFamily: "Georgia, serif", fontSize: "22px", fontWeight: 300, lineHeight: 1.5, margin: 0 }}>
          Kartalix is an <em>AI-native</em> Beşiktaş news platform. It does not rewrite — it <span style={{ color: "#e30a17" }}>extracts facts</span>, synthesizes across sources, and writes original Turkish journalism. Governed by a tight legal firewall, three governance roles (CLO · CFO · Test), and a single human-in-the-loop gate.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1px", background: "#2a2a2a", marginBottom: "40px" }}>
        {[
          { v: "8", l: "Pipeline agents", s: "Intake → Engage" },
          { v: "3", l: "Governance roles", s: "CLO · CFO · Test" },
          { v: "3", l: "Story types v1", s: "Match · Transfer · Injury" },
          { v: "6", l: "Image tiers", s: "IT3 blocked" },
          { v: "9", l: "Build slices", s: "v0 → v8" },
        ].map(s => (
          <div key={s.l} style={{ background: "#141414", padding: "22px 16px", textAlign: "center" }}>
            <div style={{ fontFamily: "Georgia, serif", fontSize: "44px", fontWeight: 300, lineHeight: 1, marginBottom: "6px" }}>{s.v}</div>
            <div style={{ fontSize: "10px", color: "#888", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "3px" }}>{s.l}</div>
            <div style={{ fontSize: "10px", color: "#666" }}>{s.s}</div>
          </div>
        ))}
      </div>

      <ST num="01" title="The flow" />
      <div style={{ display: "flex", background: "#141414", border: "1px solid #2a2a2a", marginBottom: "40px", overflowX: "auto" }}>
        {[
          { l: "Sources", s: "P1–P6", c: "#7dd3a8" },
          { l: "Firewall", s: "Facts only", c: "#e30a17" },
          { l: "Synthesize", s: "Original", c: "#7da8d4" },
          { l: "Visual", s: "IT2 + IT6", c: "#d4c47d" },
          { l: "QA", s: "Editorial", c: "#a78bfa" },
          { l: "Publish", s: "Web + social", c: "#d4a87d" },
          { l: "Learn", s: "Loop back", c: "#a78bfa" },
        ].map((s, i, arr) => (
          <React.Fragment key={s.l}>
            <div style={{ flex: "1 1 0", minWidth: "120px", padding: "26px 14px", textAlign: "center" }}>
              <div style={{ fontFamily: "Georgia, serif", fontSize: "20px", fontWeight: 300, color: s.c, marginBottom: "6px" }}>{s.l}</div>
              <div style={{ fontSize: "9px", color: "#888", letterSpacing: "0.15em", textTransform: "uppercase" }}>{s.s}</div>
            </div>
            {i < arr.length - 1 && <div style={{ width: "1px", background: "#2a2a2a" }} />}
          </React.Fragment>
        ))}
      </div>

      <ST num="02" title="Why it matters" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1px", background: "#2a2a2a", marginBottom: "40px" }}>
        {[
          { t: "Legal-first", b: "FSEK Article 36 prohibits reuse of commercial-media text. Kartalix never sees that text past the firewall — only structured facts." },
          { t: "Story-centric", b: "Multiple outlets reporting the same thing don't become multiple articles. One story, growing confidence, one Kartalix piece evolving as facts accumulate." },
          { t: "Multi-tenant", b: "Same platform runs Beşiktaş today, Juventus tomorrow. Per-club config in JSONB — no code changes per club." },
          { t: "Self-improving", b: "Engagement signals feed back into source trust, qualification thresholds, template priorities. Sharper without manual tuning." },
          { t: "Governed", b: "CLO watches legal posture, CFO watches cost, Test watches output integrity. Cross-cutting oversight, not pipeline blockers." },
          { t: "Disciplined", b: "9 slices in order. PM agent on Telegram. Four tracking files. No new design until v1 ships." },
        ].map(c => (
          <div key={c.t} style={{ background: "#141414", padding: "20px" }}>
            <div style={{ fontFamily: "Georgia, serif", fontSize: "16px", color: "#e30a17", marginBottom: "8px" }}>{c.t}</div>
            <p style={{ fontSize: "12px", color: "#bbb", lineHeight: 1.6, margin: 0 }}>{c.b}</p>
          </div>
        ))}
      </div>

      <ST num="03" title="Your role" />
      <div style={{ background: "#141414", border: "1px solid #2a2a2a", padding: "24px", marginBottom: "32px" }}>
        <p style={{ fontFamily: "Georgia, serif", fontSize: "16px", lineHeight: 1.65, margin: "0 0 16px 0" }}>
          One Telegram, one decision type. Pre-publish review for sensitive categories — financial, disciplinary, injury severity, weakly-sourced rumors. Tap <span style={{ color: "#7dd3a8" }}>Publish</span>, <span style={{ color: "#d47d7d" }}>Reject</span>, or do nothing — silence triggers auto-hold within 60 minutes. Plus a separate <span style={{ color: "#a78bfa" }}>@kartalix-pm</span> channel that holds the build plan in its head so you don't have to.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "8px" }}>
          {[["Active gate", "C only"], ["On timeout", "Auto-hold"], ["Quiet hours", "23:00 → 07:00"], ["Daily digest", "09:00 IST"], ["PM cadence", "Mon/Fri + drift"]].map(([k, v]) => (
            <div key={k} style={{ padding: "10px", background: "#0d0d0d", border: "1px solid #2a2a2a" }}>
              <div style={{ fontSize: "9px", color: "#666", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "4px" }}>{k}</div>
              <div style={{ fontSize: "13px", color: "#e8e8e8", fontFamily: "Georgia, serif" }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      <ST num="04" title="Build plan" sub="9 slices · 6-9 month realistic timeline with COO duties" />
      <div style={{ background: "#141414", border: "1px solid #2a2a2a", padding: "20px", marginBottom: "32px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #2a2a2a" }}>
              {["#", "Slice", "Weeks", "Purpose"].map(h => (
                <th key={h} style={{ textAlign: "left", padding: "8px", fontSize: "9px", color: "#888", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SLICES.map(s => (
              <tr key={s.num} style={{ borderBottom: "1px solid #1f1f1f" }}>
                <td style={{ padding: "10px 8px", fontFamily: "Georgia, serif", fontSize: "16px", color: s.num === "0" || s.num === "1" ? "#e30a17" : "#888" }}>{s.num}</td>
                <td style={{ padding: "10px 8px", color: "#e8e8e8", fontWeight: 500 }}>{s.name}</td>
                <td style={{ padding: "10px 8px", color: "#888" }}>{s.weeks}</td>
                <td style={{ padding: "10px 8px", color: "#bbb" }}>{s.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1px", background: "#2a2a2a" }}>
        {[
          { t: "Legal", c: "#e30a17", l: ["FSEK Article 36", "Law 5651 künye", "Auditable firewall", "TR IP lawyer pending"] },
          { t: "Infra", c: "#7da8d4", l: ["Cloudflare · Supabase", "Render proxy", "Claude Haiku", "JSONB config"] },
          { t: "Pitchos", c: "#7dd3a8", l: ["Per-site_id config", "Onboard via row", "Shared code", "Juve in v2"] },
          { t: "Discipline", c: "#a78bfa", l: ["4 tracking files", "PM agent v0", "Golden fixtures", "v2 backlog discipline"] },
        ].map(p => (
          <div key={p.t} style={{ background: "#141414", padding: "18px", borderTop: `2px solid ${p.c}` }}>
            <div style={{ fontFamily: "Georgia, serif", fontSize: "15px", marginBottom: "12px" }}>{p.t}</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: "11px", color: "#bbb", lineHeight: 1.7 }}>
              {p.l.map(x => <li key={x} style={{ paddingLeft: "10px", borderLeft: "1px solid #2a2a2a", marginBottom: "4px" }}>{x}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

// ===== ENGINEERING =====

function Engineering({ filterTier, setFilterTier }) {
  return (
    <>
      <ST num="01" title="Source Tiers" sub="Click to filter the registry below" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "8px", marginBottom: "32px" }}>
        {Object.entries(TIERS).map(([t, c]) => {
          const count = SOURCES.filter(s => s.tier === t).length;
          const isActive = filterTier === t;
          return (
            <div key={t} onClick={() => setFilterTier(isActive ? null : t)} style={{ border: `1px solid ${isActive ? c.color : "#2a2a2a"}`, background: isActive ? `${c.color}15` : "#141414", padding: "14px", cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "4px" }}>
                <span style={{ fontFamily: "Georgia, serif", fontSize: "20px", color: c.color, fontWeight: 600 }}>{t}</span>
                <span style={{ fontSize: "10px", color: c.color }}>{count}</span>
              </div>
              <div style={{ fontSize: "10px", color: c.color, letterSpacing: "0.1em", textTransform: "uppercase" }}>{c.name}</div>
              {t === "P4" && <div style={{ fontSize: "9px", color: "#e30a17", marginTop: "6px" }}>⚠ FSEK firewall</div>}
            </div>
          );
        })}
      </div>

      <ST num="02" title="Source Registry" sub="Per-source · trust modes: auto / locked / hybrid" />
      <div style={{ overflowX: "auto", border: "1px solid #2a2a2a", background: "#141414", marginBottom: "32px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", minWidth: "780px" }}>
          <thead>
            <tr style={{ background: "#1a1a1a", borderBottom: "1px solid #2a2a2a" }}>
              {["Tier", "Source", "Mechanism", "Trust", "Mode", "Legal"].map(h => (
                <th key={h} style={{ textAlign: "left", padding: "10px 12px", fontSize: "9px", color: "#888", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(filterTier ? SOURCES.filter(s => s.tier === filterTier) : SOURCES).map((s, i) => {
              const c = TIERS[s.tier];
              const modeColor = s.mode === "locked" ? "#d47d7d" : s.mode === "hybrid" ? "#d4c47d" : "#7dd3a8";
              return (
                <tr key={i} style={{ borderBottom: "1px solid #1f1f1f" }}>
                  <td style={{ padding: "10px 12px" }}><span style={{ color: c.color, fontFamily: "Georgia, serif", fontWeight: 600 }}>{s.tier}</span></td>
                  <td style={{ padding: "10px 12px", color: "#e8e8e8", fontWeight: 500 }}>{s.name}</td>
                  <td style={{ padding: "10px 12px", color: "#ccc" }}>{s.mech}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <div style={{ flex: 1, height: "3px", background: "#2a2a2a", minWidth: "40px" }}>
                        <div style={{ height: "100%", width: `${s.trust * 100}%`, background: s.trust >= 0.9 ? "#7dd3a8" : s.trust >= 0.7 ? "#d4c47d" : s.trust >= 0.5 ? "#d4a87d" : "#d47d7d" }} />
                      </div>
                      <span style={{ fontSize: "10px", color: "#aaa" }}>{s.trust.toFixed(2)}</span>
                    </div>
                  </td>
                  <td style={{ padding: "10px 12px" }}><span style={{ color: modeColor, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em" }}>{s.mode}</span></td>
                  <td style={{ padding: "10px 12px", color: "#888", fontSize: "10px" }}>{s.legal}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ST num="03" title="YouTube — Two Modes" sub="Embed-primary vs transcript-extract" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "10px", marginBottom: "32px" }}>
        {[
          { mode: "EMBED PRIMARY", color: "#7dd3a8", scope: "BJK official · verified club channels", use: "Match reruns, pressers, coach/player/president interviews", handle: "iframe embed · short editorial wrapper", legal: "YouTube ToS allows embed" },
          { mode: "TRANSCRIPT EXTRACT", color: "#d4a87d", scope: "beIN Sports · journalist channels", use: "Key statements, expert commentary", handle: "API → transcript → Facts Firewall → original article", legal: "FSEK · 15-word ceiling · paraphrase" },
        ].map(m => (
          <div key={m.mode} style={{ border: `1px solid ${m.color}40`, borderTop: `3px solid ${m.color}`, padding: "18px", background: "#141414" }}>
            <div style={{ fontSize: "10px", color: m.color, letterSpacing: "0.2em", marginBottom: "12px", fontWeight: 500 }}>{m.mode}</div>
            {[["Scope", m.scope], ["Use case", m.use], ["Handling", m.handle], ["Legal", m.legal]].map(([k, v], i) => (
              <div key={i} style={{ marginBottom: "10px" }}>
                <div style={{ fontSize: "9px", color: "#666", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "3px" }}>{k}</div>
                <div style={{ fontSize: "12px", color: "#ccc", lineHeight: 1.5 }}>{v}</div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <ST num="04" title="Story Types — v1 narrow" sub="Expand in v2" />
      <div style={{ overflowX: "auto", border: "1px solid #2a2a2a", background: "#141414", marginBottom: "16px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", minWidth: "640px" }}>
          <thead>
            <tr style={{ background: "#1a1a1a", borderBottom: "1px solid #2a2a2a" }}>
              {["Type", "Scope / subtypes", "Lifecycle", "Phase"].map(h => (
                <th key={h} style={{ textAlign: "left", padding: "10px 12px", fontSize: "9px", color: "#888", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STORY_TYPES.map(t => (
              <tr key={t.name} style={{ borderBottom: "1px solid #1f1f1f", opacity: t.v1 ? 1 : 0.45 }}>
                <td style={{ padding: "10px 12px", color: "#e8e8e8", fontFamily: "Georgia, serif", fontSize: "13px", fontWeight: 500 }}>{t.name}</td>
                <td style={{ padding: "10px 12px", color: "#ccc" }}>{t.scope}</td>
                <td style={{ padding: "10px 12px", color: "#888" }}>{t.lifecycle}</td>
                <td style={{ padding: "10px 12px" }}>
                  <span style={{ fontSize: "9px", padding: "2px 8px", background: t.v1 ? "#e30a17" : "#2a2a2a", color: t.v1 ? "white" : "#888", letterSpacing: "0.1em" }}>{t.v1 ? "V1" : "V2"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginBottom: "32px", padding: "12px", background: "#0d0d0d", border: "1px solid #2a2a2a", fontSize: "11px", color: "#aaa", lineHeight: 1.6 }}>
        <span style={{ color: "#7dd3a8", fontWeight: 600 }}>Match story is extended:</span> one entity covering pre/live/post phases. Sub-stories with <code style={{ color: "#7da8d4" }}>parent_story_id</code> spawn for non-routine events (VAR, controversies). Sub-stories survive parent archive. Open/close is signal-driven, not calendar-driven.
      </div>

      <ST num="05" title="Agent Pipeline" sub="8 agents · Facts Firewall is the legal core" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "8px", marginBottom: "32px" }}>
        {AGENTS.map(a => (
          <div key={a.num} style={{ padding: "16px", background: "#141414", border: `1px solid ${a.critical ? "#e30a1766" : "#2a2a2a"}`, position: "relative" }}>
            {a.critical && <div style={{ position: "absolute", top: "-1px", right: "-1px", background: "#e30a17", color: "white", fontSize: "8px", padding: "3px 8px", letterSpacing: "0.1em" }}>FIREWALL</div>}
            {a.building && <div style={{ position: "absolute", top: "-1px", left: "-1px", background: "#d4a87d", color: "#0d0d0d", fontSize: "8px", padding: "3px 8px", letterSpacing: "0.1em" }}>BUILDING</div>}
            <div style={{ fontFamily: "Georgia, serif", fontSize: "11px", color: "#666", letterSpacing: "0.2em", marginBottom: "8px" }}>{a.num}</div>
            <h3 style={{ fontFamily: "Georgia, serif", fontWeight: 400, fontSize: "16px", margin: "0 0 8px 0" }}>{a.name}</h3>
            <div style={{ fontSize: "11px", color: "#aaa", lineHeight: 1.5 }}>{a.role}</div>
          </div>
        ))}
      </div>

      <ST num="06" title="Visual Asset Strategy" sub="6 tiers · IT3 blocked · IT6 first" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "8px", marginBottom: "32px" }}>
        {IMAGE_TIERS.map(it => (
          <div key={it.id} style={{ background: "#141414", border: `1px solid ${it.blocked ? "#e30a17" : it.primary ? "#7dd3a8" : "#2a2a2a"}`, padding: "14px", opacity: !it.v1 && !it.blocked ? 0.55 : 1, position: "relative" }}>
            {it.blocked && <div style={{ position: "absolute", top: "-1px", right: "-1px", background: "#e30a17", color: "white", fontSize: "8px", padding: "2px 6px", letterSpacing: "0.1em" }}>BLOCKED</div>}
            {it.primary && <div style={{ position: "absolute", top: "-1px", right: "-1px", background: "#7dd3a8", color: "#0d0d0d", fontSize: "8px", padding: "2px 6px", letterSpacing: "0.1em" }}>PRIMARY</div>}
            {!it.v1 && !it.blocked && <div style={{ position: "absolute", top: "-1px", right: "-1px", background: "#2a2a2a", color: "#888", fontSize: "8px", padding: "2px 6px", letterSpacing: "0.1em" }}>V2</div>}
            <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px" }}>
              <span style={{ fontFamily: "Georgia, serif", fontSize: "16px", fontWeight: 600, color: it.blocked ? "#e30a17" : it.primary ? "#7dd3a8" : "#e8e8e8" }}>{it.id}</span>
              <span style={{ fontSize: "11px", color: "#bbb" }}>{it.name}</span>
            </div>
            <div style={{ fontSize: "10px", color: "#888", marginBottom: "4px" }}>{it.source}</div>
            <div style={{ fontSize: "10px", color: "#666" }}>{it.cost}</div>
            {it.limited && <div style={{ fontSize: "10px", color: "#d4c47d", marginTop: "4px" }}>↳ {it.limited}</div>}
          </div>
        ))}
      </div>

      <ST num="07" title="Governance Layer" sub="Cross-cutting · not in pipeline" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "8px", marginBottom: "32px" }}>
        {[
          { name: "CLO", title: "Legal Posture", color: "#e30a17", v1: ["FSEK rule engine", "Image-rights checker", "Quote-length checker (15w)", "IT3-leak detector"], v2: ["Async LLM audit", "Defamation/likeness checks"] },
          { name: "CFO", title: "Cost & Budget", color: "#d4c47d", v1: ["Cost ledger", "Budget caps + alerts", "Per-agent attribution", "Hard-stop on spike"], v2: ["P&L analysis", "Unit economics"] },
          { name: "Test", title: "Output Integrity", color: "#a78bfa", v1: ["Schema validation", "Pre-flight health", "Stage-output checks", "Engage-embedded"], v2: ["Sampled LLM verification"] },
        ].map(g => (
          <div key={g.name} style={{ background: "#141414", borderTop: `3px solid ${g.color}`, border: `1px solid ${g.color}40`, padding: "16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px" }}>
              <span style={{ fontFamily: "Georgia, serif", fontSize: "20px", color: g.color }}>{g.name}</span>
              <span style={{ fontSize: "11px", color: "#888" }}>{g.title}</span>
            </div>
            <div style={{ fontSize: "9px", color: "#666", letterSpacing: "0.15em", textTransform: "uppercase", marginTop: "8px", marginBottom: "4px" }}>v1 sync</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: "11px", color: "#ccc", lineHeight: 1.7 }}>
              {g.v1.map(x => <li key={x}>· {x}</li>)}
            </ul>
            <div style={{ fontSize: "9px", color: "#666", letterSpacing: "0.15em", textTransform: "uppercase", marginTop: "10px", marginBottom: "4px" }}>v2</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: "11px", color: "#888", lineHeight: 1.7 }}>
              {g.v2.map(x => <li key={x}>· {x}</li>)}
            </ul>
          </div>
        ))}
      </div>

      <ST num="08" title="HITL · Telegram · Author Flow" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px", marginBottom: "20px" }}>
        <div style={{ border: "1px solid #2a2a2a", borderLeft: "3px solid #e30a17", background: "#141414", padding: "16px" }}>
          <div style={{ fontSize: "10px", color: "#e30a17", letterSpacing: "0.15em", marginBottom: "10px", textTransform: "uppercase" }}>HITL Gates</div>
          {HITL_GATES.map(g => (
            <div key={g.id} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: "11px", color: g.state === "on" ? "#e30a17" : "#666" }}>
              <span>{g.id} · {g.name}</span><span style={{ fontWeight: 600 }}>{g.state.toUpperCase()}</span>
            </div>
          ))}
        </div>
        {TELEGRAM_CHANNELS.map(c => (
          <div key={c.handle} style={{ border: "1px solid #2a2a2a", borderLeft: `3px solid ${c.color}`, background: "#141414", padding: "16px" }}>
            <div style={{ fontSize: "11px", color: c.color, fontWeight: 500, marginBottom: "6px" }}>{c.handle}</div>
            <div style={{ fontSize: "9px", color: "#666", letterSpacing: "0.1em", textTransform: "uppercase" }}>{c.urgency}</div>
          </div>
        ))}
      </div>

      <div style={{ background: "#141414", border: "1px solid #2a2a2a", padding: "16px", fontSize: "11px", color: "#aaa", lineHeight: 1.7, marginBottom: "32px" }}>
        <span style={{ color: "#7da8d4", fontWeight: 600 }}>Author flow (two-stage):</span> Author submits → Editorial QA reviews → QA report sent to <strong>author</strong> first → author applies fixes / discusses / withdraws → resubmits → final QA → <strong>pre-final to publisher</strong> via @kartalix-decisions → publish/edit/reject. Bot proposes, author edits, you approve. No auto-applied changes ever.
      </div>

      <ST num="09" title="Build Discipline" sub="Meta-architecture · how the system gets shipped" />
      <div style={{ background: "#141414", border: "2px solid #a78bfa66", padding: "20px", marginBottom: "24px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px" }}>
          <div>
            <div style={{ fontSize: "11px", color: "#a78bfa", letterSpacing: "0.15em", marginBottom: "10px", textTransform: "uppercase" }}>Four tracking files</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: "11px", color: "#ccc", lineHeight: 1.8 }}>
              <li>· <code style={{ color: "#7da8d4" }}>architecture/pitchos-v1.tsx</code> — design</li>
              <li>· <code style={{ color: "#7da8d4" }}>SLICES.md</code> — what's in flight</li>
              <li>· <code style={{ color: "#7da8d4" }}>DECISIONS.md</code> — append-only log</li>
              <li>· <code style={{ color: "#7da8d4" }}>NEXT.md</code> — single next action</li>
            </ul>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "#a78bfa", letterSpacing: "0.15em", marginBottom: "10px", textTransform: "uppercase" }}>PM agent (@kartalix-pm)</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: "11px", color: "#ccc", lineHeight: 1.8 }}>
              <li>· Mon 09:00 — Kickoff + commitments</li>
              <li>· Fri 17:00 — Close + slip review</li>
              <li>· Daily — Drift detector (silent)</li>
              <li>· Monthly — Strategic review</li>
              <li>· On-demand — Session logger</li>
              <li>· "PM, pause for N weeks" command</li>
            </ul>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "#a78bfa", letterSpacing: "0.15em", marginBottom: "10px", textTransform: "uppercase" }}>Test discipline</div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: "11px", color: "#ccc", lineHeight: 1.8 }}>
              <li>· Unit (Vitest, ~seconds)</li>
              <li>· Integration (~30s)</li>
              <li>· Golden fixtures (~minutes)</li>
              <li>· One fixture per architectural decision</li>
              <li>· <code style={{ color: "#7da8d4" }}>dev test</code> command</li>
            </ul>
          </div>
        </div>

        <div style={{ marginTop: "20px", padding: "12px", background: "#0d0d0d", border: "1px dashed #a78bfa66", fontSize: "11px", color: "#bbb", lineHeight: 1.6 }}>
          <span style={{ color: "#a78bfa", fontWeight: 600 }}>The rule:</span> No new architecture conversations until v1 ships. New ideas during v1 → v2 backlog in SLICES.md. PM agent surfaces drift if architecture-level decisions appear in chat without DECISIONS.md entries.
        </div>
      </div>

      <ST num="10" title="Build Slices" sub="9 slices · ship in order · v0 first" />
      <div style={{ overflowX: "auto", border: "1px solid #2a2a2a", background: "#141414", marginBottom: "32px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", minWidth: "640px" }}>
          <thead>
            <tr style={{ background: "#1a1a1a", borderBottom: "1px solid #2a2a2a" }}>
              {["#", "Slice", "Weeks", "Purpose"].map(h => (
                <th key={h} style={{ textAlign: "left", padding: "10px 12px", fontSize: "9px", color: "#888", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SLICES.map(s => (
              <tr key={s.num} style={{ borderBottom: "1px solid #1f1f1f", background: s.num === "0" ? "#a78bfa10" : s.num === "1" ? "#e30a1710" : "transparent" }}>
                <td style={{ padding: "10px 12px", fontFamily: "Georgia, serif", fontSize: "16px", color: s.num === "0" ? "#a78bfa" : s.num === "1" ? "#e30a17" : "#888" }}>{s.num}</td>
                <td style={{ padding: "10px 12px", color: "#e8e8e8", fontWeight: 500 }}>{s.name}</td>
                <td style={{ padding: "10px 12px", color: "#888" }}>{s.weeks}</td>
                <td style={{ padding: "10px 12px", color: "#bbb" }}>{s.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
