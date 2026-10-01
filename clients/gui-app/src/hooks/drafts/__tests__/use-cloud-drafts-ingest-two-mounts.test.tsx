import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_DIALECT } from "@traycer/protocol/persistence/draft/version";
import type { CloudDraftReadOutcome } from "@/lib/drafts/cloud-draft-reader";
import {
  cloudDraftHeadReading,
  cloudDraftHeadSettled,
  cloudDraftIngestSeq,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { resetLandingDraftRetirementsForTests } from "@/lib/drafts/landing-draft-retirement";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

// The real coordinator, the real hook, the real landing store. Only the read
// side is faked: the directory the hook walks, the host read port, and the
// head read itself, whose promise each test settles by hand.
const directoryMock = vi.hoisted(() => ({
  chats: [] as ReadonlyArray<CloudChatSummary>,
}));
const readMock = vi.hoisted(() => ({
  pending: [] as Array<{
    chatId: string;
    resolve: (outcome: CloudDraftReadOutcome) => void;
  }>,
}));

vi.mock("@/hooks/drafts/use-cloud-drafts-directory", () => ({
  useCloudDraftsDirectory: () => ({
    visible: true,
    settled: true,
    scopeId: "scp_1",
    chats: directoryMock.chats,
    snapshotIngestSeq: (): number => 0,
  }),
}));
vi.mock("@/lib/chats/cloud-chat-read-port", () => ({
  createHostCloudChatReadPort: () => ({}),
}));
vi.mock("@/lib/drafts/cloud-draft-reader", () => ({
  readCloudDraft: (options: {
    identity: { chatId: string };
  }): Promise<CloudDraftReadOutcome> =>
    new Promise((resolve) => {
      readMock.pending.push({ chatId: options.identity.chatId, resolve });
    }),
}));

const { useCloudDraftsIngest } =
  await import("@/hooks/drafts/use-cloud-drafts-ingest");

const HOST_ID = "host-a";
const OWNER_HOST_ID = "host-b";
const HEAD_SHA = "a".repeat(64);

const HEAD: DraftHeadReaderRecord = {
  dialect: DRAFT_HEAD_DIALECT,
  schemaVersion: { major: 1, minor: 0 },
  kind: "draft",
  surfaceKind: "landing",
  lastTouchedAt: 1,
  target: { epicId: null, chatId: null, blockId: null },
  hostLocal: { hostId: OWNER_HOST_ID, workspace: null },
  portable: {
    content: { type: "doc", content: [{ type: "paragraph" }] },
    selection: null,
    runSettings: null,
    composerMode: "chat",
    blobHashes: [],
    closed: false,
  },
};

// The hook only needs a non-null client: the read port and the reader are
// mocked above.
const CLIENT = { request: () => Promise.reject(new Error("unused")) };

function row(chatId: string): CloudChatSummary {
  return {
    identity: { taskId: "scp_1", chatId, ownerUserId: "user-1" },
    ownerHostId: OWNER_HOST_ID,
    createdAt: 1,
    visibility: "private",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: HEAD_SHA,
    publishedAt: 1,
    throughRecordSeq: 1,
    isOwnedByViewer: true,
  };
}

function mount(): { unmount: () => void } {
  return renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
}

function landingIds(): readonly string[] {
  return useLandingDraftStore
    .getState()
    .drafts.map((draft) => draft.id)
    .toSorted();
}

function resolveAll(outcome: CloudDraftReadOutcome): void {
  for (const pending of readMock.pending) pending.resolve(outcome);
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  // Unmount first: teardown releases the claims it still holds.
  cleanup();
  readMock.pending.length = 0;
  directoryMock.chats = [];
  resetDraftMirrorCoordinatorForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  resetLandingDraftRetirementsForTests();
});

describe("useCloudDraftsIngest across mounts, on the real coordinator", () => {
  it("reads each head once for two simultaneous mounts, installs the mirrors, and reads nothing for a mount rendered afterwards", async () => {
    directoryMock.chats = [row("draft-1"), row("draft-2"), row("draft-3")];

    mount();
    mount();

    await vi.waitFor(() => {
      expect(readMock.pending).toHaveLength(3);
    });
    // The second mount found every head claimed and read none of them.
    await nextTick();
    expect(readMock.pending.map((read) => read.chatId).toSorted()).toEqual([
      "draft-1",
      "draft-2",
      "draft-3",
    ]);
    for (const chat of directoryMock.chats) {
      expect(cloudDraftHeadReading(chat)).toBe(true);
    }

    resolveAll({ kind: "ok", record: HEAD });
    await vi.waitFor(() => {
      expect(landingIds()).toEqual(["draft-1", "draft-2", "draft-3"]);
    });
    for (const chat of directoryMock.chats) {
      expect(cloudDraftHeadSettled(chat)).toBe(true);
      expect(cloudDraftHeadReading(chat)).toBe(false);
    }

    // A third mount, after the mirrors are installed: the coordinator's
    // settled record answers, and the per-mount set it starts with is empty.
    mount();
    await nextTick();
    expect(readMock.pending).toHaveLength(3);
  });

  it("settles heads that answer a terminal refusal, so a later mount reads nothing", async () => {
    directoryMock.chats = [row("draft-1"), row("draft-2"), row("draft-3")];

    mount();
    mount();
    await vi.waitFor(() => {
      expect(readMock.pending).toHaveLength(3);
    });

    resolveAll({ kind: "unpublished" });
    await vi.waitFor(() => {
      for (const chat of directoryMock.chats) {
        expect(cloudDraftHeadReading(chat)).toBe(false);
        expect(cloudDraftHeadSettled(chat)).toBe(true);
      }
    });
    expect(landingIds()).toEqual([]);

    mount();
    await nextTick();
    expect(readMock.pending).toHaveLength(3);
  });

  it("fences a head another mount is reading, and releases the claim only when the reading mount unmounts", async () => {
    const pendingRow = row("draft-4");
    directoryMock.chats = [pendingRow];

    const reader = mount();
    await vi.waitFor(() => {
      expect(readMock.pending).toHaveLength(1);
    });
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);

    // A second mount skips the claimed head but still reserves its ingest
    // fence: the sequence moves, and no second read is issued.
    const fenceBefore = cloudDraftIngestSeq();
    const bystander = mount();
    await nextTick();
    expect(cloudDraftIngestSeq()).toBeGreaterThan(fenceBefore);
    expect(readMock.pending).toHaveLength(1);

    // The bystander never owned the claim, so it does not release it.
    bystander.unmount();
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);

    reader.unmount();
    expect(cloudDraftHeadReading(pendingRow)).toBe(false);
    expect(cloudDraftHeadSettled(pendingRow)).toBe(false);

    // A read that lands after its mount went away installs nothing.
    resolveAll({ kind: "ok", record: HEAD });
    await nextTick();
    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(pendingRow)).toBe(false);

    // The released head is read again by the next mount.
    mount();
    await vi.waitFor(() => {
      expect(readMock.pending).toHaveLength(2);
    });
  });
});
