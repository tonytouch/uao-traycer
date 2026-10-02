import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  abandonCloudDraftHeadRead,
  acquireDraftMirrorSession,
  applyIncomingDraftDocument,
  beginCloudDraftHeadRead,
  cloudDraftHeadKey,
  cloudDraftHeadReading,
  cloudDraftHeadSettled,
  cloudDraftIngestSeq,
  ingestCloudDraftSummary,
  noteCloudDraftHeadHost,
  releaseCloudDraftHeadRead,
  resetDraftMirrorCoordinatorForTests,
  settleCloudDraftHeadWithoutApply,
  subscribeCloudDraftHeadAbandoned,
  sweepAbsentCloudDraftMirrors,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  cloudDraftImageSourceVersion,
  resetCloudDraftImageRecoveryForTests,
  subscribeCloudDraftImageSources,
} from "@/lib/drafts/cloud-draft-image-recovery";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import {
  resetLandingDraftRetirementsForTests,
  retireLandingDraft,
} from "@/lib/drafts/landing-draft-retirement";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useAuthStore } from "@/stores/auth/auth-store";

const HOST_ID = "host-a";
const OWNER_HOST_ID = "host-b";
const DRAFT_ID = "draft-settled-1";
const HEAD_ONE = "ab".repeat(32);
const HEAD_TWO = "cd".repeat(32);
const OTHER_DRAFT_ID = "draft-settled-2";

