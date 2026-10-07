import { Connection, PublicKey } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { assertDevnet } from "@/lib/squads/network";
import {
  assertSameOrigin,
  loadDeployment,
  rateLimit,
  rpcUrl,
} from "@/lib/squads/server-config";
import { callRunner, RunnerRequestError } from "@/lib/squads/guard-groups";
import { authenticate, AuthenticationError } from "@/lib/auth/server";
import {
  isPolicyMember,
  parsePolicyRequest,
  policyHashFromGuardConfig,
  readPolicyChange,
} from "@/lib/squads/policy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers });

// Policy documents are private: only a wallet-signed request from a member (Initiate or Vote) of the
// treasury, checked on chain, can read the current or a proposed document or submit a proposal.
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    rateLimit();
    const wallet = await authenticate(request);
    let input;
    try {
      input = parsePolicyRequest(JSON.parse(await request.text()));
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Invalid policy request." },
        400,
      );
    }
    const guardProgram = (await loadDeployment())?.config.guardProgram;
    if (!guardProgram) return json({ error: "Guard is not configured." }, 503);
    const rpc = new Connection(rpcUrl(), "finalized");
    await assertDevnet(rpc);
    const multisig = new PublicKey(input.multisig);
    const squad = await sqds.accounts.Multisig.fromAccountAddress(
      rpc,
      multisig,
      "finalized",
    );
    if (!isPolicyMember(squad.members, wallet))
      return json(
        { error: "Only members of this treasury can see its policy." },
        403,
      );
    const guard = new PublicKey(guardProgram);
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), multisig.toBuffer()],
      guard,
    );
    const configInfo = await rpc.getAccountInfo(configPda, "finalized");
    const current = configInfo?.owner.equals(guard)
      ? policyHashFromGuardConfig(configInfo.data)
      : null;
    if (!current)
      return json({ error: "This treasury has no guard policy." }, 404);

    const stored = async (hash: string) => {
      try {
        return (
          (await callRunner(`frontend/policies/${hash}`, {
            method: "GET",
          })) as { document: unknown }
        ).document;
      } catch (e) {
        if (e instanceof RunnerRequestError && e.status === 404) return null;
        throw e;
      }
    };
    if (input.action === "current")
      return json({
        currentPolicyHash: current,
        document: await stored(current),
      });
    if (input.action === "read") {
      // Only documents named by this treasury's own policy change proposal, read from chain.
      const [transaction] = sqds.getTransactionPda({
        multisigPda: multisig,
        index: BigInt(input.index),
      });
      const vaultTx = await sqds.accounts.VaultTransaction.fromAccountAddress(
        rpc,
        transaction,
        "finalized",
      ).catch(() => null);
      const change =
        vaultTx && vaultTx.multisig.equals(multisig)
          ? readPolicyChange(vaultTx.message, guard)
          : null;
      if (!change)
        return json(
          { error: "Not a policy change proposal of this treasury." },
          404,
        );
      return json({
        hash: change.newPolicyHash,
        document: await stored(change.newPolicyHash),
        base: change.expectedPolicyHash,
        baseDocument: await stored(change.expectedPolicyHash),
      });
    }
    const result = (await callRunner("frontend/policies", {
      method: "POST",
      body: JSON.stringify({
        multisig: input.multisig,
        document: input.document,
      }),
    })) as {
      hash: string;
      currentPolicyHash: string;
      currentVersionKnown: boolean;
      current: boolean;
    };
    return json({
      hash: result.hash,
      currentPolicyHash: result.currentPolicyHash,
      currentVersionKnown: result.currentVersionKnown,
      current: result.current,
    });
  } catch (error) {
    if (error instanceof AuthenticationError)
      return json({ error: error.message }, 401);
    if (error instanceof RunnerRequestError && error.status === 409)
      return json(
        { error: "The policy version must be higher than the current one." },
        409,
      );
    if (error instanceof RunnerRequestError && error.status === 400)
      return json({ error: "The runner rejected this policy document." }, 400);
    return json(
      { error: "The policy service is unavailable. Try again later." },
      503,
    );
  }
}
