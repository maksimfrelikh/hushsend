import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/curves/utils.js';
import { init, finish, _internals } from './cpace';

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (s: string) => hexToBytes(s);

/**
 * Official test vectors are from draft-irtf-cfrg-cpace-21 (April 2026):
 *  - Appendix A: string utility functions (prepend_len / lv_cat / o_cat /
 *    transcript_ir / transcript_oc).
 *  - Appendix B.3: CPACE-RISTRETTO255-SHA512 (group object G_Ristretto255;
 *    same vector published in the repo's testvectors.json under "G_Coffee25519").
 * Source: https://www.ietf.org/archive/id/draft-irtf-cfrg-cpace-21.txt
 */

describe('CPace string utilities (draft Appendix A vectors)', () => {
  it('prepend_len (§A.1.2)', () => {
    expect(bytesToHex(_internals.prependLen(enc('')))).toBe('00');
    expect(bytesToHex(_internals.prependLen(enc('1234')))).toBe('0431323334');
    // LEB128 boundary: 127 -> single byte 0x7f; 128 -> 0x80 0x01.
    const r127 = Uint8Array.from({ length: 127 }, (_, i) => i);
    expect(_internals.prependLen(r127)).toEqual(concatBytes(Uint8Array.of(0x7f), r127));
    const r128 = Uint8Array.from({ length: 128 }, (_, i) => i);
    expect(_internals.prependLen(r128)).toEqual(concatBytes(Uint8Array.of(0x80, 0x01), r128));
  });

  it('lv_cat (§A.1.4)', () => {
    const out = _internals.lvCat(enc('1234'), enc('5'), enc(''), enc('678'));
    expect(bytesToHex(out)).toBe('043132333401350003363738');
  });

  it('lexicographically_larger (§A.3.3)', () => {
    const b = (...n: number[]) => Uint8Array.from(n);
    expect(_internals.lexicographicallyLarger(b(0), b(0, 0))).toBe(false);
    expect(_internals.lexicographicallyLarger(b(1), b(0, 0))).toBe(true);
    expect(_internals.lexicographicallyLarger(b(0, 0), b(0))).toBe(true);
    expect(_internals.lexicographicallyLarger(b(0, 0), b(1))).toBe(false);
    expect(_internals.lexicographicallyLarger(b(0, 1), b(1))).toBe(false);
    expect(_internals.lexicographicallyLarger(enc('ABCD'), enc('BCD'))).toBe(false);
  });

  it('o_cat (§A.3.3)', () => {
    expect(bytesToHex(_internals.oCat(enc('ABCD'), enc('BCD')))).toBe('6f6342434441424344');
    expect(bytesToHex(_internals.oCat(enc('BCD'), enc('ABCDE')))).toBe('6f634243444142434445');
  });

  it('transcript_ir (§A.3.5)', () => {
    expect(bytesToHex(_internals.transcriptIr(enc('123'), enc('PartyA'), enc('234'), enc('PartyB')))).toBe(
      '03313233065061727479410332333406506172747942',
    );
    expect(bytesToHex(_internals.transcriptIr(enc('3456'), enc('PartyA'), enc('2345'), enc('PartyB')))).toBe(
      '043334353606506172747941043233343506506172747942',
    );
  });

  it('transcript_oc (§A.3.7)', () => {
    expect(bytesToHex(_internals.transcriptOc(enc('123'), enc('PartyA'), enc('234'), enc('PartyB')))).toBe(
      '6f6303323334065061727479420331323306506172747941',
    );
    expect(bytesToHex(_internals.transcriptOc(enc('3456'), enc('PartyA'), enc('2345'), enc('PartyB')))).toBe(
      '6f63043334353606506172747941043233343506506172747942',
    );
  });
});

// CPACE-RISTRETTO255-SHA512 official vector (draft Appendix B.3).
const VEC = {
  PRS: hex('50617373776f7264'), // b"Password"
  CI: hex('0b415f696e69746961746f720b425f726573706f6e646572'),
  sid: hex('7e4b4791d6a8ef019b936c79fb7f2c57'),
  g: '222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56',
  ya: hex('da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08'),
  ADa: hex('414461'), // b"ADa"
  Ya: 'd6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157',
  yb: hex('d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d'),
  ADb: hex('414462'), // b"ADb"
  Yb: '3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258',
  ISK_IR:
    'b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd' +
    '2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447',
  ISK_SY:
    '544199d71f62f8d9a1fee55727e24fe4a45844593c2b6013c4fa3969d0e5debb' +
    '2244675c0b43397cbb68d342b01fc0f98fc961469a25134de9f0f813c1a57476',
};

