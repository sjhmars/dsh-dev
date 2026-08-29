import { describe, expect, it } from 'vitest'
import { DESKTOP_TITLE_BAR, desktopTitleBarStyle } from '../electron/chrome.ts'

describe('desktop window chrome', () => {
  it('uses the compact Windows control-row geometry', () => {
    expect(DESKTOP_TITLE_BAR).toEqual({ height: 30, controlsWidth: 138, overlayColor: '#00000000' })
  })

  it('lets the sidebar span the title row while content keeps its inset', () => {
    const css = desktopTitleBarStyle()
    expect(css).toContain('grid-template-rows: 30px minmax(0, 1fr) !important')
    expect(css).toContain('grid-row: 1 / 3')
    expect(css).toContain('grid-column: 2 / 4')
    expect(css).toContain('margin-right: 138px')
    expect(css).toContain('var(--dsw-specific-sidebar-fill, rgb(27, 27, 28)) 0 30px')
    expect(css).toContain('[data-desktop-window-drag]')
    expect(css).toContain('right: 138px')
    expect(css).toContain('height: 30px')
    expect(css).toContain('app-region: drag')
  })
})
