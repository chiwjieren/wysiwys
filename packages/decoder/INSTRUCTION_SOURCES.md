# Decoder instruction sources and mappings

The mappings in `src/index.ts` were checked against these official source files on 6 October 2026. The decoder recognizes only the exact program IDs for System, classic SPL Token, and Associated Token Account. It does not accept Token-2022.

## System Program

Source: [Solana SDK `system_instruction.rs`](https://github.com/solana-labs/solana/blob/master/sdk/program/src/system_instruction.rs)

The Bincode enum variant is a u32 little-endian discriminant. The MVP tags are `Assign=1`, `Transfer=2`, `AdvanceNonceAccount=4`, `WithdrawNonceAccount=5`, `InitializeNonceAccount=6`, and `AuthorizeNonceAccount=7`. Pubkeys in payloads are 32 bytes; lamport amounts are u64 little-endian.

Account roles follow the source constructors and variant documentation:

- Assign: assigned account, encoded owner program.
- Transfer: funding account, recipient.
- AdvanceNonceAccount: nonce account, RecentBlockhashes sysvar, authority.
- WithdrawNonceAccount: nonce account, recipient, RecentBlockhashes sysvar, Rent sysvar, authority.
- InitializeNonceAccount: nonce account, RecentBlockhashes sysvar, Rent sysvar; authorized key is encoded in instruction data.
- AuthorizeNonceAccount: nonce account, current authority; new authority is encoded in instruction data.

## Classic SPL Token

Source: [Solana Token interface `instruction.rs`](https://github.com/solana-program/token/blob/main/interface/src/instruction.rs)

The first byte is the variant tag. Supported tags: `Transfer=3`, `Approve=4`, `Revoke=5`, `SetAuthority=6`, `CloseAccount=9`, `TransferChecked=12`, and `ApproveChecked=13`. Amounts are u64 little-endian. Checked forms append the encoded decimals byte. SetAuthority encodes authority type, then a one-byte COption tag and a 32-byte new authority only for `Some`; `None` is surfaced as explicit `null`.

Accounts retain their source positions: Transfer source/destination/authority; Approve source/delegate/authority; ApproveChecked source/mint/delegate/authority; Revoke source/authority; SetAuthority target/current authority; CloseAccount token account/destination/authority; TransferChecked source/mint/destination/authority. Additional multisig signer accounts may follow these required accounts.

## Associated Token Account

Source: [Associated Token Account interface `instruction.rs`](https://github.com/solana-program/associated-token-account/blob/main/interface/src/instruction.rs)

The instruction data is one byte: `Create=0`, `CreateIdempotent=1`. Both use six accounts in order: payer, associated token account, wallet owner, mint, System Program, classic SPL Token program. The decoder checks the final two program accounts and preserves the first four role keys.
