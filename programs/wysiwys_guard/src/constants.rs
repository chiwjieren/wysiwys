use anchor_lang::prelude::*;

pub const SQUADS_PROGRAM_ID: Pubkey = pubkey!("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

pub const CONFIG_SEED: &[u8] = b"config";
pub const REVIEW_SEED: &[u8] = b"review";
pub const EXECUTOR_SEED: &[u8] = b"executor";
pub const FORWARDER_SEED: &[u8] = b"forwarder";
pub const POLICY_CHANGE_SEED: &[u8] = b"policy_change";

// Anchor discriminators of Squads v4 accounts and instructions (sha256 of "account:<Name>" / "global:<name>").
pub const VAULT_TRANSACTION_DISCRIMINATOR: [u8; 8] = [168, 250, 162, 100, 81, 14, 162, 207];
pub const PROPOSAL_DISCRIMINATOR: [u8; 8] = [26, 94, 189, 187, 116, 136, 53, 33];
pub const MULTISIG_DISCRIMINATOR: [u8; 8] = [224, 116, 121, 186, 68, 161, 79, 236];
pub const VAULT_TRANSACTION_EXECUTE_DISCRIMINATOR: [u8; 8] = [194, 8, 161, 87, 153, 164, 25, 171];
pub const CONFIG_TRANSACTION_DISCRIMINATOR: [u8; 8] = [94, 8, 4, 35, 113, 139, 139, 112];
pub const CONFIG_TRANSACTION_EXECUTE_DISCRIMINATOR: [u8; 8] = [114, 146, 244, 189, 252, 140, 36, 40];

// Squads ConfigAction variants (Borsh enum tags). Only the first four are ever executed by the guard.
pub const CONFIG_ADD_MEMBER: u8 = 0;
pub const CONFIG_REMOVE_MEMBER: u8 = 1;
pub const CONFIG_CHANGE_THRESHOLD: u8 = 2;
pub const CONFIG_SET_TIME_LOCK: u8 = 3;

pub const PERMISSION_INITIATE: u8 = 1;
pub const PERMISSION_VOTE: u8 = 1 << 1;
pub const PERMISSION_EXECUTE: u8 = 1 << 2;

pub const SPL_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SPL_TOKEN_ACCOUNT_LEN: usize = 165;
pub const SPL_TOKEN_STATE_OFFSET: usize = 108;
pub const SPL_TOKEN_STATE_INITIALIZED: u8 = 1;

/// tx_hash = sha256(TX_HASH_DOMAIN || vault_transaction || VaultTransaction account data).
pub const TX_HASH_DOMAIN: &[u8] = b"wysiwys:tx:v1";
/// destination_hash = sha256(DEST_HASH_DOMAIN || kind || destination || owner || mint).
pub const DEST_HASH_DOMAIN: &[u8] = b"wysiwys:dest:v1";

// Report payload v2, see packages/shared/src/report.ts. CRE caps the Solana raw report at 265 bytes
// (109 forwarder metadata + 32 account hash + 4 length + payload), so the payload must be <= 120.
pub const REPORT_PAYLOAD_LEN: usize = 117;
pub const REPORT_VERSION: u8 = 2;
pub const VERDICT_APPROVE: u8 = 1;
pub const VERDICT_REJECT: u8 = 2;
pub const MAX_REASON: u16 = 13;

pub const ACTION_NONE: u8 = 0;
pub const ACTION_SOL: u8 = 1;
pub const ACTION_SPL: u8 = 2;

/// How far in the future a report's issued_at may be, in seconds.
pub const MAX_CLOCK_SKEW: i64 = 60;

pub const REVIEW_VERSION: u8 = 2;

// Keystone metadata passed to on_report: workflow_cid 32 | workflow_name 10 | workflow_owner 20 | report_id 2.
pub const REPORT_METADATA_LEN: usize = 64;
pub const WORKFLOW_OWNER_OFFSET: usize = 42;

// Voted policy changes. A Squads vault transaction whose only instruction is this marker (never
// executed) proposes the change; apply_policy_change applies it. See packages/shared/src/policy-change.ts.
/// sha256("global:policy_change_marker")[..8]; marker = discriminator || new_policy_hash || expected_policy_hash.
pub const POLICY_CHANGE_MARKER_DISCRIMINATOR: [u8; 8] = [238, 192, 1, 212, 108, 241, 149, 181];
pub const POLICY_CHANGE_MARKER_LEN: usize = 72;
/// Squads ProposalStatus variant index of Approved (Draft, Active, Rejected, Approved, Executing, Executed, Cancelled).
pub const PROPOSAL_STATUS_APPROVED: u8 = 3;
/// Minimum wait between a policy change's approval and its application, so members can cancel it.
/// Devnet: 5 minutes. Local tests build with `--features short-policy-delay`.
#[cfg(not(feature = "short-policy-delay"))]
pub const POLICY_CHANGE_MIN_DELAY: i64 = 300;
#[cfg(feature = "short-policy-delay")]
pub const POLICY_CHANGE_MIN_DELAY: i64 = 2;
