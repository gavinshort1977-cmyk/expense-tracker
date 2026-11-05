// Card & Cash Ledger: the app itself. Same features as the single-file version;
// data now lives in IndexedDB (store.js) and can optionally sync through Google Drive (sync.js).
import { Store, requestPersistence } from "./store.js";
import { setCategorizer, dateAt, normDate, lineToTx, finishTxs, parseCsv, parseStatementCsv, pdfLines } from "./statement.js";
import { GoogleAuth } from "./auth.js";
import { DriveClient, SYNC_FILE_NAME } from "./drive.js";
import { SyncEngine } from "./sync.js";
import { GOOGLE_CLIENT_ID } from "../config.js";
const METHODS=[
  {id:"cbd",name:"CBD",card:true},{id:"enbd",name:"ENBD",card:true},{id:"citi",name:"Citi",card:true},{id:"amazon",name:"Amazon",card:true},
  {id:"cash",name:"Cash",card:false},{id:"wallet",name:"Wallet",card:false}];
const MBY=Object.fromEntries(METHODS.map(m=>[m.id,m]));
const DEFAULTS={
  cards:{cbd:{statementDay:null,dueDay:null,limit:null},enbd:{statementDay:null,dueDay:null,limit:null},citi:{statementDay:null,dueDay:null,limit:null},amazon:{statementDay:null,dueDay:null,limit:null}},
  categories:["Groceries","Dining & coffee","Fuel & transport","Bills & utilities","Home","Shopping","Health & fitness","Entertainment","Subscriptions","Travel","Personal care","Other"],
  budgets:{},
  fx:{AED:1,USD:3.6725,SAR:0.9793,EUR:4.12,GBP:4.90,DKK:0.552},
  paid:{},
  rules:{},
  lastBackup:null
};
const SAMPLES=[
  ["2026-10-03",412.5,"AED",412.5,"cbd",true,"Groceries","Weekly shop (example)"],
  ["2026-10-07",185,"AED",185,"enbd",false,"Fuel & transport","Fuel (example)"],
  ["2026-10-11",64,"AED",64,"cash",false,"Dining & coffee","Karak & lunch (example)"],
  ["2026-10-14",89.99,"USD",330.49,"citi",false,"Subscriptions","Software subscription (example)"],
  ["2026-10-19",276,"AED",276,"amazon",false,"Shopping","Household order (example)"],
  ["2026-10-22",50,"AED",50,"wallet",false,"Fuel & transport","Ride top-up (example)"],
  ["2026-09-16",1340,"AED",1340,"cbd",false,"Bills & utilities","DEWA + internet (example)"]];

const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=n=>(Math.round((n||0)*100)/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const fmt0=n=>Math.round(n||0).toLocaleString("en-US");
const pad=n=>String(n).padStart(2,"0");
const iso=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const parse=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)};
const MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const ymKey=d=>d.getFullYear()+"-"+pad(d.getMonth()+1);
const dim=(y,m)=>new Date(y,m+1,0).getDate();
const clampDay=(y,m,d)=>new Date(y,m,Math.min(d,dim(y,m)));
const todayD=()=>{const t=new Date();return new Date(t.getFullYear(),t.getMonth(),t.getDate())};
const dayDiff=(a,b)=>Math.round((b-a)/86400000);
const shortD=d=>d.getDate()+" "+MN[d.getMonth()];
const newId=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,9);
const sp=e=>!!(e.samsungPay||e.applePay);
const clone=o=>JSON.parse(JSON.stringify(o));

let settings=clone(DEFAULTS);
let expenses=[];
let storageOK=true;
let view=todayD(); view=new Date(view.getFullYear(),view.getMonth(),1);
let selMethod="cbd", editing=null;
function mcol(id){return "var(--m-"+id+")"}

/* ---------- storage (IndexedDB, see store.js) ---------- */
function mergeSettings(d){
  const s={...clone(DEFAULTS),...clone(d||{})};
  s.cards={...clone(DEFAULTS.cards),...(d&&d.cards||{})};
  s.fx={...(d&&d.fx&&Object.keys(d.fx).length?d.fx:DEFAULTS.fx)};
  s.rules={...(d&&d.rules||{})};s.paid={...(d&&d.paid||{})};s.budgets={...(d&&d.budgets||{})};
  if(!Array.isArray(s.categories)||!s.categories.length)s.categories=clone(DEFAULTS.categories);
  return s;
}
const store=new Store();
function sampleRows(){return SAMPLES.map((r,i)=>({id:"ex"+i,date:r[0],amount:r[1],currency:r[2],aed:r[3],method:r[4],samsungPay:r[5],category:r[6],note:r[7],createdAt:i,sample:true}))}
// Every change goes through save(). It stamps what changed (for sync), writes to IndexedDB in the background and queues an upload.
function save(opts){
  try{store.commit(settings,expenses,opts).catch(saveFailed)}catch(e){saveFailed(e);return false}
  return true;
}
function saveFailed(){storageOK=false;showWarn("This device didn't let the app save. Your last change may not be stored. Download a backup from Settings now.");renderStatus()}
function showWarn(t){const b=$("#warnBanner");b.hidden=false;$("#warnText").textContent=t}
store.onChange((v,kind)=>{if(kind==="meta"){sync&&sync.refresh();return}settings=v.settings;expenses=v.expenses;if(editing&&!expenses.some(e=>e.id===editing))editing=null;renderAll()});

function download(name,text,type){
  const b=new Blob([text],{type:type||"text/plain"});const a=document.createElement("a");
  a.href=URL.createObjectURL(b);a.download=name;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);
}
function toCsv(rows){return rows.map(r=>r.map(v=>{v=String(v??"");return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}).join(",")).join("\n")}

