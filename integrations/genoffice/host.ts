// UAO owns the window and navigation. GenOffice owns document engines, editor
// IPC, save/recovery behavior and the document-tab close guards.
import { app, dialog, ipcMain, Menu, webContents, type BrowserWindow, type Rectangle, type WebContents } from 'electron';
import { join, extname, basename } from 'node:path';
import { installRendererProtocol, contextMenuLabels, installContextMenu, configuredDefaultSaveDir } from './upstream/packages/electron-utils/src/index';
import { blankXlsxBuffer } from './upstream/packages/xlsx-gateway/src/gateway/csv-import';
import { setUiLang } from './upstream/packages/i18n/src/index';
import { TabManager } from './upstream/apps/shell/src/main/tab-manager';
import { blankPdfBuffer } from './upstream/apps/pdf/src/main/blank-pdf';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readAppSettings, writeAppSettings } from './upstream/apps/shell/src/main/app-settings';
import { normalizeAiPanelPrefs } from './upstream/packages/ui/src/ai-panel-prefs';
import { buildOfficeSession, existingDocuments, readOfficeSession, writeOfficeSession, type SessionTab } from './office-session';
import {
  configureDocsRuntime, registerAiIpc, registerProjectIpc, registerDocsIpc,
  buildDocsMenu, setDocsShellWindow, setDocsShellHooks, setDocsMenuGate,
  setDocsFileOpenedHook, setDocsFileSavedHook, createAiDocument,
} from './upstream/apps/docs/src/main/docs-main';
import {
  configureSheetsRuntime, installSheetsMenu, setSheetsShellWindow,
  setSheetsWorkbookOpenedHook, setSheetsCloseTabHook, stopSheetsSidecar,
  markSheetsUnsavedNew, markSheetsUntitledPath, sendSheetsMenuAction, hasActiveQueuedWorkbook,
} from './upstream/apps/sheets/src/main/sheets-main';
import {
  configureSlidesRuntime, installSlidesMenu, setSlidesShellWindow,
  setSlidesOpenedHook, setSlidesCloseTabHook, setSlidesShowBleed,
} from './upstream/apps/slides/src/main/slides-main';
import { configurePdfRuntime } from './upstream/apps/pdf/src/main/pdf-main';
import { configureMarkdownRuntime, setMarkdownFileSavedHook } from './upstream/apps/markdown/src/main/markdown-main';
import { configureHtmlRuntime, registerPrivilegedSchemes, setHtmlFileSavedHook, setHtmlProvisionalTitleHook, setHtmlPresentHooks } from './upstream/apps/html/src/main/html-main';

export function prepareOfficeRuntime(): void {
  registerPrivilegedSchemes();
}

