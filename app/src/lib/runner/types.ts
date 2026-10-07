// Client-safe shapes returned by /api/runner/*. The runner DB is history,
// not truth: on-chain Review accounts stay authoritative.
export type RunnerStatus =
  | { configured: false }
  | { configured: true; reachable: false; ok: false; error: string }
  | {
      configured: true;
      reachable: true;
      ok: boolean;
      listener: {
        subscribed: boolean;
        lastBackfillAt: number | null;
        backfillFailed: boolean;
        backfillMessage: string | null;
      };
      reviews: {
        pending: number;
        approved: number;
        rejected: number;
        executed: number;
      };
      /** Which review path the runner serves; absent on runners without the switch. */
      reviewPath?: RunnerReviewPath;
    };
export type RunnerReviewMode = "live" | "simulator";
export type RunnerReviewPath = {
  mode: RunnerReviewMode;
  available: RunnerReviewMode[];
};
export type RunnerReviewStatus =
  "pending" | "approved" | "rejected" | "executed";
export type RunnerReview = {
  review: string;
  txIndex: string;
  status: RunnerReviewStatus;
  reason: number | null;
  updatedAt: number;
  triggerStatus: "none" | "sent" | "failed";
};
export type RunnerReviews =
  | { configured: false; reviews: [] }
  | { configured: true; reachable: false; error: string; reviews: [] }
  | {
      configured: true;
      reachable: true;
      multisig: string | null;
      reviews: RunnerReview[];
    };
