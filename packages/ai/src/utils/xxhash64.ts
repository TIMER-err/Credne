/**
 * XXH64 (xxHash, 64-bit) over bytes, for runtimes without a native implementation.
 * Matches Bun.hash.xxHash64 and the reference C implementation.
 */

const MASK = 0xffffffffffffffffn;
const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;

function rotl(value: bigint, bits: bigint): bigint {
	return ((value << bits) | (value >> (64n - bits))) & MASK;
}

function round(acc: bigint, lane: bigint): bigint {
	return (rotl((acc + lane * P2) & MASK, 31n) * P1) & MASK;
}

function mergeRound(acc: bigint, value: bigint): bigint {
	return (((acc ^ round(0n, value)) * P1) & MASK) + P4;
}

/** XXH64 of `input` with a 64-bit `seed`; returns an unsigned 64-bit bigint. */
export function xxHash64(input: Uint8Array, seed = 0n): bigint {
	const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
	const length = input.byteLength;
	seed &= MASK;
	let offset = 0;
	let hash: bigint;

	if (length >= 32) {
		let v1 = (seed + P1 + P2) & MASK;
		let v2 = (seed + P2) & MASK;
		let v3 = seed;
		let v4 = (seed - P1) & MASK;
		const limit = length - 32;
		while (offset <= limit) {
			v1 = round(v1, view.getBigUint64(offset, true));
			v2 = round(v2, view.getBigUint64(offset + 8, true));
			v3 = round(v3, view.getBigUint64(offset + 16, true));
			v4 = round(v4, view.getBigUint64(offset + 24, true));
			offset += 32;
		}
		hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
		hash = mergeRound(hash, v1) & MASK;
		hash = mergeRound(hash, v2) & MASK;
		hash = mergeRound(hash, v3) & MASK;
		hash = mergeRound(hash, v4) & MASK;
	} else {
		hash = (seed + P5) & MASK;
	}

	hash = (hash + BigInt(length)) & MASK;

	while (offset + 8 <= length) {
		hash ^= round(0n, view.getBigUint64(offset, true));
		hash = ((rotl(hash, 27n) * P1) & MASK) + P4;
		hash &= MASK;
		offset += 8;
	}
	if (offset + 4 <= length) {
		hash ^= (BigInt(view.getUint32(offset, true)) * P1) & MASK;
		hash = ((rotl(hash, 23n) * P2) & MASK) + P3;
		hash &= MASK;
		offset += 4;
	}
	while (offset < length) {
		hash ^= (BigInt(input[offset]) * P5) & MASK;
		hash = (rotl(hash, 11n) * P1) & MASK;
		offset++;
	}

	hash ^= hash >> 33n;
	hash = (hash * P2) & MASK;
	hash ^= hash >> 29n;
	hash = (hash * P3) & MASK;
	hash ^= hash >> 32n;
	return hash;
}
