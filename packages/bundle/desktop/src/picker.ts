/**
 * Electron-backed native directory picker: the desktop profile's
 * `ctx.directoryPicker` service, serving the seam's `native` capability
 * through the Electron main process's OS chooser. The koffi child-process
 * backend of the CLI stays out of the Electron runtime (native-addon ABI
 * mismatch); Electron's own dialog is the desktop carrier's picker.
 * @module @deepseek-ai/dsh-desktop-app/picker
 */

import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'

/**
 * Open one OS directory chooser via Electron's dialog. The electron import is
 * lazy so the module loads under plain Node (boot smokes, gates) and only the
 * pick path requires the Electron main process.
 * @param signal - caller/connection lifetime; Electron cannot programmatically
 * close the OS chooser, so an aborted caller receives null while the dialog
 * remains open for the operator to dismiss.
 * @returns the chosen path, or null on cancel or abort.
 */
async function pickDesktopDirectory(signal: AbortSignal): Promise<string | null> {
  const { dialog } = await import('electron')
  const selection = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (signal.aborted) return null
  return selection.canceled ? null : selection.filePaths[0] ?? null
}

/** The `ctx.directoryPicker` implementation for the desktop profile (stable capability object per service life). */
export default class DesktopDirectoryPicker extends DirectoryPicker {
  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    pick: signal => pickDesktopDirectory(signal),
  }

  /**
   * The native interaction capability.
   * @returns the stable `native` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
