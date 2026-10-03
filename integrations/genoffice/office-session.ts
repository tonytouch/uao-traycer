// Which saved Office files were open, so a restart can reopen them. Untitled,
// temp-backed and scratch documents have no file the user chose, so they are
// never recorded.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

export interface OfficeSession {
  readonly documents: readonly string[];
  /** index into documents, or -1 */
  readonly active: number;
}

export interface SessionTab {
  readonly id: string;
  readonly filePath?: string;
}

const EMPTY: OfficeSession = { documents: [], active: -1 };
const MAX_DOCUMENTS = 50;

const inside = (dir: string, file: string) => {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

export function buildOfficeSession(
  order: readonly string[],
  tabs: ReadonlyMap<string, SessionTab>,
  activeId: string | undefined,
  excludedDirs: readonly string[],
): OfficeSession {
  const documents: string[] = [];
  let active = -1;
  for (const id of order) {
    const path = tabs.get(id)?.filePath;
    if (!path || !isAbsolute(path) || documents.includes(path)) continue;
    if (excludedDirs.some(dir => inside(dir, path))) continue;
    if (id === activeId) active = documents.length;
    documents.push(path);
  }
  return { documents: documents.slice(0, MAX_DOCUMENTS), active: active < MAX_DOCUMENTS ? active : -1 };
}

export function parseOfficeSession(raw: unknown): OfficeSession {
  if (typeof raw !== 'object' || raw === null || !('documents' in raw) || !Array.isArray(raw.documents)) return EMPTY;
  const documents = raw.documents
    .filter((path): path is string => typeof path === 'string' && isAbsolute(path))
    .slice(0, MAX_DOCUMENTS);
  const active = 'active' in raw && Number.isInteger(raw.active) &&
    (raw.active as number) >= 0 && (raw.active as number) < documents.length ? raw.active as number : -1;
  return { documents, active };
}

export function readOfficeSession(file: string): OfficeSession {
  try { return parseOfficeSession(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { return EMPTY; }
}

export function writeOfficeSession(file: string, session: OfficeSession): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(session));
  renameSync(temp, file);
}

/** Documents still on disk, with the active index remapped onto them. */
export function existingDocuments(session: OfficeSession): OfficeSession {
  const activePath = session.documents[session.active];
  const documents = session.documents.filter(path => existsSync(path));
  return { documents, active: activePath ? documents.indexOf(activePath) : -1 };
}