/* ---------- quick add ---------- */
function renderChips(){
  $("#methodChips").innerHTML=METHODS.map(m=>`<button type="button" class="chip" data-m="${m.id}" aria-pressed="${m.id===selMethod}"><span class="dot" style="background:${mcol(m.id)}"></span>${m.name}</button>`).join("");
  $("#apWrap").hidden=!MBY[selMethod].card;
}
$("#methodChips").addEventListener("click",e=>{const b=e.target.closest(".chip");if(!b)return;selMethod=b.dataset.m;renderChips();store.setMeta({lastMethod:selMethod}).catch(()=>{})});
function renderSelects(){
  const curs=Object.keys(settings.fx);
  const cv=$("#aCur").value||"AED";
  $("#aCur").innerHTML=curs.map(c=>`<option ${c===cv?"selected":""}>${esc(c)}</option>`).join("");
  const cc=$("#aCat").value;
  $("#aCat").innerHTML=settings.categories.map(c=>`<option ${c===cc?"selected":""}>${esc(c)}</option>`).join("");
  const fm=$("#fMethod").value, fc=$("#fCat").value;
  $("#fMethod").innerHTML='<option value="">All methods</option>'+METHODS.map(m=>`<option value="${m.id}" ${m.id===fm?"selected":""}>${m.name}</option>`).join("");
  $("#fCat").innerHTML='<option value="">All categories</option>'+settings.categories.map(c=>`<option ${c===fc?"selected":""}>${esc(c)}</option>`).join("");
  const ic=$("#iCard").value;
  $("#iCard").innerHTML=METHODS.filter(m=>m.card).map(m=>`<option value="${m.id}" ${m.id===ic?"selected":""}>${m.name}</option>`).join("");
}
let aedTouched=false;
function updateFx(){
  const cur=$("#aCur").value, amt=parseFloat($("#aAmt").value);
  if(cur==="AED"){$("#aAed").placeholder="Same as amount";$("#fxNote").textContent="";if(!aedTouched)$("#aAed").value="";return}
  const r=settings.fx[cur]||0;
  $("#fxNote").textContent=r?`1 ${cur} = ${r} AED`:`No rate for ${cur}: enter the AED amount`;
  if(!aedTouched&&!isNaN(amt)&&r)$("#aAed").value=(amt*r).toFixed(2);
}
$("#aAmt").addEventListener("input",updateFx);
$("#aCur").addEventListener("change",()=>{aedTouched=false;updateFx()});
$("#aAed").addEventListener("input",()=>{aedTouched=$("#aAed").value!==""});
function flash(el,text,ok){el.textContent=text;el.className="msg "+(ok?"ok":"err");clearTimeout(el._t);el._t=setTimeout(()=>{el.textContent=""},4000)}
$("#addForm").addEventListener("submit",e=>{
  e.preventDefault();
  const amount=parseFloat($("#aAmt").value), cur=$("#aCur").value;
  if(!(amount>0)){flash($("#addMsg"),"Enter an amount above zero.",false);return}
  const aed=cur==="AED"?amount:parseFloat($("#aAed").value);
  if(cur!=="AED"&&!(aed>0)){flash($("#addMsg"),"Enter the AED charged, or add a rate for "+cur+" in Settings.",false);return}
  const rec={id:newId(),date:$("#aDate").value||iso(todayD()),amount:+amount.toFixed(2),currency:cur,aed:+aed.toFixed(2),method:selMethod,
    samsungPay:MBY[selMethod].card&&$("#aAp").checked,category:$("#aCat").value,note:$("#aNote").value.trim(),createdAt:Date.now()};
  expenses.push(rec);
  if(!save()){expenses.pop();return}
  flash($("#addMsg"),`Added AED ${fmt(rec.aed)} on ${MBY[rec.method].name}`,true);
  $("#aAmt").value="";$("#aAed").value="";$("#aNote").value="";aedTouched=false;updateFx();$("#aAmt").focus();
  const d=parse(rec.date);if(ymKey(d)!==ymKey(view))view=new Date(d.getFullYear(),d.getMonth(),1);
  render();
});

/* ---------- derived ---------- */
function inMonth(e,d){return e.date.slice(0,7)===ymKey(d)}
function monthExp(d){return expenses.filter(e=>inMonth(e,d))}
function sum(list){return list.reduce((a,e)=>a+(+e.aed||0),0)}
function totalBudget(){return Object.values(settings.budgets).reduce((a,b)=>a+(+b||0),0)}
function cycle(cardId){
  const c=settings.cards[cardId]||{}; const S=+c.statementDay, D=+c.dueDay;
  if(!S||!D)return null;
  const t=todayD();
  let close=clampDay(t.getFullYear(),t.getMonth(),S);
  if(close>t)close=clampDay(t.getFullYear(),t.getMonth()-1,S);
  const prevClose=clampDay(close.getFullYear(),close.getMonth()-1,S);
  let due=clampDay(close.getFullYear(),close.getMonth(),D);
  if(due<=close)due=clampDay(close.getFullYear(),close.getMonth()+1,D);
  const nextClose=clampDay(close.getFullYear(),close.getMonth()+1,S);
  const ex=expenses.filter(e=>e.method===cardId);
  const stmt=sum(ex.filter(e=>{const d=parse(e.date);return d>prevClose&&d<=close}));
  const curr=sum(ex.filter(e=>parse(e.date)>close));
  const key=cardId+":"+iso(close);
  return {close,prevClose,due,nextClose,stmt,curr,key,paid:!!settings.paid[key],daysToDue:dayDiff(t,due)};
}

