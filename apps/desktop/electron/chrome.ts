/** Desktop window-chrome geometry and AppFrame title-row styling. */

/** Shared geometry for the native controls overlay and its renderer layout. */
export const DESKTOP_TITLE_BAR = Object.freeze({
  height: 30,
  controlsWidth: 138,
  overlayColor: '#00000000',
})

/**
 * Build the desktop AppFrame rows. The sidebar spans the full viewport while
 * the conversation and details columns retain the native-control inset.
 * @returns CSS for desktop title-row composition.
 */
export function desktopTitleBarStyle(): string {
  return [
    '#root {',
    '  height: 100% !important;',
    '  margin-top: 0 !important;',
    '}',
    '[data-shell-frame] {',
    `  grid-template-rows: ${DESKTOP_TITLE_BAR.height}px minmax(0, 1fr) !important;`,
    '  background: linear-gradient(',
    `    to bottom, var(--dsw-specific-sidebar-fill, rgb(27, 27, 28)) 0 ${DESKTOP_TITLE_BAR.height}px,`,
    `    var(--dsw-alias-bg-base) ${DESKTOP_TITLE_BAR.height}px 100%`,
    '  );',
    '}',
    '[data-shell-sidebar] {',
    '  grid-column: 1;',
    '  grid-row: 1 / 3;',
    '}',
    '[data-shell-center] {',
    '  grid-column: 2;',
    '  grid-row: 2;',
    '}',
    '[data-shell-details] {',
    '  grid-column: 3;',
    '  grid-row: 2;',
    '}',
    '[data-shell-title-drag] {',
    '  display: block;',
    '  min-width: 0;',
    '  grid-column: 2 / 4;',
    '  grid-row: 1;',
    `  margin-right: ${DESKTOP_TITLE_BAR.controlsWidth}px;`,
    '  -webkit-app-region: drag;',
    '}',
    '[data-desktop-window-drag] {',
    '  position: fixed;',
    '  top: 0;',
    `  right: ${DESKTOP_TITLE_BAR.controlsWidth}px;`,
    '  left: 0;',
    `  height: ${DESKTOP_TITLE_BAR.height}px;`,
    '  z-index: 2147483647;',
    '  app-region: drag;',
    '  -webkit-app-region: drag;',
    '  user-select: none;',
    '}',
    "[data-shell-frame] > [data-side='details'] {",
    `  top: ${DESKTOP_TITLE_BAR.height}px;`,
    '}',
  ].join('\n')
}
