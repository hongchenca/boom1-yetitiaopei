const test=require('node:test');
const assert=require('node:assert/strict');
const {WeightDisplayFilter}=require('../public/weight-filter');
const channel=(value,seq,extra={})=>({channel:0,valid:true,filtered_mg:value,sample_sequence:seq,calibration_version:1,noise_band_mg:50,...extra});
const context=(seq,extra={})=>({device:'a',boot:'boot-1',sequence:seq,at:seq*200,interval:200,...extra});

test('display filtering suppresses noise and a spike without hiding sustained weight changes',()=>{
 const f=new WeightDisplayFilter(); const raw=[],out=[];
 for(let i=0;i<80;i++){const value=100000+[150,-120,80,-170,100,0,-50][i%7];raw.push(value);out.push(f.push(channel(value,i),context(i)));}
 const range=v=>Math.max(...v)-Math.min(...v);
 assert.ok(range(out.slice(20))<range(raw)*.4,'steady noise attenuation');
 const before=out.at(-1), spike=f.push(channel(500000,80),context(80));
 assert.ok(Math.abs(spike-before)<100,'isolated spike rejected');
 for(let i=81;i<86;i++)f.push(channel(100000,i),context(i));
 let step;
 for(let i=86;i<91;i++)step=f.push(channel(200000,i),context(i));
 assert.ok(step>190000,'100 g step reaches 90% within five 200 ms frames');
});
test('duplicate frames, invalid samples and identity boundaries never mix old weight',()=>{
 const f=new WeightDisplayFilter();f.push(channel(10000,1),context(1));
 assert.equal(f.push(channel(99999,1),context(1)),10000);
 assert.equal(f.push(channel(20000,0),context(2)),10000);
 assert.equal(f.push(channel(0,2,{valid:false}),context(2)),null);
 assert.equal(f.push(channel(-5000,3),context(3)),-5000);
 assert.equal(f.push(channel(75000,4,{calibration_version:2}),context(4)),75000);
 assert.equal(f.push(channel(25000,1),context(5,{boot:'boot-2'})),25000);
 assert.equal(f.push(channel(33333,6),context(6,{device:'b'})),33333);
 assert.equal(f.push(channel(66666,100),context(100)),66666,'long gap resets');
 assert.equal(f.push(channel(500,101,{channel:8}),context(101)),500,'channels isolated');
});
test('filter modes retain signed measurements and never clamp to zero',()=>{
 const f=new WeightDisplayFilter('device');
 assert.equal(f.push(channel(-1234,1),context(1)),-1234);
 assert.equal(f.push(channel(-9876,2),context(2)),-9876);
 f.setMode('steady');assert.equal(f.push(channel(0,3),context(3)),0);
 let result;for(let i=4;i<100;i++)result=f.push(channel(-250,i),context(i));
 assert.ok(result<-225,'small sustained changes are not frozen');
 f.reset();f.push(channel(10000,1),context(1));
 assert.ok(f.push(channel(100000,2),context(2,{at:10200,interval:10000}))>99000,'slow reports do not accumulate a long median window');
});
