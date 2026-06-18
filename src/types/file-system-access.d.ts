/**
 * File System Access API — `showSaveFilePicker`.
 *
 * TypeScript's DOM lib ships `FileSystemFileHandle` and `FileSystemWritableFileStream`
 * but NOT the `window.showSaveFilePicker()` entry point, so we declare the minimal
 * surface we use here (streaming a received file straight to disk on Chromium). The
 * Blob fallback path needs no extra typings.
 */
interface SaveFilePickerOptions {
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

interface Window {
  showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
