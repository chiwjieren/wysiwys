use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

declare_id!("EZFysCCewwyWGMoGPySCLRqNQUcz1sVLJbZCUKFWwkcr");

/// Anchor discriminator of global:on_report, as used by the Keystone and mock forwarders.
const ON_REPORT_DISCRIMINATOR: [u8; 8] = [214, 173, 18, 221, 173, 148, 151, 208];

/// Local-test stand-in for the Keystone forwarder: same CPI shape, same authority PDA scheme.
/// `seed_program` lets tests sign an authority derived for the wrong receiver.
#[program]
pub mod test_forwarder {
    use super::*;

    pub fn init_state(_ctx: Context<InitState>) -> Result<()> {
        Ok(())
    }

    pub fn forward<'info>(ctx: Context<'info, Forward<'info>>, seed_program: Pubkey, metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
        let state = ctx.accounts.state.key();
        let (authority, bump) =
            Pubkey::find_program_address(&[b"forwarder", state.as_ref(), seed_program.as_ref()], &crate::ID);
        require_keys_eq!(authority, ctx.accounts.authority.key());

        let mut data = ON_REPORT_DISCRIMINATOR.to_vec();
        metadata.serialize(&mut data)?;
        report.serialize(&mut data)?;

        let mut metas = vec![AccountMeta::new_readonly(state, false), AccountMeta::new_readonly(authority, true)];
        let mut infos = vec![ctx.accounts.state.to_account_info(), ctx.accounts.authority.to_account_info()];
        for acc in ctx.remaining_accounts.iter() {
            metas.push(AccountMeta { pubkey: *acc.key, is_signer: false, is_writable: acc.is_writable });
            infos.push(acc.clone());
        }
        infos.push(ctx.accounts.receiver_program.to_account_info());

        let ix = Instruction { program_id: ctx.accounts.receiver_program.key(), accounts: metas, data };
        invoke_signed(&ix, &infos, &[&[b"forwarder", state.as_ref(), seed_program.as_ref(), &[bump]]])?;
        Ok(())
    }
}

#[account]
pub struct ForwarderState {
    pub reserved: u8,
}

#[derive(Accounts)]
pub struct InitState<'info> {
    #[account(init, payer = payer, space = 8 + 1)]
    pub state: Account<'info, ForwarderState>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Forward<'info> {
    /// CHECK: any forwarder state; the receiver verifies it.
    pub state: UncheckedAccount<'info>,
    /// CHECK: PDA signed by this program.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: receiver program.
    pub receiver_program: UncheckedAccount<'info>,
}