describe('CPACE-RISTRETTO255-SHA512 against official vector (draft Appendix B.3)', () => {
  it('derives the published generator g', () => {
    expect(bytesToHex(_internals.calculateGenerator(VEC.PRS, VEC.CI, VEC.sid))).toBe(VEC.g);
  });

  it('init produces the published messages Ya and Yb with the vector scalars', () => {
    const a = init(VEC.PRS, VEC.sid, { ci: VEC.CI, ad: VEC.ADa, ephemeralScalar: VEC.ya });
    expect(bytesToHex(a.msg)).toBe(VEC.Ya);
    const b = init(VEC.PRS, VEC.sid, { ci: VEC.CI, ad: VEC.ADb, ephemeralScalar: VEC.yb });
    expect(bytesToHex(b.msg)).toBe(VEC.Yb);
  });

  it('finish derives the published ISK (initiator/responder) on both sides', () => {
    const a = init(VEC.PRS, VEC.sid, { ci: VEC.CI, ad: VEC.ADa, role: 'initiator', ephemeralScalar: VEC.ya });
    const b = init(VEC.PRS, VEC.sid, { ci: VEC.CI, ad: VEC.ADb, role: 'responder', ephemeralScalar: VEC.yb });

    const iskA = finish(a.state, b.msg, VEC.ADb);
    const iskB = finish(b.state, a.msg, VEC.ADa);

    expect(bytesToHex(iskA)).toBe(VEC.ISK_IR);
    expect(bytesToHex(iskB)).toBe(VEC.ISK_IR);
  });

  it('finish derives the published ISK (symmetric / parallel) on both sides', () => {
    const a = init(VEC.PRS, VEC.sid, { ci: VEC.CI, ad: VEC.ADa, role: 'symmetric', ephemeralScalar: VEC.ya });
    const b = init(VEC.PRS, VEC.sid, { ci: VEC.CI, ad: VEC.ADb, role: 'symmetric', ephemeralScalar: VEC.yb });

    const iskA = finish(a.state, b.msg, VEC.ADb);
    const iskB = finish(b.state, a.msg, VEC.ADa);

    expect(bytesToHex(iskA)).toBe(VEC.ISK_SY);
    expect(bytesToHex(iskB)).toBe(VEC.ISK_SY);
  });
});

describe('CPace round-trip with CSPRNG scalars', () => {
  const sid = hex('00112233445566778899aabbccddeeff');

  it('same password ⇒ identical ISK on both sides', () => {
    const prs = enc('correct horse battery staple');
    const a = init(prs, sid, { role: 'initiator', ad: enc('A') });
    const b = init(prs, sid, { role: 'responder', ad: enc('B') });

    const iskA = finish(a.state, b.msg, enc('B'));
    const iskB = finish(b.state, a.msg, enc('A'));

    expect(bytesToHex(iskA)).toBe(bytesToHex(iskB));
  });

  it('different password ⇒ diverging ISK (no shared key)', () => {
    const a = init(enc('password one'), sid, { role: 'initiator' });
    const b = init(enc('password two'), sid, { role: 'responder' });

    // CPace never aborts on a wrong password (the points still decode); the two
    // sides simply derive unrelated keys. Detection happens at key-confirmation.
    const iskA = finish(a.state, b.msg);
    const iskB = finish(b.state, a.msg);

    expect(bytesToHex(iskA)).not.toBe(bytesToHex(iskB));
  });

  it('two independent runs of the same password yield different ISK (fresh scalars)', () => {
    const prs = enc('shared phrase');
    const run = () => {
      const a = init(prs, sid, { role: 'initiator' });
      const b = init(prs, sid, { role: 'responder' });
      return bytesToHex(finish(a.state, b.msg));
    };
    expect(run()).not.toBe(run());
  });
});

describe('CPace scalar sampler (draft §8.3 clamping variant)', () => {
  const sid = hex('00112233445566778899aabbccddeeff');

  it('production scalars are non-zero, strictly < group order, and fresh per call', () => {
    // No ephemeralScalar ⇒ init() exercises the real CSPRNG sample_scalar path,
    // and the secret exponent it produced is exposed on state.scalar.
    const scalars = Array.from({ length: 64 }, () => init(enc('pw'), sid).state.scalar);

    for (const s of scalars) {
      expect(s > 0n).toBe(true);
      expect(s < _internals.GROUP_ORDER).toBe(true);
    }
    // Independent CSPRNG draws ⇒ all distinct (a collision here is ~2^-247).
    const distinct = new Set(scalars.map((s) => s.toString(16)));
    expect(distinct.size).toBe(scalars.length);
  });
});

describe('CPace abort conditions (draft §8.3 / §9)', () => {
  const sid = hex('00112233445566778899aabbccddeeff');

  it('rejects a peer message that is not a valid ristretto255 encoding', () => {
    const a = init(enc('pw'), sid, { role: 'initiator' });
    const bogus = new Uint8Array(32).fill(0xff); // not a canonical ristretto point
    expect(() => finish(a.state, bogus)).toThrow();
  });

  it('aborts when the shared point K is the identity element', () => {
    const a = init(enc('pw'), sid, { role: 'initiator' });
    const identity = new Uint8Array(32); // all-zero = ristretto255 identity encoding
    expect(() => finish(a.state, identity)).toThrow(/identity/);
  });
});
