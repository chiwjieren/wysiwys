use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::constants::*;
use crate::errors::GuardError;
use crate::events::ConfigExecuted;
use crate::logic;
use crate::state::GuardConfig;

/// Executes a voted Squads config transaction through the executor PDA, only when every action keeps the
/// guard in control: adding or removing voters, changing the threshold, setting the time lock. After the
/// CPI the executor must still be the only Execute member of an autonomous multisig.
#[derive(Accounts)]
pub struct GuardedConfigExecute<'info> {
    #[account(
        seeds = [CONFIG_SEED, multisig.key().as_ref()],
        bump = config.bump,
        has_one = multisig @ GuardError::WrongMultisig
    )]
    pub config: Account<'info, GuardConfig>,
    /// CHECK: Squads multisig, bound by config.has_one; re-parsed after the CPI.
    #[account(mut, owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub multisig: UncheckedAccount<'info>,
    /// CHECK: Squads Proposal; Squads checks its PDA and Approved status.
    #[account(mut, owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: Squads ConfigTransaction; discriminator, multisig and every action checked in the handler.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub config_transaction: UncheckedAccount<'info>,
    /// CHECK: executor PDA, signs only the Squads execute CPIs.
    #[account(seeds = [EXECUTOR_SEED, multisig.key().as_ref()], bump = config.executor_bump)]
    pub executor: UncheckedAccount<'info>,
    /// Pays (or receives) rent if the multisig account is resized. The executor holds no funds.
    #[account(mut)]
    pub rent_payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: must be exactly the Squads program.
    #[account(address = SQUADS_PROGRAM_ID @ GuardError::InvalidSquadsProgram)]
    pub squads_program: UncheckedAccount<'info>,
    /// CHECK: address checked in the handler before it is read.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn handle_guarded_config_execute(ctx: Context<GuardedConfigExecute>) -> Result<()> {
    // Same rule as guarded_execute: verify the sysvar address, then refuse durable-nonce transactions.
    let ix_sysvar = ctx.accounts.instructions_sysvar.to_account_info();
    require_keys_eq!(*ix_sysvar.key, solana_instructions_sysvar::ID, GuardError::InvalidInstructionsSysvar);
    let first = solana_instructions_sysvar::load_instruction_at_checked(0, &ix_sysvar)
        .map_err(|_| error!(GuardError::InvalidInstructionsSysvar))?;
    require!(!logic::is_advance_nonce(&first.program_id, &first.data), GuardError::DurableNonceDetected);

    let a = &ctx.accounts;
    let multisig_key = a.multisig.key();
    let executor_key = a.executor.key();
    let tx_index = {
        let data = a.config_transaction.try_borrow_data()?;
        let header = logic::parse_config_transaction(&data)?;
        require_keys_eq!(header.multisig, multisig_key, GuardError::WrongMultisig);
        logic::check_config_actions(&data, &executor_key)?;
        header.index
    };

    let ix = Instruction {
        program_id: SQUADS_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(multisig_key, false),
            AccountMeta::new_readonly(executor_key, true),
            AccountMeta::new(a.proposal.key(), false),
            AccountMeta::new_readonly(a.config_transaction.key(), false),
            AccountMeta::new(a.rent_payer.key(), true),
            AccountMeta::new_readonly(a.system_program.key(), false),
        ],
        data: CONFIG_TRANSACTION_EXECUTE_DISCRIMINATOR.to_vec(),
    };
    let infos = [
        a.multisig.to_account_info(),
        a.executor.to_account_info(),
        a.proposal.to_account_info(),
        a.config_transaction.to_account_info(),
        a.rent_payer.to_account_info(),
        a.system_program.to_account_info(),
        a.squads_program.to_account_info(),
    ];
    let bump = [a.config.executor_bump];
    let executor_seeds: &[&[u8]] = &[EXECUTOR_SEED, multisig_key.as_ref(), &bump];
    // Security rule 2: the executor signs only Squads execute CPIs, here a checked config transaction.
    invoke_signed(&ix, &infos, &[executor_seeds])?;

    // The change must leave the guard in sole control of execution.
    let info = logic::parse_multisig(&a.multisig.try_borrow_data()?)?;
    logic::check_sole_executor(&info, &executor_key)?;

    emit!(ConfigExecuted { multisig: multisig_key, tx_index });
    Ok(())
}
