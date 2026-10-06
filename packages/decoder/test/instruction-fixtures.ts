import type { DecodedAction } from '../src/index.ts';
import { encodeU64, fixtureKeys as k, makeVaultTransaction, RECENT_BLOCKHASHES_SYSVAR as RECENT, RENT_SYSVAR as RENT, systemData, SYSTEM_PROGRAM as SYSTEM, TOKEN_PROGRAM as TOKEN, ATA_PROGRAM as ATA } from './account-fixture.ts';

export type InstructionFixture = { name: string; programId: string; accounts: string[]; data: number[]; expected: DecodedAction };
const amount = 9_007_199_254_740_993n;
const checkedAmount = 7_777_777_777_777_777n;
const expected = <T extends Omit<DecodedAction, 'instructionIndex'>>(action: T) => ({ instructionIndex: 0, ...action }) as DecodedAction;

export const instructionFixtures: InstructionFixture[] = [
  { name: 'System Assign', programId: SYSTEM, accounts: [k[0]!], data: systemData(1, [...new Uint8Array(32).fill(6)]), expected: expected({ kind: 'system.assign', account: k[0]!, newOwnerProgram: k[5]! }) },
  { name: 'System Transfer', programId: SYSTEM, accounts: [k[0]!, k[1]!], data: systemData(2, encodeU64(amount)), expected: expected({ kind: 'system.transfer', source: k[0]!, destination: k[1]!, lamports: amount.toString() }) },
  { name: 'System AdvanceNonceAccount', programId: SYSTEM, accounts: [k[0]!, RECENT, k[2]!], data: systemData(4), expected: expected({ kind: 'system.advanceNonce', nonceAccount: k[0]!, recentBlockhashesSysvar: RECENT, authority: k[2]! }) },
  { name: 'System WithdrawNonceAccount', programId: SYSTEM, accounts: [k[0]!, k[1]!, RECENT, RENT, k[2]!], data: systemData(5, encodeU64(amount)), expected: expected({ kind: 'system.withdrawNonce', nonceAccount: k[0]!, destination: k[1]!, recentBlockhashesSysvar: RECENT, rentSysvar: RENT, authority: k[2]!, lamports: amount.toString() }) },
  { name: 'System InitializeNonceAccount', programId: SYSTEM, accounts: [k[0]!, RECENT, RENT], data: systemData(6, [...new Uint8Array(32).fill(3)]), expected: expected({ kind: 'system.initializeNonce', nonceAccount: k[0]!, recentBlockhashesSysvar: RECENT, rentSysvar: RENT, authority: k[2]! }) },
  { name: 'System AuthorizeNonceAccount', programId: SYSTEM, accounts: [k[0]!, k[2]!], data: systemData(7, [...new Uint8Array(32).fill(4)]), expected: expected({ kind: 'system.authorizeNonce', nonceAccount: k[0]!, currentAuthority: k[2]!, newAuthority: k[3]! }) },
  { name: 'SPL Transfer', programId: TOKEN, accounts: [k[0]!, k[1]!, k[2]!], data: [3, ...encodeU64(amount)], expected: expected({ kind: 'token.transfer', sourceTokenAccount: k[0]!, destinationTokenAccount: k[1]!, authority: k[2]!, amount: amount.toString() }) },
  { name: 'SPL Approve', programId: TOKEN, accounts: [k[0]!, k[1]!, k[2]!], data: [4, ...encodeU64(amount)], expected: expected({ kind: 'token.approve', sourceTokenAccount: k[0]!, delegate: k[1]!, authority: k[2]!, amount: amount.toString() }) },
  { name: 'SPL ApproveChecked', programId: TOKEN, accounts: [k[0]!, k[1]!, k[2]!, k[3]!], data: [13, ...encodeU64(checkedAmount), 6], expected: expected({ kind: 'token.approveChecked', sourceTokenAccount: k[0]!, mint: k[1]!, delegate: k[2]!, authority: k[3]!, amount: checkedAmount.toString(), decimals: 6 }) },
  { name: 'SPL Revoke', programId: TOKEN, accounts: [k[0]!, k[1]!], data: [5], expected: expected({ kind: 'token.revoke', sourceTokenAccount: k[0]!, authority: k[1]! }) },
  { name: 'SPL SetAuthority revoke', programId: TOKEN, accounts: [k[0]!, k[1]!], data: [6, 3, 0], expected: expected({ kind: 'token.setAuthority', target: k[0]!, authorityType: 'closeAccount', currentAuthority: k[1]!, newAuthority: null }) },
  { name: 'SPL CloseAccount', programId: TOKEN, accounts: [k[0]!, k[1]!, k[2]!], data: [9], expected: expected({ kind: 'token.closeAccount', tokenAccount: k[0]!, destination: k[1]!, authority: k[2]! }) },
  { name: 'SPL TransferChecked', programId: TOKEN, accounts: [k[0]!, k[1]!, k[2]!, k[3]!], data: [12, ...encodeU64(checkedAmount), 6], expected: expected({ kind: 'token.transferChecked', programId: TOKEN, sourceTokenAccount: k[0]!, mint: k[1]!, destinationTokenAccount: k[2]!, authority: k[3]!, amount: checkedAmount.toString(), decimals: 6 }) },
  { name: 'ATA Create', programId: ATA, accounts: [k[0]!, k[1]!, k[2]!, k[3]!, SYSTEM, TOKEN], data: [0], expected: expected({ kind: 'ata.create', payer: k[0]!, associatedTokenAccount: k[1]!, walletOwner: k[2]!, mint: k[3]! }) },
  { name: 'ATA CreateIdempotent', programId: ATA, accounts: [k[0]!, k[1]!, k[2]!, k[3]!, SYSTEM, TOKEN], data: [1], expected: expected({ kind: 'ata.createIdempotent', payer: k[0]!, associatedTokenAccount: k[1]!, walletOwner: k[2]!, mint: k[3]! }) },
];

export function fixtureBytes(fixture: InstructionFixture, malformed = false): Uint8Array {
  const accounts = malformed ? fixture.accounts.slice(0, -1) : fixture.accounts;
  return makeVaultTransaction(fixture.programId, accounts, fixture.data);
}
