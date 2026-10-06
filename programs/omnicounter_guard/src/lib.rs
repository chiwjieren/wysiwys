use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod logic;
pub mod state;

pub use instructions::*;

declare_id!("3jNv1XjPNeWUiZ8aiYheKJHknyjS81cpZfnPEp57CaH2");

#[program]
pub mod omnicounter_guard {
    use super::*;

    pub fn initialize_guard(
        ctx: Context<InitializeGuard>,
        forwarder_program: Pubkey,
        forwarder_state: Pubkey,
        policy_hash: [u8; 32],
    ) -> Result<()> {
        instructions::initialize_guard::handle_initialize_guard(ctx, forwarder_program, forwarder_state, policy_hash)
    }

    pub fn request_review(
        ctx: Context<RequestReview>,
        settlement_intent_hash: [u8; 32],
        trade_ref_hash: [u8; 32],
    ) -> Result<()> {
        instructions::request_review::handle_request_review(ctx, settlement_intent_hash, trade_ref_hash)
    }
}
