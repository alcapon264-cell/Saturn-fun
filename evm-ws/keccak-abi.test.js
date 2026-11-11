import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from '../src/keccak.js';
import { SEL, TOPIC, encodeCall, readAddr, readUint, words, topicAddr } from '../src/abi.js';

test('keccak256 matches published vectors', () => {
  assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256('transfer(address,uint256)').slice(0, 10), '0xa9059cbb'); // the ERC-20 transfer selector everyone knows
  assert.equal(keccak256('x'.repeat(200)).length, 66); // multi-block absorb path
});
test('selectors derived from signatures equal the constants already used by lib/evm.js', () => {
  assert.equal(SEL.token0, '0x0dfe1681'); assert.equal(SEL.token1, '0xd21220a7'); assert.equal(SEL.decimals, '0x313ce567');
  assert.equal(SEL.totalSupply, '0x18160ddd'); assert.equal(SEL.slot0, '0x3850c7bd'); assert.equal(SEL.getPool, '0x1698ee82');
  assert.equal(SEL.balanceOf, '0x70a08231');
});
test('event topic0 hashes: V2 Swap/Sync, V3 Swap and PancakeSwap V3 Swap are four different events', () => {
  assert.equal(TOPIC.v2Swap, '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');
  assert.equal(TOPIC.v2Sync, '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1');
  assert.equal(TOPIC.v3Swap, '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
  assert.equal(TOPIC.pancakeV3Swap, '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83');
  assert.equal(new Set(Object.values(TOPIC)).size, 4);
});
test('abi helpers are strict', () => {
  assert.equal(encodeCall(SEL.balanceOf, '0x' + '1'.repeat(40)), '0x70a08231' + '0'.repeat(24) + '1'.repeat(40));
  assert.equal(readUint('0x' + '0'.repeat(63) + 'f'), 15n);
  assert.equal(readAddr('0x' + '0'.repeat(24) + 'ab'.repeat(20)), '0x' + 'ab'.repeat(20));
  assert.throws(() => words('0x1234'), /abi_bad_length/);
  assert.throws(() => topicAddr('0x12'), /abi_bad_topic/);
});
