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

/** The same listing row pinned at another publication time (`null` is an unpublished row). */
function withPublishedAt(
  summary: CloudChatSummary,
  publishedAt: number | null,
): CloudChatSummary {
  return { ...summary, publishedAt };
}

/** The same listing row pinned at another record sequence. */
function withThroughRecordSeq(
  summary: CloudChatSummary,
  throughRecordSeq: number | null,
): CloudChatSummary {
  return { ...summary, throughRecordSeq };
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

describe("cloudDraftHeadSettled against the mirror's owner", () => {
  const OTHER_OWNER_HOST_ID = "host-z";

  /** Re-owns the mirror the store holds for `DRAFT_ID`, as another owner's row under the same id would. */
  function setMirrorOwner(ownerHostId: string | null): void {
    useLandingDraftStore.setState((state) => ({
      drafts: state.drafts.map((draft) =>
        draft.id === DRAFT_ID ? { ...draft, ownerHostId } : draft,
      ),
    }));
  }

  it("is not settled when the mirror in the store names another owner than the row, and the record is forgotten", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );
    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);

    setMirrorOwner(OTHER_OWNER_HOST_ID);

    // The mirror is still there, but it is not this row's.
    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
    expect(cloudDraftHeadReading(summary)).toBe(false);

    // The record was deleted, not merely masked: once the mirror names the
    // original owner again, the head is still not settled, and nothing is
    // being read for it.
    setMirrorOwner(OWNER_HOST_ID);
    expect(cloudDraftHeadSettled(summary)).toBe(false);
    expect(cloudDraftHeadReading(summary)).toBe(false);
  });

  it("settles by the listing's owner: the other owner's row under the same id is its own record", async () => {
    const original = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    const other = summaryFor(DRAFT_ID, OTHER_OWNER_HOST_ID, HEAD_ONE);
    await ingest(
      HOST_ID,
      original,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );
    expect(cloudDraftHeadSettled(original)).toBe(true);
    expect(cloudDraftHeadSettled(other)).toBe(false);

    // The mirror now shows the other owner's draft: the other owner's listing
    // matches it, and the original owner's no longer does.
    setMirrorOwner(OTHER_OWNER_HOST_ID);
    await ingest(
      HOST_ID,
      other,
      cloudDocument(DRAFT_ID, OTHER_OWNER_HOST_ID, "landing"),
    );

    expect(cloudDraftHeadSettled(other)).toBe(true);
    expect(cloudDraftHeadSettled(original)).toBe(false);
  });

  it("still counts a mirror with no owner as present, and keeps the record", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    await ingest(
      HOST_ID,
      summary,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
    );

    setMirrorOwner(null);

    expect(landingIds()).toEqual([DRAFT_ID]);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    // Not forgotten: a second ask answers the same.
    expect(cloudDraftHeadSettled(summary)).toBe(true);
  });
});