export function createOfficeHost(window: BrowserWindow, resources: string) {
  const moduleRoot = join(resources, 'modules');
  const paths = (kind: string) => ({
    preloadPath: join(moduleRoot, kind, 'preload/index.js'),
    rendererFile: join(moduleRoot, kind, 'renderer/index.html'),
  });
  configureDocsRuntime(paths('docs'));
  configureSheetsRuntime({ ...paths('sheets'), sidecarPath: join(resources, 'native/xlsx-sidecar'),
    openGeneratedPath: openPath, createDocument: createAiDocument });
  configureSlidesRuntime({ preloadPath: paths('slides').preloadPath,
    rendererFilePath: paths('slides').rendererFile, openGeneratedPath: openPath });
  configurePdfRuntime({ ...paths('pdf'), openGeneratedPath: openPath, createDocument: createAiDocument });
  configureMarkdownRuntime({ ...paths('markdown'), openGeneratedPath: openPath });
  configureHtmlRuntime({ ...paths('html'), openGeneratedPath: openPath });
  installRendererProtocol(Object.fromEntries(['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']
    .map(kind => [kind, join(moduleRoot, kind, 'renderer')])));
  setUiLang('en');
  registerAiIpc(); registerProjectIpc(); registerDocsIpc();
  const settingsPath = join(app.getPath('userData'), 'app-settings.json');
  const prefs = () => {
    const saved = readAppSettings(settingsPath);
    return normalizeAiPanelPrefs({ side: saved.aiPanelSide, fontSize: saved.aiPanelFontSize,
      customFontSize: saved.aiPanelCustomFontSize, spellcheck: saved.aiPanelSpellcheck });
  };
  ipcMain.handle('app:get-theme', () => readAppSettings(settingsPath).theme ?? 'dark');
  ipcMain.handle('app:get-auto-save-default', () => {
    const saved = readAppSettings(settingsPath);
    return { on: saved.autoSaveDefault === true, updatedAt: saved.autoSaveDefaultUpdatedAt ?? 0 };
  });
  ipcMain.handle('app:get-ai-panel-prefs', prefs);
  ipcMain.handle('app:set-ai-panel-prefs', (_event, patch: unknown) => {
    const raw = patch && typeof patch === 'object' ? patch : {};
    const next = normalizeAiPanelPrefs({ ...prefs(), ...raw });
    writeAppSettings(settingsPath, { aiPanelSide: next.side, aiPanelFontSize: next.fontSize,
      aiPanelCustomFontSize: next.customFontSize, aiPanelSpellcheck: next.spellcheck });
    for (const wc of webContents.getAllWebContents()) wc.send('app:ai-panel-prefs-changed', next);
    return next;
  });
  installContextMenu(app, () => contextMenuLabels('en'));
  let viewport: Rectangle | null = null;
  // Reopen last session's saved documents the first time Office is shown.
  const sessionPath = join(app.getPath('userData'), 'office-session.json');
  const scratchDir = join(app.getPath('userData'), 'office-scratch');
  const newSheetDir = join(app.getPath('temp'), 'genoffice-new');
  const knownTabs = new Map<string, SessionTab>();
  let sessionRestored = false;
  // While closing for quit, tabs close one by one; keep recording the pre-quit
  // set so a restart reopens it, including files first saved by the close prompt.
  let quitting: { order: string[]; activeId?: string } | null = null;
  const manager = new TabManager(window, changed, kind => {
    if (!viewport) return;
    if (kind === 'docs') buildDocsMenu();
    else if (kind === 'sheets') installSheetsMenu();
    else if (kind === 'slides') installSlidesMenu();
    else Menu.setApplicationMenu(null);
  }, kind => `Untitled ${kind}`) as TabManager & { setViewport(bounds: Rectangle | null): void };
  manager.setViewport(null);
  setDocsShellWindow(window); setSheetsShellWindow(window); setSlidesShellWindow(window);
  setSlidesShowBleed((wc, on) => manager.setContentBleed(wc, on));
  setHtmlPresentHooks({ hostWindow: () => window,
    setBleed: (wc, on) => manager.setContentBleed(wc, on),
    openTab: (owner, title) => { manager.openHtmlPresentTab(owner, title); return true; },
    closeTab: wc => {
      const id = manager.tabIdForWebContents(wc.id);
      if (id) void manager.closeTab(id);
      return Boolean(id);
    },
  });
  setDocsMenuGate(() => Boolean(viewport) && manager.list().some(tab => tab.active && tab.kind === 'docs'));
  setDocsShellHooks({
    openTab: (path, options) => manager.openDocsTab(path, options),
    openAiDocTab: content => manager.openDocsTab(undefined, { newBlank: true, aiContent: content }),
    listTabs: () => manager.list().filter(tab => tab.kind === 'docs')
      .map(tab => ({ id: tab.id, title: tab.title, focused: tab.active })),
    focusTab: id => manager.activateTab(id), closeActiveTab: () => manager.closeActiveTab(),
    openGeneratedPath: openPath,
  });
  setDocsFileOpenedHook((id, path) => manager.setTabFileFor(id, path));
  setDocsFileSavedHook((wc, path) => manager.setTabFileFor(wc.id, path));
  const saved = (wc: WebContents, path: string) => manager.setTabFileFor(wc.id, path);
  setSheetsWorkbookOpenedHook(saved); setSlidesOpenedHook(saved);
  setMarkdownFileSavedHook(saved); setHtmlFileSavedHook(saved);
  setHtmlProvisionalTitleHook((wc, title) => manager.setTabTitleFor(wc.id, title));
  setSheetsCloseTabHook(() => manager.closeActiveTab());
  setSlidesCloseTabHook(() => manager.closeActiveTab());
  app.once('will-quit', () => stopSheetsSidecar());

  function changed() {
    if (!window.isDestroyed()) window.webContents.send('uao-office:changed');
    persistSession();
  }
  function persistSession() {
    const tabs = manager.list();
    if (!quitting) knownTabs.clear();
    for (const tab of tabs) knownTabs.set(tab.id, { id: tab.id, filePath: tab.filePath });
    if (!sessionRestored) return;
    const order = quitting?.order ?? tabs.map(tab => tab.id);
    const activeId = quitting ? quitting.activeId : tabs.find(tab => tab.active)?.id;
    try {
      writeOfficeSession(sessionPath, buildOfficeSession(order, knownTabs, activeId,
        [newSheetDir, scratchDir]));
    } catch (error) {
      console.warn('[uao-office] could not record open documents', error);
    }
  }
  function restoreSession() {
    if (sessionRestored) return;
    const session = existingDocuments(readOfficeSession(sessionPath));
    const opened: (string | undefined)[] = [];
    for (const path of session.documents) {
      try { openPath(path); }
      catch (error) { console.warn('[uao-office] could not reopen', path, error); }
      opened.push(manager.list().find(tab => tab.filePath === path)?.id);
    }
    const activeId = opened[session.active];
    if (activeId) manager.activateTab(activeId);
    sessionRestored = true;
    persistSession();
  }
  // GenOffice's in-memory blank grid cannot be saved. Like its own shell, back a
  // new sheet with a temp workbook whose first Save goes through Save As.
  async function newSheetTab() {
    const saveDir = configuredDefaultSaveDir(app);
    let suggested = join(saveDir, 'Untitled.xlsx');
    for (let n = 2; existsSync(suggested); n++) suggested = join(saveDir, `Untitled-${n}.xlsx`);
    const tempDir = join(newSheetDir, randomUUID());
    mkdirSync(tempDir, { recursive: true });
    const backing = join(tempDir, basename(suggested));
    writeFileSync(backing, await blankXlsxBuffer());
    markSheetsUnsavedNew(backing, suggested, tempDir);
    markSheetsUntitledPath(backing);
    manager.openSheetsTab(backing);
    // The renderer may mount after a single 'open' nudge; repeat until consumed.
    const startedAt = Date.now();
    sendSheetsMenuAction('open');
    const nudge = setInterval(() => {
      if (!hasActiveQueuedWorkbook() || Date.now() - startedAt > 30_000) clearInterval(nudge);
      else sendSheetsMenuAction('open');
    }, 700);
  }
  function openPath(path: string) {
    if (!existsSync(path)) throw new Error('The document no longer exists.');
    const existing = manager.list().find(tab => tab.filePath === path);
    if (existing) { manager.activateTab(existing.id); return; }
    switch (extname(path).toLowerCase()) {
      case '.docx': manager.openDocsTab(path); break;
      case '.xlsx': case '.xlsm': case '.xls': case '.csv': case '.tsv': manager.openSheetsTab(path); break;
      case '.pptx': manager.openSlidesTab(path); break;
      case '.pdf': manager.openPdfTab(path); break;
      case '.md': case '.markdown': manager.openMarkdownTab(path); break;
      case '.html': case '.htm': manager.openHtmlTab(path); break;
      default: throw new Error('Choose a Word, Excel, PowerPoint, PDF, Markdown or HTML file.');
    }
  }
  return {
    list: () => manager.list(),
    async browse() {
      const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Office documents', extensions: ['docx', 'xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'pptx', 'pdf', 'md', 'markdown', 'html', 'htm'] }] });
      if (!result.canceled) result.filePaths.forEach(openPath);
    },
    async create(kind: string) {
      switch (kind) {
        case 'docs': manager.openDocsTab(undefined, { newBlank: true }); break;
        case 'sheets': await newSheetTab(); break;
        case 'slides': manager.openSlidesTab(); break;
        case 'markdown': manager.openMarkdownTab(); break;
        case 'html': manager.openHtmlTab(); break;
        case 'pdf': {
          mkdirSync(scratchDir, { recursive: true });
          const file = join(scratchDir, `Untitled-${randomUUID()}.pdf`);
          writeFileSync(file, await blankPdfBuffer());
          manager.openPdfTab(file); break;
        }
        default: throw new Error('Unknown office document type.');
      }
    },
    openPath,
    activate: (id: string) => manager.activateTab(id),
    close: (id: string) => manager.closeTab(id),
    setViewport(bounds: Rectangle | null) {
      viewport = bounds; manager.setViewport(bounds);
      if (bounds) {
        restoreSession();
        manager.refreshActiveTargets();
      } else Menu.setApplicationMenu(null);
    },
    async closeAll() {
      const tabs = manager.list();
      quitting = { order: tabs.map(tab => tab.id), activeId: tabs.find(tab => tab.active)?.id };
      for (const tab of tabs.filter(tab => tab.closable)) {
        await manager.closeTab(tab.id);
        if (manager.list().some(current => current.id === tab.id)) {
          // Quit canceled: the remaining tabs are the session again.
          quitting = null;
          persistSession();
          return false;
        }
      }
      return true;
    },
  };
}
