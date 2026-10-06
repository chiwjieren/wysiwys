use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GuardError;
use crate::events::ReviewRequested;
use crate::logic;
use crate::state::{Review, ReviewStatus};

/// Review PDA seed from the raw vault transaction bytes; validated in the handler.
fn tx_index_seed(account: &AccountInfo) -> [u8; 8] {
    account.try_borrow_data().map(|d| logic::tx_index_seed_from(&d)).unwrap_or([0u8; 8])
}

#[derive(Accounts)]
pub struct RequestReview<'info> {
    /// CHECK: Squads multisig. The vault transaction and proposal must name it.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub multisig: UncheckedAccount<'info>,
    /// CHECK: Squads VaultTransaction. Owner here; discriminator, multisig and index in the handler.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub vault_transaction: UncheckedAccount<'info>,
    /// CHECK: Squads Proposal. Owner here; discriminator, multisig and index in the handler.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub proposal: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Review::INIT_SPACE,
        seeds = [REVIEW_SEED, multisig.key().as_ref(), &tx_index_seed(&vault_transaction)],
        bump
    )]
    pub review: Account<'info, Review>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_request_review(
    ctx: Context<RequestReview>,
    settlement_intent_hash: [u8; 32],
    trade_ref_hash: [u8; 32],
) -> Result<()> {
    let multisig = ctx.accounts.multisig.key();
    let (vault_tx, msg_hash) = {
        let data = ctx.accounts.vault_transaction.try_borrow_data()?;
        (logic::parse_vault_transaction(&data)?, logic::sha256(&data))
    };
    require_keys_eq!(vault_tx.multisig, multisig, GuardError::WrongMultisig);
    let proposal = logic::parse_proposal(&ctx.accounts.proposal.try_borrow_data()?)?;
    require_keys_eq!(proposal.multisig, multisig, GuardError::WrongMultisig);
    require!(proposal.transaction_index == vault_tx.index, GuardError::WrongTxIndex);

    let vault_transaction = ctx.accounts.vault_transaction.key();
    let proposal_key = ctx.accounts.proposal.key();
    let review = &mut ctx.accounts.review;
    review.version = REVIEW_VERSION;
    review.multisig = multisig;
    review.vault_transaction = vault_transaction;
    review.proposal = proposal_key;
    review.tx_index = vault_tx.index;
    review.msg_hash = msg_hash;
    review.settlement_intent_hash = settlement_intent_hash;
    review.trade_ref_hash = trade_ref_hash;
    review.status = ReviewStatus::Pending;
    review.reason = 0;
    review.policy_hash = [0u8; 32];
    review.expires_at = 0;
    review.created_at = Clock::get()?.unix_timestamp;
    review.bump = ctx.bumps.review;

    emit!(ReviewRequested {
        review: review.key(),
        multisig,
        tx_index: vault_tx.index,
        msg_hash,
        settlement_intent_hash,
        trade_ref_hash,
    });
    Ok(())
}
