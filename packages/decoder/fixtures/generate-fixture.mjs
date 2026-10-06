const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decode58(text) {
  const bytes = [0];
  for (const char of text) {
    let carry = alphabet.indexOf(char);
    if (carry < 0) throw new Error('bad base58');
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 255); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const result = new Uint8Array(zeros + (bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length));
  for (let i = 0; i < bytes.length && !(bytes.length === 1 && bytes[0] === 0); i++) result[result.length - 1 - i] = bytes[i];
  return result;
}
const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const vec = (bytes) => [...u32(bytes.length), ...bytes];
const itemVec = (count, bytes) => [...u32(count), ...bytes];
const pk = (str) => [...decode58(str)];
const keys = [
  '11111111111111111111111111111112',
  '11111111111111111111111111111113',
  '11111111111111111111111111111114',
  '11111111111111111111111111111115',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
].map(pk);
if (keys.some((key) => key.length !== 32)) throw new Error('invalid fixture key');
const amount = [1, 0, 0, 0, 0, 0, 32, 0];
const instruction = [4, ...vec([0, 1, 2, 3]), ...vec([12, ...amount, 6])];
function account(lookup) {
  return [
    168, 250, 162, 100, 81, 14, 162, 207,
    ...keys[0], ...keys[1], ...Array(8).fill(0), 254, 0, 253,
    ...vec([]),
    1, 1, 3,
    ...itemVec(keys.length, keys.flat()),
    ...itemVec(1, instruction),
    ...itemVec(lookup ? 1 : 0, lookup ? [...keys[4], ...vec([]), ...vec([])] : []),
  ];
}
const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
console.log(JSON.stringify({
  provenance: 'synthetic-local; @sqds/multisig 2.1.4 generated layout',
  accountDataHex: hex(account(false)),
  altAccountDataHex: hex(account(true)),
}, null, 2));
