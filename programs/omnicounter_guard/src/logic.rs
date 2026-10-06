use anchor_lang::error::Error;
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GuardError;
use crate::state::{GuardConfig, ReviewStatus};

pub fn sha256(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

/// SHA-256(settlement_intent_hash || trade_ref_hash). Same as `intentHash` in packages/shared.
pub fn intent_hash(settlement_intent_hash: &[u8; 32], trade_ref_hash: &[u8; 32]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[settlement_intent_hash, trade_ref_hash]).to_bytes()
}

fn not_squads() -> Error {
    error!(GuardError::NotSquadsAccount)
}

fn read_pubkey(d: &[u8], off: usize) -> Result<Pubkey> {
    let s: [u8; 32] = d.get(off..off + 32).ok_or_else(not_squads)?.try_into().unwrap();
    Ok(Pubkey::new_from_array(s))
}

fn read_u64(d: &[u8], off: usize) -> Result<u64> {
    let s: [u8; 8] = d.get(off..off + 8).ok_or_else(not_squads)?.try_into().unwrap();
    Ok(u64::from_le_bytes(s))
}

fn read_u32(d: &[u8], off: usize) -> Result<u32> {
    let s: [u8; 4] = d.get(off..off + 4).ok_or_else(not_squads)?.try_into().unwrap();
    Ok(u32::from_le_bytes(s))
}

pub struct VaultTxHeader {
    pub multisig: Pubkey,
    pub index: u64,
}

/// Squads VaultTransaction: discriminator, multisig (8..40), creator (40..72), index (72..80).
pub fn parse_vault_transaction(data: &[u8]) -> Result<VaultTxHeader> {
    require!(data.len() >= 80 && data[..8] == VAULT_TRANSACTION_DISCRIMINATOR, GuardError::NotSquadsAccount);
    Ok(VaultTxHeader { multisig: read_pubkey(data, 8)?, index: read_u64(data, 72)? })
}

/// Review PDA seed taken from raw vault transaction bytes during account validation.
/// Bad data yields zeros; the handler then rejects the account with NotSquadsAccount.
pub fn tx_index_seed_from(data: &[u8]) -> [u8; 8] {
    data.get(72..80).map(|s| s.try_into().unwrap()).unwrap_or([0u8; 8])
}

pub struct ProposalHeader {
    pub multisig: Pubkey,
    pub transaction_index: u64,
}

/// Squads Proposal: discriminator, multisig (8..40), transaction_index (40..48).
pub fn parse_proposal(data: &[u8]) -> Result<ProposalHeader> {
    require!(data.len() >= 48 && data[..8] == PROPOSAL_DISCRIMINATOR, GuardError::NotSquadsAccount);
    Ok(ProposalHeader { multisig: read_pubkey(data, 8)?, transaction_index: read_u64(data, 40)? })
}

pub struct MultisigInfo {
    pub config_authority: Pubkey,
    pub members: Vec<(Pubkey, u8)>,
}

/// Squads Multisig: create_key (8..40), config_authority (40..72), threshold u16, time_lock u32,
/// transaction_index u64, stale_transaction_index u64, rent_collector Option<Pubkey> (tag at 94),
/// bump u8, members Vec<{ key, mask u8 }>.
pub fn parse_multisig(data: &[u8]) -> Result<MultisigInfo> {
    require!(data.len() >= 96 && data[..8] == MULTISIG_DISCRIMINATOR, GuardError::NotSquadsAccount);
    let config_authority = read_pubkey(data, 40)?;
    let bump_at = match data[94] {
        0 => 95,
        1 => 127,
        _ => return err!(GuardError::NotSquadsAccount),
    };
    let mut off = bump_at + 1;
    let len = read_u32(data, off)? as usize;
    off += 4;
    let mut members = Vec::with_capacity(len.min(32));
    for _ in 0..len {
        let key = read_pubkey(data, off)?;
        let mask = *data.get(off + 32).ok_or_else(not_squads)?;
        members.push((key, mask));
        off += 33;
    }
    Ok(MultisigInfo { config_authority, members })
}

/// The firewall only holds if the guard's executor is the only member able to execute
/// and nobody can change members outside a (guarded) config transaction.
pub fn check_sole_executor(info: &MultisigInfo, executor: &Pubkey) -> Result<()> {
    require_keys_eq!(info.config_authority, Pubkey::default(), GuardError::InvalidMultisigConfig);
    let mut found = false;
    for (key, mask) in &info.members {
        if key == executor {
            require!(*mask == PERMISSION_EXECUTE, GuardError::InvalidMultisigConfig);
            found = true;
        } else {
            require!(mask & PERMISSION_EXECUTE == 0, GuardError::InvalidMultisigConfig);
        }
    }
    require!(found, GuardError::InvalidMultisigConfig);
    Ok(())
}

