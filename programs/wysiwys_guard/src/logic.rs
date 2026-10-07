use anchor_lang::error::Error;
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GuardError;
use crate::state::{GuardConfig, ReviewStatus};

pub fn sha256(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

/// Domain-separated hash of the stored Squads message, bound to the VaultTransaction address.
/// Same as `txHash` in packages/shared.
pub fn tx_hash(vault_transaction: &Pubkey, data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[TX_HASH_DOMAIN, vault_transaction.as_ref(), data]).to_bytes()
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
    pub creator: Pubkey,
    pub index: u64,
}

/// Squads VaultTransaction: discriminator, multisig (8..40), creator (40..72), index (72..80).
pub fn parse_vault_transaction(data: &[u8]) -> Result<VaultTxHeader> {
    require!(data.len() >= 80 && data[..8] == VAULT_TRANSACTION_DISCRIMINATOR, GuardError::NotSquadsAccount);
    Ok(VaultTxHeader { multisig: read_pubkey(data, 8)?, creator: read_pubkey(data, 40)?, index: read_u64(data, 72)? })
}

/// Review PDA seed taken from raw vault transaction bytes during account validation.
/// Bad data yields zeros; the handler then rejects the account with NotSquadsAccount.
pub fn tx_index_seed_from(data: &[u8]) -> [u8; 8] {
    data.get(72..80).map(|s| s.try_into().unwrap()).unwrap_or([0u8; 8])
}

pub struct ConfigTxHeader {
    pub multisig: Pubkey,
    pub index: u64,
}

/// Squads ConfigTransaction: discriminator, multisig (8..40), creator (40..72), index (72..80), bump, actions.
pub fn parse_config_transaction(data: &[u8]) -> Result<ConfigTxHeader> {
    require!(data.len() >= 85 && data[..8] == CONFIG_TRANSACTION_DISCRIMINATOR, GuardError::NotSquadsAccount);
    Ok(ConfigTxHeader { multisig: read_pubkey(data, 8)?, index: read_u64(data, 72)? })
}

/// The only config changes the guard executes: add a voter (Initiate and/or Vote, never Execute, never
/// the executor), remove a member other than the executor, change the threshold, set the time lock.
/// Spending limits, rent collector and unknown actions could route funds or control around the guard.
pub fn check_config_actions(data: &[u8], executor: &Pubkey) -> Result<()> {
    parse_config_transaction(data)?;
    let count = read_u32(data, 81)? as usize;
    require!(count > 0, GuardError::ConfigActionNotAllowed);
    let mut off = 85;
    for _ in 0..count {
        let tag = *data.get(off).ok_or_else(not_squads)?;
        off += 1;
        match tag {
            CONFIG_ADD_MEMBER => {
                let key = read_pubkey(data, off)?;
                let mask = *data.get(off + 32).ok_or_else(not_squads)?;
                require!(key != *executor, GuardError::ConfigActionNotAllowed);
                require!(mask != 0 && mask & !(PERMISSION_INITIATE | PERMISSION_VOTE) == 0, GuardError::ConfigActionNotAllowed);
                off += 33;
            }
            CONFIG_REMOVE_MEMBER => {
                require!(read_pubkey(data, off)? != *executor, GuardError::ConfigActionNotAllowed);
                off += 32;
            }
            CONFIG_CHANGE_THRESHOLD => {
                require!(data.len() >= off + 2, GuardError::NotSquadsAccount);
                off += 2;
            }
            CONFIG_SET_TIME_LOCK => {
                require!(data.len() >= off + 4, GuardError::NotSquadsAccount);
                off += 4;
            }
            _ => return err!(GuardError::ConfigActionNotAllowed),
        }
    }
    require!(off == data.len(), GuardError::NotSquadsAccount);
    Ok(())
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
    pub tx_hash: [u8; 32],
    pub policy_hash: [u8; 32],
    pub action_kind: u8,
    pub destination_hash: [u8; 32],
    pub issued_at: i64,
    pub expires_at: i64,
}

fn bytes32(b: &[u8], off: usize) -> [u8; 32] {
    b[off..off + 32].try_into().unwrap()
}

fn i64_at(b: &[u8], off: usize) -> i64 {
    i64::from_le_bytes(b[off..off + 8].try_into().unwrap())
}

/// Binds the reviewed destination. Same as `destinationHash` in packages/shared.
/// SOL: destination = owner = recipient wallet, mint zero. SPL: token account, its owner wallet, its mint.
pub fn destination_hash(kind: u8, destination: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[DEST_HASH_DOMAIN, &[kind], destination.as_ref(), owner.as_ref(), mint.as_ref()]).to_bytes()
}