/* ---------- render ---------- */
function renderStatus(){
  const real=expenses.filter(e=>!e.sample).length;
  let t=storageOK?`Saved on this device · ${real} expense${real===1?"":"s"}`:"Not saving: this browser is blocking storage";
  const lb=settings.lastBackup?dayDiff(parse(settings.lastBackup.slice(0,10)),todayD()):null;
  $("#status").innerHTML=esc(t)+(real?` · <button class="linkbtn" type="button" id="bkNow">${lb===null?"Never backed up":lb===0?"Backed up today":"Last backup "+lb+" day"+(lb===1?"":"s")+" ago"}</button>`:"");
  const bk=$("#bkNow");if(bk){bk.classList.toggle("stale",lb===null||lb>14);bk.onclick=doBackup}
  const ss=syncSummary();
  if(ss)$("#status").insertAdjacentHTML("beforeend",` · <button class="linkbtn${ss.bad?" stale":""}" type="button" id="syncLink">${esc(ss.text)}</button>`);
  const sl=$("#syncLink");if(sl)sl.onclick=openSync;
  if(installEvt)$("#status").insertAdjacentHTML("beforeend",` · <button class="linkbtn" type="button" id="instLink">Install app</button>`);
  const il=$("#instLink");if(il)il.onclick=async()=>{const ev=installEvt;installEvt=null;renderStatus();try{await ev.prompt()}catch(_){}};
}
function render(){
  $("#monthLbl").textContent=MN[view.getMonth()]+" "+view.getFullYear();
  const isCur=ymKey(view)===ymKey(todayD());
  $("#nextM").disabled=isCur;$("#nextM").style.opacity=isCur?.35:1;
  renderKpis();renderCards();renderMethods();renderCats();renderTrend();renderRows();renderStatus();
  $("#exBanner").hidden=!expenses.some(e=>e.sample);
}
function renderAll(){renderSelects();if(!$("#settings").contains(document.activeElement))renderSettings();render()}
function renderKpis(){
  const m=monthExp(view), tot=sum(m), bud=totalBudget();
  const prev=new Date(view.getFullYear(),view.getMonth()-1,1), ptot=sum(monthExp(prev));
  const isCur=ymKey(view)===ymKey(todayD());
  const daysIn=dim(view.getFullYear(),view.getMonth()), dayNow=isCur?todayD().getDate():daysIn;
  const pct=bud?tot/bud:0;
  const foreign=sum(m.filter(e=>e.currency!=="AED"));
  const delta=ptot?((tot-ptot)/ptot*100):null;
  const nsp=m.filter(sp).length;
  let budState="neutral",budTxt="No budget set";
  if(bud){const pace=dayNow/daysIn; if(pct>1){budState="crit";budTxt="Over budget"}else if(pct>pace+0.1){budState="warn";budTxt="Ahead of pace"}else{budState="good";budTxt="On track"}}
  $("#kpis").innerHTML=`
   <div class="kpi"><span class="eyebrow">Spent in ${MN[view.getMonth()]}</span><span class="v num"><small>AED</small>${fmt0(tot)}</span>
     <span class="small muted">${delta===null?"No spend logged last month":(delta>=0?"▲ ":"▼ ")+Math.abs(delta).toFixed(0)+"% vs "+MN[prev.getMonth()]}</span></div>
   <div class="kpi"><span class="eyebrow">Budget used</span><span class="v num">${bud?Math.round(pct*100)+"%":"—"}</span>
     <div class="meter"><i style="width:${Math.min(100,pct*100)}%;background:var(--${budState==="crit"?"crit":budState==="warn"?"warn":"accent"})"></i></div>
     <span><span class="pill ${budState}">${budTxt}</span></span></div>
   <div class="kpi"><span class="eyebrow">Left to spend</span><span class="v num"><small>AED</small>${bud?fmt0(bud-tot):"—"}</span>
     <span class="small muted">${bud?(isCur?`${daysIn-dayNow} days left · AED ${fmt0(Math.max(0,(bud-tot)/Math.max(1,daysIn-dayNow+1)))}/day`:`of AED ${fmt0(bud)} budget`):"Set budgets in Settings"}</span></div>
   <div class="kpi"><span class="eyebrow">Transactions</span><span class="v num">${m.length}</span>
     <span class="small muted">${foreign?`AED ${fmt0(foreign)} in foreign currency`:"All in AED"}${nsp?` · ${nsp} by Samsung Pay`:""}</span></div>`;
}
function renderCards(){
  $("#cards").innerHTML=METHODS.filter(m=>m.card).map(m=>{
    const c=cycle(m.id), lim=+(settings.cards[m.id]||{}).limit||0;
    if(!c)return `<div class="stmt" style="--mc:${mcol(m.id)}"><div class="nm"><b>${m.name}</b><span class="pill neutral">Not set up</span></div>
      <p class="small muted" style="margin:0">Add the statement and due days in Settings, or import a statement, to track what's due.</p>
      <div><button class="btn sm" type="button" data-open-set>Set up card</button></div></div>`;
    let pill;
    if(c.stmt<=0)pill=`<span class="pill neutral">Nothing due</span>`;
    else if(c.paid)pill=`<span class="pill good">✓ Paid</span>`;
    else if(c.daysToDue<0)pill=`<span class="pill crit">! Overdue ${-c.daysToDue}d</span>`;
    else if(c.daysToDue<=5)pill=`<span class="pill warn">Due in ${c.daysToDue}d</span>`;
    else pill=`<span class="pill neutral">Due in ${c.daysToDue}d</span>`;
    const util=lim?Math.min(100,(c.curr+(c.paid?0:c.stmt))/lim*100):0;
    return `<div class="stmt" style="--mc:${mcol(m.id)}">
      <div class="nm"><b>${m.name}</b>${pill}</div>
      <dl class="kv"><dt>Statement ${shortD(c.close)}</dt><dd class="big">${fmt(c.stmt)}</dd>
        <dt>Payment due</dt><dd>${shortD(c.due)}</dd>
        <dt>Since statement</dt><dd>${fmt(c.curr)}</dd>
        <dt>Next statement</dt><dd>${shortD(c.nextClose)}</dd></dl>
      ${lim?`<div><div class="row spread small"><span class="muted">Limit used</span><span class="num">${util.toFixed(0)}% of ${fmt0(lim)}</span></div><div class="meter"><i style="width:${util}%;background:${util>80?"var(--warn)":mcol(m.id)}"></i></div></div>`:""}
      ${c.stmt>0?`<div><button class="btn sm" type="button" data-paid="${c.key}">${c.paid?"Mark unpaid":"Mark statement paid"}</button></div>`:""}
    </div>`}).join("");
}
$("#cards").addEventListener("click",e=>{
  if(e.target.closest("[data-open-set]")){$("#settings").open=true;$("#settings").scrollIntoView({behavior:"smooth"});return}
  const b=e.target.closest("[data-paid]");if(!b)return;
  const k=b.dataset.paid; if(settings.paid[k])delete settings.paid[k]; else settings.paid[k]=true;
  save();renderCards();
});
function barRows(items,max){
  if(!items.length)return `<div class="empty">No spend in ${MN[view.getMonth()]} yet. Add an expense above and it shows up here.</div>`;
  return items.map(it=>{
    const w=max?it.v/max*100:0, bw=it.budget&&max?Math.min(100,it.budget/max*100):null, over=it.budget&&it.v>it.budget;
    return `<div class="bar ${over?"over":""}" data-tip="${esc(it.tip)}"><span class="lab">${it.color?`<span class="dot" style="background:${it.color}"></span>`:""}${esc(it.label)}</span>
      <span class="t"><i style="width:${w}%;background:${over?"var(--crit)":(it.color||"var(--accent)")}"></i>${bw!==null?`<span class="bud" style="left:calc(${bw}% - 1px)"></span>`:""}</span>
      <span class="val">${fmt0(it.v)}${it.budget?`<span class="muted"> / ${fmt0(it.budget)}</span>`:""}</span></div>`}).join("");
}
function renderMethods(){
  const m=monthExp(view), tot=sum(m);
  const items=METHODS.map(x=>{const l=m.filter(e=>e.method===x.id),v=sum(l),ap=sum(l.filter(sp));
    return {label:x.name,v,color:mcol(x.id),tip:`${x.name}: AED ${fmt(v)} · ${l.length} txn${l.length===1?"":"s"}${ap?` · AED ${fmt(ap)} by Samsung Pay`:""}${tot?` · ${(v/tot*100).toFixed(0)}%`:""}`}}).filter(i=>i.v>0).sort((a,b)=>b.v-a.v);
  $("#methBars").innerHTML=barRows(items,items.length?items[0].v:0);
  $("#methTot").textContent=tot?"AED "+fmt(tot):"";
}
function renderCats(){
  const m=monthExp(view);
  const cats=[...new Set([...settings.categories,...m.map(e=>e.category)])];
  const items=cats.map(c=>{const l=m.filter(e=>e.category===c),v=sum(l),b=+settings.budgets[c]||0;
    return {label:c,v,budget:b,tip:`${c}: AED ${fmt(v)}${b?` of ${fmt0(b)} budget (${(v/b*100).toFixed(0)}%)`:" · no budget"}`}}).filter(i=>i.v>0||i.budget>0).sort((a,b)=>b.v-a.v||b.budget-a.budget);
  const max=Math.max(0,...items.map(i=>Math.max(i.v,i.budget)));
  $("#catBars").innerHTML=barRows(items,max);
  const bud=totalBudget(); $("#catTot").textContent=bud?`Budget AED ${fmt0(bud)}`:"";
}
function niceMax(v){if(v<=0)return 1000;const p=Math.pow(10,Math.floor(Math.log10(v)));const n=v/p;return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p}
function renderTrend(){
  const months=[];for(let i=5;i>=0;i--)months.push(new Date(view.getFullYear(),view.getMonth()-i,1));
  const vals=months.map(d=>sum(monthExp(d)));
  const W=720,H=220,L=52,R=12,T=22,B=28, iw=W-L-R, ih=H-T-B;
  const bud=totalBudget();
  const max=niceMax(Math.max(...vals,bud));
  const step=iw/months.length, bw=Math.min(56,step*0.55), vmax=Math.max(...vals);
  let s=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly spend for the last six months">`;
  for(let i=0;i<=4;i++){const v=max*i/4,y=T+ih-ih*i/4;s+=`<line class="${i?"gl":"base"}" x1="${L}" x2="${W-R}" y1="${y}" y2="${y}"/><text x="${L-8}" y="${y+4}" text-anchor="end">${v>=1000?(v/1000).toFixed(v%1000?1:0)+"k":fmt0(v)}</text>`}
  months.forEach((d,i)=>{const x=L+step*i+(step-bw)/2,h=vals[i]/max*ih,y=T+ih-h,cur=i===5,r=Math.min(4,h);
    if(h>0)s+=`<path fill="var(--accent)" opacity="${cur?1:.55}" d="M${x},${T+ih}V${y+r}q0,-${r} ${r},-${r}h${bw-2*r}q${r},0 ${r},${r}V${T+ih}Z"/>`;
    if(vals[i]>0&&(cur||vals[i]===vmax))s+=`<text class="vl" x="${x+bw/2}" y="${y-6}" text-anchor="middle">${fmt0(vals[i])}</text>`;
    s+=`<text x="${x+bw/2}" y="${H-8}" text-anchor="middle">${MN[d.getMonth()]}</text>`;
    s+=`<rect class="hit" x="${L+step*i}" y="${T}" width="${step}" height="${ih}" data-ym="${ymKey(d)}" data-tip="${MN[d.getMonth()]} ${d.getFullYear()}: AED ${fmt(vals[i])}"/>`});
  if(bud){const y=T+ih-bud/max*ih;s+=`<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${W-R}" y="${y-5}" text-anchor="end" style="fill:var(--ink-2)">Budget ${fmt0(bud)}</text>`}
  $("#trend").innerHTML=s+"</svg>";
}
$("#trend").addEventListener("click",e=>{const r=e.target.closest("[data-ym]");if(!r)return;const [y,m]=r.dataset.ym.split("-").map(Number);view=new Date(y,m-1,1);render()});
const tip=$("#tip");
document.addEventListener("pointermove",e=>{const t=e.target.closest&&e.target.closest("[data-tip]");if(!t){tip.hidden=true;return}
  tip.textContent=t.dataset.tip;tip.hidden=false;const w=tip.offsetWidth;let x=e.clientX+14;if(x+w>innerWidth-8)x=e.clientX-w-14;tip.style.left=Math.max(8,x)+"px";tip.style.top=(e.clientY+16)+"px"});
