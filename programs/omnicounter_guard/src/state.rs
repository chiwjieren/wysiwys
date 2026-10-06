use anchor_lang::prelude::*;

/// Immutable after `initialize_guard`. No instruction updates it.
#[account]
#[derive(InitSpace)]
pub struct GuardConfig {
    pub multisig: Pubkey,
    pub forwarder_program: Pubkey,
    pub forwarder_state: Pubkey,
    pub policy_hash: [u8; 32],
    /// CRE workflow owner (20-byte address) whose reports this guard accepts.
    pub workflow_owner: [u8; 20],
    pub bump: u8,
    pub executor_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ReviewStatus {
    Pending,
    Approved,
    Rejected,
    Executed,
}

#[account]
#[derive(InitSpace)]
pub struct Review {
    pub version: u8,
    pub multisig: Pubkey,
    pub vault_transaction: Pubkey,
    pub proposal: Pubkey,
    pub tx_index: u64,
    pub msg_hash: [u8; 32],
    pub settlement_intent_hash: [u8; 32],
    pub trade_ref_hash: [u8; 32],
    pub status: ReviewStatus,
    pub reason: u16,
    pub policy_hash: [u8; 32],
    pub expires_at: i64,
    pub created_at: i64,
    pub bump: u8,
}
