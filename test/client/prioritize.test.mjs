// test/client/prioritize.test.mjs — unit tests for the transparent money-at-stake ranker.
// Verifies: known-money items ranked money desc → age desc; unknown-value items in separate group;
// money:null never faked to 0; mixed-currency items both appear with currency labeled.
import { test } from 'node:test';
import assert from 'node:assert';
import { rankActions } from '../../lib/prioritize.mjs';

test('known-money ranked by money desc then age; unknown-value separate by age', () => {
  const r = rankActions({
    deals:      [{ contactId:'d1', name:'Big', monetaryValue:50000, ageDays:21 }, { contactId:'d2', name:'Small', monetaryValue:5000, ageDays:40 }],
    invoices:   [{ contactId:'i1', name:'Owes', due:30000, cur:'PHP', ageDays:104 }],
    threads:    [{ contactId:'t1', name:'Waiting', ageDays:3 }],   // no known money
    noshows:    [{ contactId:'n1', name:'NoShow', ageDays:8 }],     // no known money
    neverBilled:[{ contactId:'b1', name:'NeverBilled', estValue:0, ageDays:6 }], // est unknown → unknown group
  });
  // ranked = money items, money desc: deal 50k, invoice 30k, deal 5k
  assert.deepEqual(r.ranked.map(x=>x.contact), ['d1','i1','d2']);
  assert.equal(r.ranked[0].money, 50000); assert.equal(r.ranked[0].kind, 'deal');
  assert.ok(r.ranked[0].inputs.includes('21d') || r.ranked[0].inputs.includes('21'));
  // unknownValue = threads + noshows + zero-est never-billed, by age desc
  const uv = r.unknownValue.map(x=>x.contact);
  assert.ok(uv.includes('t1') && uv.includes('n1') && uv.includes('b1'));
  assert.equal(r.unknownValue[0].money, null); // never faked to 0-as-money
});

test('empty lanes → empty groups, no throw', () => {
  const r = rankActions({});
  assert.deepEqual(r.ranked, []); assert.deepEqual(r.unknownValue, []);
});

test('multi-currency money items not cross-summed in the sort (compare within currency or by raw value w/ currency shown)', () => {
  const r = rankActions({ invoices:[{contactId:'a',name:'P',due:1000,cur:'PHP',ageDays:5},{contactId:'b',name:'U',due:100,cur:'USD',ageDays:5}] });
  // both appear, each carries its own currency in inputs; we do NOT convert — document the sort is by raw number with currency labeled
  assert.equal(r.ranked.length, 2);
  assert.ok(r.ranked.every(x=>x.inputs.match(/PHP|USD|₱|\$/)));
});

test('never-billed with real estValue > 0 is a money item, not unknownValue', () => {
  const r = rankActions({
    neverBilled: [
      { contactId:'nb1', name:'HasEst', estValue:15000, ageDays:10 },
      { contactId:'nb2', name:'ZeroEst', estValue:0, ageDays:5 },
    ],
  });
  const ranked = r.ranked.map(x => x.contact);
  const uv = r.unknownValue.map(x => x.contact);
  assert.ok(ranked.includes('nb1'), 'nb1 (real estValue) must be in ranked');
  assert.ok(uv.includes('nb2'), 'nb2 (estValue=0) must be in unknownValue');
  assert.ok(!ranked.includes('nb2'), 'nb2 must NOT be in ranked');
});

test('unknownValue sorted by age desc', () => {
  const r = rankActions({
    threads: [
      { contactId:'t1', name:'Oldest', ageDays:30 },
      { contactId:'t2', name:'Newest', ageDays:2 },
      { contactId:'t3', name:'Mid', ageDays:15 },
    ],
  });
  assert.deepEqual(r.unknownValue.map(x=>x.contact), ['t1','t3','t2']);
});

test('tie-break on age desc when money equal', () => {
  const r = rankActions({
    deals: [
      { contactId:'d1', name:'YoungBig', monetaryValue:10000, ageDays:5 },
      { contactId:'d2', name:'OldBig', monetaryValue:10000, ageDays:20 },
    ],
  });
  // Same money → older deal ranked first (more urgent)
  assert.deepEqual(r.ranked.map(x=>x.contact), ['d2','d1']);
});

test('money:null on all unknownValue items regardless of kind', () => {
  const r = rankActions({
    threads:  [{ contactId:'t1', name:'T', ageDays:1 }],
    noshows:  [{ contactId:'n1', name:'N', ageDays:2 }],
    neverBilled: [{ contactId:'b1', name:'B', estValue:0, ageDays:3 }],
  });
  for (const item of r.unknownValue) {
    assert.strictEqual(item.money, null, `${item.contact} must have money:null`);
  }
});

test('a deal with no monetaryValue (0/unset) is UNKNOWN-value, not faked as ₱0 in ranked', () => {
  const r = rankActions({
    deals: [
      { contactId:'real', name:'Real', monetaryValue:40000, ageDays:5 },
      { contactId:'zero', name:'NoValue', monetaryValue:0, ageDays:9 },
      { contactId:'unset', name:'Unset', ageDays:12 }, // monetaryValue undefined
    ],
  });
  // only the real-money deal is ranked
  assert.deepEqual(r.ranked.map(x=>x.contact), ['real']);
  // the 0/unset deals are surfaced honestly as unknown-value, money:null
  const uv = r.unknownValue.filter(x=>x.kind==='deal');
  assert.equal(uv.length, 2);
  assert.ok(uv.every(x=>x.money===null), 'unset deals never carry a faked money number');
  assert.ok(uv.every(x=>/value unknown/i.test(x.inputs)));
});
