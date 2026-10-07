"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownLeft, Plus, Send, ScanLine } from "lucide-react";
import { Connection, PublicKey, TransactionMessage } from "@solana/web3.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSquad } from "@/lib/squads/provider";
import { useWalletConnection } from "@/lib/auth/provider";
import {
  assetLabel,
  buildGuardedPaymentInstruction,
  buildPaymentInstructions,
  tokenAmount,
  type PaymentInput,
} from "@/lib/squads/payments";
import {
  draftVaultTransaction,
  previewVaultTransaction,
  type PaymentPreview,
} from "@/lib/squads/decoded-preview";
import { CopyButton } from "@/components/dialogs";
import { VaultFunding } from "./account-actions";
import { PaymentInsights } from "./payment-insights";
export function ReceiveButton() {
  const { snapshot } = useSquad();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" disabled={!snapshot}>
          <ArrowDownLeft className="size-4" />
          Receive
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card">
        <DialogTitle>Receive funds</DialogTitle>
        <DialogDescription>
          Fund the treasury vault with SOL or supported Solana tokens on Devnet.
        </DialogDescription>
        {snapshot && (
          <>
            <p className="caption">Treasury vault address</p>
            <p className="break-all rounded-lg bg-secondary p-3 text-xs">
              {snapshot.vault.toBase58()}
            </p>
            <CopyButton
              value={snapshot.vault.toBase58()}
              label="Copy vault address"
            />
            <VaultFunding />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
export function PaymentButton() {
  const { config, snapshot, account, busy, error, proposePayment } = useSquad();
  const auth = useWalletConnection();
  const router = useRouter();
  const [open, setOpen] = useState(false),
    [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState(""),
    [asset, setAsset] = useState(""),
    [memo, setMemo] = useState(""),
    [step, setStep] = useState<"edit" | "decoding" | "review">("edit"),
    [validation, setValidation] = useState("");
  const [reviewed, setReviewed] = useState<{
    input: PaymentInput;
    multisig: string;
    vault: string;
    vaultIndex: number;
    creator: string;
    index: bigint;
    guarded: boolean;
  }>();
  const guarded = !!config?.executor;
  const [decoded, setDecoded] = useState<PaymentPreview>();
  const token = snapshot?.tokens.find((t) => t.address === asset);
  const member = snapshot?.squad.members.find(
    (m) => m.key.toBase58() === account?.address,
  );
  const permitted = !!member && !!(member.permissions.mask & 1);
  useEffect(() => {
    if (step !== "decoding" || !reviewed) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      const load = async () => {
        try {
          const vault = new PublicKey(reviewed.vault);
          const rpc = new Connection(
            new URL("/api/squads/rpc", window.location.origin).toString(),
            "finalized",
          );
          // Preview exactly what proposePayment will store for this group type: the
          // VaultTransaction account bytes from the Squads SDK serializer, decoded by
          // @wysiwys/decoder.
          const message = new TransactionMessage({
            payerKey: vault,
            recentBlockhash: reviewed.input.recipient,
            instructions: reviewed.guarded
              ? [
                  await buildGuardedPaymentInstruction(rpc, {
                    ...reviewed.input,
                    vault,
                  }),
                ]
              : buildPaymentInstructions({
                  ...reviewed.input,
                  vault,
                }),
          });
          const result = await previewVaultTransaction(
            rpc,
            draftVaultTransaction({
              multisig: new PublicKey(reviewed.multisig),
              creator: new PublicKey(reviewed.creator),
              index: reviewed.index,
              vaultIndex: reviewed.vaultIndex,
              message,
            }),
            vault,
            undefined,
            config?.token,
          );
          if (!cancelled) {
            if (!result.supported) throw new Error(result.reason);
            setDecoded(result);
            setStep("review");
          }
        } catch (e) {
          if (!cancelled) {
            setValidation(
              e instanceof Error ? e.message : "Could not decode this payment.",
            );
            setStep("edit");
          }
        }
      };
      void load();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [step, reviewed]);
  const preview = () => {
    try {
      if (!snapshot || !config) return;
      if (asset && !token)
        throw new Error(
          "Selected token is no longer available. Choose the asset again.",
        );
      const input: PaymentInput = {
        recipient,
        amount,
        // Guarded payouts store exactly one instruction and no memo.
        memo: guarded ? undefined : memo,
        token: token
          ? {
              mint: token.mint,
              source: token.address,
              decimals: token.decimals,
            }
          : undefined,
      };
      buildPaymentInstructions({
        vault: snapshot.vault,
        recipient,
        amount,
        token: token
          ? {
              mint: token.mint,
              source: token.address,
              decimals: token.decimals,
            }
          : undefined,
      });
      setReviewed({
        input,
        multisig: config.multisig,
        vault: snapshot.vault.toBase58(),
        vaultIndex: config.vaultIndex,
        // Creator and index only change the draft's header bytes, never the decoded actions.
        creator: account?.address ?? snapshot.vault.toBase58(),
        index: BigInt(snapshot.squad.transactionIndex.toString()) + 1n,
        guarded,
      });
      setValidation("");
      setStep("decoding");
    } catch (e) {
      setValidation(
        e instanceof Error ? e.message : "Check the payment details.",
      );
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) {
          setStep("edit");
          setValidation("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={!snapshot || !!busy}>
          <Plus className="size-4" />
          New payment
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {step === "edit" ? (
              <Send className="size-5" />
            ) : (
              <ScanLine className="size-5" />
            )}
          </span>
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span className={step === "edit" ? "text-foreground" : ""}>
              1. Payment details
            </span>
            <span>/</span>
            <span className={step !== "edit" ? "text-foreground" : ""}>
              2. Review & propose
            </span>
          </div>
        </div>
        <DialogTitle>
          {step === "edit"
            ? "New payment"
            : step === "decoding"
              ? "Decoding transaction…"
              : "Review your payment"}
        </DialogTitle>
        <DialogDescription>
          {step === "edit"
            ? "Propose a payment from your shared treasury. Members approve before funds can move."
            : "What you see is what you sign."}
        </DialogDescription>
        {step === "edit" ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              preview();
            }}
          >
            <label className="block space-y-2">
              <span>Recipient wallet</span>
              <Input
                required
                placeholder="Solana wallet address"
                className="font-mono text-xs"
                spellCheck={false}
                autoComplete="off"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
              />
            </label>
            <label className="block space-y-2">
              <span>Asset</span>
              <select
                className="h-11 w-full rounded-lg border border-input bg-background/60 px-3"
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
              >
                <option value="">SOL</option>
                {snapshot?.tokens.map((t) => (
                  <option value={t.address} key={t.address}>
                    {assetLabel(config, t.mint) === "tokens"
                      ? `${t.mint.slice(0, 6)}… · `
                      : ""}
                    {tokenAmount(t.amount, t.decimals)}{" "}
                    {assetLabel(config, t.mint)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2">
              <span>Amount</span>
              <Input
                required
                inputMode="decimal"
                placeholder="0.00"
                className="h-14 text-2xl font-semibold tracking-tight md:text-2xl"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p className="caption">
              Available in vault:{" "}
              {token
                ? `${tokenAmount(token.amount, token.decimals)} ${assetLabel(config, token.mint)}`
                : snapshot
                  ? `${tokenAmount(String(snapshot.sol), 9)} SOL`
                  : "Unavailable"}
            </p>
            {!guarded && (
              <label className="block space-y-2">
                <span>Memo (optional)</span>
                <Input
                  maxLength={180}
                  placeholder="What is this payment for?"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                />
              </label>
            )}
            {validation && (
              <p role="alert" className="text-destructive">
                {validation}
              </p>
            )}
            <Button className="w-full">Review payment</Button>
          </form>
        ) : step === "decoding" ? (
          <div role="status" className="space-y-4 py-12 text-center">
            <span className="mx-auto block size-8 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none" />
            <p>Reading the asset, amount and recipient…</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="workspace-hero rounded-xl border border-primary/20 bg-background/40 p-5">
              <p className="caption">Decoded payment preview</p>
              {decoded?.payments.map((payment, i) => (
                <div key={i}>
                  <p className="mt-2 text-[32px] leading-10 font-semibold tracking-tight">
                    Send {payment.amount} {payment.symbol}
                  </p>
                  <p className="eyebrow mt-5">Recipient wallet</p>
                  <p className="mt-2 break-all rounded-lg border bg-background/60 p-3 font-mono text-xs leading-5">
                    {payment.recipient}
                  </p>
                  {payment.mint && (
                    <p className="caption mt-2 break-all">
                      {`Token address ${payment.mint}. Paid into the recipient's token account ${payment.destination}.`}
                    </p>
                  )}
                </div>
              ))}
              {decoded && (
                <div className="mt-4">
                  <PaymentInsights preview={decoded} />
                </div>
              )}
              {decoded?.lines.map((line, i) => (
                <p
                  key={i}
                  className="mt-3 break-words text-xs text-muted-foreground"
                >
                  {line}
                </p>
              ))}
              {reviewed?.input.memo && (
                <p className="mt-3">{reviewed.input.memo}</p>
              )}
              {decoded?.decoded && (
                <details className="mt-3">
                  <summary className="caption cursor-pointer">
                    Technical details
                  </summary>
                  <p className="caption mt-2">
                    Decoder output (@wysiwys/decoder)
                  </p>
                  <pre
                    data-testid="decoder-json"
                    className="mt-1 max-h-60 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground"
                  >
                    {JSON.stringify(decoded.decoded, null, 2)}
                  </pre>
                </details>
              )}
            </div>
            <p className="caption">
              You are creating a proposal. This signature does not send the
              payment. It must be approved by your group before execution.
            </p>
            {reviewed && reviewed.multisig !== config?.multisig && (
              <p role="alert" className="text-destructive">
                Treasury changed. Edit and review the payment again.
              </p>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            {auth.connected ? (
              <Button
                className="w-full"
                disabled={
                  !permitted ||
                  !!busy ||
                  !!error ||
                  !reviewed ||
                  reviewed.multisig !== config?.multisig ||
                  !!(
                    reviewed.input.token &&
                    !snapshot?.tokens.some(
                      (t) => t.address === reviewed.input.token!.source,
                    )
                  )
                }
                onClick={async () => {
                  if (!reviewed || reviewed.multisig !== config?.multisig)
                    return;
                  const id = await proposePayment(reviewed.input);
                  if (id) {
                    setOpen(false);
                    setStep("edit");
                    router.push(`/transactions/${id}`);
                  }
                }}
              >
                {busy || "Sign and propose payment"}
              </Button>
            ) : (
              <Button
                className="w-full"
                onClick={auth.connect}
                disabled={!auth.ready}
              >
                Connect wallet to propose
              </Button>
            )}
            {auth.connected && !permitted && (
              <p className="caption">
                Use a member wallet with proposal permission.
              </p>
            )}
            <Button
              variant="secondary"
              className="w-full"
              disabled={!!busy}
              onClick={() => setStep("edit")}
            >
              Edit payment
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
