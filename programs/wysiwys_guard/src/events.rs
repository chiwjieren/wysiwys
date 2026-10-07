use anchor_lang::prelude::*;

#[event]
pub struct ReviewRequested {
    pub review: Pubkey,
    pub multisig: Pubkey,
    pub tx_index: u64,
    pub tx_hash: [u8; 32],
}

#[event]
pub struct DecisionRecorded {
    pub review: Pubkey,
    pub verdict: u8,
    pub reason: u16,
    pub policy_hash: [u8; 32],
    pub action_kind: u8,
    pub destination_hash: [u8; 32],
    pub expires_at: i64,
}

#[event]
pub struct Executed {
    pub review: Pubkey,
    pub multisig: Pubkey,
    pub tx_index: u64,
}

#[event]
pub struct ConfigExecuted {
    pub multisig: Pubkey,
    pub tx_index: u64,
}
