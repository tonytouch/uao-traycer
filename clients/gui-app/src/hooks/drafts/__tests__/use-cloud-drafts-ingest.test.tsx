import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_DIALECT } from "@traycer/protocol/persistence/draft/version";
import { appLogger } from "@/lib/logger";

const directoryMock = vi.hoisted(() => ({
  chats: [] as ReadonlyArray<CloudChatSummary>,
  settled: true,
  snapshotSeq: 0,
}));
const readMock = vi.hoisted(() => ({
  read: vi.fn<() => Promise<{ kind: string; record: unknown }>>(),
}));
const reserveMock = vi.hoisted(() => ({
  reserve: vi.fn<(draftId: string) => void>(),
}));
const ingestMock = vi.hoisted(() => ({
  ingest:
    vi.fn<
      (args: {
        hostId: string;
        summary: CloudChatSummary;
        document: unknown;
      }) => Promise<void>
    >(),
}));
const sweepMock = vi.hoisted(() => ({
  sweep:
    vi.fn<
      (
        hostId: string,
        listed: ReadonlyMap<string, ReadonlySet<string>>,
        fenceSeq: number,
      ) => readonly string[]
    >(),
}));
// No mirrors dropped unless a test overrides this.
sweepMock.sweep.mockReturnValue([]);
const flushMock = vi.hoisted(() => ({
  flush:
    vi.fn<
      (
        listed: ReadonlyMap<string, ReadonlySet<string>>,
        fenceSeq: number,
        alreadyFlushed: ReadonlySet<string>,
      ) => readonly string[]
    >(),
}));
flushMock.flush.mockReturnValue([]);
// The coordinator's process-wide "settled" record. Nothing settled unless a
// test says so; keyed exactly as production keys it.
const settledMock = vi.hoisted(() => ({
  settled: vi.fn<(summary: CloudChatSummary) => boolean>(),
}));
settledMock.settled.mockReturnValue(false);
// The coordinator's claim on a head: begun before a read, released when the
// read ends without a decision (out of attempts, an ambiguous identity),
// abandoned when the mount holding it is torn down with the read undecided,
// settled when it answers a terminal refusal.
const claimMock = vi.hoisted(() => ({
  begin: vi.fn<(summary: CloudChatSummary) => void>(),
  release: vi.fn<(summary: CloudChatSummary) => void>(),
  abandon: vi.fn<(summary: CloudChatSummary) => void>(),
  settleWithoutApply: vi.fn<(summary: CloudChatSummary) => void>(),
}));
// A skipped head's host is registered as an image source for it.
const noteHostMock = vi.hoisted(() => ({
  note: vi.fn<(summary: CloudChatSummary, hostId: string) => void>(),
}));
// The abandon subscription: the hook's listener is captured so a test can
// deliver an abandon to it, and every subscribe hands back one shared
// unsubscribe spy.
const abandonSubscriptionMock = vi.hoisted(() => ({
  subscribe:
    vi.fn<(listener: (summary: CloudChatSummary) => void) => () => void>(),
  unsubscribe: vi.fn<() => void>(),
  listener: null as ((summary: CloudChatSummary) => void) | null,
}));
function installAbandonSubscription(): void {
  abandonSubscriptionMock.listener = null;
  abandonSubscriptionMock.subscribe.mockImplementation((listener) => {
    abandonSubscriptionMock.listener = listener;
    return abandonSubscriptionMock.unsubscribe;
  });
}
installAbandonSubscription();