pub struct ReportPayload {
    pub verdict: u8,
    pub reason: u16,
    pub msg_hash: [u8; 32],
    pub intent_hash: [u8; 32],
    pub policy_hash: [u8; 32],
    pub expires_at: i64,
}

/// Fixed 107-byte little-endian layout, see packages/shared/src/report.ts.
pub fn decode_report(bytes: &[u8], now: i64) -> Result<ReportPayload> {
    require!(bytes.len() == REPORT_PAYLOAD_LEN, GuardError::InvalidPayload);
    let verdict = bytes[0];
    require!(verdict == VERDICT_APPROVE || verdict == VERDICT_REJECT, GuardError::InvalidPayload);
    let reason = u16::from_le_bytes([bytes[1], bytes[2]]);
    require!(reason <= MAX_REASON, GuardError::InvalidPayload);
    let expires_at = i64::from_le_bytes(bytes[99..107].try_into().unwrap());
    require!(expires_at > now, GuardError::InvalidPayload);
    Ok(ReportPayload {
        verdict,
        reason,
        msg_hash: bytes[3..35].try_into().unwrap(),
        intent_hash: bytes[35..67].try_into().unwrap(),
        policy_hash: bytes[67..99].try_into().unwrap(),
        expires_at,
    })
}

/// Keystone forwarder check: configured state, owned by the configured forwarder program,
/// authority = PDA ["forwarder", state, guard_id] under that program, and it signed.
pub fn verify_forwarder(
    state_key: &Pubkey,
    state_owner: &Pubkey,
    authority_key: &Pubkey,
    authority_is_signer: bool,
    config: &GuardConfig,
) -> Result<()> {
    require_keys_eq!(*state_key, config.forwarder_state, GuardError::InvalidForwarder);
    require_keys_eq!(*state_owner, config.forwarder_program, GuardError::InvalidForwarder);
    let (expected, _) =
        Pubkey::find_program_address(&[FORWARDER_SEED, state_key.as_ref(), crate::ID.as_ref()], &config.forwarder_program);
    require_keys_eq!(*authority_key, expected, GuardError::InvalidForwarder);
    require!(authority_is_signer, GuardError::InvalidForwarder);
    Ok(())
}

/// The forwarder authority PDA is shared by every workflow that targets this receiver,
/// so the report must also come from the configured workflow owner.
pub fn verify_workflow(metadata: &[u8], expected_owner: &[u8; 20]) -> Result<()> {
    require!(metadata.len() == REPORT_METADATA_LEN, GuardError::InvalidWorkflow);
    require!(
        metadata[WORKFLOW_OWNER_OFFSET..WORKFLOW_OWNER_OFFSET + 20] == expected_owner[..],
        GuardError::InvalidWorkflow
    );
    Ok(())
}

/// System program AdvanceNonceAccount (bincode u32 tag 4).
pub fn is_advance_nonce(program_id: &Pubkey, data: &[u8]) -> bool {
    *program_id == anchor_lang::solana_program::system_program::ID && data.len() >= 4 && data[..4] == [4, 0, 0, 0]
}

