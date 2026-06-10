# TODO — Onboarding video (idea #12)

> Captured 2026-05-04 from the v3.1 brainstorm. Assigned to the website (landing) repo because acquisition + activation belong to the marketing site, not the extension.

## What to build

A 2:14 demo video embedded on `tocafichadr.com.br` that walks a new doctor from "what is this?" to "I'd install it" in under three minutes. Pairs with the in-product 3-spotlight tour that ships in the extension itself.

## Where to embed

- **Primary placement:** above-the-fold on `landing/index.html` — replace or push down the current hero illustration. Auto-play muted, click-to-unmute, with chapter list to the right (or below on mobile).
- **Secondary placement:** mid-page section after the "35 → 4 actions" stat block, looped at 15s as ambient proof.
- **OG/Twitter card:** export the 0:45 frame ("primeira gravação") as `og-demo.jpg` for share previews.

## 5-chapter script (2:14 total)

| Time | Chapter | Beat |
|------|---------|------|
| `0:00` | O problema | Screen recording: doctor's 25 clicks across G-Hosp. Counter overlay tracks each click. Subtitle: "uma consulta hoje". |
| `0:30` | Instalação | Chrome Web Store install + popup config. 30 seconds, real-time. Show the new wave-to-tick mark in the toolbar. |
| `0:45` | Primeira gravação | Doctor speaks complaint, SOAP appears streaming, CID confidence card. Voice-over names each piece. Highlight that any specialty works (not just pediatrics). |
| `1:20` | Receita + alta | Template card click → prescription auto-fills → review → finalizar. Show the new diagnosis + age-band cards (Resfriado >6m e <2a, GEA <1a, OMA, HAS adulto). Counter shows 4 actions total. |
| `1:50` | O resultado | Side-by-side timer: 5min34s vs 1min12s. End frame: time-saved analytics tile. CTA: "Instalar grátis". |

## Production checklist

- [ ] Record on a real shift (anonymized patient — fake name/MRN; redact face/voice if relevant).
- [ ] Edit in Descript or CapCut. Add: counter overlay, click highlights (yellow ring), bottom subtitle bar.
- [ ] Voice-over in PT-BR by the doctor (own voice = trust signal). Or use ElevenLabs if uncomfortable.
- [ ] Export 1920×1080 H.264, < 8 MB. Also export a vertical 9:16 trim of chapter 3 (0:45-1:20) for social.
- [ ] Host on Vercel as `/demo.mp4` (extension landing is already on Vercel under `chris-projects-9b96e743`). Add a `<video poster="/demo-poster.jpg">` tag, no autoplay sound, `playsinline`.
- [ ] Add a JSON-LD `VideoObject` block to `index.html` for SEO.
- [ ] A/B test: hero with video vs hero without video. Track install conversion via UTM on the Web Store link.

## Why both video AND in-product tour

The tour ships in the extension (already mocked at `brainstorm-ideas.html#deepdive`, idea #12 deep dive). The two are complementary:

- **Video** sells the *idea* — before the install decision. Lives on the landing, in WhatsApp shares, in conference talks.
- **In-product tour** sells the *habit* — first 60 seconds after install. Catches doctors who installed on a colleague's recommendation but haven't tried it yet.

Activation = first successful transcription. Video drives install; tour drives activation.

## Estimate

~6 hours total: 2h script + record, 2h edit, 1h voice-over, 1h embed + JSON-LD + poster.

## Repositioning note (2026-05-04)

The current landing positions Toca Ficha Dr. as a **pediatric** tool. The v3.1 release repositions it as **general physician** — pediatric remains a use case, not the brand identity. Update copy:

- Title: "Instrumento clínico para o plantão pediátrico" → "Instrumento clínico para o plantão"
- Description: drop "pediátrico"
- og:title, twitter:title: same
- Hero copy: examples should mix pediatric + adult cases (HAS, DM2, lombalgia alongside Resfriado, GEA)
