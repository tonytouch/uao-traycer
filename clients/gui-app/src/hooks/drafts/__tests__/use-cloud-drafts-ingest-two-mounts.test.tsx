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
import { appLogger } from "@/lib/logger";
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
    // The host client the read went out on: each mount's port wraps its own,
    // so a test can say WHICH mount issued a read.
    client: object;
    resolve: (outcome: CloudDraftReadOutcome) => void;
    reject: (error: Error) => void;
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
  createHostCloudChatReadPort: (client: object): { client: object } => ({
    client,
  }),
}));
vi.mock("@/lib/drafts/cloud-draft-reader", () => ({
  readCloudDraft: (options: {
    identity: { chatId: string };
    port: { client: object };
  }): Promise<CloudDraftReadOutcome> =>
    new Promise((resolve, reject) => {
      readMock.pending.push({
        chatId: options.identity.chatId,
        client: options.port.client,
        resolve,
        reject,
      });
    }),
}));

const { useCloudDraftsIngest } =
  await import("@/hooks/drafts/use-cloud-drafts-ingest");

const HOST_ID = "host-a";
const SECOND_HOST_ID = "host-c";
const OWNER_HOST_ID = "host-b";
const HEAD_SHA = "a".repeat(64);
// Mirrors the retry constants in use-cloud-drafts-ingest.ts, which are not
// exported: keep in sync if the production values change.
const HEAD_READ_RETRY_BASE_MS = 2_000;

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
// A second mount bound to another host reads through its own client.
const SECOND_CLIENT = { request: () => Promise.reject(new Error("unused")) };

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

