// Static preview server for the PalmaYard homepage.
// `theme/assets/` is exposed as the public root so /hero.png, /base.css, etc.
// resolve to the same files the Shopify theme serves.

export default {
  base: './',
  publicDir: 'theme/assets',
  server: {
    host: true,
    port: 3000,
    open: false
  }
};
