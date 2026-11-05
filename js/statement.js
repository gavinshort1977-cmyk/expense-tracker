// Statement reading (PDF and bank CSV). Runs entirely in this browser.
// pdf.js is bundled with the app in vendor/pdfjs, so this works offline.
const pad=n=>String(n).padStart(2,"0");
const iso=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const parse=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)};
const dim=(y,m)=>new Date(y,m+1,0).getDate();
const clampDay=(y,m,d)=>new Date(y,m,Math.min(d,dim(y,m)));
const todayD=()=>{const t=new Date();return new Date(t.getFullYear(),t.getMonth(),t.getDate())};
let guessCategory=()=>"Other";
export function setCategorizer(f){guessCategory=f}

const MONS={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
const CUR=new Set("AED USD EUR GBP SAR QAR KWD BHD OMR INR PKR LKR BDT NPR PHP DKK SEK NOK CHF JPY CNY HKD SGD AUD CAD NZD TRY EGP JOD LBP THB MYR IDR ZAR MAD KES GEL AZN RUB PLN CZK HUF".split(" "));
// returns {y|null,m,d,len} for a date at the start of s
export function dateAt(s){
  let m;
  if((m=/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/.exec(s)))return ok(+m[1],+m[2],+m[3],m[0].length);
  if((m=/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/.exec(s)))return ok(yr(m[3]),+m[2],+m[1],m[0].length);
  if((m=/^(\d{1,2})[\s\-\/]?([A-Za-z]{3,4})\.?(?:[\s\-\/,]*('?\d{4}|\d{2})(?![\d.,]))?/.exec(s))&&MONS[m[2].toLowerCase()])
    return ok(m[3]?yr(m[3].replace("'","")):null,MONS[m[2].toLowerCase()],+m[1],m[0].length);
  if((m=/^([A-Za-z]{3,4})\.?\s+(\d{1,2}),?(?:\s+(\d{4}))?\b/.exec(s))&&MONS[m[1].toLowerCase()])
    return ok(m[3]?+m[3]:null,MONS[m[1].toLowerCase()],+m[2],m[0].length);
  if((m=/^(\d{1,2})[\/\-](\d{1,2})(?![\/\-.\d])/.exec(s))&&+m[2]<=12)return ok(null,+m[2],+m[1],m[0].length);
  return null;
  function yr(t){t=+t;return t<100?2000+t:t}
  function ok(y,mo,d,len){return mo>=1&&mo<=12&&d>=1&&d<=31?{y,m:mo,d,len}:null}
}
export function normDate(s){s=String(s||"").trim();const d=dateAt(s);if(!d||!d.y)return null;return d.y+"-"+pad(d.m)+"-"+pad(d.d)}
function findDates(line){const out=[];const re=/(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\s\-]?[A-Za-z]{3,4}[\s\-,]*\d{2,4}|[A-Za-z]{3,4}\s+\d{1,2},?\s+\d{4})/g;let m;
  while((m=re.exec(line))){const d=dateAt(m[1]);if(d&&d.y)out.push(d.y+"-"+pad(d.m)+"-"+pad(d.d))}return out}
// amount cell: "1,234.56" "1,234.56 CR" "-12.00" "(12.00)" "AED 12.00" "USD 89.99" "89.99 USD" "12.00-"
const AMT_RE=/^(?:([A-Z]{3})\s*)?(\(?)\s*([-−+])?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*(\)?)\s*(CR|Cr|cr|DR|Dr|dr|-)?\s*(?:([A-Z]{3}))?$/;
export function amountCell(c){
  const m=AMT_RE.exec(c.trim());if(!m)return null;
  const cur=m[1]||m[7]||null;if(cur&&!CUR.has(cur))return null;
  const v=parseFloat(m[4].replace(/,/g,""));
  const credit=!!(m[2]&&m[5])||m[3]==="-"||m[3]==="−"||/^(cr|-)$/i.test(m[6]||"");
  return {v,cur,credit};
}
const SKIP_RE=/\b(opening|closing|previous|new|outstanding|statement|current)\s+balance\b|\bbalance\s+(brought|carried|b\/f|c\/f)|\bsub-?total\b|\btotal\s+(amount|due|balance|payments?|credits?|debits?|purchases?|spend|outstanding)\b|minimum\s+(amount|payment|due)|credit\s+limit|available\s+(limit|credit|balance)|cash\s+limit|(payment\s+)?due\s+date|statement\s+(date|period)|reward|points|\binterest\s+rate|annual\s+percentage/i;
const PAY_RE=/\bpayment|thank\s*you|pymt|paymt|\bpaid\b.*\b(card|bank)|transfer\s+(received|from)|direct\s+debit\s+received/i;
const CREDIT_RE=/\brefund|reversal|reversed|cash\s*back|cashback|chargeback|\bcredit\s+adj/i;
export function lineToTx(cells){
  // cells: column texts on one printed line
  cells=cells.map(c=>c.trim()).filter(Boolean);
  if(cells.length<2)return null;
  // first date within the first three cells
  let di=-1,d1=null;
  for(let i=0;i<Math.min(3,cells.length);i++){const d=dateAt(cells[i]);if(d){di=i;d1=d;break}}
  if(di<0)return null;
  const rest=[];const head=cells[di].slice(d1.len).trim();if(head)rest.push(head);
  for(let i=di+1;i<cells.length;i++)rest.push(cells[i]);
  // optional posting date right after
  if(rest.length){const d2=dateAt(rest[0]);if(d2){const tail=rest[0].slice(d2.len).trim();if(tail)rest[0]=tail;else rest.shift()}}
  const desc=[],amts=[];let pendCur=null;
  rest.forEach(c=>{
    if(CUR.has(c)&&c.length===3){pendCur=c;return}
    const a=amountCell(c);
    if(a){if(!a.cur&&pendCur)a.cur=pendCur;pendCur=null;amts.push(a);return}
    // a cell like "STARBUCKS DUBAI 12.50" (amount glued to text)
    const g=/^(.*?\S)\s+((?:[A-Z]{3}\s*)?\(?[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?(?:\s*(?:CR|Cr|DR|Dr|-))?)$/.exec(c);
    if(g&&amountCell(g[2])&&!amts.length){desc.push(g[1]);amts.push(amountCell(g[2]));return}
    if(pendCur){desc.push(pendCur);pendCur=null}
    if(!amts.length)desc.push(c);
  });
  let description=desc.join(" ").replace(/\s+/g," ").trim();
  if(!amts.length||!description||description.length<2)return null;
  if(SKIP_RE.test(description))return null;
  const billed=[...amts].reverse().find(a=>!a.cur||a.cur==="AED")||amts[amts.length-1];
  const foreign=amts.find(a=>a.cur&&a.cur!=="AED"&&a!==billed);
  let type="charge";
  if(billed.credit||CREDIT_RE.test(description))type="credit";
  if(PAY_RE.test(description)&&(billed.credit||!/fee|charge|interest/i.test(description)))type="payment";
  description=description.replace(/\b\d{6,}\b/g,"").replace(/\s+/g," ").trim().slice(0,120);
  return {d:d1,description,aed:billed.v,amount:foreign?foreign.v:billed.v,currency:foreign?foreign.cur:"AED",type};
}
export function finishTxs(raw,allLines){
  // statement + due dates from labelled lines
  let stmt=null,due=null;
  allLines.forEach((l,i)=>{
    const near=()=>{const own=findDates(l);return own.length?own:findDates(allLines[i+1]||"")};
    if(!stmt&&/statement\s+(date|period)|closing\s+date|billing\s+date/i.test(l)&&!/due/i.test(l)){const ds=near();if(ds.length)stmt=ds.sort().pop()}
    if(!due&&/(payment\s+)?due\s+date|pay\s+by/i.test(l)){const ds=near();if(ds.length)due=ds[0]}
  });
  const full=raw.filter(t=>t.d.y).map(t=>t.d.y+"-"+pad(t.d.m)+"-"+pad(t.d.d)).sort();
  const ref=stmt?parse(stmt):full.length?parse(full[full.length-1]):todayD();
  const txs=raw.map(t=>{let y=t.d.y;
    if(!y){y=ref.getFullYear();if(t.d.m>ref.getMonth()+2)y--}
    const dt=clampDay(y,t.d.m-1,t.d.d);
    return {date:iso(dt),description:t.description,amount:t.amount,currency:t.currency,aed:t.aed,type:t.type,category:guessCategory(t.description)}});
  if(due&&stmt&&due<stmt)due=null;
  return {statementDate:stmt,dueDate:due,txs};
}
export function parseCsv(text){
  const rows=[];let row=[],cell="",q=false;
  for(let i=0;i<text.length;i++){const ch=text[i];
    if(q){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++}else q=false}else cell+=ch}
    else if(ch==='"')q=true;
    else if(ch===","||ch===";"&&!text.includes(",")){row.push(cell);cell=""}
    else if(ch==="\n"||ch==="\r"){if(ch==="\r"&&text[i+1]==="\n")i++;row.push(cell);rows.push(row);row=[];cell=""}
    else cell+=ch}
  if(cell||row.length){row.push(cell);rows.push(row)}
  return rows.filter(r=>r.some(c=>c.trim()));
}
export function parseStatementCsv(text){
  const rows=parseCsv(text);
  const hi=rows.findIndex(r=>r.some(c=>/date/i.test(c))&&r.some(c=>/amount|debit|aed|value/i.test(c)));
  if(hi<0)throw new Error("csvhead");
  const h=rows[hi].map(c=>c.trim().toLowerCase());
  const find=re=>h.findIndex(c=>re.test(c));
  if(h.includes("method")&&h.includes("aed"))throw new Error("ledgercsv");
  let dc=find(/^(transaction|txn|trans)\.?\s*date/);if(dc<0)dc=find(/date/);
  let desc=find(/desc|detail|merchant|narration|particular|remarks?|transaction$/);
  const deb=find(/debit|withdraw/),cre=find(/credit|deposit/);
  let amt=find(/billing amount|amount.*aed|aed.*amount|^amount$|amount/);if(amt===deb||amt===cre)amt=-1;
  const curc=find(/currency/),orig=find(/original|foreign|transaction amount/);
  const raw=[];
  rows.slice(hi+1).forEach(r=>{
    const d=dateAt((r[dc]||"").trim());if(!d)return;
    let v=0,credit=false;
    if(deb>=0||cre>=0){const dv=amountCell(r[deb]||"")||amountCell((r[deb]||"").replace(/[^\d.,\-]/g,"")),cv=amountCell(r[cre]||"")||amountCell((r[cre]||"").replace(/[^\d.,\-]/g,""));
      if(dv&&dv.v>0)v=dv.v;else if(cv&&cv.v>0){v=cv.v;credit=true}}
    if(!v&&amt>=0){const a=amountCell((r[amt]||"").replace(/[^\dA-Z.,\-()]/g,""));if(a){v=a.v;credit=a.credit}}
    if(!(v>0))return;
    const description=(desc>=0?r[desc]:r.filter((_,i)=>i!==dc&&i!==amt&&i!==deb&&i!==cre).join(" ")).replace(/\s+/g," ").trim().slice(0,120);
    let type=credit||CREDIT_RE.test(description)?"credit":"charge";if(PAY_RE.test(description)&&type==="credit")type="payment";
    let currency="AED",amount=v;
    if(curc>=0&&CUR.has((r[curc]||"").trim().toUpperCase())&&(r[curc]||"").trim().toUpperCase()!=="AED"&&orig>=0){const o=amountCell((r[orig]||"").replace(/[^\d.,]/g,""));if(o){currency=r[curc].trim().toUpperCase();amount=o.v}}
    raw.push({d,description:description||"(no description)",aed:v,amount,currency,type});
  });
  return finishTxs(raw,rows.map(r=>r.join(" ")));
}

/* PDF reading: pdf.js is loaded from this app's own files the first time a PDF is imported */
const PDFJS=new URL("../vendor/pdfjs/",import.meta.url).href;
let pdfReady=null;
export function loadPdfJs(){
  if(pdfReady)return pdfReady;
  pdfReady=import(PDFJS+"pdf.min.mjs").then(lib=>{lib.GlobalWorkerOptions.workerSrc=PDFJS+"pdf.worker.min.mjs";return lib},
    e=>{pdfReady=null;const err=new Error("load");err.cause=e;throw err});
  return pdfReady;
}
export async function pdfLines(file,password){
  const lib=await loadPdfJs();
  const data=file instanceof Uint8Array?file:new Uint8Array(await file.arrayBuffer());
  const doc=await lib.getDocument({data,password:password||undefined,isEvalSupported:false,standardFontDataUrl:PDFJS+"standard_fonts/",useSystemFonts:false}).promise;
  const lines=[];
  for(let p=1;p<=doc.numPages;p++){
    const pg=await doc.getPage(p);const tc=await pg.getTextContent();
    const rows=[];
    tc.items.forEach(it=>{if(!it.str||!it.str.trim())return;const y=it.transform[5],h=Math.abs(it.transform[3])||8;
      let r=rows.find(r=>Math.abs(r.y-y)<=Math.max(2,h*0.35));if(!r){r={y,items:[]};rows.push(r)}
      r.items.push({x:it.transform[4],w:it.width||0,t:it.str})});
    rows.sort((a,b)=>b.y-a.y).forEach(r=>{
      r.items.sort((a,b)=>a.x-b.x);
      const cells=[];let cur="",end=null;
      r.items.forEach(it=>{const gap=end===null?0:it.x-end;
        if(end!==null&&gap>6){cells.push(cur);cur=""}else if(end!==null&&gap>0.5&&!/\s$/.test(cur))cur+=" ";
        cur+=it.t;end=it.x+it.w});
      if(cur)cells.push(cur);
      lines.push(cells.map(c=>c.replace(/\s+/g," ").trim()).filter(Boolean));
    });
  }
  doc.destroy();
  return lines;
}
