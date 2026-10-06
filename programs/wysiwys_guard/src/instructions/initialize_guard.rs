use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GuardError;
use crate::logic;
use crate::state::GuardConfig;

#[derive(Accounts)]
pub struct InitializeGuard<'info> {
    /// CHECK: Squads multisig. Owner checked here; discriminator, PDA and members in the handler.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub multisig: UncheckedAccount<'info>,
    /// The Squads create_key. Signing proves the caller created this multisig (no front-running).
    pub create_key: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + GuardConfig::INIT_SPACE,
        seeds = [CONFIG_SEED, multisig.key().as_ref()],
        bump
    )]
    pub config: Account<'info, GuardConfig>,
    /// CHECK: PDA signer for the Squads execute CPI. Holds no data.
    #[account(seeds = [EXECUTOR_SEED, multisig.key().as_ref()], bump)]
    pub executor: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_guard(
    ctx: Context<InitializeGuard>,
    forwarder_program: Pubkey,
    forwarder_state: Pubkey,
    policy_hash: [u8; 32],
    workflow_owner: [u8; 20],
    max_review_lifetime: i64,
    review_deadline_secs: i64,
) -> Result<()> {
    require!(max_review_lifetime > 0 && review_deadline_secs > 0, GuardError::InvalidConfig);
    let multisig = ctx.accounts.multisig.key();
    let (expected, _) = Pubkey::find_program_address(
        &[b"multisig", b"multisig", ctx.accounts.create_key.key().as_ref()],
        &SQUADS_PROGRAM_ID,
    );
    require_keys_eq!(expected, multisig, GuardError::WrongMultisig);

    let info = logic::parse_multisig(&ctx.accounts.multisig.try_borrow_data()?)?;
    logic::check_sole_executor(&info, &ctx.accounts.executor.key())?;

    let config = &mut ctx.accounts.config;
    config.multisig = multisig;
    config.forwarder_program = forwarder_program;
    config.forwarder_state = forwarder_state;
    config.policy_hash = policy_hash;
    config.workflow_owner = workflow_owner;
    config.max_review_lifetime = max_review_lifetime;
    config.review_deadline_secs = review_deadline_secs;
    config.bump = ctx.bumps.config;
    config.executor_bump = ctx.bumps.executor;
    Ok(())
}
