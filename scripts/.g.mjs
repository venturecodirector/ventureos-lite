import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
const F=(n)=>readFileSync("extension/"+n,"utf8");
const dom=new JSDOM(readFileSync("test/fixtures/linkedin/g-abbreviated-slug-us-metro.html","utf8"),
  {url:"https://www.linkedin.com/in/mgoldberger/"});
let sy=0;
Object.defineProperty(dom.window,"scrollY",{get:()=>sy,configurable:true});
dom.window.scrollTo=(x,y)=>{sy=typeof y==="number"?y:0;};
const g={};
for (const m of ["selectors.js","names.js","cleanup.js","contact-parse.js","machine.js"])
  new Function("globalThis","window","document",F(m))(g,dom.window,dom.window.document);
const prep = await g.VentureMachine.run({globalMs:4000,routeMs:200,topcardMs:200,openContactMs:200,
  readContactMs:200,closeContactMs:200,expandBioMs:200,loadSectionsMs:600,readPostsMs:200,
  scrollSettleMs:10,scrollMaxSteps:3,window:dom.window,document:dom.window.document});
const out=new Function("document","window","location","URL","globalThis",
  `return (${F("content.js").trim().replace(/;\s*$/,"")})`)(
    dom.window.document,dom.window,dom.window.location,dom.window.URL,g);
const p=(k,v)=>console.log("  "+k.padEnd(13)+" "+v);
console.log("=== fixture (g) /in/mgoldberger — CURRENT CODE ===");
for (const f of ["name","headline","location","companyName","jobTitle"]) {
  const pr=out.provenance?.[f];
  p(f, out[f]===undefined ? "— (absent)" : `${JSON.stringify(out[f])}${pr?`  [${pr.source}/${pr.confidence}]`:""}`);
}
p("bio", out.bio?`${out.bio.length} chars`:"—");
p("posts", String(out.posts.length));
p("photoUrl", out.photoUrl?out.photoUrl.replace(/^.*shrink_/,"shrink_").slice(0,24):"—");
p("boundary", `ok=${out.boundary.ok} identities=${out.boundary.identitiesInCard}`);
p("skipped", JSON.stringify(out.skipped));
p("attempts.name", JSON.stringify(out._attempts.name));
p("LOAD_SECTIONS", JSON.stringify(prep.machine.steps.find(s=>s.name==="LOAD_SECTIONS")));
// item 3: the server-side location resolution
const { parseLocation } = await import("../src/modules/capture/location.ts").catch(()=>({parseLocation:null}));
console.log("\n=== item 3: what the gazetteer says (via tsx) ===");
