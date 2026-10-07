use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GuardError;
use crate::events::PolicyChanged;
use crate::logic;
use crate::state::{GuardConfig, PolicyChange};

/// Seed of the PolicyChange record from the raw vault transaction bytes; validated in the handler.
fn tx_index_seed(account: &AccountInfo) -> [u8; 8] {
    account.try_borrow_data().map(|d| logic::tx_index_seed_from(&d)).unwrap_or([0u8; 8])
}

/// Applies a policy change the members approved in Squads. The proposal's vault transaction holds only
/// the marker (new hash, expected current hash) and is never executed (guard -> Squads -> guard would be
/// re-entrant). Anyone may call this; the members' vote and the waiting period are the authorization.
/// No CPI and no executor signature.
#[derive(Accounts)]
pub struct ApplyPolicyChange<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, multisig.key().as_ref()],
        bump = config.bump,
        has_one = multisig @ GuardError::WrongMultisig
    )]
    pub config: Account<'info, GuardConfig>,
    /// CHECK: Squads multisig, bound by config.has_one; time lock and stale index parsed in the handler.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub multisig: UncheckedAccount<'info>,
    /// CHECK: Squads Proposal; PDA re-derived and status parsed in the handler.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: Squads VaultTransaction; PDA re-derived and the whole message checked in the handler.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub vault_transaction: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + PolicyChange::INIT_SPACE,
        seeds = [POLICY_CHANGE_SEED, multisig.key().as_ref(), &tx_index_seed(&vault_transaction)],
        bump
    )]
    pub policy_change: Account<'info, PolicyChange>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_apply_policy_change(ctx: Context<ApplyPolicyChange>) -> Result<()> {
    let multisig_key = ctx.accounts.multisig.key();

    // 1. The vault transaction belongs to this multisig and sits at its Squads PDA.
    let (tx_index, marker) = {
        let data = ctx.accounts.vault_transaction.try_borrow_data()?;
        let header = logic::parse_vault_transaction(&data)?;
        require_keys_eq!(header.multisig, multisig_key, GuardError::WrongMultisig);
        let index = header.index.to_le_bytes();
        let (tx_pda, _) = Pubkey::find_program_address(
            &[b"multisig", multisig_key.as_ref(), b"transaction", &index],
            &SQUADS_PROGRAM_ID,
        );
        require_keys_eq!(tx_pda, ctx.accounts.vault_transaction.key(), GuardError::InvalidPolicyChange);
        let (proposal_pda, _) = Pubkey::find_program_address(
            &[b"multisig", multisig_key.as_ref(), b"transaction", &index, b"proposal"],
            &SQUADS_PROGRAM_ID,
        );
        require_keys_eq!(proposal_pda, ctx.accounts.proposal.key(), GuardError::InvalidPolicyChange);
        // 2. Its only content is the marker instruction to the guard, paid by the multisig's vault.
        let vault_index = data[81];
        let (vault, _) = Pubkey::find_program_address(
            &[b"multisig", multisig_key.as_ref(), b"vault", &[vault_index]],
            &SQUADS_PROGRAM_ID,
        );
        (header.index, logic::parse_policy_change_transaction(&data, &crate::ID, &vault)?)
    };

    // 3. It changes the current policy (a change written against an older policy is refused).
    let config = &mut ctx.accounts.config;
    require!(marker.expected_policy_hash == config.policy_hash, GuardError::PolicyChangeOutdated);

    // 4. The members approved it in Squads (cancelled, rejected or still active proposals are refused).
    let approved_at = logic::proposal_approved_at(&ctx.accounts.proposal.try_borrow_data()?)?
        .ok_or_else(|| error!(GuardError::PolicyChangeNotApproved))?;

    // 5. Not stale (Squads marks earlier transactions stale when membership or threshold changes).
    let timing = logic::parse_multisig_timing(&ctx.accounts.multisig.try_borrow_data()?)?;
    require!(tx_index > timing.stale_transaction_index, GuardError::PolicyChangeStale);

    // 6. The waiting period has passed, so members had time to cancel.
    let now = Clock::get()?.unix_timestamp;
    require!(now >= logic::policy_change_ready_at(approved_at, timing.time_lock), GuardError::PolicyChangeTooEarly);

    // 7. Record it (init: one application per proposal) and switch the policy.
    let old_policy_hash = config.policy_hash;
    config.policy_hash = marker.new_policy_hash;
    let record = &mut ctx.accounts.policy_change;
    record.multisig = multisig_key;
    record.tx_index = tx_index;
    record.old_policy_hash = old_policy_hash;
    record.new_policy_hash = marker.new_policy_hash;
    record.approved_at = approved_at;
    record.applied_at = now;
    record.bump = ctx.bumps.policy_change;

    emit!(PolicyChanged { multisig: multisig_key, tx_index, old_policy_hash, new_policy_hash: marker.new_policy_hash });
    Ok(())
}