document.addEventListener("pointerleave",()=>tip.hidden=true);

/* ---------- register ---------- */
function filtered(){
  const fm=$("#fMethod").value,fc=$("#fCat").value,ft=$("#fText").value.trim().toLowerCase();
  return monthExp(view).filter(e=>(!fm||e.method===fm)&&(!fc||e.category===fc)&&(!ft||(e.note||"").toLowerCase().includes(ft)))
    .sort((a,b)=>b.date.localeCompare(a.date)||(b.createdAt||0)-(a.createdAt||0));
}
function renderRows(){
  const list=filtered();
  $("#regCount").textContent=list.length?`${list.length} · AED ${fmt(sum(list))}`:"";
  if(!list.length){$("#rows").innerHTML=`<tr><td colspan="7"><div class="empty" style="margin:6px 0">${expenses.length?"Nothing matches in "+MN[view.getMonth()]+".":"No expenses yet. Add your first one at the top; it lands here and in every chart."}</div></td></tr>`;return}
  $("#rows").innerHTML=list.map(e=>{
    const m=MBY[e.method]||{name:e.method};
    if(editing===e.id)return `<tr data-id="${e.id}">
      <td><input type="date" id="eDate" value="${esc(e.date)}"></td>
      <td><select id="eMethod">${METHODS.map(x=>`<option value="${x.id}" ${x.id===e.method?"selected":""}>${x.name}</option>`).join("")}</select></td>
      <td><select id="eCat">${[...new Set([...settings.categories,e.category])].map(c=>`<option ${c===e.category?"selected":""}>${esc(c)}</option>`).join("")}</select></td>
      <td><input type="text" id="eNote" value="${esc(e.note)}"></td>
      <td class="r"><input type="number" id="eAmt" step="0.01" value="${e.amount}" style="width:100px"> ${esc(e.currency)}</td>
      <td class="r"><input type="number" id="eAed" step="0.01" value="${e.aed}" style="width:100px"></td>
      <td><div class="acts"><button class="btn sm primary" data-act="save">Save</button><button class="btn sm ghost" data-act="cancel">Cancel</button></div></td></tr>`;
    return `<tr data-id="${e.id}" class="${e.sample?"sample":""}">
      <td class="num">${shortD(parse(e.date))}</td>
      <td style="white-space:nowrap"><span class="dot" style="background:${mcol(e.method)}"></span>${esc(m.name)}${sp(e)?'<span class="tag">Samsung Pay</span>':""}</td>
      <td>${esc(e.category)}</td>
      <td>${esc(e.note)}${e.sample?'<span class="tag ex">Example</span>':""}${e.source==="statement"?'<span class="tag st">Statement</span>':""}</td>
      <td class="r num muted">${e.currency!=="AED"?esc(e.currency)+" "+fmt(e.amount):""}</td>
      <td class="r num">${fmt(e.aed)}</td>
      <td><div class="acts">${e._confirm?`<button class="btn sm" data-act="del" style="color:var(--crit)">Delete</button><button class="btn sm ghost" data-act="nodel">Keep</button>`:`<button class="btn sm ghost" data-act="edit">Edit</button><button class="btn sm ghost" data-act="ask" aria-label="Delete">✕</button>`}</div></td></tr>`}).join("");
}
$("#rows").addEventListener("click",ev=>{
  const b=ev.target.closest("[data-act]");if(!b)return;const id=b.closest("tr").dataset.id;const e=expenses.find(x=>x.id===id);if(!e)return;
  const act=b.dataset.act;
  if(act==="edit"){editing=id;renderRows();return}
  if(act==="cancel"){editing=null;renderRows();return}
  if(act==="ask"){expenses.forEach(x=>x._confirm=false);e._confirm=true;renderRows();return}
  if(act==="nodel"){e._confirm=false;renderRows();return}
  if(act==="del"){expenses=expenses.filter(x=>x.id!==id);save();render();return}
  if(act==="save"){
    const amt=parseFloat($("#eAmt").value),aed=parseFloat($("#eAed").value),method=$("#eMethod").value;
    if(!(amt>0)||!(aed>0)){flash($("#addMsg"),"Amounts must be above zero.",false);return}
    Object.assign(e,{date:$("#eDate").value||e.date,method,samsungPay:MBY[method].card&&sp(e),category:$("#eCat").value,note:$("#eNote").value.trim(),amount:+amt.toFixed(2),aed:+(e.currency==="AED"?amt:aed).toFixed(2)});
    delete e.sample;delete e.applePay;
    if(e.note)learnRule(e.note,e.category);
    editing=null;save();render();
  }
});
["#fMethod","#fCat"].forEach(s=>$(s).addEventListener("change",renderRows));
$("#fText").addEventListener("input",renderRows);
$("#prevM").addEventListener("click",()=>{view=new Date(view.getFullYear(),view.getMonth()-1,1);editing=null;render()});
$("#nextM").addEventListener("click",()=>{view=new Date(view.getFullYear(),view.getMonth()+1,1);editing=null;render()});
$("#clearEx").addEventListener("click",()=>{expenses=expenses.filter(e=>!e.sample);save();render()});
$("#csvBtn").addEventListener("click",()=>{
  const rows=[["Date","Method","Samsung Pay","Category","Note","Amount","Currency","AED"]].concat(
    [...expenses].filter(e=>!e.sample).sort((a,b)=>a.date.localeCompare(b.date)).map(e=>[e.date,(MBY[e.method]||{}).name||e.method,sp(e)?"Yes":"",e.category,e.note,e.amount,e.currency,e.aed]));
  download("expenses-"+iso(todayD())+".csv",toCsv(rows),"text/csv");
});

