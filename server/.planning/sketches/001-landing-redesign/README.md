---
sketch: 001
name: landing-redesign
question: "What visual direction should the Toca Ficha Dr. landing page take?"
winner: "G"
tags: [landing, branding, typography, marketing, animation]
---

# Sketch 001 — Landing Redesign · ★ Winner: G

## Winner

**G · F + Persuasion** — F's clean Live Demo aesthetic, extended with a before/after hero, an objection-handling section ("E se a IA errar?"), a real-shift timeline (15 de abril · 23 pacientes · 0 erros), and a sticky bottom CTA. Scroll-reveal on sections. Respects `prefers-reduced-motion`.

### Files

- **`winner-g.html`** — standalone, production-ready G. No sketch chrome, no other variants. This is the file to port to `landing/index.html`.
- **`index.html`** — the full 8-variant archive. Kept for reference and future comparison rounds.
- **`../themes/default.css`** — shared token base (unchanged).

### Why G won

1. **Aesthetic from F:** white background, medical teal `#0891B2`, Inter + JetBrains Mono, single-accent harmony. Reads as modern tech-SaaS rather than hospital-clinical — the aesthetic doctors *voluntarily* use, not the one forced on them.
2. **Persuasion structure:** before/after + objection + real-shift add evidence-based selling over pure product demo.
3. **Regulatory defensibility:** the "E se a IA errar?" section pre-empts CFM 2.454/2026 reviewer concerns by quoting the actual implementation (Temperature 0.1, "proibido inventar" prompt rule, doctor-review-before-save).
4. **Solo-founder maintainable:** one live-HUD JS state machine, scroll-reveal via IntersectionObserver, no heavy framework dependency.

### Trade-off to know

The self-playing HUD's JS state machine is a maintenance vector. For production, consider replacing with a recorded `<video>` of the same animation — same impact, zero JS to break.

---

## All Variants Explored (Archive)

### Static (A/B/C)
- **A · Clinical Swiss** — White, navy, Inter, ruled Swiss grid. Closest fallback if G's animation ever becomes risky.
- **B · Dossiê Médico** — Cream, Fraunces editorial serif. Useful later for a content/blog/whitepaper site.
- **C · Plantão Terminal** — Warm beige + coral + brutal numerals. Rejected: too "consumer app."

### Animated (D/E/F/F+)
- **D · Kinetic Brutal** — Black + electric lime, flipping type, ticker. Rejected: business analysis explicitly warned "avoid neon, motion-heavy." Reads as web3.
- **E · Aurora Calm** — Animated purple/pink/blue gradient blobs, glass morphism. Rejected: business analysis explicitly warned "avoid AI purple/pink gradients."
- **F · Live Demo** — The direct predecessor of G. Clean white dashboard with self-playing HUD.
- **F+ · Clinical Trust** — F retokenized to the business report's Option A palette (Figtree + Noto Sans + clinical green CTA). Rejected in favor of F: Inter reads more premium/tech than Figtree to the doctor audience, single-teal accent is visually tighter than dual teal/green.

## Decision Provenance

See `/Users/admin/Dev/BUSINESS_ANALYSIS_2026-04-21.md` §3–§4 for the analysis that shaped the directional constraints. G satisfies:
- Option A's `#0891B2` medical teal palette
- "Avoid neon, motion-heavy animations, AI purple/pink gradients" guidance
- Unified design-system requirement (G's patterns port cleanly to Conduta Rápida / Audio-to-Note / other products in the portfolio)

## Next Step

Port `winner-g.html` into `landing/index.html`, replacing the current dark-emerald version. Adapt the live HUD to either remain JS-driven or swap for a pre-recorded video.
