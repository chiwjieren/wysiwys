import { reviewReasonText, reviewState, type Review } from "./review";

// Progress of one proposal for the dot-line tracker on the proposal page. Votes and the Chainlink
// review are independent gates (either can finish first); execution needs both. Pure: chain reads
// happen in the page.

export type StepState = "done" | "active" | "waiting" | "failed";
export type ProgressStep = {
  key: "proposed" | "review" | "votes" | "execute";
  label: string;
  state: StepState;
  detail: string;
};

export function proposalProgress(o: {
  kind: "vault" | "config" | "batch" | "archived";
  guarded: boolean;
  proposalStatus: string;
  approvals: number;
  threshold: number | null;
  review: Review | null | undefined;
  nowSeconds: number;
}): ProgressStep[] {
  const executed = o.proposalStatus === "Executed" || o.kind === "archived";
  const withReview = o.guarded && (o.kind === "vault" || o.kind === "archived");
  const steps: ProgressStep[] = [{ key: "proposed", label: "Proposed", state: "done", detail: "Stored in Squads" }];

  let reviewBlocks = false;
  let reviewApproved = !withReview;
  if (withReview) {
    const state = o.review === undefined ? "unreadable" : reviewState(o.review, o.nowSeconds);
    const step = (s: StepState, detail: string): ProgressStep => ({ key: "review", label: "Chainlink review", state: s, detail });
    if (state === "unreadable") steps.push(step("waiting", "Review unavailable"));
    else if (state === "none") steps.push(step("failed", "No review requested"));
    else if (state === "pending") steps.push(step("active", "Waiting for the Chainlink workflow"));
    else if (state === "approved" || state === "executed") steps.push(step("done", "Approved within policy"));
    else if (state === "expired") steps.push(step("failed", "Approval expired"));
    else {
      const reason = reviewReasonText(o.review!.reason).replace(/^Blocked: /, "");
      steps.push(step("failed", reason.charAt(0).toUpperCase() + reason.slice(1)));
    }
    reviewBlocks = state === "none" || state === "expired" || state === "rejected";
    reviewApproved = state === "approved" || state === "executed";
  }

  const votesNeeded = o.threshold ?? 0;
  const votesDetail = votesNeeded ? `${Math.min(o.approvals, votesNeeded)} of ${votesNeeded} approved` : `${o.approvals} approved`;
  const votesFailed = o.proposalStatus === "Rejected" || o.proposalStatus === "Cancelled";
  const votesDone = executed || o.proposalStatus === "Approved" || o.proposalStatus === "Executing";
  steps.push({
    key: "votes",
    label: "Member approvals",
    state: votesDone ? "done" : votesFailed ? "failed" : o.proposalStatus === "Draft" ? "waiting" : "active",
    detail: votesFailed ? `Proposal ${o.proposalStatus.toLowerCase()}` : votesDetail,
  });

  const label = o.kind === "config" ? "Applied" : "Executed";
  if (executed) steps.push({ key: "execute", label, state: "done", detail: o.kind === "config" ? "Changes applied" : "Payment sent" });
  else if (votesFailed || reviewBlocks) steps.push({ key: "execute", label, state: "failed", detail: "Cannot execute" });
  else if (votesDone && reviewApproved) steps.push({ key: "execute", label, state: "active", detail: "Ready to execute" });
  else steps.push({ key: "execute", label, state: "waiting", detail: withReview ? "Needs both approvals" : "Needs member approvals" });
  return steps;
}