function typed(text: string) {
  return {
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function summaryFor(
  draftId: string,
  ownerHostId: string,
  headSha256: string,
): CloudChatSummary {
  return {
    identity: {
      taskId: "scp_TESTDRAFTSSCOPEID000001",
      chatId: draftId,
      ownerUserId: "user-1",
    },
    ownerHostId,
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
  };
}

function cloudDocument(
  draftId: string,
  ownerHostId: string,
  kind: "landing" | "chat-composer",
): DraftDocument {
  return {
    draftId,
    kind,
    target:
      kind === "landing"
        ? { epicId: null, chatId: null, blockId: null }
        : { epicId: "epic-1", chatId: "chat-1", blockId: null },
    revision: 1,
    lastTouchedAt: 2,
    workspace: null,
    supersedes: null,
    ownerHostId,
    origin: "replica",
    adoption: { state: "adopted", hostId: ownerHostId },
    publication: {
      status: "current",
      lastPublishedAt: 1,
      publishedRevision: 1,
      halted: null,
    },
    portable: {
      content: typed("cloud body"),
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

/** A landing document whose portable body names `hashes`, as a published head with images does. */
function landingDocumentWithImages(
  draftId: string,
  ownerHostId: string,
  hashes: readonly string[],
): DraftDocument {
  const document = cloudDocument(draftId, ownerHostId, "landing");
  if (document.kind !== "landing") {
    throw new Error("expected a landing document");
  }
  return {
    ...document,
    portable: { ...document.portable, blobHashes: [...hashes] },
  };
}

function landingIds(): readonly string[] {
  return useLandingDraftStore.getState().drafts.map((draft) => draft.id);
}

async function ingest(
  hostId: string,
  summary: CloudChatSummary,
  document: DraftDocument,
): Promise<void> {
  await ingestCloudDraftSummary({
    hostId,
    summary,
    document,
    readOwner: null,
  });
}

afterEach(() => {
  resetDraftMirrorCoordinatorForTests();
  resetCloudDraftImageRecoveryForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  resetLandingDraftRetirementsForTests();
  useAuthStore.setState({ contextMetadata: null });
});

describe("cloudDraftHeadSettled", () => {
  it("keys a head by its identity plus headSha256", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);

    expect(cloudDraftHeadKey(summary)).toBe(
      `${OWNER_HOST_ID}:scp_TESTDRAFTSSCOPEID000001:user-1:${DRAFT_ID}:${HEAD_ONE}`,
    );
  });

  it("settles a host-bound head without touching the landing store", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const document = cloudDocument(DRAFT_ID, OWNER_HOST_ID, "chat-composer");
    expect(cloudDraftHeadSettled(summary)).toBe(false);

    await ingest(HOST_ID, summary, document);

    expect(cloudDraftHeadSettled(summary)).toBe(true);
    expect(landingIds()).toEqual([]);
  });

  it("settles an installed landing head with its mirror and forgets it once the mirror is removed from the store", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const document = cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing");
    expect(cloudDraftHeadSettled(summary)).toBe(false);

    await ingest(HOST_ID, summary, document);

    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    const mirrors = useLandingDraftStore.getState().drafts;
    useLandingDraftStore.getState().applyHostDelete(DRAFT_ID);

    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
    // The record was deleted, not merely masked: a mirror that comes back
    // under the same id does not resurrect the settled head.
    useLandingDraftStore.setState({ drafts: mirrors });
    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
  });

  it("forgets a landing head when the absence sweep drops its mirror", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const document = cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing");
    await ingest(HOST_ID, summary, document);
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    const dropped = sweepAbsentCloudDraftMirrors(
      HOST_ID,
      new Map(),
      cloudDraftIngestSeq(),
    );

    expect(dropped).toEqual([DRAFT_ID]);
    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
  });

  it("does not treat a different headSha256 for the same identity as settled", async () => {
    const settled = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    await ingest(
      HOST_ID,
      settled,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "chat-composer"),
    );

    expect(cloudDraftHeadSettled(settled)).toBe(true);
    expect(cloudDraftHeadKey(newer)).not.toBe(cloudDraftHeadKey(settled));
    expect(cloudDraftHeadSettled(newer)).toBe(false);
  });

  it("settles nothing for a row the ingesting host owns", async () => {
    const summary = summaryFor(DRAFT_ID, HOST_ID, HEAD_ONE);

    await ingest(HOST_ID, summary, cloudDocument(DRAFT_ID, HOST_ID, "landing"));

    expect(cloudDraftHeadSettled(summary)).toBe(false);
    expect(landingIds()).toEqual([]);
  });

  it("clears a settled head on resetDraftMirrorCoordinatorForTests", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "chat-composer"),
    );
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    resetDraftMirrorCoordinatorForTests();

    expect(cloudDraftHeadSettled(summary)).toBe(false);
  });

  it("treats a head being read as settled for the same sha only", () => {
    const reading = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const other = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    expect(cloudDraftHeadSettled(reading)).toBe(false);

    beginCloudDraftHeadRead(reading);

    expect(cloudDraftHeadSettled(reading)).toBe(true);
    expect(cloudDraftHeadSettled(other)).toBe(false);
  });

  it("releases a head still being read, but never a settled one", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);

    beginCloudDraftHeadRead(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    releaseCloudDraftHeadRead(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(false);

    settleCloudDraftHeadWithoutApply(summary);
    releaseCloudDraftHeadRead(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });

  it("keeps a read in flight for one sha when a release names another sha of the row", () => {
    const original = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const other = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    beginCloudDraftHeadRead(original);

    releaseCloudDraftHeadRead(other);

    expect(cloudDraftHeadSettled(original)).toBe(true);
    expect(cloudDraftHeadSettled(other)).toBe(false);
  });

  it("settles a head without apply with no mirror in the landing store", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    expect(cloudDraftHeadSettled(summary)).toBe(false);

    settleCloudDraftHeadWithoutApply(summary);

    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    expect(
      cloudDraftHeadSettled(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO)),
    ).toBe(false);
  });

  it("replaces the row's record when a read of a new sha begins", () => {
    const older = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    settleCloudDraftHeadWithoutApply(older);
    expect(cloudDraftHeadSettled(older)).toBe(true);

    beginCloudDraftHeadRead(newer);

    expect(cloudDraftHeadSettled(older)).toBe(false);
    expect(cloudDraftHeadSettled(newer)).toBe(true);
  });

  it("releases a read in flight when the apply is refused for a reason about the moment (an older revision than the row holds)", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    // The row already holds a newer revision from the same owner, so the
    // cloud head (revision 1) is refused as older: not retired, not about
    // this head.
    await applyIncomingDraftDocument({
      ...cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
      revision: 5,
    });
    expect(landingIds()).toEqual([DRAFT_ID]);
    beginCloudDraftHeadRead(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(cloudDraftHeadSettled(summary)).toBe(false);
  });

  it("settles a landing head refused because its id is retired here, without a mirror", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    retireLandingDraft(DRAFT_ID, null);
    beginCloudDraftHeadRead(summary);

    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });

  it("keeps one record per row: two rows install side by side, and a new sha for a row replaces only that row's record", async () => {
    const first = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const second = summaryFor(OTHER_DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    await ingest(
      HOST_ID,
      first,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );
    await ingest(
      HOST_ID,
      second,
      cloudDocument(OTHER_DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(cloudDraftHeadSettled(first)).toBe(true);
    expect(cloudDraftHeadSettled(second)).toBe(true);

    const firstNewer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    // The reader claims the new head before it reads it, which is what
    // replaces the row's record: a settle alone never replaces another head's.
    beginCloudDraftHeadRead(firstNewer);
    await ingest(
      HOST_ID,
      firstNewer,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(cloudDraftHeadSettled(firstNewer)).toBe(true);
    expect(cloudDraftHeadSettled(first)).toBe(false);
    expect(cloudDraftHeadSettled(second)).toBe(true);
  });
});

describe("cloudDraftHeadReading", () => {
  it("is true while a head is being read, for the same sha only", () => {
    const reading = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const other = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    expect(cloudDraftHeadReading(reading)).toBe(false);

    beginCloudDraftHeadRead(reading);

    expect(cloudDraftHeadReading(reading)).toBe(true);
    expect(cloudDraftHeadReading(other)).toBe(false);
  });

  it("is false once the read is released", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    beginCloudDraftHeadRead(summary);

    releaseCloudDraftHeadRead(summary);

    expect(cloudDraftHeadReading(summary)).toBe(false);
  });

  it("is false once the head is settled, although the head still counts as settled", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    beginCloudDraftHeadRead(summary);

    settleCloudDraftHeadWithoutApply(summary);

    expect(cloudDraftHeadReading(summary)).toBe(false);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });

  it("releases, rather than settles, a read whose apply started under another account", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    useAuthStore.setState({
      contextMetadata: { userId: "user-b", username: "b" },
    });
    beginCloudDraftHeadRead(summary);
    expect(cloudDraftHeadReading(summary)).toBe(true);

    // The read was issued under user-a; the window now belongs to user-b.
    await ingestCloudDraftSummary({
      hostId: HOST_ID,
      summary,
      document: cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
      readOwner: "user-a",
    });

    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
    expect(cloudDraftHeadReading(summary)).toBe(false);
  });

  it("still applies and settles a read whose account matches the window's", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    useAuthStore.setState({
      contextMetadata: { userId: "user-a", username: "a" },
    });
    beginCloudDraftHeadRead(summary);

    await ingestCloudDraftSummary({
      hostId: HOST_ID,
      summary,
      document: cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
      readOwner: "user-a",
    });

    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    expect(cloudDraftHeadReading(summary)).toBe(false);
  });
});