pub fn check_executable(status: ReviewStatus, expires_at: i64, now: i64) -> Result<()> {
    match status {
        ReviewStatus::Approved => {}
        ReviewStatus::Executed => return err!(GuardError::AlreadyExecuted),
        _ => return err!(GuardError::NotApproved),
    }
    require!(now < expires_at, GuardError::Expired);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::error::Error;

    fn code_of<T>(r: Result<T>) -> u32 {
        match r {
            Err(Error::AnchorError(e)) => e.error_code_number,
            Err(e) => panic!("unexpected error {e:?}"),
            Ok(_) => panic!("expected an error"),
        }
    }
    // Anchor custom errors start at 6000.
    fn code(e: GuardError) -> u32 {
        e as u32 + 6000
    }
    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }
    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn vault_tx_bytes(multisig: Pubkey, index: u64) -> Vec<u8> {
        let mut d = VAULT_TRANSACTION_DISCRIMINATOR.to_vec();
        d.extend_from_slice(multisig.as_ref());
        d.extend_from_slice(key(9).as_ref()); // creator
        d.extend_from_slice(&index.to_le_bytes());
        d.extend_from_slice(&[255, 0, 254]); // bump, vault_index, vault_bump
        d.extend_from_slice(&0u32.to_le_bytes()); // ephemeral_signer_bumps
        d
    }

    fn proposal_bytes(multisig: Pubkey, index: u64) -> Vec<u8> {
        let mut d = PROPOSAL_DISCRIMINATOR.to_vec();
        d.extend_from_slice(multisig.as_ref());
        d.extend_from_slice(&index.to_le_bytes());
        d.push(1); // Active
        d.extend_from_slice(&0i64.to_le_bytes());
        d.push(255); // bump
        for _ in 0..3 {
            d.extend_from_slice(&0u32.to_le_bytes());
        }
        d
    }

    fn multisig_bytes(config_authority: Pubkey, rent_collector: Option<Pubkey>, members: &[(Pubkey, u8)]) -> Vec<u8> {
        let mut d = MULTISIG_DISCRIMINATOR.to_vec();
        d.extend_from_slice(key(7).as_ref()); // create_key
        d.extend_from_slice(config_authority.as_ref());
        d.extend_from_slice(&3u16.to_le_bytes()); // threshold
        d.extend_from_slice(&0u32.to_le_bytes()); // time_lock
        d.extend_from_slice(&0u64.to_le_bytes()); // transaction_index
        d.extend_from_slice(&0u64.to_le_bytes()); // stale_transaction_index
        match rent_collector {
            None => d.push(0),
            Some(k) => {
                d.push(1);
                d.extend_from_slice(k.as_ref());
            }
        }
        d.push(255); // bump
        d.extend_from_slice(&(members.len() as u32).to_le_bytes());
        for (k, mask) in members {
            d.extend_from_slice(k.as_ref());
            d.push(*mask);
        }
        d
    }

    fn payload(verdict: u8, reason: u16, expires_at: i64) -> Vec<u8> {
        let mut d = vec![verdict];
        d.extend_from_slice(&reason.to_le_bytes());
        d.extend_from_slice(&[1u8; 32]);
        d.extend_from_slice(&[2u8; 32]);
        d.extend_from_slice(&[3u8; 32]);
        d.extend_from_slice(&expires_at.to_le_bytes());
        d
    }

    const HUMAN: u8 = 1 | 2; // Initiate + Vote

    // sha256

    #[test]
    fn sha256_known_vector() {
        assert_eq!(hex(&sha256(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn intent_hash_matches_shared_ts_vectors() {
        assert_eq!(hex(&intent_hash(&[0; 32], &[0; 32])), "f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b");
        let a: [u8; 32] = core::array::from_fn(|i| i as u8);
        let b: [u8; 32] = core::array::from_fn(|i| i as u8 + 32);
        assert_eq!(hex(&intent_hash(&a, &b)), "fdeab9acf3710362bd2658cdc9a29e8f9c757fcf9811603a8c447cd1d9151108");
    }

    // Squads parsing

    #[test]
    fn parses_vault_transaction_header() {
        let h = parse_vault_transaction(&vault_tx_bytes(key(1), 42)).unwrap();
        assert_eq!(h.multisig, key(1));
        assert_eq!(h.index, 42);
    }

    #[test]
    fn proposal_bytes_are_not_a_vault_transaction() {
        assert_eq!(code_of(parse_vault_transaction(&proposal_bytes(key(1), 42))), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn short_vault_transaction_is_rejected() {
        assert_eq!(code_of(parse_vault_transaction(&vault_tx_bytes(key(1), 1)[..79])), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn parses_proposal_header() {
        let h = parse_proposal(&proposal_bytes(key(2), 7)).unwrap();
        assert_eq!(h.multisig, key(2));
        assert_eq!(h.transaction_index, 7);
    }

    #[test]
    fn vault_transaction_bytes_are_not_a_proposal() {
        assert_eq!(code_of(parse_proposal(&vault_tx_bytes(key(2), 7))), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn tx_index_seed_reads_bytes_72_to_80_or_zero() {
        assert_eq!(tx_index_seed_from(&vault_tx_bytes(key(1), 258)), [2, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(tx_index_seed_from(&[0u8; 10]), [0u8; 8]);
    }

    #[test]
    fn parses_multisig_without_rent_collector() {
        let m = parse_multisig(&multisig_bytes(Pubkey::default(), None, &[(key(1), HUMAN), (key(4), PERMISSION_EXECUTE)])).unwrap();
        assert_eq!(m.config_authority, Pubkey::default());
        assert_eq!(m.members, vec![(key(1), HUMAN), (key(4), PERMISSION_EXECUTE)]);
    }

    #[test]
    fn parses_multisig_with_rent_collector() {
        let m = parse_multisig(&multisig_bytes(Pubkey::default(), Some(key(8)), &[(key(4), PERMISSION_EXECUTE)])).unwrap();
        assert_eq!(m.members, vec![(key(4), PERMISSION_EXECUTE)]);
    }

    #[test]
    fn multisig_with_bad_option_tag_is_rejected() {
        let mut d = multisig_bytes(Pubkey::default(), None, &[]);
        d[94] = 2;
        assert_eq!(code_of(parse_multisig(&d)), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn truncated_member_list_is_rejected() {
        let d = multisig_bytes(Pubkey::default(), None, &[(key(1), HUMAN)]);
        assert_eq!(code_of(parse_multisig(&d[..d.len() - 1])), code(GuardError::NotSquadsAccount));
    }

    // Sole executor

    fn members_ok() -> Vec<(Pubkey, u8)> {
        vec![(key(1), HUMAN), (key(2), HUMAN), (key(3), HUMAN), (key(4), PERMISSION_EXECUTE)]
    }

    #[test]
    fn sole_executor_accepts_autonomous_multisig() {
        let m = MultisigInfo { config_authority: Pubkey::default(), members: members_ok() };
        check_sole_executor(&m, &key(4)).unwrap();
    }

    #[test]
    fn sole_executor_rejects_config_authority() {
        let m = MultisigInfo { config_authority: key(9), members: members_ok() };
        assert_eq!(code_of(check_sole_executor(&m, &key(4))), code(GuardError::InvalidMultisigConfig));
    }

    #[test]
    fn sole_executor_rejects_human_with_execute() {
        let mut members = members_ok();
        members[0].1 = HUMAN | PERMISSION_EXECUTE;
        let m = MultisigInfo { config_authority: Pubkey::default(), members };
        assert_eq!(code_of(check_sole_executor(&m, &key(4))), code(GuardError::InvalidMultisigConfig));
    }

    #[test]
    fn sole_executor_rejects_executor_with_vote() {
        let mut members = members_ok();
        members[3].1 = PERMISSION_EXECUTE | 2;
        let m = MultisigInfo { config_authority: Pubkey::default(), members };
        assert_eq!(code_of(check_sole_executor(&m, &key(4))), code(GuardError::InvalidMultisigConfig));
    }

    #[test]
    fn sole_executor_rejects_missing_executor() {
        let m = MultisigInfo { config_authority: Pubkey::default(), members: members_ok()[..3].to_vec() };
        assert_eq!(code_of(check_sole_executor(&m, &key(4))), code(GuardError::InvalidMultisigConfig));
    }

    // Report payload

    #[test]
    fn decodes_valid_payload() {
        let p = decode_report(&payload(VERDICT_APPROVE, 0, 1_000), 999).unwrap();
        assert_eq!(p.verdict, VERDICT_APPROVE);
        assert_eq!(p.reason, 0);
        assert_eq!(p.msg_hash, [1u8; 32]);
        assert_eq!(p.intent_hash, [2u8; 32]);
        assert_eq!(p.policy_hash, [3u8; 32]);
        assert_eq!(p.expires_at, 1_000);
    }

    #[test]
    fn payload_length_must_be_exact() {
        let p = payload(VERDICT_APPROVE, 0, 1_000);
        assert_eq!(code_of(decode_report(&p[..106], 0)), code(GuardError::InvalidPayload));
        let mut long = p.clone();
        long.push(0);
        assert_eq!(code_of(decode_report(&long, 0)), code(GuardError::InvalidPayload));
    }

    #[test]
    fn verdict_must_be_1_or_2() {
        assert_eq!(code_of(decode_report(&payload(0, 0, 1_000), 0)), code(GuardError::InvalidPayload));
        assert_eq!(code_of(decode_report(&payload(3, 0, 1_000), 0)), code(GuardError::InvalidPayload));
    }

    #[test]
    fn reason_is_range_checked() {
        assert!(decode_report(&payload(VERDICT_REJECT, 22, 1_000), 0).is_ok());
        assert_eq!(code_of(decode_report(&payload(VERDICT_REJECT, 23, 1_000), 0)), code(GuardError::InvalidPayload));
    }

    #[test]
    fn expiry_must_be_in_the_future() {
        assert!(decode_report(&payload(VERDICT_APPROVE, 0, 1_001), 1_000).is_ok());
        assert_eq!(code_of(decode_report(&payload(VERDICT_APPROVE, 0, 1_000), 1_000)), code(GuardError::InvalidPayload));
    }

    #[test]
    fn reject_with_past_expiry_is_invalid() {
        assert_eq!(code_of(decode_report(&payload(VERDICT_REJECT, 12, 10), 1_000)), code(GuardError::InvalidPayload));
    }

    // Forwarder

    fn config(forwarder_program: Pubkey, forwarder_state: Pubkey) -> GuardConfig {
        GuardConfig { multisig: key(1), forwarder_program, forwarder_state, policy_hash: [3; 32], workflow_owner: [7; 20], bump: 255, executor_bump: 255 }
    }

    fn authority_for(state: &Pubkey, forwarder_program: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[FORWARDER_SEED, state.as_ref(), crate::ID.as_ref()], forwarder_program).0
    }

    #[test]
    fn forwarder_accepts_configured_state_and_authority() {
        let (prog, state) = (key(20), key(21));
        verify_forwarder(&state, &prog, &authority_for(&state, &prog), true, &config(prog, state)).unwrap();
    }

    #[test]
    fn forwarder_rejects_other_state() {
        let (prog, state, other) = (key(20), key(21), key(22));
        assert_eq!(
            code_of(verify_forwarder(&other, &prog, &authority_for(&other, &prog), true, &config(prog, state))),
            code(GuardError::InvalidForwarder)
        );
    }

    #[test]
    fn forwarder_rejects_state_with_wrong_owner() {
        let (prog, state) = (key(20), key(21));
        assert_eq!(
            code_of(verify_forwarder(&state, &key(23), &authority_for(&state, &prog), true, &config(prog, state))),
            code(GuardError::InvalidForwarder)
        );
    }

    #[test]
    fn forwarder_rejects_wrong_authority() {
        let (prog, state) = (key(20), key(21));
        assert_eq!(code_of(verify_forwarder(&state, &prog, &key(24), true, &config(prog, state))), code(GuardError::InvalidForwarder));
    }

    #[test]
    fn forwarder_rejects_unsigned_authority() {
        let (prog, state) = (key(20), key(21));
        assert_eq!(
            code_of(verify_forwarder(&state, &prog, &authority_for(&state, &prog), false, &config(prog, state))),
            code(GuardError::InvalidForwarder)
        );
    }

    // Workflow binding (metadata: workflow_cid 32 | workflow_name 10 | workflow_owner 20 | report_id 2)

    fn metadata(owner: [u8; 20]) -> Vec<u8> {
        let mut m = vec![0xAAu8; 32];
        m.extend_from_slice(&[0xBBu8; 10]);
        m.extend_from_slice(&owner);
        m.extend_from_slice(&[0, 1]);
        m
    }

    #[test]
    fn workflow_accepts_configured_owner() {
        verify_workflow(&metadata([7; 20]), &[7; 20]).unwrap();
    }

    #[test]
    fn workflow_rejects_other_owner() {
        assert_eq!(code_of(verify_workflow(&metadata([8; 20]), &[7; 20])), code(GuardError::InvalidWorkflow));
    }

    #[test]
    fn workflow_metadata_must_be_64_bytes() {
        let m = metadata([7; 20]);
        assert_eq!(code_of(verify_workflow(&m[..63], &[7; 20])), code(GuardError::InvalidWorkflow));
        let mut long = m.clone();
        long.push(0);
        assert_eq!(code_of(verify_workflow(&long, &[7; 20])), code(GuardError::InvalidWorkflow));
    }

    // Durable nonce

    #[test]
    fn detects_advance_nonce_account() {
        let system = anchor_lang::solana_program::system_program::ID;
        assert!(is_advance_nonce(&system, &[4, 0, 0, 0]));
        assert!(!is_advance_nonce(&system, &[2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])); // Transfer
        assert!(!is_advance_nonce(&key(5), &[4, 0, 0, 0]));
        assert!(!is_advance_nonce(&system, &[4]));
    }

    // Execution status

    #[test]
    fn approved_and_unexpired_is_executable() {
        check_executable(ReviewStatus::Approved, 1_001, 1_000).unwrap();
    }

    #[test]
    fn pending_and_rejected_are_not_approved() {
        assert_eq!(code_of(check_executable(ReviewStatus::Pending, 1_001, 1_000)), code(GuardError::NotApproved));
        assert_eq!(code_of(check_executable(ReviewStatus::Rejected, 1_001, 1_000)), code(GuardError::NotApproved));
    }

    #[test]
    fn executed_is_already_executed() {
        assert_eq!(code_of(check_executable(ReviewStatus::Executed, 1_001, 1_000)), code(GuardError::AlreadyExecuted));
    }

    #[test]
    fn approval_expires_at_expires_at() {
        assert_eq!(code_of(check_executable(ReviewStatus::Approved, 1_000, 1_000)), code(GuardError::Expired));
    }
}