/* ---------- settings ---------- */
function renderSettings(){
  $("#cardSet").innerHTML=METHODS.filter(m=>m.card).map(m=>{const c=settings.cards[m.id]||{};
    return `<tr><td><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;background:${mcol(m.id)}"></span>${m.name}</td>
      <td><input type="number" min="1" max="31" id="s-${m.id}-st" value="${c.statementDay??""}" placeholder="—"></td>
      <td><input type="number" min="1" max="31" id="s-${m.id}-due" value="${c.dueDay??""}" placeholder="—"></td>
      <td><input type="number" min="0" step="100" id="s-${m.id}-lim" value="${c.limit??""}" placeholder="optional"></td></tr>`}).join("");
  $("#budSet").innerHTML=settings.categories.map((c,i)=>`<tr><td>${esc(c)}</td><td><input type="number" min="0" step="50" id="b-${i}" value="${settings.budgets[c]??""}" placeholder="0"></td><td><button class="btn sm ghost" type="button" data-rmcat="${i}" aria-label="Remove ${esc(c)}">✕</button></td></tr>`).join("");
  $("#fxSet").innerHTML=Object.entries(settings.fx).filter(([k])=>k!=="AED").map(([k,v])=>`<tr><td>1 ${esc(k)} =</td><td><input type="number" step="0.0001" min="0" data-fx="${esc(k)}" value="${v}"></td><td>AED</td></tr>`).join("");
}
function readSettingsForm(){
  const s=clone(settings);
  METHODS.filter(m=>m.card).forEach(m=>{const n=id=>{const v=parseInt($("#s-"+m.id+"-"+id).value,10);return isNaN(v)?null:v};
    s.cards[m.id]={statementDay:n("st")?Math.min(31,Math.max(1,n("st"))):null,dueDay:n("due")?Math.min(31,Math.max(1,n("due"))):null,limit:n("lim")}});
  s.budgets={};settings.categories.forEach((c,i)=>{const el=$("#b-"+i);const v=el?parseFloat(el.value):NaN;if(v>0)s.budgets[c]=v});
  document.querySelectorAll("[data-fx]").forEach(i=>{const v=parseFloat(i.value);if(v>0)s.fx[i.dataset.fx]=v});
  return s;
}
$("#budSet").addEventListener("click",e=>{const b=e.target.closest("[data-rmcat]");if(!b)return;settings=readSettingsForm();const c=settings.categories[+b.dataset.rmcat];settings.categories=settings.categories.filter(x=>x!==c);delete settings.budgets[c];renderSettings();renderSelects();flash($("#setMsg"),"Removed "+c+". Save to keep it.",true)});
$("#addCat").addEventListener("click",()=>{const v=$("#newCat").value.trim();if(!v||settings.categories.includes(v))return;settings=readSettingsForm();settings.categories.push(v);$("#newCat").value="";renderSettings();renderSelects()});
$("#addCur").addEventListener("click",()=>{const c=$("#newCur").value.trim().toUpperCase(),r=parseFloat($("#newRate").value);if(!/^[A-Z]{3}$/.test(c)||!(r>0)){flash($("#setMsg"),"Enter a 3-letter code and a rate above zero.",false);return}settings=readSettingsForm();settings.fx[c]=r;$("#newCur").value="";$("#newRate").value="";renderSettings();renderSelects()});
$("#saveSet").addEventListener("click",()=>{settings=readSettingsForm();if(save()){flash($("#setMsg"),"Settings saved",true);render()}});

/* ---------- backup & restore ---------- */
function doBackup(){
  settings.lastBackup=new Date().toISOString();save();
  const data={app:"card-cash-ledger",v:1,savedAt:settings.lastBackup,settings,expenses:expenses.filter(e=>!e.sample).map(({_confirm,...e})=>e)};
  download("ledger-backup-"+iso(todayD())+".json",JSON.stringify(data,null,1),"application/json");
  renderStatus();flash($("#bkMsg"),"Backup downloaded",true);
}
$("#bkBtn").addEventListener("click",doBackup);
let pendingRestore=null;
$("#rsFile").addEventListener("change",async()=>{
  const f=$("#rsFile").files[0];if(!f)return;
  const text=await f.text();$("#rsFile").value="";
  $("#rsConfirm").hidden=true;pendingRestore=null;
  if(/\.json$/i.test(f.name)||text.trim().startsWith("{")){
    let d;try{d=JSON.parse(text)}catch(_){flash($("#bkMsg"),"That file isn't a ledger backup.",false);return}
    if(!d||!Array.isArray(d.expenses)){flash($("#bkMsg"),"That file isn't a ledger backup.",false);return}
    pendingRestore=d;
    $("#rsConfirm").hidden=false;
    $("#rsText").textContent=`Replace everything here (${expenses.filter(e=>!e.sample).length} expenses) with the backup from ${d.savedAt?shortD(new Date(d.savedAt))+" "+new Date(d.savedAt).getFullYear():"this file"} (${d.expenses.length} expenses)?${sync&&sync.connected?" Sync is on, so this also replaces the data on your other devices.":""}`;
    return}
  // ledger CSV export (from this tracker or the Claude version)
  const rows=parseCsv(text);const h=(rows[0]||[]).map(x=>x.trim().toLowerCase());
  const ci=n=>h.indexOf(n);
  if(ci("date")<0||ci("method")<0||ci("aed")<0){flash($("#bkMsg"),"That CSV isn't a ledger export. For a bank CSV, use Import card statement.",false);return}
  const byName=Object.fromEntries(METHODS.map(m=>[m.name.toLowerCase(),m.id]));
  let added=0,skipped=0;
  rows.slice(1).forEach(r=>{
    const date=normDate(r[ci("date")]);const aed=parseFloat(r[ci("aed")]);const method=byName[(r[ci("method")]||"").trim().toLowerCase()];
    if(!date||!(aed>0)||!method){if(r.join("").trim())skipped++;return}
    const note=ci("note")>=0?r[ci("note")]||"":"";
    if(expenses.some(e=>e.date===date&&e.method===method&&Math.abs(e.aed-aed)<0.005&&(e.note||"")===note)){skipped++;return}
    const amt=parseFloat(r[ci("amount")]);const cur=(r[ci("currency")]||"AED").trim().toUpperCase()||"AED";
    const spCol=h.findIndex(x=>x==="samsung pay"||x==="apple pay");
    expenses.push({id:newId(),date,amount:amt>0?amt:aed,currency:/^[A-Z]{3}$/.test(cur)?cur:"AED",aed,method,samsungPay:spCol>=0&&/yes/i.test(r[spCol]||""),
      category:(ci("category")>=0&&r[ci("category")])||"Other",note,createdAt:Date.now()});added++});
  save();renderAll();flash($("#bkMsg"),`Imported ${added} expense${added===1?"":"s"}${skipped?`, skipped ${skipped} already here or unreadable`:""}.`,!!added||!skipped);
});
$("#rsYes").addEventListener("click",()=>{
  if(!pendingRestore)return;
  settings=mergeSettings(pendingRestore.settings);expenses=restoredExpenses(pendingRestore.expenses);pendingRestore=null;
  $("#rsConfirm").hidden=true;save({force:true});renderAll();flash($("#bkMsg"),"Backup restored",true);
});
$("#rsNo").addEventListener("click",()=>{pendingRestore=null;$("#rsConfirm").hidden=true});

/* ---------- categorising ---------- */
const KW=[
 ["Dining & coffee",/careem\s*food|noon\s*food|talabat|deliveroo|zomato|starbucks|costa|tim hortons|caribou|\bcafe|coffee|restaurant|mcdonald|\bkfc\b|burger|pizza|shawarma|karak|bakery|eatery|grill|kitchen|dining|bistro|sushi/i],
 ["Groceries",/carrefour|spinneys|lulu|waitrose|choithram|union\s*coop|kibsons|grandiose|al\s*maya|west\s*zone|viva\b|nesto|instashop|el\s*grocer|supermarket|hypermarket|grocer|baqala|organic foods/i],
 ["Fuel & transport",/adnoc|enoc|eppco|emarat|petrol|fuel|careem|uber|salik|\brta\b|nol\b|parking|parkin|taxi|yango|darb|car wash/i],
 ["Bills & utilities",/dewa|sewa|addc|aadc|fewa|etisalat|\be&|\bdu\b|virgin mobile|empower|tabreed|lootah|internet|telecom/i],
 ["Subscriptions",/netflix|spotify|apple\.com|itunes|google\s*(one|play|storage|\*)|youtube|\bosn\b|shahid|anghami|disney|prime video|amazon prime|adobe|microsoft|openai|chatgpt|anthropic|claude\.ai|dropbox|icloud|zoom\.us|linkedin/i],
 ["Shopping",/amazon|amzn|noon\b|namshi|ikea|\bace\b|home\s*centre|centrepoint|max fashion|h&m|zara|sharaf\s*dg|jumbo|virgin megastore|decathlon|mall/i],
 ["Travel",/emirates|flydubai|etihad|air arabia|airline|airways|booking\.com|agoda|expedia|hotel|marriott|hilton|airbnb|hyatt|rotana|accor/i],
 ["Health & fitness",/pharmacy|aster|boots|clinic|hospital|medical|dental|\bgym|fitness|physio|healthcare/i],
 ["Entertainment",/\bvox\b|reel cinemas|novo cinemas|cinema|ticketmaster|platinumlist|steam|playstation|xbox|nintendo/i],
 ["Personal care",/salon|barber|\bspa\b|grooming|nails/i],
 ["Home",/ikea|home\s*box|pan emirates|danube|maintenance|plumb|laundry|cleaning/i],
 ["Other",/\bfee\b|charge|interest|\bvat\b|commission|finance cost/i]];