describe("a listing older than the record", () => {
  const HEAD_THREE = "12".repeat(32);

  it("is settled, and a read of it leaves a settled newer head in place", () => {
    const newer = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const stale = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    settleCloudDraftHeadWithoutApply(newer);

    expect(cloudDraftHeadSettled(stale)).toBe(true);
    beginCloudDraftHeadRead(stale);

    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadReading(stale)).toBe(false);
    expect(cloudDraftHeadReading(newer)).toBe(false);
  });

  it("is settled, and a read of it leaves a newer head still being read in place", () => {
    const newer = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const stale = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    beginCloudDraftHeadRead(newer);

    expect(cloudDraftHeadSettled(stale)).toBe(true);
    beginCloudDraftHeadRead(stale);

    expect(cloudDraftHeadReading(newer)).toBe(true);
    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadReading(stale)).toBe(false);
  });

  it("is settled after a newer head was installed through an ingest", async () => {
    const newer = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const stale = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    await ingest(
      HOST_ID,
      newer,
      cloudDocument(DRAFT_ID, OWNER_HOST_ID, "chat-composer"),
    );

    expect(cloudDraftHeadSettled(newer)).toBe(true);
    expect(cloudDraftHeadSettled(stale)).toBe(true);
  });

  it("is not settled when the listing carries a later publication time, and its read replaces the record", () => {
    const settled = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const newer = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_THREE),
      12,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(newer)).toBe(false);
    beginCloudDraftHeadRead(newer);

    expect(cloudDraftHeadReading(newer)).toBe(true);
    expect(cloudDraftHeadReading(settled)).toBe(false);
    // The record now names the publishedAt-12 head, so the old one is the stale
    // listing and is settled by that rule, not by holding the record.
    expect(cloudDraftHeadSettled(settled)).toBe(true);
  });

  it("keeps the old behaviour when the listing has no publication time", () => {
    const settled = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      9,
    );
    const unknown = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      null,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(unknown)).toBe(false);
    beginCloudDraftHeadRead(unknown);

    expect(cloudDraftHeadReading(unknown)).toBe(true);
    expect(cloudDraftHeadSettled(settled)).toBe(false);
  });

  it("keeps the old behaviour when the record has no publication time", () => {
    const settled = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      null,
    );
    const other = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(other)).toBe(false);
    beginCloudDraftHeadRead(other);

    expect(cloudDraftHeadReading(other)).toBe(true);
    expect(cloudDraftHeadSettled(settled)).toBe(false);
  });

  it("orders by publishedAt and not by throughRecordSeq: a later publication with a LOWER sequence is a new head", () => {
    // A fork or a rewrite renumbers the sequence, so the later head can carry
    // the smaller number.
    const settled = withThroughRecordSeq(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO), 5),
      9,
    );
    const later = withThroughRecordSeq(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_THREE), 8),
      3,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(later)).toBe(false);
    beginCloudDraftHeadRead(later);

    expect(cloudDraftHeadReading(later)).toBe(true);
    expect(cloudDraftHeadReading(settled)).toBe(false);
  });

  it("advances the record's stamp when the same digest is listed again later, so an intermediate head delivered late is stale", () => {
    // The row published A (5), then B (7), then byte-identical A again (9).
    // This renderer saw A first and sees the republication next; B arrives
    // last, from another host's cache.
    const first = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const republished = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      9,
    );
    const intermediate = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      7,
    );
    settleCloudDraftHeadWithoutApply(first);

    expect(cloudDraftHeadSettled(republished)).toBe(true);
    expect(cloudDraftHeadSettled(intermediate)).toBe(true);
    beginCloudDraftHeadRead(intermediate);
    expect(cloudDraftHeadReading(intermediate)).toBe(false);
    expect(cloudDraftHeadSettled(first)).toBe(true);
  });

  it("advances the stamp of a head still being read, and the stamp never moves back when that read settles or restarts", () => {
    const first = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const republished = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      9,
    );
    const intermediate = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      7,
    );
    beginCloudDraftHeadRead(first);
    expect(cloudDraftHeadSettled(republished)).toBe(true);
    expect(cloudDraftHeadReading(republished)).toBe(true);

    // The read that started from the publishedAt-5 listing settles.
    settleCloudDraftHeadWithoutApply(first);
    expect(cloudDraftHeadSettled(intermediate)).toBe(true);

    // A later read of the same digest from the old listing keeps the stamp.
    beginCloudDraftHeadRead(first);
    expect(cloudDraftHeadSettled(intermediate)).toBe(true);
    expect(cloudDraftHeadReading(first)).toBe(true);
  });

  it("does not move the stamp back when the same digest is listed again earlier", () => {
    const later = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      9,
    );
    const earlierListing = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE),
      5,
    );
    const between = withPublishedAt(
      summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO),
      7,
    );
    settleCloudDraftHeadWithoutApply(later);

    expect(cloudDraftHeadSettled(earlierListing)).toBe(true);
    expect(cloudDraftHeadSettled(between)).toBe(true);
  });

  it("orders by publishedAt and not by throughRecordSeq: an earlier publication with a HIGHER sequence is stale", () => {
    const settled = withThroughRecordSeq(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_TWO), 8),
      3,
    );
    const earlier = withThroughRecordSeq(
      withPublishedAt(summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE), 5),
      9,
    );
    settleCloudDraftHeadWithoutApply(settled);

    expect(cloudDraftHeadSettled(earlier)).toBe(true);
    beginCloudDraftHeadRead(earlier);

    expect(cloudDraftHeadSettled(settled)).toBe(true);
    expect(cloudDraftHeadReading(earlier)).toBe(false);
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

  it("does not mark the host while the window serves another account, so the account's return still registers it", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(HOST_ID);
    mountSession(SECOND_HOST_ID);
    await Promise.resolve();
    await ingestWithImage(HOST_ID, summary);
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    useAuthStore.setState({
      contextMetadata: { userId: "user-2", username: "user-2" },
    });
    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

    expect(sources.count()).toBe(0);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore);

    useAuthStore.setState({
      contextMetadata: { userId: OWNER_USER_ID, username: OWNER_USER_ID },
    });
    noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

    expect(sources.count()).toBe(1);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);
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

  it("does not mark the ingesting host when the account moves between the apply and its settlement, so the account's return still registers it", async () => {
    const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
    mountSession(HOST_ID);
    await Promise.resolve();
    // The apply's own owner check passes (it runs right before the store
    // write); the switch happens inside the store write, so the ingest's
    // continuation is the first thing to see another account.
    const stopSwitching = useLandingDraftStore.subscribe(() => {
      useAuthStore.setState({
        contextMetadata: { userId: "user-2", username: "user-2" },
      });
    });
    await ingestWithImage(HOST_ID, summary);
    stopSwitching();
    useAuthStore.setState({
      contextMetadata: { userId: OWNER_USER_ID, username: OWNER_USER_ID },
    });
    expect(cloudDraftHeadSettled(summary)).toBe(true);
    const sources = countSourceChanges();
    const versionBefore = cloudDraftImageSourceVersion();

    // The ingest recorded no source (the owner check returned before it), and
    // it must not have marked HOST_ID as one either: this skip registers it.
    noteCloudDraftHeadHost(summary, HOST_ID);

    expect(sources.count()).toBe(1);
    expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 1);
  });
  describe("a host skipped while the head is still being read", () => {
    /** Mounts both sessions, so each host has a requester to register. */
    async function mountBothSessions(): Promise<void> {
      mountSession(HOST_ID);
      mountSession(SECOND_HOST_ID);
      await Promise.resolve();
    }

    it("control: ingesting an image head through a mounted host records one source change and nothing for another host", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(summary);

      await ingestWithImage(HOST_ID, summary);

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(sources.count()).toBe(1);
    });

    it("registers nothing while the read is in flight, then registers the skipped host's requester once when the read settles with images", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      const versionBefore = cloudDraftImageSourceVersion();
      beginCloudDraftHeadRead(summary);

      // Whether the head names images is unknown until the read settles. Noted
      // twice (two mounts on the same host): still one entry on the record.
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      expect(cloudDraftHeadReading(summary)).toBe(true);
      expect(sources.count()).toBe(0);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore);

      // The reading host ingests it: its own source (the control above) plus
      // the skipped host's, which is registered at the settle.
      await ingestWithImage(HOST_ID, summary);

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(cloudDraftHeadReading(summary)).toBe(false);
      expect(sources.count()).toBe(2);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 2);

      // The host is marked on the settled record: noting it again adds nothing.
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      expect(sources.count()).toBe(2);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore + 2);
    });

    it("leaves a skipped host with no mounted session unmarked at the settle, and a later note registers it once its session mounts", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      mountSession(HOST_ID);
      await Promise.resolve();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(summary);
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      await ingestWithImage(HOST_ID, summary);

      // Only the reading host's own source: the skipped host had no session.
      expect(sources.count()).toBe(1);

      // Still no session: nothing to register, and nothing marked.
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
      expect(sources.count()).toBe(1);

      mountSession(SECOND_HOST_ID);
      await Promise.resolve();
      const afterMount = sources.count();

      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
      expect(sources.count()).toBe(afterMount + 1);

      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
      expect(sources.count()).toBe(afterMount + 1);
    });

    it("registers nothing for a skipped host when the head settles without images", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      const versionBefore = cloudDraftImageSourceVersion();
      beginCloudDraftHeadRead(summary);
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      await ingestCloudDraftSummary({
        hostId: HOST_ID,
        summary,
        document: cloudDocument(DRAFT_ID, OWNER_HOST_ID, "landing"),
        readOwner: OWNER_USER_ID,
      });

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(sources.count()).toBe(0);
      expect(cloudDraftImageSourceVersion()).toBe(versionBefore);

      // Nothing was held back on the settled record either.
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);
      expect(sources.count()).toBe(0);
    });

    it("registers nothing for a skipped host when the head settles without an apply", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(summary);
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      settleCloudDraftHeadWithoutApply(summary);

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(sources.count()).toBe(0);
    });

    it("forgets a skipped host along with a released read: a later read of the head does not register it", async () => {
      const summary = summaryFor(DRAFT_ID, OWNER_HOST_ID, HEAD_ONE);
      await mountBothSessions();
      const sources = countSourceChanges();
      beginCloudDraftHeadRead(summary);
      noteCloudDraftHeadHost(summary, SECOND_HOST_ID);

      // Released silently: an abandon would also wake whatever subscribers
      // other tests in this file left behind.
      releaseCloudDraftHeadRead(summary);
      expect(cloudDraftHeadReading(summary)).toBe(false);

      // The next read is a new record: its settle owes the old skip nothing.
      beginCloudDraftHeadRead(summary);
      await ingestWithImage(HOST_ID, summary);

      expect(cloudDraftHeadSettled(summary)).toBe(true);
      expect(sources.count()).toBe(1);
    });
  });
});