vi.mock("@/hooks/drafts/use-cloud-drafts-directory", () => ({
  useCloudDraftsDirectory: () => ({
    visible: true,
    settled: directoryMock.settled,
    scopeId: "scp_1",
    chats: directoryMock.chats,
    snapshotIngestSeq: (): number => directoryMock.snapshotSeq,
  }),
}));
vi.mock("@/lib/chats/cloud-chat-read-port", () => ({
  createHostCloudChatReadPort: () => ({}),
}));
vi.mock("@/lib/drafts/cloud-draft-reader", () => ({
  readCloudDraft: (): Promise<{ kind: string; record: unknown }> =>
    readMock.read(),
}));
vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  cloudDraftHeadKey: (summary: CloudChatSummary): string =>
    `${summary.ownerHostId}:${summary.identity.taskId}:${summary.identity.ownerUserId}:${summary.identity.chatId}:${summary.headSha256}`,
  cloudDraftHeadSettled: (summary: CloudChatSummary): boolean =>
    settledMock.settled(summary),
  beginCloudDraftHeadRead: (summary: CloudChatSummary): void =>
    claimMock.begin(summary),
  releaseCloudDraftHeadRead: (summary: CloudChatSummary): void =>
    claimMock.release(summary),
  abandonCloudDraftHeadRead: (summary: CloudChatSummary): void =>
    claimMock.abandon(summary),
  noteCloudDraftHeadHost: (summary: CloudChatSummary, hostId: string): void =>
    noteHostMock.note(summary, hostId),
  subscribeCloudDraftHeadAbandoned: (
    listener: (summary: CloudChatSummary) => void,
  ): (() => void) => abandonSubscriptionMock.subscribe(listener),
  settleCloudDraftHeadWithoutApply: (summary: CloudChatSummary): void =>
    claimMock.settleWithoutApply(summary),
  reserveCloudDraftIngestFence: (draftId: string): void =>
    reserveMock.reserve(draftId),
  ingestCloudDraftSummary: (args: {
    hostId: string;
    summary: CloudChatSummary;
    document: unknown;
  }): Promise<void> => ingestMock.ingest(args),
  sweepAbsentCloudDraftMirrors: (
    hostId: string,
    listed: ReadonlyMap<string, ReadonlySet<string>>,
    fenceSeq: number,
  ): readonly string[] => sweepMock.sweep(hostId, listed, fenceSeq),
  flushAbsentOwnCloudDrafts: (
    listed: ReadonlyMap<string, ReadonlySet<string>>,
    fenceSeq: number,
    alreadyFlushed: ReadonlySet<string>,
    // Snapshotted: the hook mutates the set after the call, and the tests
    // read what was excluded AT the call.
  ): readonly string[] =>
    flushMock.flush(listed, fenceSeq, new Set(alreadyFlushed)),
}));

const { useCloudDraftsIngest } =
  await import("@/hooks/drafts/use-cloud-drafts-ingest");

const HOST_ID = "host-a";
const OWNER_HOST_ID = "host-b";
const DIGEST_ONE = "a".repeat(64);
const DIGEST_TWO = "b".repeat(64);
// Mirrors the retry constants in use-cloud-drafts-ingest.ts. They are not
// exported, so these tests restate them - keep them in sync if the
// production values change.
const MAX_HEAD_READ_ATTEMPTS = 3;
const HEAD_READ_RETRY_BASE_MS = 2_000;

function summary(
  headSha256: string | null,
  overrides: Partial<CloudChatSummary> | null,
): CloudChatSummary {
  return {
    identity: {
      taskId: "scp_1",
      chatId: "draft-1",
      ownerUserId: "user-1",
    },
    ownerHostId: OWNER_HOST_ID,
    createdAt: 1,
    visibility: "private",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256,
    publishedAt: 1,
    throughRecordSeq: 1,
    isOwnedByViewer: true,
    ...overrides,
  };
}

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

// The hook only needs the client to be non-null; every call it would make
// goes through the mocked reader and coordinator.
const CLIENT = { request: () => Promise.reject(new Error("unused")) };

/** Delivers an abandon to the listener the mounted hook registered. */
function deliverAbandon(abandoned: CloudChatSummary): void {
  const listener = abandonSubscriptionMock.listener;
  if (listener === null) throw new Error("the hook never subscribed");
  listener(abandoned);
}

