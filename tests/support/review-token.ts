import type { OperationIdentity, OperationRecord } from "../../src/core/types";

/** The current review's token, as a review screen would have kept it from the AWAITING_REVIEW result. */
export async function tokenOf(
  store: { getOperation(id: string): Promise<OperationRecord | null> },
  identity: string | OperationIdentity
): Promise<string> {
  const record = await store.getOperation(typeof identity === "string" ? identity : identity.id);
  return record?.reviewEpisode?.token ?? "(no review open)";
}
