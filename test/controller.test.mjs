import test from 'node:test';
import assert from 'node:assert/strict';
import {decide, speedCap} from '../src/controller.mjs';
const state = (position, speed=0) => ({t:10, phase:'running', safety:12,
  own:{position,speed}, opponent:{deployed:0}});
test('brakes while still below safety when inertia would overshoot', () => {
  assert.equal(decide(state(11,1.55),{held:true}).held,false);
  assert.equal(decide(state(0)).held,true);
});
test('restarts with headroom hysteresis', () => {
  assert.equal(decide(state(11.7),{held:true}).held,true);
  assert.equal(decide(state(11.7),{held:false}).held,false);
});
test('rejects invalid state and terminal phase', () => {
  assert.equal(decide(null).held,false);
  assert.equal(decide(state(NaN)).held,false);
  assert.equal(decide({...state(0),phase:'settling'}).held,false);
});
test('uses only observed past frontier slope', () => {
  const s={...state(10),t:20,safety:15};
  const r=decide(s,{history:[{t:19.5,safety:14.5}]});
  assert.equal(r.slope,1);
  assert.equal(r.target,15.4);
});
test('speed cap grows within recovered bounds', () => {
  assert.equal(speedCap(0),1.5);
  assert.ok(speedCap(40)>speedCap(20));
  assert.ok(speedCap(100)<=3.24);
});
