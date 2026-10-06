# Guarded treasury created through the app's code path (devnet, 7 Oct)

The app's own builders and validators (`buildGroupCreation`, `validateInitializeGuard`, `buildVaultDeposit`, `buildGuardedPaymentInstruction`, `buildPayoutProposal`, `buildGuardedExecute`) with three test keypairs standing in for browser wallets; the runner served `/frontend/*` and ran the CRE review workflow automatically (simulator, `--broadcast`).

| Step | Signature |
|---|---|
| Create treasury `26XYHwTdNnNN1mFZAu11LK3m68eY1SmA8HNVhb41gMc4` (multisigCreateV2 + initialize_guard, one tx) | `3zucAApudmwHWps3YSvtkSB7cV25ETS75AwVMsifns23Ky2vcNAJS8m1CrmWVotddQzGhKkqei328XdSq8BTUfDW` |
| Deposit 1,000 mUSD into the vault | `2wVEmwq2cXbszPUEKVJNaiKA1fuwS7uJqgAngNHgDANGCvdBJrFZdvBRiwtYt3ahXFkH9VjBAEx1At2nvBup84PL` |
| Propose #1 (250 mUSD to the whitelisted wallet) + request_review | `51UTxo1sqSY81v11PUdGqEPb8LNSZHhXbALaqBG9sPmiabMmtNajTymUi27RY5BMR9ZycDQTVSH7psEqvjmVJi6w` |
| CRE review (triggered by the runner's listener) | Approved, reason 0 |
| 3 of 3 votes, then guarded_execute | `3gHysjFMw9Xx7b5ojjKwoiwAKNm22VF7o9mSrYHaVB4eF923RfRC4TYEetHgRRQWVuuLzm7sYDZKYWERoHztc5Pq` |
| Result | Recipient +250 mUSD; vault 750 mUSD left |

The built app then opened the treasury through `/api/squads/groups` as guarded (executor `QzGztbo7YpqfS54TQorCJZU9gKBkrofsSjZ4xs7gDNq`, mUSD) and its recent-reviews feed showed #1 executed. Not covered: signing in a real browser wallet.
