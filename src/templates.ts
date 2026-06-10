/**
 * Backward-compatible entry point. The template system now lives under
 * `src/templates/` (a shared layout + a registry of template types). This file
 * re-exports the stable surface so existing imports keep working.
 */
export { escapeHtml, humanizeLabel, renderLayout } from "./templates/layout";
export { renderEmail, getTemplate } from "./templates/index";
