use anchor_lang::prelude::*;

// Order is the error code contract with packages/shared/src/guard.ts (codes start at 6000).
#[error_code]
pub enum GuardError {
    #[msg("Account is not a Squads account of the expected type")]
    NotSquadsAccount,
    #[msg("Account belongs to a different multisig")]
    WrongMultisig,
    #[msg("Proposal and vault transaction indexes differ")]
    WrongTxIndex,
    #[msg("Accounts do not match the Review")]
    ReviewMismatch,
    #[msg("Vault transaction hash does not match the Review")]
    HashMismatch,
    #[msg("Review is not approved")]
    NotApproved,
    #[msg("Review approval has expired")]
    Expired,
    #[msg("Review was already executed")]
    AlreadyExecuted,
    #[msg("Invalid Review status transition")]
    InvalidStatusTransition,
    #[msg("Durable nonce transactions cannot execute payouts")]
    DurableNonceDetected,
    #[msg("Malformed report payload")]
    InvalidPayload,
    #[msg("CPI target is not the Squads program")]
    InvalidSquadsProgram,
    #[msg("Invalid instructions sysvar account")]
    InvalidInstructionsSysvar,
    #[msg("Report policy hash does not match the guard config")]
    PolicyMismatch,
    #[msg("Report did not come from the configured forwarder")]
    InvalidForwarder,
    #[msg("Multisig must be autonomous with the executor as the only Execute member")]
    InvalidMultisigConfig,
    #[msg("Vault transaction must not reference the executor PDA")]
    ExecutorInMessage,
    #[msg("Report was not produced by the configured CRE workflow owner")]
    InvalidWorkflow,
    #[msg("Only the creator of the vault transaction can request its review")]
    NotProposer,
    #[msg("Destination account no longer matches the reviewed destination")]
    DestinationChanged,
    #[msg("Report arrived after the review deadline")]
    ReviewDeadlinePassed,
    #[msg("Invalid guard configuration")]
    InvalidConfig,
}