/** A mount bound to another host than `mount()`'s, with its own client. */
function mountOnSecondHost(): { unmount: () => void } {
  return renderHook(() =>
    useCloudDraftsIngest(SECOND_CLIENT as never, SECOND_HOST_ID),
  );
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

/** The reads issued for one draft so far, in the order they were issued. */
function readsFor(
  chatId: string,
): readonly (typeof readMock.pending)[number][] {
  return readMock.pending.filter((read) => read.chatId === chatId);
}

/** The reads one mount's client issued for one draft so far. */
function readsOn(
  client: object,
  chatId: string,
): readonly (typeof readMock.pending)[number][] {
  return readMock.pending.filter(
    (read) => read.client === client && read.chatId === chatId,
  );
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  // Unmount first: teardown releases the claims it still holds.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("fences a head another mount is reading, and abandons the claim when the reading mount unmounts with nobody left to wake", async () => {
    const pendingRow = row("draft-4");
    directoryMock.chats = [pendingRow];

    const reader = mount();
    await vi.waitFor(() => {
      expect(readMock.pending).toHaveLength(1);
    });
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);

    // A second mount skips the claimed head but still reserves its SWEEP
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
    // Nobody was listening, so nothing read it in the meantime.
    expect(readMock.pending).toHaveLength(1);

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

  it("hands a head to the surviving mount when the mount reading it unmounts: one read from it, its claim standing, and the abandoned read installing nothing", async () => {
    const pendingRow = row("draft-5");
    directoryMock.chats = [pendingRow];

    const reader = mount();
    await vi.waitFor(() => {
      expect(readsFor("draft-5")).toHaveLength(1);
    });
    const abandonedRead = readsFor("draft-5")[0];
    mount();
    await nextTick();
    // The second mount skipped the head the first one holds.
    expect(readsFor("draft-5")).toHaveLength(1);
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);

    reader.unmount();

    // The survivor read it at once, not at its next directory delivery: two
    // reads over the head's lifetime, and the claim is the survivor's.
    expect(readsFor("draft-5")).toHaveLength(2);
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);
    await nextTick();
    expect(readsFor("draft-5")).toHaveLength(2);

    // The abandoned continuation resolves with a good head: it installs
    // nothing and does not disturb the survivor's claim.
    abandonedRead.resolve({ kind: "ok", record: HEAD });
    await nextTick();
    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);
    expect(cloudDraftHeadSettled(pendingRow)).toBe(true);

    // The survivor's own read decides the head.
    readsFor("draft-5")[1].resolve({ kind: "ok", record: HEAD });
    await vi.waitFor(() => {
      expect(landingIds()).toEqual(["draft-5"]);
    });
    expect(cloudDraftHeadReading(pendingRow)).toBe(false);
    expect(cloudDraftHeadSettled(pendingRow)).toBe(true);
    expect(readsFor("draft-5")).toHaveLength(2);
  });

  it("wakes every surviving mount that skipped the head but only one of them reads it", async () => {
    const pendingRow = row("draft-6");
    directoryMock.chats = [pendingRow];

    const reader = mount();
    await vi.waitFor(() => {
      expect(readsFor("draft-6")).toHaveLength(1);
    });
    mount();
    mount();
    await nextTick();
    expect(readsFor("draft-6")).toHaveLength(1);

    reader.unmount();

    // The first survivor claims the head; the second asks the guard again and
    // finds it held.
    expect(readsFor("draft-6")).toHaveLength(2);
    await nextTick();
    expect(readsFor("draft-6")).toHaveLength(2);
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);
  });

  it("does not wake a surviving mount for a head the reading mount decided before it unmounted", async () => {
    const decidedRow = row("draft-7");
    directoryMock.chats = [decidedRow];

    const reader = mount();
    await vi.waitFor(() => {
      expect(readsFor("draft-7")).toHaveLength(1);
    });
    mount();
    await nextTick();
    readsFor("draft-7")[0].resolve({ kind: "unpublished" });
    await vi.waitFor(() => {
      expect(cloudDraftHeadSettled(decidedRow)).toBe(true);
    });

    reader.unmount();
    await nextTick();

    expect(readsFor("draft-7")).toHaveLength(1);
    expect(cloudDraftHeadSettled(decidedRow)).toBe(true);
  });

  it("hands a head to the surviving mount, bound to another host, when the reading mount gives up after every attempt: one read from the survivor through its own client, none more from the exhausted mount", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    const failingRow = row("draft-8");
    directoryMock.chats = [failingRow];

    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(readsOn(CLIENT, "draft-8")).toHaveLength(1);
    mountOnSecondHost();
    await vi.advanceTimersByTimeAsync(0);
    // The second mount skipped the head, and is still mounted throughout.
    expect(readsFor("draft-8")).toHaveLength(1);
    expect(readsOn(SECOND_CLIENT, "draft-8")).toHaveLength(0);

    // Attempt 0 fails; the retry is the reading mount's, at 2 s.
    readsFor("draft-8")[0].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);
    expect(readsOn(CLIENT, "draft-8")).toHaveLength(2);
    expect(readsOn(SECOND_CLIENT, "draft-8")).toHaveLength(0);
    expect(cloudDraftHeadReading(failingRow)).toBe(true);

    // Attempt 1 fails; the retry is at 4 s.
    readsFor("draft-8")[1].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);
    expect(readsOn(CLIENT, "draft-8")).toHaveLength(3);
    expect(readsOn(SECOND_CLIENT, "draft-8")).toHaveLength(0);

    // Attempt 2 is the last: the mount gives up and abandons the claim, which
    // wakes the second mount. It reads the head now, through its own pipe; the
    // exhausted mount ignores its own wake and starts no fourth read.
    readsOn(CLIENT, "draft-8")[2].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(readsOn(SECOND_CLIENT, "draft-8")).toHaveLength(1);
    expect(readsOn(CLIENT, "draft-8")).toHaveLength(3);
    expect(cloudDraftHeadReading(failingRow)).toBe(true);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readsOn(SECOND_CLIENT, "draft-8")).toHaveLength(1);
    expect(readsOn(CLIENT, "draft-8")).toHaveLength(3);

    // The survivor's read decides the head.
    readsOn(SECOND_CLIENT, "draft-8")[0].resolve({ kind: "ok", record: HEAD });
    await vi.advanceTimersByTimeAsync(0);
    expect(landingIds()).toEqual(["draft-8"]);
    expect(cloudDraftHeadReading(failingRow)).toBe(false);
    expect(cloudDraftHeadSettled(failingRow)).toBe(true);
    expect(readsFor("draft-8")).toHaveLength(4);
  });

  it("gives the head back to nobody when the only mount gives up after every attempt: released, not settled, and a later mount asks again", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    const failingRow = row("draft-9");
    directoryMock.chats = [failingRow];

    mount();
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      readsFor("draft-9")[attempt].reject(new Error("read failed"));
      await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2 ** attempt);
    }
    expect(readsFor("draft-9")).toHaveLength(3);

    readsFor("draft-9")[2].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(cloudDraftHeadReading(failingRow)).toBe(false);
    expect(cloudDraftHeadSettled(failingRow)).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Nobody else was listening, and the exhausted mount ignored its own wake.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readsFor("draft-9")).toHaveLength(3);

    // Released, not settled: a later mount asks again.
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(readsFor("draft-9")).toHaveLength(4);
  });
});