/// Fixed 117-byte little-endian layout v2, see packages/shared/src/report.ts.
pub fn decode_report(bytes: &[u8], now: i64) -> Result<ReportPayload> {
    require!(bytes.len() == REPORT_PAYLOAD_LEN, GuardError::InvalidPayload);
    require!(bytes[0] == REPORT_VERSION, GuardError::InvalidPayload);
    let verdict = bytes[1];
    require!(verdict == VERDICT_APPROVE || verdict == VERDICT_REJECT, GuardError::InvalidPayload);
    let reason = u16::from_le_bytes([bytes[2], bytes[3]]);
    require!(reason <= MAX_REASON, GuardError::InvalidPayload);

    let p = ReportPayload {
        verdict,
        reason,
        tx_hash: bytes32(bytes, 4),
        policy_hash: bytes32(bytes, 36),
        action_kind: bytes[68],
        destination_hash: bytes32(bytes, 69),
        issued_at: i64_at(bytes, 101),
        expires_at: i64_at(bytes, 109),
    };
    match p.action_kind {
        ACTION_NONE => {
            require!(verdict == VERDICT_REJECT, GuardError::InvalidPayload);
            require!(p.destination_hash == [0u8; 32], GuardError::InvalidPayload);
        }
        ACTION_SOL | ACTION_SPL => require!(p.destination_hash != [0u8; 32], GuardError::InvalidPayload),
        _ => return err!(GuardError::InvalidPayload),
    }
    require!(p.issued_at <= now + MAX_CLOCK_SKEW, GuardError::InvalidPayload);
    require!(p.expires_at > now && p.expires_at > p.issued_at, GuardError::InvalidPayload);
    Ok(p)
}

/// The report must arrive before the review deadline and may not approve for longer than the config allows.
pub fn check_report_times(p: &ReportPayload, created_at: i64, now: i64, config: &GuardConfig) -> Result<()> {
    require!(now <= created_at.saturating_add(config.review_deadline_secs), GuardError::ReviewDeadlinePassed);
    require!(p.expires_at - p.issued_at <= config.max_review_lifetime, GuardError::InvalidPayload);
    Ok(())
}

/// Recomputes the destination hash from the account passed to guarded_execute and its live data.
/// SPL: must still be a legacy Token account, initialized and not frozen, with the reviewed mint and
/// owner wallet. Any difference (other account, new owner, other mint) is DestinationChanged.
pub fn check_destination(action_kind: u8, expected_hash: &[u8; 32], key: &Pubkey, owner_program: &Pubkey, data: &[u8]) -> Result<()> {
    let current = match action_kind {
        ACTION_SOL => destination_hash(ACTION_SOL, key, key, &Pubkey::default()),
        ACTION_SPL => {
            require_keys_eq!(*owner_program, SPL_TOKEN_PROGRAM_ID, GuardError::DestinationChanged);
            require!(data.len() == SPL_TOKEN_ACCOUNT_LEN, GuardError::DestinationChanged);
            require!(data[SPL_TOKEN_STATE_OFFSET] == SPL_TOKEN_STATE_INITIALIZED, GuardError::DestinationChanged);
            let mint = Pubkey::new_from_array(bytes32(data, 0));
            let owner = Pubkey::new_from_array(bytes32(data, 32));
            destination_hash(ACTION_SPL, key, &owner, &mint)
        }
        _ => return err!(GuardError::DestinationChanged),
    };
    require!(current == *expected_hash, GuardError::DestinationChanged);
    Ok(())
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

/// A proposed policy change, from the marker instruction data.
pub struct PolicyChangeMarker {
    pub new_policy_hash: [u8; 32],
    pub expected_policy_hash: [u8; 32],
}

/// The marker, or None unless exactly 72 bytes with the marker discriminator and two different hashes.
pub fn parse_policy_change_marker(data: &[u8]) -> Option<PolicyChangeMarker> {
    if data.len() != POLICY_CHANGE_MARKER_LEN || data[..8] != POLICY_CHANGE_MARKER_DISCRIMINATOR {
        return None;
    }
    let new_policy_hash: [u8; 32] = data[8..40].try_into().ok()?;
    let expected_policy_hash: [u8; 32] = data[40..72].try_into().ok()?;
    if new_policy_hash == expected_policy_hash {
        return None;
    }
    Some(PolicyChangeMarker { new_policy_hash, expected_policy_hash })
}

/// Bounds-checked cursor over a Squads VaultTransaction; any overrun is an invalid policy change.
struct Cursor<'a> {
    d: &'a [u8],
    off: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.off.checked_add(n).ok_or_else(|| error!(GuardError::InvalidPolicyChange))?;
        let s = self.d.get(self.off..end).ok_or_else(|| error!(GuardError::InvalidPolicyChange))?;
        self.off = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn vec_len(&mut self) -> Result<usize> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as usize)
    }
    fn pubkey(&mut self) -> Result<Pubkey> {
        Ok(Pubkey::new_from_array(self.take(32)?.try_into().unwrap()))
    }
}