describe("a settle is guarded by the head", () => {
  it("leaves a newer head's read in flight when an older head of the row settles", () => {
    const older = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    beginCloudDraftHeadRead(newer);

    settleCloudDraftHeadWithoutApply(older);

    expect(cloudDraftHeadReading(newer)).toBe(true);
    expect(cloudDraftHeadSettled(older)).toBe(false);
    expect(cloudDraftHeadSettled(newer)).toBe(true);
  });

  it("settles the head once its own settle arrives, after an older head's was ignored", () => {
    const older = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    beginCloudDraftHeadRead(newer);
    settleCloudDraftHeadWithoutApply(older);

    settleCloudDraftHeadWithoutApply(newer);

    expect(cloudDraftHeadReading(newer)).toBe(false);
    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadSettled(older)).toBe(false);
  });

  it("keeps a settled newer head when an older head settles after it", () => {
    const older = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    settleCloudDraftHeadWithoutApply(newer);

    settleCloudDraftHeadWithoutApply(older);

    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadSettled(older)).toBe(false);
  });

  it("settles a row that has no record, and re-settles the same head", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    expect(cloudDraftHeadSettled(summary)).toBe(false);

    settleCloudDraftHeadWithoutApply(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    settleCloudDraftHeadWithoutApply(summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    expect(cloudDraftHeadReading(summary)).toBe(false);
  });

  it("does not let an install of an older head replace the newer head's claim", async () => {
    const older = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const newer = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    beginCloudDraftHeadRead(newer);

    await ingest(
      HOST_ID,
      older,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    expect(cloudDraftHeadReading(newer)).toBe(true);
    expect(cloudDraftHeadSettled(older)).toBe(false);
  });
});

