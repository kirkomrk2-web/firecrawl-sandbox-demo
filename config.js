/**
 * Runtime configuration for the Firecrawl sandbox demo.
 *
 * Set `FIRECRAWL_PROXY` to your deployed Worker / Node proxy URL to
 * enable the live Run button. When empty, the dashboard falls back to
 * the baked-in replay of the last verified end-to-end run.
 *
 * Examples:
 *   window.FIRECRAWL_PROXY = 'https://firecrawl-sandbox-proxy.acme.workers.dev';
 *   window.FIRECRAWL_PROXY = 'http://localhost:8787';   // local Node server
 *
 * You can also override at runtime with the ?proxy= query param:
 *   https://your-site.example/?proxy=https://firecrawl-sandbox-proxy.acme.workers.dev
 */
window.FIRECRAWL_PROXY = '';
