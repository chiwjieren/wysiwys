use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::constants::*;
use crate::errors::GuardError;
use crate::events::Executed;
use crate::logic;
use crate::state::{GuardConfig, Review, ReviewStatus};

/// Remaining accounts: the Squads message accounts, in the order Squads expects
/// (see @sqds/multisig accountsForTransactionExecute). They are passed through unchanged.
#[derive(Accounts)]
pub struct GuardedExecute<'info> {
    #[account(
        seeds = [CONFIG_SEED, multisig.key().as_ref()],
        bump = config.bump,
        has_one = multisig @ GuardError::WrongMultisig
    )]
    pub config: Account<'info, GuardConfig>,
    /// Multisig, PDA and account bindings checked in the handler, in a fixed order.
    #[account(mut)]
    pub review: Account<'info, Review>,
    /// CHECK: Squads multisig, bound by config.has_one; Squads re-validates it.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub multisig: UncheckedAccount<'info>,
    /// CHECK: must equal review.proposal (handler); Squads re-validates it.
    #[account(mut, owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: must equal review.vault_transaction and still hash to review.tx_hash (handler).
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub vault_transaction: UncheckedAccount<'info>,
    /// CHECK: must equal review.destination; for SPL its token program, mint and owner are re-checked (handler).
    pub destination: UncheckedAccount<'info>,
    /// CHECK: executor PDA, signs only the Squads CPI below.
    #[account(seeds = [EXECUTOR_SEED, multisig.key().as_ref()], bump = config.executor_bump)]
    pub executor: UncheckedAccount<'info>,
    /// CHECK: must be exactly the Squads program.
    #[account(address = SQUADS_PROGRAM_ID @ GuardError::InvalidSquadsProgram)]
    pub squads_program: UncheckedAccount<'info>,
    /// CHECK: address checked in the handler before it is read.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn handle_guarded_execute<'info>(ctx: Context<'info, GuardedExecute<'info>>) -> Result<()> {
    // Security rule 4: verify the sysvar address, then refuse durable-nonce transactions.
    let ix_sysvar = ctx.accounts.instructions_sysvar.to_account_info();
    require_keys_eq!(*ix_sysvar.key, solana_instructions_sysvar::ID, GuardError::InvalidInstructionsSysvar);
    let first = solana_instructions_sysvar::load_instruction_at_checked(0, &ix_sysvar)
        .map_err(|_| error!(GuardError::InvalidInstructionsSysvar))?;
    require!(!logic::is_advance_nonce(&first.program_id, &first.data), GuardError::DurableNonceDetected);

    let multisig_key = ctx.accounts.multisig.key();
    let proposal_key = ctx.accounts.proposal.key();
    let vault_tx_key = ctx.accounts.vault_transaction.key();
    let current_hash = logic::tx_hash(&vault_tx_key, &ctx.accounts.vault_transaction.try_borrow_data()?);
    // Security rule 2: if the message names the executor, the runtime merges it with the signed
    // executor account below and Squads could pass the signature to an inner instruction.
    let executor_key = ctx.accounts.executor.key();
    require!(
        ctx.remaining_accounts.iter().all(|acc| *acc.key != executor_key),
        GuardError::ExecutorInMessage
    );
    let now = Clock::get()?.unix_timestamp;

    let (review_key, tx_index) = {
        let review = &mut ctx.accounts.review;
        require_keys_eq!(review.multisig, multisig_key, GuardError::WrongMultisig);
        let expected = Pubkey::create_program_address(
            &[REVIEW_SEED, multisig_key.as_ref(), &review.tx_index.to_le_bytes(), &[review.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(GuardError::ReviewMismatch))?;
        require_keys_eq!(expected, review.key(), GuardError::ReviewMismatch);
        require_keys_eq!(review.vault_transaction, vault_tx_key, GuardError::ReviewMismatch);
        require_keys_eq!(review.proposal, proposal_key, GuardError::ReviewMismatch);
        logic::check_executable(review.status, review.expires_at, now)?;
        require!(current_hash == review.tx_hash, GuardError::HashMismatch);
        let dest = &ctx.accounts.destination;
        logic::check_destination(
            review.action_kind,
            &review.destination,
            &review.destination_owner,
            &review.mint,
            &dest.key(),
            dest.owner,
            &dest.try_borrow_data()?,
        )?;

        // Security rule 6: Executed is written before the CPI.
        review.status = ReviewStatus::Executed;
        (review.key(), review.tx_index)
    };
    anchor_lang::AccountsExit::exit(&ctx.accounts.review, &crate::ID)?;

    let a = &ctx.accounts;
    let mut metas = vec![
        AccountMeta::new_readonly(multisig_key, false),
        AccountMeta::new(proposal_key, false),
        AccountMeta::new_readonly(vault_tx_key, false),
        AccountMeta::new_readonly(a.executor.key(), true),
    ];
    let mut infos = vec![
        a.multisig.to_account_info(),
        a.proposal.to_account_info(),
        a.vault_transaction.to_account_info(),
        a.executor.to_account_info(),
    ];
    for acc in ctx.remaining_accounts.iter() {
        metas.push(AccountMeta { pubkey: *acc.key, is_signer: false, is_writable: acc.is_writable });
        infos.push(acc.clone());
    }
    infos.push(a.squads_program.to_account_info());

    let ix = Instruction {
        program_id: SQUADS_PROGRAM_ID,
        accounts: metas,
        data: VAULT_TRANSACTION_EXECUTE_DISCRIMINATOR.to_vec(),
    };
    let bump = [a.config.executor_bump];
    let executor_seeds: &[&[u8]] = &[EXECUTOR_SEED, multisig_key.as_ref(), &bump];
    // Security rule 2: the only invoke_signed in the guard.
    invoke_signed(&ix, &infos, &[executor_seeds])?;

    emit!(Executed { review: review_key, multisig: multisig_key, tx_index });
    Ok(())
}
