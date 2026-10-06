use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GuardError;
use crate::events::DecisionRecorded;
use crate::logic;
use crate::state::{GuardConfig, Review, ReviewStatus};

/// Account order is fixed by the Keystone forwarder: [forwarder_state, forwarder_authority, ...receiver accounts].
#[derive(Accounts)]
pub struct OnReport<'info> {
    /// CHECK: verified against config in logic::verify_forwarder.
    pub forwarder_state: UncheckedAccount<'info>,
    /// CHECK: PDA and signer flag verified in logic::verify_forwarder (custom error instead of Anchor's).
    pub forwarder_authority: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED, review.multisig.as_ref()], bump = config.bump)]
    pub config: Account<'info, GuardConfig>,
    #[account(
        mut,
        seeds = [REVIEW_SEED, review.multisig.as_ref(), &review.tx_index.to_le_bytes()],
        bump = review.bump
    )]
    pub review: Account<'info, Review>,
}

pub fn handle_on_report(ctx: Context<OnReport>, metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
    let state = &ctx.accounts.forwarder_state;
    let authority = &ctx.accounts.forwarder_authority;
    logic::verify_forwarder(&state.key(), state.owner, &authority.key(), authority.is_signer, &ctx.accounts.config)?;
    logic::verify_workflow(&metadata, &ctx.accounts.config.workflow_owner)?;

    let config = &ctx.accounts.config;
    let review = &mut ctx.accounts.review;
    require!(review.status == ReviewStatus::Pending, GuardError::InvalidStatusTransition);

    let now = Clock::get()?.unix_timestamp;
    let payload = logic::decode_report(&report, now)?;
    logic::check_report_times(&payload, review.created_at, now, config)?;
    require!(payload.tx_hash == review.tx_hash, GuardError::HashMismatch);
    require!(payload.policy_hash == config.policy_hash, GuardError::PolicyMismatch);

    review.status = if payload.verdict == VERDICT_APPROVE { ReviewStatus::Approved } else { ReviewStatus::Rejected };
    review.reason = payload.reason;
    review.policy_hash = payload.policy_hash;
    review.action_kind = payload.action_kind;
    review.destination = payload.destination;
    review.destination_owner = payload.destination_owner;
    review.mint = payload.mint;
    review.issued_at = payload.issued_at;
    review.expires_at = payload.expires_at;

    emit!(DecisionRecorded {
        review: review.key(),
        verdict: payload.verdict,
        reason: payload.reason,
        policy_hash: payload.policy_hash,
        action_kind: payload.action_kind,
        destination: payload.destination,
        destination_owner: payload.destination_owner,
        mint: payload.mint,
        expires_at: payload.expires_at,
    });
    Ok(())
}