describe("abandonCloudDraftHeadRead", () => {
  it("clears a read in flight and tells every subscriber which head, once", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const first = vi.fn<(abandoned: CloudChatSummary) => void>();
    const second = vi.fn<(abandoned: CloudChatSummary) => void>();
    subscribeCloudDraftHeadAbandoned(first);
    subscribeCloudDraftHeadAbandoned(second);
    beginCloudDraftHeadRead(summary);

    abandonCloudDraftHeadRead(summary);

    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][0]).toBe(summary);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][0]).toBe(summary);
    expect(cloudDraftHeadReading(summary)).toBe(false);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
  });

  it("has already cleared the claim when a subscriber hears of it, so a woken mount can claim the head", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const seenSettled: boolean[] = [];
    subscribeCloudDraftHeadAbandoned((abandoned) => {
      seenSettled.push(cloudDraftHeadSettled(abandoned));
      beginCloudDraftHeadRead(abandoned);
    });
    beginCloudDraftHeadRead(summary);

    abandonCloudDraftHeadRead(summary);

    expect(seenSettled).toEqual([false]);
    expect(cloudDraftHeadReading(summary)).toBe(true);
  });

  it("notifies nobody and keeps the record when the head is already settled", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const listener = vi.fn<(abandoned: CloudChatSummary) => void>();
    subscribeCloudDraftHeadAbandoned(listener);
    beginCloudDraftHeadRead(summary);
    settleCloudDraftHeadWithoutApply(summary);

    abandonCloudDraftHeadRead(summary);

    expect(listener).not.toHaveBeenCalled();
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });

  it("notifies nobody and keeps the claim when it names another head of the row", () => {
    const reading = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const other = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO);
    const listener = vi.fn<(abandoned: CloudChatSummary) => void>();
    subscribeCloudDraftHeadAbandoned(listener);
    beginCloudDraftHeadRead(reading);

    abandonCloudDraftHeadRead(other);

    expect(listener).not.toHaveBeenCalled();
    expect(cloudDraftHeadReading(reading)).toBe(true);
  });

  it("notifies nobody when the row has no record", () => {
    const listener = vi.fn<(abandoned: CloudChatSummary) => void>();
    subscribeCloudDraftHeadAbandoned(listener);

    abandonCloudDraftHeadRead(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE));

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying a subscriber once it unsubscribes, and only that one", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const gone = vi.fn<(abandoned: CloudChatSummary) => void>();
    const kept = vi.fn<(abandoned: CloudChatSummary) => void>();
    const unsubscribeGone = subscribeCloudDraftHeadAbandoned(gone);
    subscribeCloudDraftHeadAbandoned(kept);
    unsubscribeGone();
    beginCloudDraftHeadRead(summary);

    abandonCloudDraftHeadRead(summary);

    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it("is not heard after resetDraftMirrorCoordinatorForTests drops the record", () => {
    // The record, not the subscription, is what an abandon needs: with no
    // read in flight there is nothing to hand over.
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const listener = vi.fn<(abandoned: CloudChatSummary) => void>();
    subscribeCloudDraftHeadAbandoned(listener);
    beginCloudDraftHeadRead(summary);
    resetDraftMirrorCoordinatorForTests();

    abandonCloudDraftHeadRead(summary);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("noteCloudDraftHeadHost", () => {
  const IMAGE_HASH = "ef".repeat(32);
  const SECOND_HOST_ID = "host-c";
  const OWNER_USER_ID = "user-1";

  beforeEach(() => {
    installFreshIndexedDb();
    // A cloud image source carries the account it was minted under, and is
    // refused unless the window serves that account.
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: OWNER_USER_ID, username: OWNER_USER_ID },
    });
  });

  afterEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  function mountSession(hostId: string): void {
    acquireDraftMirrorSession({
      hostId,
      client: {
        request: () =>
          Promise.resolve({
            drafts: [],
            tombstones: [],
            snapshotSeq: 0,
            scopeId: null,
          }),
      } as never,
      streamClient: fakeDraftStreamClient(),
      timing: undefined,
    });
  }

  function ingestWithImage(
    hostId: string,
    summary: CloudChatSummary,
  ): Promise<void> {
    return ingestCloudDraftSummary({
      hostId,
      summary,
      document: landingDocumentWithImages(DRAFT_ID, OWNER_HOST_ID, [
        IMAGE_HASH,
      ]),
      readOwner: OWNER_USER_ID,
    });
  }

  /** Counts every change of the recorded image sources from here on. */
  function countSourceChanges(): { readonly count: () => number } {
    let changes = 0;
    subscribeCloudDraftImageSources(() => {
      changes += 1;
    });
    return { count: () => changes };
  }

  it("is a no-op, and throws nothing, for a settled head that has no images", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(SECOND_HOST_ID);
    await ingestCloudDraftSummary({
      hostId: HOST_ID,
      summary,
      document: cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
      readOwner: OWNER_USER_ID,
    });
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    expect(() => {
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
    }).not.toThrow();

    expect(cloudDraftHeadSettled(summary)).toBe(true);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore);
    expect(sources.count()).toBe(0);
  });

  it("is a no-op for a row with no record and for a head still being read", () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(SECOND_HOST_ID);
    const sources = countSourceChanges();

    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
    beginCloudDraftHeadRead(summary);
    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

    expect(cloudDraftHeadReading(summary)).toBe(true);
    expect(sources.count()).toBe(0);
  });

  it("registers a second host's requester as a source for an installed head's images, once", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(HOST_ID);
    mountSession(SECOND_HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

    expect(sources.count()).toBe(1);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);

    // The second skip of the same head by a mount on the same host adds
    // nothing: the host is remembered on the record.
    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

    expect(sources.count()).toBe(1);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);
  });

  it("does not register the host that already ingested the head with a mounted session", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, summary);
    const sources = countSourceChanges();

    noteCloudDraftHeadHost(summary, HOST_ID);

    expect(sources.count()).toBe(0);
  });

  it("registers a host that ingested the head without a mounted session once its session is mounted, and not before", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    // The head is installed through a host this window holds no mirror on:
    // no source could be recorded at ingest.
    await ingestWithImage(HOST_ID, summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    const sources = countSourceChanges();

    noteCloudDraftHeadHost(summary, HOST_ID);
    expect(sources.count()).toBe(0);

    mountSession(HOST_ID);
    await Promise.resolve();
    const afterMount = sources.count();

    noteCloudDraftHeadHost(summary, HOST_ID);
    expect(sources.count()).toBe(afterMount + 1);

    noteCloudDraftHeadHost(summary, HOST_ID);
    expect(sources.count()).toBe(afterMount + 1);
  });

  it("is a no-op for another head of the row than the settled one", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(HOST_ID);
    mountSession(SECOND_HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, summary);
    const sources = countSourceChanges();

    noteCloudDraftHeadHost(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      SECOND_HOST_ID,
    );

    expect(sources.count()).toBe(0);
  });
});