/// A policy change proposal's Squads VaultTransaction: no ephemeral signers, account keys exactly
/// [vault, guard], one instruction to the guard with no accounts whose data is the marker, no address
/// lookup tables. Layout (pinned Squads IDL): header (83 bytes), ephemeral_signer_bumps, then the message
/// (3 signer counts, account_keys, instructions { program_id_index, account_indexes, data }, lookups).
pub fn parse_policy_change_transaction(data: &[u8], guard: &Pubkey, vault: &Pubkey) -> Result<PolicyChangeMarker> {
    let invalid = || error!(GuardError::InvalidPolicyChange);
    if data.len() < 83 || data[..8] != VAULT_TRANSACTION_DISCRIMINATOR {
        return Err(invalid());
    }
    let mut c = Cursor { d: data, off: 83 };
    if c.vec_len()? != 0 {
        return Err(invalid());
    }
    c.take(3)?; // num_signers, num_writable_signers, num_writable_non_signers
    if c.vec_len()? != 2 || c.pubkey()? != *vault || c.pubkey()? != *guard {
        return Err(invalid());
    }
    if c.vec_len()? != 1 || c.u8()? != 1 || c.vec_len()? != 0 {
        return Err(invalid());
    }
    let len = c.vec_len()?;
    let marker = parse_policy_change_marker(c.take(len)?).ok_or_else(invalid)?;
    if c.vec_len()? != 0 {
        return Err(invalid());
    }
    Ok(marker)
}

/// Whether a Squads VaultTransaction's stored message lists `key` among its account keys.
pub fn message_has_account_key(data: &[u8], key: &Pubkey) -> Result<bool> {
    require!(data.len() >= 83 && data[..8] == VAULT_TRANSACTION_DISCRIMINATOR, GuardError::NotSquadsAccount);
    let mut c = Cursor { d: data, off: 83 };
    let scan = |c: &mut Cursor| -> Result<bool> {
        let ephemeral = c.vec_len()?;
        c.take(ephemeral)?;
        c.take(3)?;
        let n = c.vec_len()?;
        for _ in 0..n {
            if c.pubkey()? == *key {
                return Ok(true);
            }
        }
        Ok(false)
    };
    scan(&mut c).map_err(|_| not_squads())
}

/// Approval time of a Squads Proposal, or None for any status other than Approved. The status follows
/// multisig (8..40) and transaction_index (40..48); every variant but Executing carries a timestamp.
pub fn proposal_approved_at(data: &[u8]) -> Result<Option<i64>> {
    require!(data.len() >= 49 && data[..8] == PROPOSAL_DISCRIMINATOR, GuardError::NotSquadsAccount);
    match data[48] {
        PROPOSAL_STATUS_APPROVED => {
            // timestamp, bump, then approved, rejected and cancelled member lists must all be present.
            let mut c = Cursor { d: data, off: 49 };
            let parse = |c: &mut Cursor| -> Result<i64> {
                let ts = i64::from_le_bytes(c.take(8)?.try_into().unwrap());
                c.take(1)?;
                for _ in 0..3 {
                    let n = c.vec_len()?;
                    c.take(n.checked_mul(32).ok_or_else(not_squads)?)?;
                }
                Ok(ts)
            };
            parse(&mut c).map(Some).map_err(|_| not_squads())
        }
        0..=6 => Ok(None),
        _ => err!(GuardError::NotSquadsAccount),
    }
}

pub struct MultisigTiming {
    pub time_lock: u32,
    pub stale_transaction_index: u64,
}

/// Squads Multisig time_lock (74..78) and stale_transaction_index (86..94).
pub fn parse_multisig_timing(data: &[u8]) -> Result<MultisigTiming> {
    require!(data.len() >= 96 && data[..8] == MULTISIG_DISCRIMINATOR, GuardError::NotSquadsAccount);
    Ok(MultisigTiming { time_lock: read_u32(data, 74)?, stale_transaction_index: read_u64(data, 86)? })
}

