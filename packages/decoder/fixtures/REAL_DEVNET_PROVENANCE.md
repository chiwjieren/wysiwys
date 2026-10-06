# Real Squads devnet account fixtures

`real-devnet.json` contains full account bytes captured from public Solana devnet RPC on 6 October 2026. Both accounts were read at `finalized` commitment from `https://api.devnet.solana.com` using `getMultipleAccounts`. The RPC response context slot was `507998625`. Each account owner was `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` and each had the pinned `VaultTransaction` discriminator.

The creation signatures were found with `getSignaturesForAddress` and checked with `getTransaction`. Both transactions succeeded and logged `Instruction: VaultTransactionCreate`. The fixture bytes were deserialized and serialized without change by the exact pinned `@sqds/multisig` version `2.1.4`. The test repeats that SDK roundtrip offline. Account data is public; no keypair or secret is included.

| Fixture | Account | Creation transaction | Creation slot | Expected decoder result |
| --- | --- | --- | ---: | --- |
| Ordered System transfers | [11fcK8xBkav1Ypd3fDWHcqN5F9FeWLfqCwTVj2tMxCY](https://explorer.solana.com/address/11fcK8xBkav1Ypd3fDWHcqN5F9FeWLfqCwTVj2tMxCY?cluster=devnet) | [32kQ2FzJ1Sq3TZDJNok1vEm3BoiwiB61izZqkY9SKr7jhRTGZkLzQzBBgeP4F4P4C2r94SUVMn1WyL9keU2kStQi](https://explorer.solana.com/tx/32kQ2FzJ1Sq3TZDJNok1vEm3BoiwiB61izZqkY9SKr7jhRTGZkLzQzBBgeP4F4P4C2r94SUVMn1WyL9keU2kStQi?cluster=devnet) | 427397070 | Success, two ordered `system.transfer` actions for 68,210,000 and 2,699,120 lamports. |
| ATA with Token-2022 | [18PTVHBFMj1nyWaV26u1Q8hSw83djpKLiJfwBtRZmNg](https://explorer.solana.com/address/18PTVHBFMj1nyWaV26u1Q8hSw83djpKLiJfwBtRZmNg?cluster=devnet) | [4ucjg4jWTgCwzr1sUtyHMrKnj2Boe3Fj29cT3zJ3V7Hqb4QezBTkddJGgXcvX8fq3G5MXLNCnmsbbXUcyrHmjqtg](https://explorer.solana.com/tx/4ucjg4jWTgCwzr1sUtyHMrKnj2Boe3Fj29cT3zJ3V7Hqb4QezBTkddJGgXcvX8fq3G5MXLNCnmsbbXUcyrHmjqtg?cluster=devnet) | 427521772 | Unsupported, because account position 5 selects Token-2022. The instruction data is empty. |

The positive real account and the synthetic `TransferChecked` account both roundtrip through the pinned SDK. The positive real account also decodes to its complete expected action sequence. The Token-2022 account is a negative fixture that confirms a known out-of-scope instruction cannot succeed.

## Source discrepancy found during validation

The earlier instruction source note described ATA `Create` as one byte `[0]` only. The [official ATA instruction builder](https://github.com/solana-program/associated-token-account/blob/main/interface/src/instruction.rs) emits `[0]`, but the [official processor](https://github.com/solana-program/associated-token-account/blob/main/program/src/processor.rs) also accepts empty data as `Create`. The real Token-2022 fixture contains that empty form. The decoder now accepts either form when the final account is the classic SPL Token program. It still rejects Token-2022 as unsupported.

The tests use the recorded bytes and make no RPC calls. RPC context slot identifies when the account snapshot was observed; creation slots identify the transactions that created those accounts.

To independently compare the saved account bytes and owners with current finalized devnet state, run `npm run verify:devnet-fixtures --workspace=packages/decoder`. This optional command makes one public `getMultipleAccounts` request and fails if an account is missing or differs. It is separate from the deterministic offline test suite. On 6 October 2026, both saved accounts still matched at finalized RPC context slot `508021013`.
