use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod logic;
pub mod state;

declare_id!("3jNv1XjPNeWUiZ8aiYheKJHknyjS81cpZfnPEp57CaH2");

#[program]
pub mod omnicounter_guard {}
