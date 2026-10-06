use anchor_lang::prelude::*;

pub const SQUADS_PROGRAM_ID: Pubkey = pubkey!("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

pub const CONFIG_SEED: &[u8] = b"config";
pub const REVIEW_SEED: &[u8] = b"review";
pub const EXECUTOR_SEED: &[u8] = b"executor";
pub const FORWARDER_SEED: &[u8] = b"forwarder";

// Anchor discriminators of Squads v4 accounts and instructions (sha256 of "account:<Name>" / "global:<name>").
pub const VAULT_TRANSACTION_DISCRIMINATOR: [u8; 8] = [168, 250, 162, 100, 81, 14, 162, 207];
pub const PROPOSAL_DISCRIMINATOR: [u8; 8] = [26, 94, 189, 187, 116, 136, 53, 33];
pub const MULTISIG_DISCRIMINATOR: [u8; 8] = [224, 116, 121, 186, 68, 161, 79, 236];
pub const VAULT_TRANSACTION_EXECUTE_DISCRIMINATOR: [u8; 8] = [194, 8, 161, 87, 153, 164, 25, 171];

pub const PERMISSION_EXECUTE: u8 = 1 << 2;

pub const REPORT_PAYLOAD_LEN: usize = 107;
pub const VERDICT_APPROVE: u8 = 1;
pub const VERDICT_REJECT: u8 = 2;
pub const MAX_REASON: u16 = 22;

pub const REVIEW_VERSION: u8 = 1;
