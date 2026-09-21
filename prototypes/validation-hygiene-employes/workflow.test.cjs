const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
function engine(kind='tank',answers={}){
 let script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 script=script.slice(0,script.indexOf("$('ls-next').addEventListener"));
 script+='globalThis.api={flows,hasIssue,coolingState,unfinished,visibleSteps,visibleFields,validate,updateAnswer,data,TODAY,set:(k,d,i=0)=>{kind=k;draftMap[k]=d;index=i;}};})();';
 const context={document:{getElementById:()=>({querySelector:()=>({})})}};
 vm.createContext(context);vm.runInContext(script,context);
 context.api.set(kind,answers);return context.api;
}
test('seven PDF workflows are available',()=>assert.equal(Object.keys(engine().flows).length,7));
test('tank salinity limits are inclusive',()=>{const a=engine();for(const s of [1020,1022,1025])assert.equal(a.hasIssue('tank',{salinity:String(s)}),false);for(const s of [1019,1026])assert.equal(a.hasIssue('tank',{salinity:String(s)}),true);});
test('empty operating tank still requires readings; out of service requires action',()=>{let a=engine('tank',{tankState:'Vide mais en service'});assert(a.visibleSteps().some(s=>s.id==='water'));a.set('tank',{tankState:'Hors service'});assert(!a.visibleSteps().some(s=>s.id==='water'));assert(a.visibleSteps().some(s=>s.id==='tank-action'));});
test('impossible reading has no invented values',()=>{const a=engine('tank',{tankMeasured:'Impossible'});assert(a.hasIssue('tank',a.data()));assert(!a.visibleFields(a.flows.tank[1]).some(f=>f.key==='salinity'));});
test('changing a branch clears stale readings and downstream visa',()=>{const a=engine('tank',{tankState:'En service avec animaux',tankMeasured:'Oui',salinity:'1028',attest:true});a.updateAnswer('tankState','Hors service');assert.equal(a.data().salinity,undefined);assert.equal(a.data().attest,undefined);assert.equal(a.data().tankMeasured,undefined);});
test('changing recheck keeps original reading and allows recheck fields',()=>{const d={tankState:'En service avec animaux',tankMeasured:'Oui',salinity:'1028',tankRecheck:'Pas encore',due:'2026-09-22T10:00'};const a=engine('tank',d);a.set('tank',d,2);a.updateAnswer('tankRecheck','Oui');a.updateAnswer('followAt','2026-09-20T10:00');assert.equal(a.data().salinity,'1028');assert.equal(a.data().due,undefined);assert.equal(a.data().followAt,'2026-09-20T10:00');});
test('probe replacement includes both 0.9 boundaries',()=>{const a=engine();for(const bath of ['-0.9','0.9'])assert(a.hasIssue('probe',{bath}));assert.equal(a.hasIssue('probe',{bath:'0.8'}),false);});
test('cooling duration crosses midnight, and 120 minutes is outside',()=>{const a=engine();assert.equal(a.coolingState({cookOut:'2026-09-19T23:30',coolOut:'2026-09-20T01:29',coolTemp:'4'}),'target');assert.equal(a.coolingState({cookOut:'2026-09-19T23:30',coolOut:'2026-09-20T01:30',coolTemp:'4'}),'outside');for(const [t,result]of [['10','tolerance'],['10.1','outside']])assert.equal(a.coolingState({cookOut:'2026-09-19T10:00',coolOut:'2026-09-19T11:00',coolTemp:t}),result);});
test('nonconforming core mean prevents acceptance and requires refusal',()=>{const a=engine('receipt',{coreVerdict:'Non conforme',decision:'Réception',decisionNote:'test'});assert(a.validate(a.flows.receipt.find(s=>s.id==='decision')).some(e=>e.includes('impose le refus')));});
test('direct delivery requires all packages except full truck procedure',()=>{const d={supply:'Direct',fullTruck:'Non',packages:'4',checkedPackages:'1'};const a=engine('receipt',d);assert(a.validate(a.flows.receipt[1]).some(e=>e.includes('tous les colis')));});
test('weekly reading needs automatic recording and alarm',()=>{const a=engine('temp',{slot:'Hebdomadaire',automatic:'Non'});assert(a.validate(a.flows.temp[0]).some(e=>e.includes('ET alarme')));});
test('missing freshness grid cannot be accepted',()=>{const a=engine('fresh',{gridReady:'Non',aspect:'Accepté',missingGrid:'test'});assert(a.validate(a.flows.fresh[1]).some(e=>e.includes('Sans grille')));});
test('missing size reference is not a pass and undersized cannot be accepted',()=>{const a=engine('fresh',{sizeApplies:'Oui',sizeReady:'Oui',size:'9',sizeMin:'11',sizeVerdict:'Accepté'});assert(a.validate(a.flows.fresh[3]).some(e=>e.includes('inférieure')));});
test('cook origin blocked and missing plan never completes a control',()=>{const a=engine('cook',{origin:'Étal',customer:'Non'});assert(!a.visibleSteps().some(s=>s.id==='cook-out'));assert(a.hasIssue('cook',a.data()));assert(a.unfinished('clean',{planReady:'Non'}));});
test('invalid calendar dates and future observations are rejected',()=>{const a=engine('tank',{day:'2026-02-30',observed:'2099-01-01T12:00'});const errors=a.validate(a.flows.tank[0]);assert(errors.some(e=>e.includes('Date invalide')));assert(errors.some(e=>e.includes('futur')));});
test('all seven complete test paths can reach and validate simulated visa',()=>{
 for(const kind of ['fresh','receipt','temp','tank','clean','cook','probe']){
  const a=engine(kind,{day:'2026-09-19'});let i=0;
  while(i<a.visibleSteps().length){const s=a.visibleSteps()[i];const d=a.data();
   for(let pass=0;pass<3;pass++)for(const f of a.visibleFields(s))if(d[f.key]===undefined)d[f.key]=f.type==='checkbox'?true:f.type==='radio'?f.options[0]:f.type==='date'?'2026-09-19':f.type==='datetime-local'?'2026-09-19T10:00':f.type==='number'?'1':'Valeur test';
   Object.assign(d,{salinity:'1022',bath:'0',size:'20',sizeMin:'10',coolTemp:'4',cookOut:'2026-09-19T10:00',coolIn:'2026-09-19T10:00',coolOut:'2026-09-19T11:00'});
   const errors=a.validate(s);assert.equal(errors.length,0,kind+'/'+s.id+': '+errors.join(';'));i++;
  }
  assert.equal(a.visibleSteps().at(-1).id,'visa');
 }
});
test('test page has no production requests or persistent storage',()=>{assert(!/fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage/.test(html));});