function ruleKey(desc){return String(desc||"").toUpperCase().replace(/[^A-Z& ]+/g," ").replace(/\s+/g," ").trim().split(" ").filter(w=>w.length>1).slice(0,2).join(" ")}
function learnRule(desc,cat){const k=ruleKey(desc);if(k.length>=3)settings.rules[k]=cat}
function guessCategory(desc){
  const cats=settings.categories, fallback=cats.includes("Other")?"Other":cats[cats.length-1];
  const k=ruleKey(desc);
  if(k&&settings.rules[k]&&cats.includes(settings.rules[k]))return settings.rules[k];
  if(k){const prev=[...expenses].reverse().find(e=>!e.sample&&e.note&&ruleKey(e.note)===k&&cats.includes(e.category));if(prev)return prev.category}
  for(const [c,re] of KW)if(cats.includes(c)&&re.test(desc))return c;
  return fallback;
}

/* ---------- statement import UI ---------- */
let impRows=[],impMeta=null;
function iStat(html,busy){const el=$("#iStat");el.hidden=!html;el.innerHTML=(busy?'<span class="spin" aria-hidden="true"></span>':"")+html}
$("#iFile").addEventListener("change",()=>{const f=$("#iFile").files[0];$("#pwWrap").hidden=!!(f&&/\.csv$/i.test(f.name))});
function findMatch(tx,used){
  const d=parse(tx.date);let best=null,bd=99;
  expenses.forEach(e=>{if(e.sample||used.has(e.id)||e.method!==impMeta.card)return;
    if(Math.abs((+e.aed||0)-tx.aed)>Math.max(0.5,tx.aed*0.01))return;
    const dd=Math.abs(dayDiff(parse(e.date),d));if(dd<=4&&dd<bd){bd=dd;best=e}});
  return best;
}
$("#impForm").addEventListener("submit",async ev=>{
  ev.preventDefault();
  const file=$("#iFile").files[0];if(!file){iStat("Choose the statement file first.");return}
  const card=$("#iCard").value;
  $("#iGo").disabled=true;$("#iReview").hidden=true;
  let res;
  try{
    if(/\.csv$/i.test(file.name)||file.type==="text/csv"){iStat("Reading the CSV…",true);res=parseStatementCsv(await file.text())}
    else{
      iStat("Unlocking and reading the PDF…",true);
      const lines=await pdfLines(file,$("#iPw").value);
      $("#iPw").value="";
      const flat=lines.map(c=>c.join("  "));
      if(flat.join("").replace(/\s/g,"").length<40){iStat("This PDF has no readable text (it may be a scanned image), so transactions can't be picked out.");return}
      const raw=lines.map(lineToTx).filter(Boolean);
      res=finishTxs(raw,flat);
    }
  }catch(e){
    if(e&&e.name==="PasswordException"){iStat(e.code===2?"That password didn't open the PDF. Check it and try again.":"This PDF is password-protected. Enter the password and try again.");$("#iPw").focus()}
    else if(e&&e.message==="load")iStat("The PDF reader couldn't load. Reload the app and try again.");
    else if(e&&e.message==="csvhead")iStat("Couldn't find a header row with a date and an amount column in this CSV.");
    else if(e&&e.message==="ledgercsv")iStat("This is a ledger export, not a bank statement. Use Restore in Settings to load it.");
    else iStat("Couldn't read this file.");
    return;
  }finally{$("#iGo").disabled=false}
  if(!res.txs.length){iStat("No transactions were recognised in this statement. If it's a PDF, try your bank's CSV download instead, or send me a redacted sample line so the reader can learn the layout.");return}
  impMeta={card,statementDate:res.statementDate,dueDate:res.dueDate};
  const used=new Set();
  impRows=res.txs.sort((a,b)=>a.date.localeCompare(b.date)).map((t,i)=>{let st="new",m=null;
    if(t.type!=="charge")st=t.type;else{m=findMatch(t,used);if(m){used.add(m.id);st="dup"}}
    return {...t,i,status:st,match:m,pick:st==="new"}});
  renderReview();
});
function renderReview(){
  const nNew=impRows.filter(r=>r.status==="new").length,nDup=impRows.filter(r=>r.status==="dup").length,nPick=impRows.filter(r=>r.pick).length;
  const cname=MBY[impMeta.card].name, cs=settings.cards[impMeta.card]||{};
  const canSet=impMeta.statementDate&&impMeta.dueDate&&(!cs.statementDay||!cs.dueDay);
  const chg=impRows.filter(r=>r.status==="new"||r.status==="dup").reduce((a,r)=>a+r.aed,0);
  iStat(`Found ${impRows.length} line${impRows.length===1?"":"s"} on the ${cname} statement${impMeta.statementDate?" dated "+shortD(parse(impMeta.statementDate)):""}: <b>${nNew} not yet logged</b>, ${nDup} already in the tracker. Charges total AED ${fmt(chg)}; compare that with the statement before adding.`);
  $("#iReview").hidden=false;
  $("#iReview").innerHTML=`
    ${canSet?`<label class="toggle"><input type="checkbox" id="iSetDays" checked> Also set ${cname}'s statement day to ${parse(impMeta.statementDate).getDate()} and due day to ${parse(impMeta.dueDate).getDate()}</label>`:""}
    <div class="tablewrap" style="margin-top:0"><table><thead><tr><th><input type="checkbox" id="iAll" aria-label="Select all new" ${nPick&&nPick===nNew?"checked":""}></th><th>Date</th><th>Description</th><th>Status</th><th>Category</th><th class="r">Original</th><th class="r">AED</th></tr></thead>
    <tbody>${impRows.map(r=>{const isNew=r.status==="new";return `<tr class="${isNew?"":"dim"}" data-i="${r.i}">
      <td>${isNew?`<input type="checkbox" data-pick ${r.pick?"checked":""} aria-label="Import this line">`:""}</td>
      <td>${isNew?`<input type="date" data-date value="${r.date}" style="width:140px">`:`<span class="num" style="white-space:nowrap">${shortD(parse(r.date))}</span>`}</td>
      <td>${esc(r.description)}</td>
      <td style="white-space:nowrap">${isNew?'<span class="tag new" style="margin:0">Not logged</span>':r.status==="dup"?`<span class="tag dup" style="margin:0" title="Matches ${esc(r.match.note||r.match.category)} on ${shortD(parse(r.match.date))}">Already logged</span>`:r.status==="credit"?'<span class="tag cr" style="margin:0">Refund / credit</span>':'<span class="tag dup" style="margin:0">Card payment</span>'}</td>
      <td>${isNew?`<select data-cat aria-label="Category">${settings.categories.map(c=>`<option ${c===r.category?"selected":""}>${esc(c)}</option>`).join("")}</select>`:esc(r.status==="dup"?r.match.category:"")}</td>
      <td class="r num muted">${r.currency!=="AED"?esc(r.currency)+" "+fmt(r.amount):""}</td>
      <td class="r">${isNew?`<input type="number" data-aed step="0.01" min="0" value="${r.aed.toFixed(2)}" style="width:110px;text-align:right" class="num">`:`<span class="num">${r.status==="credit"||r.status==="payment"?"−":""}${fmt(r.aed)}</span>`}</td></tr>`}).join("")}</tbody></table></div>
    <div class="row"><button class="btn primary" type="button" id="iAdd" ${nPick?"":"disabled"}>Add ${nPick} to tracker</button><button class="btn" type="button" id="iCsv">Download as CSV</button><button class="btn ghost" type="button" id="iClose">Close</button><span class="msg" id="iMsg" role="status"></span></div>
    <p class="hint" style="margin:0">Dates, categories and AED amounts on new lines can be corrected before adding. Refunds and card payments are listed for reference and aren't added. "Already logged" means an entry on ${cname} with the same AED amount within 4 days.</p>`;
}
$("#iReview").addEventListener("change",e=>{
  if(e.target.id==="iAll"){impRows.forEach(r=>{if(r.status==="new")r.pick=e.target.checked});renderReview();return}
  const tr=e.target.closest("tr[data-i]");if(!tr)return;const r=impRows.find(x=>x.i===+tr.dataset.i);
  if(e.target.matches("[data-pick]")){r.pick=e.target.checked;const n=impRows.filter(x=>x.pick).length;$("#iAdd").textContent=`Add ${n} to tracker`;$("#iAdd").disabled=!n}
  if(e.target.matches("[data-cat]")){r.category=e.target.value;r.catSet=true}
  if(e.target.matches("[data-date]")&&e.target.value)r.date=e.target.value;
  if(e.target.matches("[data-aed]")){const v=parseFloat(e.target.value);if(v>0){r.aed=v;if(r.currency==="AED")r.amount=v}}
});
$("#iReview").addEventListener("click",e=>{
  if(e.target.id==="iClose"){$("#iReview").hidden=true;iStat("");impRows=[];return}
  if(e.target.id==="iCsv"){
    const rows=[["Date","Description","Type","Status","Category","Amount","Currency","AED"]].concat(impRows.map(r=>[r.date,r.description,r.type,r.status==="dup"?"already logged":r.status==="new"?"not logged":r.status,r.category,r.amount,r.currency,r.aed]));
    download(MBY[impMeta.card].name.toLowerCase()+"-statement-"+(impMeta.statementDate||iso(todayD()))+".csv",toCsv(rows),"text/csv");return}
  if(e.target.id==="iAdd"){
    const picks=impRows.filter(r=>r.pick);const before=expenses.length;
    picks.forEach((r,k)=>{expenses.push({id:newId(),date:r.date,amount:+r.amount.toFixed(2),currency:r.currency,aed:+r.aed.toFixed(2),method:impMeta.card,samsungPay:false,category:r.category,note:r.description,createdAt:Date.now()+k,source:"statement"});
      if(r.catSet)learnRule(r.description,r.category)});
    const sd=$("#iSetDays");
    if(sd&&sd.checked)settings.cards[impMeta.card]={...(settings.cards[impMeta.card]||{}),statementDay:parse(impMeta.statementDate).getDate(),dueDay:parse(impMeta.dueDate).getDate()};
    if(!save()){expenses.length=before;flash($("#iMsg"),"Couldn't save. Download a backup and check Chrome's site storage settings.",false);return}
    $("#iReview").hidden=true;iStat(`Added ${picks.length} expense${picks.length===1?"":"s"} from the ${MBY[impMeta.card].name} statement.`);impRows=[];
    renderAll();
  }
});

