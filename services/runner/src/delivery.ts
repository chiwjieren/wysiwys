import anchor, { type Idl } from "@anchor-lang/core";
import { PublicKey, type Connection } from "@solana/web3.js";
import { ReviewStatus, SEEDS, txIndexSeed } from "@wysiwys/shared";
import idl from "@wysiwys/shared/idl/wysiwys_guard.json" with { type: "json" };
import type { ReviewRequest } from "./cre";

/** Chain state, not a CLI exit code or log line, confirms report delivery. RPC failures stay retryable. */
export function createReviewVerifier(
  connection: Pick<Connection, "getAccountInfo">,
  guard: PublicKey,
) {
  const coder = new anchor.BorshCoder(idl as Idl);
  const statusNames = (
    idl.types.find((t) => t.name === "ReviewStatus")!.type as {
      variants: { name: string }[];
    }
  ).variants.map((v) => v.name);
  return async (request: ReviewRequest): Promise<boolean> => {
    const multisig = new PublicKey(request.multisig);
    const index = BigInt(request.txIndex);
    const [address] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.review), multisig.toBuffer(), txIndexSeed(index)],
      guard,
    );
    const account = await connection.getAccountInfo(address, "finalized");
    if (!account || !account.owner.equals(guard) || account.executable)
      return false;
    try {
      const review = coder.accounts.decode("Review", account.data);
      const variants = Object.keys(review.status);
      const status =
        variants.length === 1 ? statusNames.indexOf(variants[0]!) : -1;
      return (
        review.version === 2 &&
        review.multisig.equals(multisig) &&
        review.tx_index.toString() === request.txIndex &&
        (
          [
            ReviewStatus.Approved,
            ReviewStatus.Rejected,
            ReviewStatus.Executed,
          ] as number[]
        ).includes(status)
      );
    } catch {
      return false;
    }
  };
}
