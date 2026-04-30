# PalmaYard — Shopify Theme (Phase 1)

Custom Shopify theme replicating the PalmaYard homepage from Figma.

> Status: **Phase 1 — visual fidelity preview.** Sections render the Figma frames as composite images so you can verify the UI 1:1 against the design. Phase 2 rebuilds each section with semantic HTML + clean photo exports for production.

## Run locally

```bash
# 1. Install Shopify CLI: https://shopify.dev/docs/themes/tools/cli/install
# 2. From the repo root:
cd theme
shopify theme dev --store=YOUR-STORE.myshopify.com
```

This serves the theme against your dev store with hot reload. The home URL will preview the homepage you saw in Figma.

To preview without a store, you can also drop the `theme/` folder directly via Online Store → Themes → Add theme → Upload zip.

## Layout

```
theme/
  assets/        # CSS + Figma frame exports
  config/        # theme settings schema
  layout/        # theme.liquid wrapper
  locales/       # i18n strings
  sections/      # header, footer, hero, collection-grid, image-strip, cta-banner
  snippets/      # (empty — phase 2)
  templates/     # index.json, 404.liquid
```

The homepage (`templates/index.json`) wires together the sections in this order:
1. Hero
2. Discover Our Collections (real grid of 4 tiles)
3. Designed for Real Outdoor Living (composite)
4. Build Around the Pergola — 3 product card rows (composites)
5. Custom Pergola features (composite)
6. Explore Our Products (composite)
7. The Triangular Pergola (composite)
8. Why PalmaYard (composite)
9. Inspired Outdoor Living gallery (composite)
10. Testimonials (composite)
11. Not Sure What Fits Your Space (composite)
12. Final CTA banner (real HTML)
13. Footer (real HTML, working email signup)

## What's still needed before Phase 2

The Figma exports are flat composites with text **rasterized into the image**. To rebuild every section as semantic, responsive, accessible HTML I need:

- **Logo** as SVG (the `PALMAYARD / INSPIRED OUTDOOR LIVING` wordmark)
- **Fonts** — the actual font files (`.woff2`) used in the design, with foundry/license info. The current theme uses `DM Sans` + `Cormorant Garamond` from Google Fonts as placeholders.
- **Brand color tokens** as hex (the placeholders in `config/settings_schema.json` are eyeballed from the screenshots)
- **Clean photography** without text overlays:
  - 4 collection tile photos (Outdoor Dining, Garden Lounger, Grill & Entertaining, Poolside Retreat)
  - "Designed for Real Outdoor Living" hero photo
  - 3 "Build Around the Pergola" feature photos + 6 small product cards (Pergola 2.0, Outdoor Kitchen, Dining, Lounge Seating)
  - 4 custom-pergola icons as SVG
  - "Pergolas" + "Patio Furniture" tile photos
  - Triangular Pergola photo
  - 6 Inspired Outdoor Living gallery photos
  - Testimonial photo + customer name/quote
  - 4 helper-tile photos
  - CTA banner photo
  - Footer palm-leaf background photo
- **Real product data** — Pergola 2.0, Outdoor Kitchen, Dining, Lounge Seating with:
  - Variants (size, finish, add-ons)
  - Prices
  - Bundle/builder logic (Shopify product bundle, or app like Bundler / Bold Bundles)
- **Copy** for: hero subtitle, value prop body text, testimonial, CTA, helper-tile descriptions

## Pergola configurator (next phase)

The "Build Around the Pergola" section in the design implies a real configurator:
**base pergola → optional kitchen / dining / lounge add-ons → single bundled cart**.

Implementation options when we get to it:
- **Native Shopify bundles** (Combined Listings + Bundles & Cart Transform, Plus only for full Cart Transform)
- **App-based**: Bundler, Bold Bundles, or Shopify's free Bundles app
- **Custom Liquid configurator** that adds multiple line items as one logical bundle (uses line item properties to group, plus `_bundle_id` cart attribute)

Recommend the **custom Liquid configurator** since the design has a heavy custom UI — fewer compromises with off-the-shelf apps.

## Branch / PR

Working branch: `claude/figma-to-shopify-Wtkro`