/* ---------- restore helpers ---------- */
// Backups are the same format as the single-file version: {app,v:1,savedAt,settings,expenses}
function restoredExpenses(list){
  const seen=new Set();
  return (list||[]).filter(e=>e&&typeof e==="object"&&e.date&&e.method).map(e=>{const r={...e};
    if(!r.id||seen.has(r.id))r.id=newId();seen.add(r.id);delete r._confirm;return r});
}

/* ---------- Google Drive sync UI ---------- */
const CONFIGURED=typeof GOOGLE_CLIENT_ID==="string"&&/\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID.trim());
let auth=null, sync=null, installEvt=null, persistState="unknown";
function ago(isoStr){
  if(!isoStr)return "never";
  const d=new Date(isoStr), s=Math.round((Date.now()-d)/1000);
  if(s<45)return "just now"; if(s<3600)return Math.round(s/60)+" min ago";
  const t=d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  if(iso(d)===iso(todayD()))return "today "+t;
  return shortD(d)+(d.getFullYear()!==todayD().getFullYear()?" "+d.getFullYear():"")+" "+t;
}
function syncSummary(){
  if(!sync||!sync.connected)return null;
  const st=sync.status, p=st.pending;
  const waiting=p?` · ${p} change${p===1?"":"s"} waiting`:"";
  switch(st.state){
    case "syncing":return {text:"Syncing…"};
    case "offline":return {text:"Offline"+waiting,bad:false};
    case "needs-auth":return {text:"Sign in to sync"+waiting,bad:true};
    case "needs-passphrase":return {text:"Sync needs passphrase",bad:true};
    case "error":return {text:"Sync error"+waiting,bad:true};
    default:return {text:"Synced "+ago(st.lastSync)+waiting,bad:false};
  }
}
function openSync(){$("#settings").open=true;renderSync();$("#syncBox").scrollIntoView({behavior:"smooth"})}
const PASS_WARN=`<b>No recovery:</b> if you forget this passphrase, the Drive copy can't be opened by you, by Google or by anyone else. The data on each device stays readable, and backups you download are not encrypted.`;
function renderSync(force){
  const box=$("#syncBody");if(!box)return;
  if(!force&&box.contains(document.activeElement)&&/INPUT|SELECT/.test(document.activeElement.tagName))return;
  if(!CONFIGURED){box.innerHTML=`<p class="hint" style="margin:0">Sync is off. To keep your phone and laptop in step through your own Google Drive, a Google client ID needs to be added to <code>config.js</code> (see SETUP-GUIDE.md). Everything else works without it.</p>`;return}
  if(!sync.connected){box.innerHTML=`<p class="hint" style="margin:0">Keeps this device and your others in step through one file in your own Google Drive. The app can only see files it created itself, nothing else in your Drive. There's no server in between.</p>
    <div class="row"><button class="btn" type="button" data-sync="connect">Connect Google Drive</button><span class="msg" id="syncMsg" role="status"></span></div>`;return}
  const st=sync.status, err=st.lastError;
  const stateTxt={idle:"Up to date",syncing:"Syncing…",offline:"Offline: changes are kept here and sync when you're back online",
    "needs-auth":"Google sign-in has expired (it lasts about an hour). Tap Sync now to sign in again.",
    "needs-passphrase":"Waiting for the sync passphrase",error:"Last sync failed"}[st.state]||"";
  let h=`<dl class="kv" style="max-width:520px"><dt>Status</dt><dd style="font-family:var(--f-body);white-space:normal">${esc(stateTxt)}</dd>
    <dt>Last synced</dt><dd>${esc(ago(st.lastSync))}</dd>
    <dt>Changes waiting to upload</dt><dd>${st.pending}</dd>
    <dt>File in your Drive</dt><dd style="font-family:var(--f-body);white-space:normal">${esc(SYNC_FILE_NAME)}</dd></dl>`;
  if(st.notice)h+=`<div class="banner"><span>${esc(st.notice)}</span></div>`;
  if(err&&st.state!=="idle"&&st.state!=="syncing")h+=`<div class="banner err" role="alert"><span>${esc(err.message)} <span class="muted">(${esc(ago(err.at))})</span></span></div>`;
  if(st.state==="needs-passphrase")h+=`<div class="row"><input type="password" id="syUnlock" autocomplete="off" placeholder="Sync passphrase" style="max-width:260px"><button class="btn primary" type="button" data-sync="unlock">Unlock</button></div>`;
  h+=`<div class="row"><button class="btn" type="button" data-sync="now">Sync now</button><button class="btn ghost" type="button" data-sync="disconnect">Disconnect</button><span class="msg" id="syncMsg" role="status"></span></div>`;
  if(st.state!=="needs-passphrase"){
    if(st.encrypted)h+=`<p class="hint" style="margin:0">🔒 The Drive file is encrypted with your passphrase. Other devices ask for it once.</p>
      <div class="row"><button class="btn sm" type="button" data-sync="showpass">Change passphrase</button><button class="btn sm ghost" type="button" data-sync="encoff">Turn off encryption</button></div>`;
    else h+=`<div><button class="btn sm" type="button" data-sync="showpass">Encrypt the Drive file with a passphrase…</button></div>`;
    h+=`<div id="passForm" class="bk" hidden style="max-width:520px">
      <div class="banner"><span>${PASS_WARN}</span></div>
      <input type="password" id="syP1" autocomplete="new-password" placeholder="New passphrase (at least 10 characters)">
      <input type="password" id="syP2" autocomplete="new-password" placeholder="Type it again">
      <label class="toggle"><input type="checkbox" id="syAck"> I understand a lost passphrase can't be recovered</label>
      <div class="row"><button class="btn primary" type="button" data-sync="encon">Encrypt Drive file</button><button class="btn ghost" type="button" data-sync="hidepass">Cancel</button></div></div>`;
  }
  box.innerHTML=h;
}
const AUTH_MSG={popup:"Chrome blocked Google's sign-in window. Allow pop-ups for this site, then try again.",closed:"Sign-in was cancelled.",denied:"Google access wasn't allowed.",
  scope:"Drive access wasn't granted. On Google's screen, tick the box that lets the app see the files it creates, then try again.",load:"Couldn't reach Google. Check your connection and try again.",failed:"Google sign-in didn't work. Try again."};
