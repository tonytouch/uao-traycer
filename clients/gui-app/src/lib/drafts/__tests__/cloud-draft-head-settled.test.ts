import { afterEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  applyIncomingDraftDocument,
  beginCloudDraftHeadRead,
  cloudDraftHeadKey,
  cloudDraftHeadSettled,
  cloudDraftIngestSeq,
  ingestCloudDraftSummary,
  releaseCloudDraftHeadRead,
  resetDraftMirrorCoordinatorForTests,
  settleCloudDraftHeadWithoutApply,
  sweepAbsentCloudDraftMirrors,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  resetLandingDraftRetirementsForTests,
  retireLandingDraft,
} from "@/lib/drafts/landing-draft-retirement";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

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
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  resetLandingDraftRetirementsForTests();
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
