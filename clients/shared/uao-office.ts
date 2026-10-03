export const OFFICE_KINDS = ["docs", "sheets", "slides", "pdf", "markdown", "html"] as const;
export type OfficeKind = typeof OFFICE_KINDS[number];
export interface OfficeTab {
  readonly id: string;
  readonly kind: OfficeKind | "home";
  readonly title: string;
  readonly active: boolean;
  readonly closable: boolean;
  readonly filePath?: string;
}
export interface OfficeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface UaoOfficeApi {
  readonly list: () => Promise<readonly OfficeTab[]>;
  readonly create: (kind: OfficeKind) => Promise<void>;
  readonly browse: () => Promise<void>;
  readonly activate: (id: string) => Promise<void>;
  readonly close: (id: string) => Promise<void>;
  readonly setViewport: (bounds: OfficeBounds | null) => void;
  readonly onChanged: (handler: () => void) => () => void;
}
export function isOfficeKind(value: unknown): value is OfficeKind {
  return OFFICE_KINDS.some(kind => kind === value);
}
export function parseOfficeTabs(value: unknown): readonly OfficeTab[] {
  if (!Array.isArray(value)) throw new Error("Invalid office document list.");
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null ||
      !("id" in item) || typeof item.id !== "string" ||
      !("title" in item) || typeof item.title !== "string" ||
      !("kind" in item) || (item.kind !== "home" && !isOfficeKind(item.kind)) ||
      !("active" in item) || typeof item.active !== "boolean" ||
      !("closable" in item) || typeof item.closable !== "boolean") {
      throw new Error("Invalid office document.");
    }
    return { id: item.id, title: item.title, kind: item.kind,
      active: item.active, closable: item.closable,
      ...("filePath" in item && typeof item.filePath === "string" ? { filePath: item.filePath } : {}) };
  });
}