async function ensureToken(){if(auth.token())return true;await auth.connect();return true}
$("#syncBox").addEventListener("click",async e=>{
  const b=e.target.closest("[data-sync]");if(!b)return;const act=b.dataset.sync;const msg=()=>$("#syncMsg");
  const fail=err=>{const m=AUTH_MSG[err&&err.kind]||(err&&err.name==="WrongPassphrase"?"That passphrase doesn't open the Drive file.":"Something went wrong: "+(err&&err.message||err));const el=msg();if(el)flash(el,m,false)};
  try{
    if(act==="connect"){await ensureToken();await sync.connect();renderSync(true);renderStatus();return}
    if(act==="now"){await ensureToken();await sync.syncNow();renderSync(true);return}
    if(act==="disconnect"){await sync.disconnect();await auth.disconnect();renderSync(true);renderStatus();return}
    if(act==="showpass"){$("#passForm").hidden=false;$("#syP1").focus();return}
    if(act==="hidepass"){$("#passForm").hidden=true;return}
    if(act==="encon"){const p1=$("#syP1").value,p2=$("#syP2").value;
      if(p1.length<10){flash(msg(),"Use at least 10 characters. A few unrelated words works well.",false);return}
      if(p1!==p2){flash(msg(),"The two passphrases don't match.",false);return}
      if(!$("#syAck").checked){flash(msg(),"Tick the box to confirm you understand there's no recovery.",false);return}
      b.disabled=true;await sync.setPassphrase(p1);renderSync(true);flash(msg(),sync.status.state==="idle"?"Drive file is now encrypted":"Encryption is on; it applies at the next successful sync",true);return}
    if(act==="encoff"){await sync.disableEncryption();renderSync(true);return}
    if(act==="unlock"){const p=$("#syUnlock").value;if(!p)return;b.disabled=true;await sync.unlock(p);renderSync(true);return}
  }catch(err){fail(err);b.disabled=false}
});

/* ---------- boot ---------- */
async function boot(){
  let v;
  try{v=await store.init({defaults:()=>clone(DEFAULTS),samples:sampleRows,normalizeSettings:mergeSettings})}
  catch(e){storageOK=false;showWarn("The app couldn't open its storage on this device.");return}
  settings=v.settings;expenses=v.expenses;
  if(store.failed){storageOK=false;showWarn("This browser is blocking storage, so entries will be lost when you close the app. In Chrome, allow site data, or use a normal (not Incognito) window.")}
  if(store.info.migrateError)showWarn("Data saved by the earlier version of this page couldn't be read. Restore from a backup in Settings.");
  setCategorizer(guessCategory);
  const lm=store.getMeta("lastMethod");if(lm&&MBY[lm])selMethod=lm;
  // sync
  auth=new GoogleAuth({clientId:(GOOGLE_CLIENT_ID||"").trim(),store});
  sync=new SyncEngine({store,auth,configured:CONFIGURED,drive:new DriveClient({getToken:()=>auth.token()})});
  sync.onStatus(()=>{renderStatus();renderSync()});
  store.onLocalChange(()=>sync.schedule());
  window.addEventListener("online",()=>sync.syncNow());
  window.addEventListener("offline",()=>sync.refresh());
  let lastKick=Date.now();
  const kick=()=>{if(document.visibilityState!=="visible"||!sync.connected)return;lastKick=Date.now();sync.syncNow()};
  document.addEventListener("visibilitychange",()=>{if(Date.now()-lastKick>30000)kick()});
  setInterval(()=>{if(Date.now()-lastKick>300000)kick()},60000);
  $("#aDate").value=iso(todayD());
  renderChips();renderSelects();renderSettings();render();updateFx();renderSync();
  if(store.info.migrated)flash($("#addMsg"),"Moved your saved expenses into the app's new storage",true);
  // storage persistence
  persistState=await requestPersistence();renderPersist();
  if(sync.connected){if(navigator.onLine)auth.load().catch(()=>{});sync.syncNow()}
  else if(CONFIGURED)$("#settings").addEventListener("toggle",()=>{if($("#settings").open)auth.load().catch(()=>{})},{once:true});
}
function renderPersist(){
  const el=$("#persistNote");if(!el)return;
  el.textContent=persistState==="granted"?"Chrome has agreed to keep this app's storage unless you remove it yourself."
    :"Chrome may clear this app's storage if the device runs very low on space. Installing the app makes that less likely.";
}
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installEvt=e;renderStatus()});
window.addEventListener("appinstalled",()=>{installEvt=null;renderStatus();requestPersistence().then(s=>{persistState=s;renderPersist()})});

/* ---------- service worker (offline + install) ---------- */
if("serviceWorker" in navigator&&location.protocol!=="file:"){
  const hadController=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("./sw.js").then(reg=>{
    setInterval(()=>reg.update().catch(()=>{}),3600000);
  }).catch(()=>{});
  navigator.serviceWorker.addEventListener("controllerchange",()=>{
    if(!hadController)return; // first install, nothing to refresh
    $("#updBanner").hidden=false;
  });
  $("#updReload").addEventListener("click",()=>location.reload());
}
boot();
