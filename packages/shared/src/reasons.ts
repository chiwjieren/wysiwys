// Reason codes (u16) carried in the CRE report. Stable: append only.
export enum ReviewReason {
  WITHIN_POLICY = 0,
  RPC_NO_QUORUM = 1,
  TX_HASH_MISMATCH = 2,
  UNKNOWN_PROGRAM = 3,
  UNEXPECTED_INSTRUCTION = 4,
  /** Address Lookup Tables, account creation, Token-2022, ephemeral signers. */
  UNSUPPORTED_FEATURE = 5,
  AUTHORITY_CHANGE_BLOCKED = 6,
  DURABLE_NONCE_DETECTED = 7,
  DESTINATION_NOT_WHITELISTED = 8,
  DESTINATION_OWNER_UNRESOLVED = 9,
  MINT_NOT_ALLOWED = 10,
  AMOUNT_OVER_CAP = 11,
  SCREENING_REJECTED = 12,
  POLICY_STALE = 13,
}

export const MAX_REASON = ReviewReason.POLICY_STALE;
