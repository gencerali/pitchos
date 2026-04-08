# Kartalix Logo Pack
**Version 1.0 — April 2026**

---

## Files Included

### SVG Files (scalable, use for web + print)
| File | Description | Use when |
|------|-------------|----------|
| `kartalix-logo-dark.svg` | Full logo, white on transparent | Dark backgrounds, website header |
| `kartalix-logo-light.svg` | Full logo, dark on light bg | Light backgrounds, print, documents |
| `kartalix-logo-red.svg` | Full logo, white on red | Breaking news, match day cards, social |
| `kartalix-icon-dark.svg` | K icon only, white on transparent | Dark UI elements, watermarks |
| `kartalix-icon-light.svg` | K icon only, dark on light bg | Light backgrounds, print |
| `kartalix-icon-red.svg` | K icon only, white on red | Red accent elements |
| `kartalix-favicon.svg` | 32x32 favicon with rounded corners | Browser tab, app icon |
| `kartalix-wordmark-dark.svg` | KARTALIX text only, white | Minimal contexts, white on dark |
| `kartalix-wordmark-accent.svg` | KAR-TAL-IX with red TAL | Social media headers, posters |
| `kartalix-brand-sheet.svg` | Complete brand reference | Sharing brand identity |

---

## Colors

| Name | Hex | RGB | Use |
|------|-----|-----|-----|
| Primary Black | `#0D0D0D` | 13, 13, 13 | Backgrounds, dark text |
| Beşiktaş Red | `#E30A17` | 227, 10, 23 | Accent, icon lower wing, CTA |
| Pure White | `#FFFFFF` | 255, 255, 255 | Text on dark, icon on dark |
| Surface | `#141414` | 20, 20, 20 | Card backgrounds |
| Light Background | `#F0EDE6` | 240, 237, 230 | Light mode background |
| Muted | `#555550` | 85, 85, 80 | Secondary text, timestamps |

---

## Typography

### Headlines & Logo
- **Barlow Condensed** weight 900 (Black)
- Letter spacing: 3-5px
- All caps
- Google Fonts: `https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@900`
- Fallback: `Impact, Arial Narrow, sans-serif`

### Body & UI
- **Inter** weight 400/500
- Or **Arial/Helvetica** as fallback
- Body size: 14-16px
- UI labels: 8-11px, letter-spacing 2-3px

---

## Usage Rules

### ✅ Correct usage
- Use provided SVG files without modification
- Maintain minimum clear space = height of K icon on all sides
- Use dark logo on dark backgrounds, light logo on light backgrounds
- Red variant only for breaking news, match day, urgent content

### ❌ Do not
- Stretch or distort the logo
- Change colors outside the defined palette
- Add effects (shadows, gradients, outlines) to the logo
- Place logo on busy photographic backgrounds without overlay
- Use alongside Beşiktaş JK official crest (avoid confusion with official club)

---

## Logo on Photos

When placing logo over photography:
1. Add dark overlay first: `background: rgba(0,0,0,0.6)`
2. Place white logo version on top
3. Ensure minimum contrast ratio 4.5:1

---

## Favicon Implementation

Add to HTML `<head>`:
```html
<link rel="icon" type="image/svg+xml" href="/kartalix-favicon.svg">
<link rel="alternate icon" href="/favicon.ico">
```

---

## Social Media Sizes

| Platform | Size | File to use |
|----------|------|-------------|
| Twitter/X profile | 400×400 | `kartalix-icon-dark.svg` on red bg |
| Twitter/X header | 1500×500 | `kartalix-logo-dark.svg` centered |
| Instagram profile | 320×320 | `kartalix-icon-red.svg` |
| Facebook cover | 820×312 | `kartalix-logo-dark.svg` |
| WhatsApp | 192×192 | `kartalix-favicon.svg` scaled up |

---

## Inline SVG for Web (copy-paste into HTML)

### Header logo (dark site):
```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 40" height="40">
  <rect x="0" y="2" width="7" height="36" fill="#ffffff"/>
  <polygon points="7,20 30,2 24,2 7,14" fill="#ffffff"/>
  <polygon points="7,20 31,38 37,38 7,23" fill="#E30A17"/>
  <rect x="0" y="18" width="7" height="4" fill="#E30A17"/>
  <text x="44" y="26" font-family="'Barlow Condensed',Impact,sans-serif" 
        font-size="22" font-weight="900" letter-spacing="2" fill="#ffffff">KARTALIX</text>
</svg>
```

---

## Legal Note

Kartalix is an independent fan media platform.
This logo and brand identity are original works created for Kartalix.
Beşiktaş JK club crest, name, and official marks are property of Beşiktaş Jimnastik Kulübü.
Kartalix is not affiliated with or endorsed by Beşiktaş JK.

---

*Kartalix · Fan Media Platform · kartalix.com · 2026*