/// A policy change applies no earlier than the longer of the Squads time lock and POLICY_CHANGE_MIN_DELAY.
pub fn policy_change_ready_at(approved_at: i64, time_lock: u32) -> i64 {
    approved_at.saturating_add((time_lock as i64).max(POLICY_CHANGE_MIN_DELAY))
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

    struct P {
        version: u8,
        verdict: u8,
        reason: u16,
        kind: u8,
        dest_hash: [u8; 32],
        issued_at: i64,
        expires_at: i64,
    }

    /// SPL approve, issued at 1_000, expiring at 1_600.
    fn spl() -> P {
        P { version: 2, verdict: VERDICT_APPROVE, reason: 0, kind: ACTION_SPL, dest_hash: [9u8; 32], issued_at: 1_000, expires_at: 1_600 }
    }

    fn sol() -> P {
        P { kind: ACTION_SOL, ..spl() }
    }

    fn bytes(p: &P) -> Vec<u8> {
        let mut d = vec![p.version, p.verdict];
        d.extend_from_slice(&p.reason.to_le_bytes());
        d.extend_from_slice(&[1u8; 32]); // tx_hash
        d.extend_from_slice(&[3u8; 32]); // policy_hash
        d.push(p.kind);
        d.extend_from_slice(&p.dest_hash);
        d.extend_from_slice(&p.issued_at.to_le_bytes());
        d.extend_from_slice(&p.expires_at.to_le_bytes());
        d
    }

    const NOW: i64 = 1_000;

    fn invalid(p: P) {
        assert_eq!(code_of(decode_report(&bytes(&p), NOW)), code(GuardError::InvalidPayload));
    }

    const HUMAN: u8 = 1 | 2; // Initiate + Vote

    // sha256

    #[test]
    fn sha256_known_vector() {
        assert_eq!(hex(&sha256(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn tx_hash_matches_shared_ts_vector() {
        assert_eq!(
            hex(&tx_hash(&Pubkey::default(), b"abc")),
            "e239731306bf53ae6cc15109d6a3ef161b7e97b4285c39cca41e4822c41b5954"
        );
    }

    #[test]
    fn tx_hash_is_bound_to_the_vault_transaction_address() {
        assert_ne!(tx_hash(&key(1), b"abc"), tx_hash(&key(2), b"abc"));
        assert_ne!(tx_hash(&key(1), b"abc"), sha256(b"abc"));
    }

    // Squads parsing

    #[test]
    fn parses_vault_transaction_header() {
        let h = parse_vault_transaction(&vault_tx_bytes(key(1), 42)).unwrap();
        assert_eq!(h.multisig, key(1));
        assert_eq!(h.creator, key(9));
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
    fn decodes_spl_payload() {
        let p = decode_report(&bytes(&spl()), NOW).unwrap();
        assert_eq!(REPORT_PAYLOAD_LEN, 117);
        assert_eq!(p.verdict, VERDICT_APPROVE);
        assert_eq!(p.reason, 0);
        assert_eq!(p.tx_hash, [1u8; 32]);
        assert_eq!(p.policy_hash, [3u8; 32]);
        assert_eq!(p.action_kind, ACTION_SPL);
        assert_eq!(p.destination_hash, [9u8; 32]);
        assert_eq!(p.issued_at, 1_000);
        assert_eq!(p.expires_at, 1_600);
    }

    #[test]
    fn decodes_sol_payload() {
        assert_eq!(decode_report(&bytes(&sol()), NOW).unwrap().action_kind, ACTION_SOL);
    }

    #[test]
    fn payload_length_must_be_exact() {
        let b = bytes(&spl());
        assert_eq!(code_of(decode_report(&b[..116], NOW)), code(GuardError::InvalidPayload));
        let mut long = b.clone();
        long.push(0);
        assert_eq!(code_of(decode_report(&long, NOW)), code(GuardError::InvalidPayload));
    }

    #[test]
    fn version_must_be_2() {
        invalid(P { version: 1, ..spl() });
        invalid(P { version: 3, ..spl() });
    }

    #[test]
    fn verdict_must_be_1_or_2() {
        invalid(P { verdict: 0, ..spl() });
        invalid(P { verdict: 3, ..spl() });
    }

    #[test]
    fn reason_is_range_checked() {
        assert!(decode_report(&bytes(&P { verdict: VERDICT_REJECT, reason: 13, ..spl() }), NOW).is_ok());
        invalid(P { verdict: VERDICT_REJECT, reason: 14, ..spl() });
    }

    #[test]
    fn approve_needs_a_destination() {
        invalid(P { kind: ACTION_NONE, dest_hash: [0u8; 32], ..spl() });
        invalid(P { dest_hash: [0u8; 32], ..spl() });
        let none = P { verdict: VERDICT_REJECT, reason: 8, kind: ACTION_NONE, dest_hash: [0u8; 32], ..spl() };
        assert!(decode_report(&bytes(&none), NOW).is_ok());
    }

    #[test]
    fn no_destination_must_have_a_zero_hash() {
        invalid(P { verdict: VERDICT_REJECT, reason: 8, kind: ACTION_NONE, ..spl() });
    }

    #[test]
    fn unknown_action_kind_is_invalid() {
        invalid(P { kind: 3, ..spl() });
    }

    #[test]
    fn issued_at_may_not_be_in_the_future_beyond_skew() {
        assert!(decode_report(&bytes(&P { issued_at: NOW + MAX_CLOCK_SKEW, ..spl() }), NOW).is_ok());
        invalid(P { issued_at: NOW + MAX_CLOCK_SKEW + 1, ..spl() });
    }

    #[test]
    fn expiry_must_be_in_the_future() {
        assert!(decode_report(&bytes(&P { expires_at: NOW + 1, ..spl() }), NOW).is_ok());
        invalid(P { expires_at: NOW, ..spl() });
    }

    #[test]
    fn reject_with_past_expiry_is_invalid() {
        invalid(P { verdict: VERDICT_REJECT, reason: 8, expires_at: 10, issued_at: 5, ..spl() });
    }

    // Report time bounds against config

    #[test]
    fn report_within_deadline_and_lifetime_is_accepted() {
        let p = decode_report(&bytes(&spl()), NOW).unwrap();
        // created at 500, deadline 900s -> 1_400; lifetime 600 == 1_600 - 1_000.
        check_report_times(&p, 500, NOW, &config(key(20), key(21))).unwrap();
    }

    #[test]
    fn report_after_the_review_deadline_is_refused() {
        let p = decode_report(&bytes(&spl()), NOW).unwrap();
        assert_eq!(code_of(check_report_times(&p, 99, NOW, &config(key(20), key(21)))), code(GuardError::ReviewDeadlinePassed));
        check_report_times(&p, 100, NOW, &config(key(20), key(21))).unwrap();
    }

    #[test]
    fn approval_window_longer_than_max_lifetime_is_refused() {
        let p = decode_report(&bytes(&P { expires_at: 1_601, ..spl() }), NOW).unwrap();
        assert_eq!(code_of(check_report_times(&p, 500, NOW, &config(key(20), key(21)))), code(GuardError::InvalidPayload));
    }

    // Destination binding and re-check at execution

    fn from_hex(h: &str) -> [u8; 32] {
        core::array::from_fn(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap())
    }

    #[test]
    fn destination_hash_matches_shared_ts_vectors() {
        assert_eq!(
            destination_hash(ACTION_SPL, &key(3), &key(4), &key(5)),
            from_hex("7c55facd8ebf19ba72048503dd3e5852e51992c9d921d14f19eb731a15a4fe27")
        );
        assert_eq!(
            destination_hash(ACTION_SOL, &key(7), &key(7), &Pubkey::default()),
            from_hex("f19d30a01abfca20f15278b788f55568b87bd01ea9834782df2d5b5e84933deb")
        );
    }

    /// SPL token account: mint 0..32, owner 32..64, amount, delegate, state at 108, ... (165 bytes).
    fn token_account(mint: Pubkey, owner: Pubkey, state: u8) -> Vec<u8> {
        let mut d = vec![0u8; 165];
        d[0..32].copy_from_slice(mint.as_ref());
        d[32..64].copy_from_slice(owner.as_ref());
        d[108] = state;
        d
    }

    /// Reviewed: token account key(30) owned by wallet key(31), mint key(32).
    fn reviewed_spl() -> [u8; 32] {
        destination_hash(ACTION_SPL, &key(30), &key(31), &key(32))
    }

    fn check_spl(key_: Pubkey, program: Pubkey, data: &[u8]) -> Result<()> {
        check_destination(ACTION_SPL, &reviewed_spl(), &key_, &program, data)
    }

    #[test]
    fn spl_destination_unchanged_is_accepted() {
        check_spl(key(30), SPL_TOKEN_PROGRAM_ID, &token_account(key(32), key(31), 1)).unwrap();
    }

    #[test]
    fn spl_destination_changes_are_refused() {
        let changed = code(GuardError::DestinationChanged);
        assert_eq!(code_of(check_spl(key(35), SPL_TOKEN_PROGRAM_ID, &token_account(key(32), key(31), 1))), changed);
        assert_eq!(code_of(check_spl(key(30), key(36), &token_account(key(32), key(31), 1))), changed);
        assert_eq!(code_of(check_spl(key(30), SPL_TOKEN_PROGRAM_ID, &token_account(key(37), key(31), 1))), changed);
        assert_eq!(code_of(check_spl(key(30), SPL_TOKEN_PROGRAM_ID, &token_account(key(32), key(38), 1))), changed);
        assert_eq!(code_of(check_spl(key(30), SPL_TOKEN_PROGRAM_ID, &token_account(key(32), key(31), 2))), changed); // frozen
        assert_eq!(code_of(check_spl(key(30), SPL_TOKEN_PROGRAM_ID, &token_account(key(32), key(31), 1)[..164])), changed);
    }

    #[test]
    fn sol_destination_must_be_the_reviewed_wallet() {
        let sys = anchor_lang::solana_program::system_program::ID;
        let reviewed = destination_hash(ACTION_SOL, &key(33), &key(33), &Pubkey::default());
        check_destination(ACTION_SOL, &reviewed, &key(33), &sys, &[]).unwrap();
        assert_eq!(code_of(check_destination(ACTION_SOL, &reviewed, &key(34), &sys, &[])), code(GuardError::DestinationChanged));
    }

    #[test]
    fn a_hash_for_another_kind_does_not_match() {
        let sys = anchor_lang::solana_program::system_program::ID;
        // An SPL hash cannot be satisfied by passing a SOL-style account and vice versa.
        assert_eq!(code_of(check_destination(ACTION_SOL, &reviewed_spl(), &key(30), &sys, &[])), code(GuardError::DestinationChanged));
    }

    #[test]
    fn no_destination_is_never_executable() {
        assert_eq!(
            code_of(check_destination(ACTION_NONE, &[0u8; 32], &Pubkey::default(), &key(1), &[])),
            code(GuardError::DestinationChanged)
        );
    }

    // Forwarder

    fn config(forwarder_program: Pubkey, forwarder_state: Pubkey) -> GuardConfig {
        GuardConfig {
            multisig: key(1),
            forwarder_program,
            forwarder_state,
            policy_hash: [3; 32],
            workflow_owner: [7; 20],
            max_review_lifetime: 600,
            review_deadline_secs: 900,
            bump: 255,
            executor_bump: 255,
        }
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

    // Config transactions (guarded_config_execute)

    fn config_tx_bytes(multisig: Pubkey, index: u64, actions: &[Vec<u8>]) -> Vec<u8> {
        let mut d = CONFIG_TRANSACTION_DISCRIMINATOR.to_vec();
        d.extend_from_slice(multisig.as_ref());
        d.extend_from_slice(key(9).as_ref()); // creator
        d.extend_from_slice(&index.to_le_bytes());
        d.push(255); // bump
        d.extend_from_slice(&(actions.len() as u32).to_le_bytes());
        for a in actions {
            d.extend_from_slice(a);
        }
        d
    }
    fn add_member(k: Pubkey, mask: u8) -> Vec<u8> {
        let mut a = vec![0u8];
        a.extend_from_slice(k.as_ref());
        a.push(mask);
        a
    }
    fn remove_member(k: Pubkey) -> Vec<u8> {
        let mut a = vec![1u8];
        a.extend_from_slice(k.as_ref());
        a
    }
    fn change_threshold(t: u16) -> Vec<u8> {
        let mut a = vec![2u8];
        a.extend_from_slice(&t.to_le_bytes());
        a
    }
    fn set_time_lock(t: u32) -> Vec<u8> {
        let mut a = vec![3u8];
        a.extend_from_slice(&t.to_le_bytes());
        a
    }

    #[test]
    fn parses_config_transaction_header() {
        let h = parse_config_transaction(&config_tx_bytes(key(1), 7, &[change_threshold(2)])).unwrap();
        assert_eq!(h.multisig, key(1));
        assert_eq!(h.index, 7);
    }

    #[test]
    fn vault_transaction_bytes_are_not_a_config_transaction() {
        assert_eq!(code_of(parse_config_transaction(&vault_tx_bytes(key(1), 7))), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn safe_member_and_threshold_changes_are_allowed() {
        let d = config_tx_bytes(
            key(1),
            3,
            &[add_member(key(20), HUMAN), add_member(key(21), 2), remove_member(key(22)), change_threshold(2), set_time_lock(0)],
        );
        check_config_actions(&d, &key(4)).unwrap();
    }

    #[test]
    fn adding_a_member_with_execute_is_refused() {
        let refused = code(GuardError::ConfigActionNotAllowed);
        for mask in [PERMISSION_EXECUTE, HUMAN | PERMISSION_EXECUTE, 0u8, 8u8] {
            assert_eq!(code_of(check_config_actions(&config_tx_bytes(key(1), 1, &[add_member(key(20), mask)]), &key(4))), refused, "mask {mask}");
        }
    }

    #[test]
    fn the_executor_cannot_be_added_or_removed() {
        let refused = code(GuardError::ConfigActionNotAllowed);
        assert_eq!(code_of(check_config_actions(&config_tx_bytes(key(1), 1, &[add_member(key(4), 2)]), &key(4))), refused);
        assert_eq!(code_of(check_config_actions(&config_tx_bytes(key(1), 1, &[remove_member(key(4))]), &key(4))), refused);
    }

    #[test]
    fn spending_limits_rent_collector_and_unknown_actions_are_refused() {
        let refused = code(GuardError::ConfigActionNotAllowed);
        // AddSpendingLimit (4), RemoveSpendingLimit (5), SetRentCollector (6), unknown (7): refused on the tag.
        for tag in [4u8, 5, 6, 7] {
            let mut a = vec![tag];
            a.extend_from_slice(&[0u8; 64]);
            assert_eq!(code_of(check_config_actions(&config_tx_bytes(key(1), 1, &[change_threshold(2), a]), &key(4))), refused, "tag {tag}");
        }
    }

    #[test]
    fn empty_or_truncated_action_lists_are_refused() {
        assert_eq!(code_of(check_config_actions(&config_tx_bytes(key(1), 1, &[]), &key(4))), code(GuardError::ConfigActionNotAllowed));
        let d = config_tx_bytes(key(1), 1, &[add_member(key(20), HUMAN)]);
        assert_eq!(code_of(check_config_actions(&d[..d.len() - 1], &key(4))), code(GuardError::NotSquadsAccount));
        let mut long = d.clone();
        long.push(0);
        assert_eq!(code_of(check_config_actions(&long, &key(4))), code(GuardError::NotSquadsAccount));
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

#[cfg(test)]
mod policy_change_tests {
    use super::*;
    use anchor_lang::error::Error;

    fn code_of<T>(r: Result<T>) -> u32 {
        match r {
            Err(Error::AnchorError(e)) => e.error_code_number,
            Err(e) => panic!("unexpected error {e:?}"),
            Ok(_) => panic!("expected an error"),
        }
    }
    fn code(e: GuardError) -> u32 {
        e as u32 + 6000
    }
    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }
    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    /// Value of `"name": "<hex>"` in the shared fixture (packages/shared/fixtures/policy-change-marker.json).
    fn fixture_hex(name: &str) -> Vec<u8> {
        let json = include_str!("../../../packages/shared/fixtures/policy-change-marker.json");
        let start = json.find(&format!("\"{name}\": \"")).unwrap() + name.len() + 5;
        let end = start + json[start..].find('"').unwrap();
        unhex(&json[start..end])
    }
    fn marker() -> Vec<u8> {
        fixture_hex("markerHex")
    }

    const GUARD: Pubkey = crate::ID;
    fn vault() -> Pubkey {
        key(5)
    }

    /// Squads VaultTransaction bytes with the given message parts.
    fn policy_tx(ephemeral: &[u8], keys: &[Pubkey], ixs: &[(u8, Vec<u8>, Vec<u8>)], lookups: u32) -> Vec<u8> {
        let mut d = VAULT_TRANSACTION_DISCRIMINATOR.to_vec();
        d.extend_from_slice(key(1).as_ref()); // multisig
        d.extend_from_slice(key(9).as_ref()); // creator
        d.extend_from_slice(&7u64.to_le_bytes()); // index
        d.extend_from_slice(&[255, 0, 254]); // bump, vault_index, vault_bump
        d.extend_from_slice(&(ephemeral.len() as u32).to_le_bytes());
        d.extend_from_slice(ephemeral);
        d.extend_from_slice(&[1, 1, 0]); // num_signers, num_writable_signers, num_writable_non_signers
        d.extend_from_slice(&(keys.len() as u32).to_le_bytes());
        for k in keys {
            d.extend_from_slice(k.as_ref());
        }
        d.extend_from_slice(&(ixs.len() as u32).to_le_bytes());
        for (program, accounts, data) in ixs {
            d.push(*program);
            d.extend_from_slice(&(accounts.len() as u32).to_le_bytes());
            d.extend_from_slice(accounts);
            d.extend_from_slice(&(data.len() as u32).to_le_bytes());
            d.extend_from_slice(data);
        }
        d.extend_from_slice(&lookups.to_le_bytes());
        for _ in 0..lookups {
            d.extend_from_slice(key(3).as_ref());
            d.extend_from_slice(&0u32.to_le_bytes());
            d.extend_from_slice(&0u32.to_le_bytes());
        }
        d
    }
    fn good_tx() -> Vec<u8> {
        policy_tx(&[], &[vault(), GUARD], &[(1, vec![], marker())], 0)
    }

    #[test]
    fn marker_discriminator_matches_the_shared_fixture() {
        assert_eq!(POLICY_CHANGE_MARKER_DISCRIMINATOR.to_vec(), fixture_hex("discriminatorHex"));
    }

    #[test]
    fn parses_the_shared_marker_fixture() {
        let m = parse_policy_change_marker(&marker()).unwrap();
        assert_eq!(m.new_policy_hash.to_vec(), fixture_hex("newPolicyHashHex"));
        assert_eq!(m.expected_policy_hash.to_vec(), fixture_hex("expectedPolicyHashHex"));
    }

    #[test]
    fn marker_needs_exact_length_discriminator_and_distinct_hashes() {
        let m = marker();
        assert!(parse_policy_change_marker(&m[..71]).is_none());
        assert!(parse_policy_change_marker(&[m.clone(), vec![0]].concat()).is_none());
        let mut wrong = m.clone();
        wrong[0] ^= 1;
        assert!(parse_policy_change_marker(&wrong).is_none());
        let mut equal = m.clone();
        let new_hash = m[8..40].to_vec();
        equal[40..72].copy_from_slice(&new_hash);
        assert!(parse_policy_change_marker(&equal).is_none());
    }

    #[test]
    fn accepts_a_single_marker_instruction_to_the_guard() {
        let m = parse_policy_change_transaction(&good_tx(), &GUARD, &vault()).unwrap();
        assert_eq!(m.new_policy_hash.to_vec(), fixture_hex("newPolicyHashHex"));
    }

    #[test]
    fn refuses_every_other_transaction_shape() {
        let bad = [
            policy_tx(&[], &[vault(), GUARD], &[(1, vec![], marker()), (1, vec![], marker())], 0), // two instructions
            policy_tx(&[], &[vault(), key(4)], &[(1, vec![], marker())], 0),                      // another program
            policy_tx(&[], &[vault(), GUARD, key(4)], &[(1, vec![2], marker())], 0),              // extra account
            policy_tx(&[], &[vault(), GUARD], &[(1, vec![0], marker())], 0),                      // instruction accounts
            policy_tx(&[], &[key(6), GUARD], &[(1, vec![], marker())], 0),                        // not the vault
            policy_tx(&[], &[vault(), GUARD], &[(1, vec![], marker())], 1),                       // lookup table
            policy_tx(&[3], &[vault(), GUARD], &[(1, vec![], marker())], 0),                      // ephemeral signer
            policy_tx(&[], &[vault(), GUARD], &[(1, vec![], marker()[..71].to_vec())], 0),        // bad marker
            policy_tx(&[], &[vault(), GUARD], &[(0, vec![], marker())], 0),                       // program index is the vault
            policy_tx(&[], &[vault(), GUARD], &[], 0),                                            // no instruction
        ];
        for (i, tx) in bad.iter().enumerate() {
            assert_eq!(code_of(parse_policy_change_transaction(tx, &GUARD, &vault())), code(GuardError::InvalidPolicyChange), "case {i}");
        }
        let truncated = &good_tx()[..good_tx().len() - 3];
        assert_eq!(code_of(parse_policy_change_transaction(truncated, &GUARD, &vault())), code(GuardError::InvalidPolicyChange));
    }

    fn proposal_with_status(tag: u8, timestamp: Option<i64>) -> Vec<u8> {
        let mut d = PROPOSAL_DISCRIMINATOR.to_vec();
        d.extend_from_slice(key(1).as_ref());
        d.extend_from_slice(&7u64.to_le_bytes());
        d.push(tag);
        if let Some(ts) = timestamp {
            d.extend_from_slice(&ts.to_le_bytes());
        }
        d.push(255);
        for _ in 0..3 {
            d.extend_from_slice(&0u32.to_le_bytes());
        }
        d
    }

    #[test]
    fn only_an_approved_proposal_has_an_approval_time() {
        assert_eq!(proposal_approved_at(&proposal_with_status(3, Some(1_700_000_123))).unwrap(), Some(1_700_000_123));
        for (tag, ts) in [(0, Some(1)), (1, Some(1)), (2, Some(1)), (4, None), (5, Some(1)), (6, Some(1))] {
            assert_eq!(proposal_approved_at(&proposal_with_status(tag, ts)).unwrap(), None, "status {tag}");
        }
        assert_eq!(code_of(proposal_approved_at(&proposal_with_status(7, Some(1)))), code(GuardError::NotSquadsAccount));
        assert_eq!(code_of(proposal_approved_at(&proposal_with_status(3, None))), code(GuardError::NotSquadsAccount));
        let mut wrong = proposal_with_status(3, Some(1));
        wrong[0] ^= 1;
        assert_eq!(code_of(proposal_approved_at(&wrong)), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn reads_time_lock_and_stale_index_from_the_multisig() {
        let mut d = MULTISIG_DISCRIMINATOR.to_vec();
        d.extend_from_slice(key(7).as_ref()); // create_key
        d.extend_from_slice(Pubkey::default().as_ref()); // config_authority
        d.extend_from_slice(&3u16.to_le_bytes()); // threshold
        d.extend_from_slice(&86_400u32.to_le_bytes()); // time_lock
        d.extend_from_slice(&12u64.to_le_bytes()); // transaction_index
        d.extend_from_slice(&9u64.to_le_bytes()); // stale_transaction_index
        d.push(0); // rent_collector None
        d.push(255);
        d.extend_from_slice(&0u32.to_le_bytes());
        let t = parse_multisig_timing(&d).unwrap();
        assert_eq!((t.time_lock, t.stale_transaction_index), (86_400, 9));
        assert_eq!(code_of(parse_multisig_timing(&d[..90])), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn finds_a_key_among_the_stored_message_account_keys() {
        let tx = good_tx();
        assert!(message_has_account_key(&tx, &GUARD).unwrap());
        assert!(message_has_account_key(&tx, &vault()).unwrap());
        assert!(!message_has_account_key(&tx, &key(42)).unwrap());
        assert_eq!(code_of(message_has_account_key(&tx[..90], &GUARD)), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn ready_after_the_longer_of_time_lock_and_minimum_delay() {
        assert_eq!(policy_change_ready_at(1_000, 0), 1_000 + POLICY_CHANGE_MIN_DELAY);
        assert_eq!(policy_change_ready_at(1_000, (POLICY_CHANGE_MIN_DELAY + 50) as u32), 1_000 + POLICY_CHANGE_MIN_DELAY + 50);
    }
}