afterEach(() => {
  // Unmount first, so a teardown's calls land before the mocks are reset
  // rather than leaking into the next test's counts.
  cleanup();
  directoryMock.chats = [];
  directoryMock.settled = true;
  directoryMock.snapshotSeq = 0;
  readMock.read.mockReset();
  reserveMock.reserve.mockReset();
  ingestMock.ingest.mockReset();
  sweepMock.sweep.mockReset();
  // No mirrors dropped unless a test says otherwise.
  sweepMock.sweep.mockReturnValue([]);
  flushMock.flush.mockReset();
  flushMock.flush.mockReturnValue([]);
  settledMock.settled.mockReset();
  settledMock.settled.mockReturnValue(false);
  claimMock.begin.mockReset();
  claimMock.release.mockReset();
  claimMock.abandon.mockReset();
  claimMock.settleWithoutApply.mockReset();
  noteHostMock.note.mockReset();
  abandonSubscriptionMock.subscribe.mockReset();
  abandonSubscriptionMock.unsubscribe.mockReset();
  installAbandonSubscription();
  vi.useRealTimers();
});

describe("useCloudDraftsIngest", () => {
  it("re-reads the same draft when its published head changes", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    // Same identity, same scope, newer head. Keyed on the identity alone this
    // second publish was skipped and the replica stayed on the old bytes.
    directoryMock.chats = [summary(DIGEST_TWO, null)];
    view.rerender();
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
  });

  it("reserves the ingest fence before the head read resolves, then ingests once the read settles", async () => {
    const pending: Array<() => void> = [];
    readMock.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => {
            resolve({ kind: "ok", record: HEAD });
          });
        }),
    );
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // The fence is reserved BEFORE the head read resolves - while the read
    // is still pending, the reserve has already happened but nothing has
    // ingested yet. It is reserved twice: once pre-sweep for every foreign
    // row with a head, and once more inside `attemptRead`, before its own
    // read.
    await vi.waitFor(() => {
      expect(reserveMock.reserve).toHaveBeenCalledTimes(2);
    });
    expect(reserveMock.reserve).toHaveBeenNthCalledWith(1, "draft-1");
    expect(reserveMock.reserve).toHaveBeenNthCalledWith(2, "draft-1");
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).not.toHaveBeenCalled();

    for (const resolve of pending) resolve();
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
  });

  it("drops a read that resolves after the effect was torn down", async () => {
    const pending: Array<() => void> = [];
    readMock.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => {
            resolve({ kind: "ok", record: HEAD });
          });
        }),
    );
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(1);
    });
    view.unmount();
    for (const resolve of pending) resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("retries a head read that throws once, then ingests once it succeeds", async () => {
    vi.useFakeTimers();
    readMock.read
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValueOnce({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // The first read rejects. Let that promise settle so attemptRead's catch
    // block actually runs and arms the retry timer before the clock moves -
    // advancing first would jump straight past a timer that does not exist
    // yet.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);

    // Backoff for attempt 0: HEAD_READ_RETRY_BASE_MS * 2 ** 0 = 2s.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    // Reserved once pre-sweep (every foreign row with a head is) plus once
    // per attempt: the failed first read and the successful retry each
    // reserve the fence again before their own read.
    expect(reserveMock.reserve).toHaveBeenCalledTimes(3);
  });

  it("gives up after MAX_HEAD_READ_ATTEMPTS reads and makes no further attempt", async () => {
    vi.useFakeTimers();
    readMock.read.mockRejectedValue(new Error("persistent read failure"));
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // Attempt 0 fails and arms the first retry (2s backoff).
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    // Attempt 1 fails and arms the second retry (4s backoff).
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);

    // Attempt 2 is the last one (MAX_HEAD_READ_ATTEMPTS = 3): it fails and
    // gives up rather than arming a third timer.
    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    });
    expect(vi.getTimerCount()).toBe(0);

    // Advancing well past every backoff makes no further read.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("calls sweepAbsentCloudDraftMirrors once with every directory row's ids - foreign and own-host - and the directory's snapshot seq, when the directory is settled, and only head-ingests the foreign row", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.settled = true;
    directoryMock.snapshotSeq = 7;
    const ownHostSummary = summary(DIGEST_TWO, {
      identity: {
        taskId: "scp_1",
        chatId: "draft-2",
        ownerUserId: "user-1",
      },
      ownerHostId: HOST_ID,
    });
    directoryMock.chats = [summary(DIGEST_ONE, null), ownHostSummary];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(sweepMock.sweep).toHaveBeenCalledTimes(1);
    });
    expect(sweepMock.sweep).toHaveBeenCalledWith(
      HOST_ID,
      new Map([
        ["draft-1", new Set([OWNER_HOST_ID])],
        ["draft-2", new Set([HOST_ID])],
      ]),
      7,
    );
    // Only the foreign row (owned by another host) is head-ingested; the
    // own-host row is already live via `drafts.subscribe`.
    expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
  });

  it("nudges absent own rows with a flush once per settled snapshot, excluding ids already nudged for it", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.settled = true;
    directoryMock.snapshotSeq = 7;
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    flushMock.flush.mockReturnValueOnce(["own-absent"]);

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(flushMock.flush).toHaveBeenCalledTimes(1);
    });
    const [listed, fenceSeq, excluded] = flushMock.flush.mock.calls[0];
    expect([...listed.keys()]).toEqual(["draft-1"]);
    expect(fenceSeq).toBe(7);
    expect(excluded.size).toBe(0);

    // The same snapshot read again (a new array reference, same fence):
    // the id already nudged is excluded rather than flushed twice.
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();
    await vi.waitFor(() => {
      expect(flushMock.flush).toHaveBeenCalledTimes(2);
    });
    expect([...flushMock.flush.mock.calls[1][2]]).toEqual(["own-absent"]);

    // A new snapshot starts over.
    directoryMock.snapshotSeq = 8;
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();
    await vi.waitFor(() => {
      expect(flushMock.flush).toHaveBeenCalledTimes(3);
    });
    expect(flushMock.flush.mock.calls[2][1]).toBe(8);
    expect(flushMock.flush.mock.calls[2][2].size).toBe(0);
  });

  it("does not nudge own rows while the directory is unsettled", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.settled = false;
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(flushMock.flush).not.toHaveBeenCalled();
  });

  it("does not call sweepAbsentCloudDraftMirrors while the directory is unsettled", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.settled = false;
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(sweepMock.sweep).not.toHaveBeenCalled();
  });

  it("re-attempts ingest for the same head after a rejected ingest, on the next effect run", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockRejectedValueOnce(new Error("ingest failed"));
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    ingestMock.ingest.mockResolvedValueOnce(undefined);
    // Same head, new array reference (an equal-by-value array with a
    // different identity) so the effect re-runs.
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
  });

  it("ingests the happy path exactly once per head across rerenders, with the host id, summary and document", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    const [ingestArgs] = ingestMock.ingest.mock.calls[0];
    expect(ingestArgs.hostId).toBe(HOST_ID);
    expect(ingestArgs.summary.headSha256).toBe(DIGEST_ONE);
    expect(ingestArgs.document).toBeDefined();

    // Same head, new array reference each time: the key is already marked
    // ingested, so no further ingest calls should happen.
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
  });

  it("retries a rejected ingest via the same backoff, then succeeds without warning on the first failure", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest
      .mockRejectedValueOnce(new Error("transient apply failure"))
      .mockResolvedValueOnce(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // The first ingest rejects. Let that promise settle so the catch block
    // arms the retry timer before the clock moves.
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();

    // Backoff for attempt 0: HEAD_READ_RETRY_BASE_MS * 2 ** 0 = 2s. The
    // retry re-reads the head before calling ingest again.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("releases the key when teardown interrupts a failing apply, so the next setup asks again", async () => {
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    const pending: Array<() => void> = [];
    ingestMock.ingest
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            pending.push(() => {
              reject(new Error("apply failed after teardown"));
            });
          }),
      )
      .mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(
      ({ client }) => useCloudDraftsIngest(client, HOST_ID),
      { initialProps: { client: CLIENT as never } },
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    // A new client instance re-runs the effect: the old scope is torn down
    // while its apply is still in flight, and that apply then rejects.
    view.rerender({ client: { ...CLIENT } as never });
    for (const reject of pending) reject();

    // The torn-down chain must have released the key, so the fresh setup
    // ingests the same head again instead of skipping it.
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("clears a pending retry timer on unmount, so it never fires a read", async () => {
    vi.useFakeTimers();
    readMock.read.mockRejectedValue(new Error("transient read failure"));
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );

    // Prove the trigger fired - the first attempt failed and armed a retry -
    // before asserting that unmounting stops it.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);

    // The cleanup cleared the timer: letting it lapse reads no further.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("reserves the ingest fence for a foreign row with a head before the settled sweep runs", async () => {
    const order: string[] = [];
    reserveMock.reserve.mockImplementation(() => {
      order.push("reserve");
    });
    sweepMock.sweep.mockImplementation(() => {
      order.push("sweep");
      return [];
    });
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(sweepMock.sweep).toHaveBeenCalledTimes(1);
    });
    // The pre-sweep reserve (over every foreign row with a head) happens
    // before the settled sweep runs, on the first effect run.
    const firstReserve = order.indexOf("reserve");
    const firstSweep = order.indexOf("sweep");
    expect(firstReserve).toBeGreaterThanOrEqual(0);
    expect(firstSweep).toBeGreaterThanOrEqual(0);
    expect(firstReserve).toBeLessThan(firstSweep);
  });

  it("a fresh mount reads nothing for a head the coordinator has settled: no read, no claim, no ingest, but the head is still fenced", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    settledMock.settled.mockReturnValue(true);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    // A second mount of the hook (a new tab) starts with an empty per-mount
    // set; the coordinator's record is what stops the fan-out.
    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settledMock.settled).toHaveBeenCalled();
    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
    // One pre-sweep reserve per mount: the fence is taken for a listed head
    // whether or not this mount reads it.
    expect(reserveMock.reserve).toHaveBeenCalledTimes(2);
    expect(reserveMock.reserve).toHaveBeenCalledWith("draft-1");
  });

  it("fences a skipped head without reading or claiming it, so the reader's apply never meets a replica this mount's sweep dropped", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    // A head under read by another mount is settled as far as the guard is
    // concerned (the coordinator answers true for both).
    settledMock.settled.mockReturnValue(true);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await new Promise((resolve) => setTimeout(resolve, 0));
    // Reserved once, pre-sweep. Nothing else is done with the row.
    expect(reserveMock.reserve).toHaveBeenCalledTimes(1);
    expect(reserveMock.reserve).toHaveBeenCalledWith("draft-1");
    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("registers this host as an image source for a skipped head, with the hook's host id, and not for a head it reads", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    const skipped = summary(DIGEST_ONE, null);
    const read = summary(DIGEST_TWO, {
      identity: {
        taskId: "scp_1",
        chatId: "draft-2",
        ownerUserId: "user-1",
      },
    });
    settledMock.settled.mockImplementation(
      (candidate) => candidate === skipped,
    );
    directoryMock.chats = [skipped, read];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(ingestMock.ingest.mock.calls[0][0].summary).toBe(read);
    expect(noteHostMock.note).toHaveBeenCalledTimes(1);
    expect(noteHostMock.note).toHaveBeenCalledWith(skipped, HOST_ID);
    expect(noteHostMock.note.mock.calls[0][0]).toBe(skipped);
  });

  it("a settled head is still swept and nudged like any listed row; only the read is skipped", async () => {
    settledMock.settled.mockReturnValue(true);
    directoryMock.settled = true;
    directoryMock.snapshotSeq = 7;
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sweepMock.sweep).toHaveBeenCalledTimes(1);
    const [, listed, fenceSeq] = sweepMock.sweep.mock.calls[0];
    expect(fenceSeq).toBe(7);
    expect(listed.get("draft-1")).toEqual(new Set([OWNER_HOST_ID]));
    expect(flushMock.flush).toHaveBeenCalledTimes(1);
    expect(readMock.read).not.toHaveBeenCalled();
  });

  it("reads a head again once the coordinator no longer reports it settled (its mirror left the store)", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    settledMock.settled.mockReturnValue(true);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readMock.read).not.toHaveBeenCalled();

    settledMock.settled.mockReturnValue(false);
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
  });

  it("releases the guard for a chat the sweep drops, so a later listing re-ingests its head", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    sweepMock.sweep.mockReturnValue([]);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);

    // The sweep reports draft-1's mirror dropped on this run - the
    // directory listing is unchanged (same head), only the sweep verdict
    // differs.
    sweepMock.sweep.mockReturnValue(["draft-1"]);
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    // A further rerender with the same summary: the guard entry for
    // draft-1 was released by the drop above, so this head - previously
    // skipped by the guard - is read and ingested again rather than
    // silently staying stuck on the old apply. (The drop-triggered read on
    // the prior rerender never resolves before this one tears it down, so
    // it counts as a `readMock.read` call but never reaches ingest - it is
    // the fresh attempt started on THIS rerender that ingests.)
    sweepMock.sweep.mockReturnValue([]);
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
    expect(readMock.read).toHaveBeenCalledTimes(3);
  });

  it("neither reads, fences nor claims a row that has no head yet, while still reading the rows beside it", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    const headless = summary(null, null);
    const published = summary(DIGEST_ONE, {
      identity: {
        taskId: "scp_1",
        chatId: "draft-2",
        ownerUserId: "user-1",
      },
    });
    directoryMock.chats = [headless, published];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    // Only the published row was read, claimed and fenced.
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledWith(published);
    expect(claimMock.begin).not.toHaveBeenCalledWith(headless);
    expect(reserveMock.reserve).not.toHaveBeenCalledWith("draft-1");
    expect(reserveMock.reserve).toHaveBeenCalledWith("draft-2");
    expect(ingestMock.ingest.mock.calls[0][0].summary).toBe(published);
  });

  it("does nothing at all for a lone row that has no head yet", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    directoryMock.chats = [summary(null, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readMock.read).not.toHaveBeenCalled();
    expect(reserveMock.reserve).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("claims the head with the coordinator before its read starts", async () => {
    const order: string[] = [];
    claimMock.begin.mockImplementation(() => {
      order.push("begin");
    });
    readMock.read.mockImplementation(() => {
      order.push("read");
      // Never resolves: the claim must already stand while the read is pending.
      return new Promise(() => {});
    });
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(1);
    });
    expect(order).toEqual(["begin", "read"]);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledWith(row);
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
  });

  it("settles a head whose read answers a terminal refusal, without a retry or an ingest", async () => {
    vi.useFakeTimers();
    readMock.read.mockResolvedValue({ kind: "unpublished", record: null });
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(claimMock.settleWithoutApply).toHaveBeenCalledTimes(1);
    });
    expect(claimMock.settleWithoutApply).toHaveBeenCalledWith(row);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
    expect(claimMock.release).not.toHaveBeenCalled();
  });

  it("releases, and does not settle, a head whose read answers an ambiguous identity, without a retry or an ingest", async () => {
    vi.useFakeTimers();
    readMock.read.mockResolvedValue({
      kind: "ambiguous-identity",
      record: null,
    });
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(claimMock.release).toHaveBeenCalledTimes(1);
    });
    expect(claimMock.release).toHaveBeenCalledWith(row);
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
    expect(claimMock.release).toHaveBeenCalledTimes(1);
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
  });

  it("abandons, rather than releases, the coordinator's claim when the effect is torn down with a read still pending, after unsubscribing", async () => {
    readMock.read.mockImplementation(() => new Promise(() => {}));
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(1);
    });
    expect(claimMock.begin).toHaveBeenCalledWith(row);
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(abandonSubscriptionMock.unsubscribe).not.toHaveBeenCalled();

    view.unmount();

    expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    expect(claimMock.abandon).toHaveBeenCalledWith(row);
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    // Unsubscribed FIRST: the abandon this teardown issues must not reach the
    // listener of the very mount that is going away.
    expect(abandonSubscriptionMock.unsubscribe).toHaveBeenCalledTimes(1);
    expect(
      abandonSubscriptionMock.unsubscribe.mock.invocationCallOrder[0],
    ).toBeLessThan(claimMock.abandon.mock.invocationCallOrder[0]);
  });

  it("does not abandon a head whose read already decided before the teardown", async () => {
    readMock.read.mockResolvedValue({ kind: "unpublished", record: null });
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(claimMock.settleWithoutApply).toHaveBeenCalledTimes(1);
    });

    view.unmount();

    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(claimMock.release).not.toHaveBeenCalled();
  });

  it("subscribes to abandoned heads once per effect run and unsubscribes on every teardown", async () => {
    settledMock.settled.mockReturnValue(true);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(1);
    });
    expect(abandonSubscriptionMock.unsubscribe).not.toHaveBeenCalled();

    // A new directory delivery re-runs the effect: the old subscription ends
    // with the old run, and one new one replaces it.
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();
    expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(2);
    expect(abandonSubscriptionMock.unsubscribe).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(abandonSubscriptionMock.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("starts exactly one read for an abandoned head this mount skipped and the guard no longer holds", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    // Another mount holds the head, so this mount skips it at setup.
    settledMock.settled.mockReturnValue(true);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    await vi.waitFor(() => {
      expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();

    // The holder is torn down: the claim is gone, and the coordinator names
    // the head. An equal-by-value copy, as the coordinator's own summary is a
    // different object from this mount's directory row.
    settledMock.settled.mockReturnValue(false);
    deliverAbandon({ ...row });

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    // The row it reads is this mount's own listing, not the abandoned copy.
    expect(claimMock.begin.mock.calls[0][0]).toBe(row);
    expect(ingestMock.ingest.mock.calls[0][0].summary).toBe(row);

    // The same abandon delivered again finds the key this mount now holds.
    deliverAbandon({ ...row });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
  });

  it("starts no read for an abandoned head the directory does not list under the same key", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    settledMock.settled.mockReturnValue(true);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    await vi.waitFor(() => {
      expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(1);
    });
    settledMock.settled.mockReturnValue(false);

    // Another row, another head of the same row, another owner of the same id.
    deliverAbandon(
      summary(DIGEST_ONE, {
        identity: { taskId: "scp_1", chatId: "draft-9", ownerUserId: "user-1" },
      }),
    );
    deliverAbandon(summary(DIGEST_TWO, null));
    deliverAbandon(summary(DIGEST_ONE, { ownerHostId: "host-c" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("starts no read for an abandoned head the guard still skips because something else holds it", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    settledMock.settled.mockReturnValue(true);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    await vi.waitFor(() => {
      expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(1);
    });

    // A third mount claimed the head first: the guard is asked again at the
    // abandon, and still answers settled.
    deliverAbandon({ ...row });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("starts no read for an abandoned head once the mount is gone, even if the old listener is still invoked", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    settledMock.settled.mockReturnValue(true);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(1);
    });
    // The reference a coordinator that notified from a snapshot taken before
    // the unsubscribe would still hold.
    const staleListener = abandonSubscriptionMock.listener;
    if (staleListener === null) throw new Error("the hook never subscribed");

    view.unmount();
    expect(abandonSubscriptionMock.unsubscribe).toHaveBeenCalledTimes(1);

    settledMock.settled.mockReturnValue(false);
    staleListener({ ...row });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("abandons the coordinator's claim once, at the end, when every attempt of a head read throws, and starts no read of its own when the abandon wakes it", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockRejectedValue(new Error("persistent read failure"));
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];
    // The real coordinator tells every subscriber, this mount's included, and
    // answers "not held" once the claim is gone (the default of the settled
    // mock): without the hook's own exhausted-key check this wake would start
    // a fourth read.
    claimMock.abandon.mockImplementation((abandoned) => {
      deliverAbandon({ ...abandoned });
    });

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );

    // Attempt 0 fails and arms the first retry; the claim stands through it.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(claimMock.abandon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    // Attempt 1 fails and arms the second retry (doubled); still claimed.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(claimMock.abandon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);

    // Attempt 2 is the last: it gives up and abandons.
    await vi.waitFor(() => {
      expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(claimMock.abandon).toHaveBeenCalledWith(row);
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // The wake the abandon delivered to this very mount started nothing: no
    // new claim, no fourth read, no timer, however long it waits.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);
    expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    expect(claimMock.release).not.toHaveBeenCalled();

    // The exhausted head is no longer this mount's to abandon when it goes.
    view.unmount();
    expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("abandons the coordinator's claim once, at the end, when every attempt of an apply throws, and starts no read of its own when the abandon wakes it", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockRejectedValue(new Error("persistent apply failure"));
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];
    claimMock.abandon.mockImplementation((abandoned) => {
      deliverAbandon({ ...abandoned });
    });

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );

    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(claimMock.abandon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(claimMock.abandon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);

    await vi.waitFor(() => {
      expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    });
    expect(ingestMock.ingest).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(claimMock.abandon).toHaveBeenCalledWith(row);
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // No fourth read or apply from the wake the abandon delivered here.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(ingestMock.ingest).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);

    view.unmount();
    expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    expect(claimMock.release).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("ignores the abandon wake only for the head it exhausted this run: another head's abandon still starts a read", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockRejectedValue(new Error("persistent read failure"));
    const exhausted = summary(DIGEST_ONE, null);
    const skipped = summary(DIGEST_TWO, {
      identity: {
        taskId: "scp_1",
        chatId: "draft-2",
        ownerUserId: "user-1",
      },
    });
    // The second row is held by another mount at setup, and free afterwards.
    settledMock.settled.mockImplementation(
      (candidate) => candidate === skipped,
    );
    directoryMock.chats = [exhausted, skipped];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);
    await vi.waitFor(() => {
      expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);

    // The exhausted head's wake is ignored; the skipped head's is not.
    settledMock.settled.mockReturnValue(false);
    deliverAbandon({ ...exhausted });
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);

    deliverAbandon({ ...skipped });
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(2);
    expect(claimMock.begin.mock.calls[1][0]).toBe(skipped);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS + 1);
    warnSpy.mockRestore();
  });

  it("asks the coordinator about a head this mount already ingested when it is listed again, and starts no read", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    const first = summary(DIGEST_ONE, null);
    directoryMock.chats = [first];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(settledMock.settled).toHaveBeenCalledWith(first);
    settledMock.settled.mockClear();
    noteHostMock.note.mockClear();

    // The same identity and digest listed again at a later publication time:
    // the coordinator is the one that moves the record's stamp on it, so the
    // guard must reach it even though this mount's own set has the key.
    const republished = summary(DIGEST_ONE, { publishedAt: 9 });
    directoryMock.chats = [republished];
    view.rerender();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settledMock.settled).toHaveBeenCalledTimes(1);
    expect(settledMock.settled).toHaveBeenCalledWith(republished);
    expect(settledMock.settled.mock.calls[0][0]).toBe(republished);
    // The per-mount set still skips it when the coordinator does not hold it.
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    expect(noteHostMock.note).toHaveBeenCalledWith(republished, HOST_ID);
  });
});
