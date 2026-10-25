import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as db from './db.js';
import {
  Ledger,
  daysOverdue,
  latestPromise,
  remainingCents,
  type Debtor,
  type Invoice,
  type LedgerEvent,
  type LedgerStats,
} from './ledger.js';
import { recordContactTrial } from './engine.js';
import { checkDraft, gate, POLICY, replySignal } from './policy.js';
import { PLAYBOOKS, segmentOf, type Playbook, type Segment } from './strategy.js';
import { money } from './score.js';
import {
  defaultSettings,
  loadSettings,
  policyFromSettings,
  renderTemplate,
  saveSettings,
  scheduleStatus,
  type AgentSettings,
} from './settings.js';
import { sweep } from './sweep.js';

// Remit Control Room: overview, clients/invoices, human queue, learned
// playbooks, runs, and bounded operator settings. It is deliberately an
// operating desk, not a God-mode panel: there is no write-off, discount,
// threat language, delete-invoice, or resume-after-opt-out control.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function parseDollarsToCents(value: string | null | undefined): number {
  const cleaned = String(value ?? '').replace(/[$,\s]/g, '');
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars <= 0) throw new Error('Enter a positive dollar amount');
  const cents = Math.round(dollars * 100);
  if (cents > 100_000_000) throw new Error('Amount is too large for this dashboard');
  return cents;
}

export type QueueAction = 'resolve_dispute' | 'approve_plan' | 'resume' | 'keep_paused';

export function allowedQueueActions(kind: string, detail?: unknown): QueueAction[] {
  if (kind === 'optout') return ['keep_paused'];
  if (kind === 'dispute') return ['resolve_dispute', 'keep_paused'];
  const draft = (detail as { draft?: { action?: unknown } } | null | undefined)?.draft;
  if (kind === 'policy' && draft?.action === 'offer_plan') return ['approve_plan', 'resume', 'keep_paused'];
  return ['resume', 'keep_paused'];
}

const QUEUE_ACTION_LABELS: Record<QueueAction, string> = {
  resolve_dispute: 'Dispute resolved',
  approve_plan: 'Approve & send plan',
  resume: 'Resume contact',
  keep_paused: 'Keep paused',
};

const STYLE = `
:root{
  --ink:#101828;--muted:#667085;--faint:#98a2b3;--line:#e4e7ec;--bg:#f4f6fb;--card:#fff;
  --blue:#175cd3;--blue2:#2e90fa;--indigo:#3538cd;--green:#067647;--green2:#12b76a;
  --amber:#b54708;--red:#b42318;--soft:#eef4ff;--greenbg:#ecfdf3;--amberbg:#fffaeb;--redbg:#fef3f2;
  --shadow:0 10px 30px rgba(16,24,40,.07);--shadow-sm:0 2px 8px rgba(16,24,40,.06);--radius:20px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
button,input,select,textarea{font:inherit}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid rgba(46,144,250,.35);outline-offset:2px}
.app{display:grid;grid-template-columns:268px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;overflow:auto;background:radial-gradient(circle at 15% -10%,rgba(46,144,250,.42),transparent 34%),linear-gradient(180deg,#0a1428,#0d1f3c 58%,#0a2c25);color:#fff;padding:24px 16px;display:flex;flex-direction:column;gap:22px;z-index:20}
.brand{display:flex;align-items:center;gap:11px;color:#fff;padding:2px 6px}.brand:hover{text-decoration:none}
.mark{width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#2e90fa,#12b76a);display:grid;place-items:center;font-size:23px;font-weight:900;box-shadow:0 8px 22px rgba(46,144,250,.38);flex:0 0 auto}
.brand strong{display:block;font-size:19px;line-height:1.05;letter-spacing:-.02em}.brand small{display:block;color:#b9c6e2;font-size:11px;margin-top:3px}
.side-label{color:#8fa3c8;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.09em;padding:0 10px;margin-bottom:7px}
.sidenav{display:grid;gap:5px}.sidenav a{display:flex;align-items:center;gap:10px;color:#d6e0f2;padding:11px 11px;border-radius:12px;border:1px solid transparent;font-weight:650}
.sidenav a span.ico{width:26px;height:26px;border-radius:8px;background:rgba(255,255,255,.08);display:grid;place-items:center;font-size:14px;flex:0 0 auto}
.sidenav a:hover{background:rgba(255,255,255,.07);color:#fff;text-decoration:none}
.sidenav a.active{background:linear-gradient(135deg,rgba(46,144,250,.35),rgba(18,183,106,.22));border-color:rgba(255,255,255,.16);color:#fff;box-shadow:0 8px 20px rgba(0,0,0,.16)}
.side-safety{margin-top:auto;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);border-radius:16px;padding:14px;color:#d6e0f2}
.side-safety b{color:#fff}.side-safety ul{margin:8px 0 0;padding-left:18px}.side-safety li{margin:3px 0}
.mainwrap{min-width:0}.wrap{width:100%;max-width:1420px;margin:0 auto}main{padding:28px 30px 52px}
h1{font-size:31px;line-height:1.1;letter-spacing:-.035em;margin:0 0 7px}h2{font-size:19px;letter-spacing:-.02em;margin:0 0 9px}h3{font-size:15px;margin:0 0 8px}
.sub{color:var(--muted);margin:0 0 18px;max-width:780px}.muted{color:var(--muted)}.small{font-size:12px}.right{text-align:right}.nowrap{white-space:nowrap}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}.span3{grid-column:span 3}.span4{grid-column:span 4}.span6{grid-column:span 6}.span8{grid-column:span 8}.span12{grid-column:span 12}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow-sm);margin-bottom:16px}
.card.flush{padding:0;overflow:hidden}.card.pad-lg{padding:24px}
.kpi{position:relative;overflow:hidden}.kpi:before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:linear-gradient(180deg,var(--blue2),var(--green2))}
.kpi .label{color:var(--muted);font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.07em}.kpi .value{font-size:30px;font-weight:850;letter-spacing:-.035em;line-height:1.12;margin-top:5px}.kpi .note{color:var(--muted);font-size:12px}
.kpi-icon{float:right;width:40px;height:40px;border-radius:13px;display:grid;place-items:center;background:var(--soft);color:var(--blue);font-size:19px}
.progress{height:11px;background:#eaecf0;border-radius:99px;overflow:hidden}.progress div{height:100%;background:linear-gradient(90deg,#2e90fa,#12b76a);border-radius:99px}
.banner{border-radius:14px;padding:13px 15px;margin:0 0 16px;border:1px solid;box-shadow:var(--shadow-sm)}.banner.ok{background:var(--greenbg);border-color:#a6f4c5;color:#05603a}.banner.err{background:var(--redbg);border-color:#fecdca;color:#7a271a}.banner.warn{background:var(--amberbg);border-color:#fedf89;color:#93370d}
.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:15px;background:#fff}table{border-collapse:collapse;width:100%;min-width:760px}th,td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{position:sticky;top:0;background:#f8f9fc;color:#475467;font-size:11px;text-transform:uppercase;letter-spacing:.05em;z-index:1}tr:last-child td{border-bottom:0}tbody tr:hover td{background:#fbfcff}
.badge{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:750;border:1px solid var(--line);background:#f9fafb;color:#344054}.badge.green{background:var(--greenbg);border-color:#a6f4c5;color:var(--green)}.badge.blue{background:var(--soft);border-color:#b2ccff;color:var(--blue)}.badge.amber{background:var(--amberbg);border-color:#fedf89;color:var(--amber)}.badge.red{background:var(--redbg);border-color:#fecdca;color:var(--red)}.badge.dark{background:#1d2939;border-color:#1d2939;color:#fff}.badge.violet{background:#f4f3ff;border-color:#d9d6fe;color:#5925dc}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid #d0d5dd;background:#fff;color:#1d2939;border-radius:11px;padding:9px 13px;cursor:pointer;font-weight:700;box-shadow:0 1px 2px rgba(16,24,40,.04)}
button:hover,.button:hover{background:#f9fafb;text-decoration:none;transform:translateY(-1px)}button.primary,.button.primary{background:linear-gradient(135deg,#175cd3,#2e90fa);border-color:#175cd3;color:#fff;box-shadow:0 7px 16px rgba(23,92,211,.24)}button.go{background:linear-gradient(135deg,#067647,#12b76a);border-color:#067647;color:#fff}button.warnbtn{background:#fffaeb;border-color:#fedf89;color:#93370d}button.danger{background:#fff;border-color:#fecdca;color:var(--red)}button.smallbtn,.button.smallbtn{padding:5px 9px;font-size:12px;border-radius:9px}button.large{padding:12px 18px;font-size:15px}button:disabled{opacity:.45;cursor:not-allowed;transform:none}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.inline-form{display:inline}
label{display:block;font-weight:700;margin:13px 0 6px}input,select,textarea{width:100%;border:1px solid #d0d5dd;border-radius:11px;padding:10px 11px;background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.03)}textarea{min-height:100px;resize:vertical}input[type=checkbox]{width:17px;height:17px;accent-color:var(--blue)}input[type=range]{accent-color:var(--blue);padding:0;box-shadow:none;min-height:28px}.check{display:flex;gap:8px;align-items:center;font-weight:600;margin:6px 0;border:1px solid var(--line);background:#fbfcfe;border-radius:11px;padding:8px 10px}.check:has(input:checked){background:var(--soft);border-color:#84adff;color:#1849a9}.formgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px}.formgrid .wide{grid-column:1/-1}.help{color:var(--muted);font-size:12px;margin-top:5px}.search{max-width:560px;margin:0 0 14px;border-radius:13px;padding:12px 14px}.divider{height:1px;background:var(--line);margin:19px 0}.timeline{display:grid;gap:10px}.event{position:relative;border-left:3px solid #d0d5dd;padding:3px 0 3px 14px}.event:before{content:"";position:absolute;left:-7px;top:8px;width:9px;height:9px;border-radius:50%;background:#fff;border:2px solid #98a2b3}.event.payment{border-color:#12b76a}.event.payment:before{border-color:#12b76a}.event.reply{border-color:#2e90fa}.event.reply:before{border-color:#2e90fa}.event.contact{border-color:#f79009}.event.contact:before{border-color:#f79009}.event.promise{border-color:#7a5af8}.event.promise:before{border-color:#7a5af8}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.chips{display:flex;gap:6px;flex-wrap:wrap}.empty{color:var(--muted);padding:26px 18px;text-align:center;background:#fbfcfe;border:1px dashed #d0d5dd;border-radius:15px}
.hero{position:relative;overflow:hidden;background:radial-gradient(circle at 92% -15%,rgba(46,144,250,.38),transparent 35%),radial-gradient(circle at 15% 120%,rgba(18,183,106,.25),transparent 36%),linear-gradient(135deg,#0a1730,#132c5f 58%,#0a4c3a);color:#fff;border-radius:26px;padding:27px;box-shadow:0 18px 42px rgba(16,24,40,.20);margin-bottom:16px}
.hero:after{content:"";position:absolute;right:-80px;top:-90px;width:260px;height:260px;border:1px solid rgba(255,255,255,.14);border-radius:50%;box-shadow:0 0 0 38px rgba(255,255,255,.025),0 0 0 82px rgba(255,255,255,.018)}
.hero-grid{position:relative;z-index:1;display:grid;grid-template-columns:minmax(0,1.45fr) minmax(230px,.75fr);gap:24px;align-items:center}
.hero h1{font-size:36px;color:#fff}.hero .sub{color:#c7d2fe}.eyebrow{display:inline-flex;gap:6px;align-items:center;text-transform:uppercase;letter-spacing:.08em;font-size:11px;font-weight:850;color:#84caff;margin-bottom:8px}.hero .eyebrow{color:#7dd3fc}
.money-big{font-size:43px;font-weight:900;letter-spacing:-.045em;line-height:1}.hero-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:17px}.hero-stat{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.13);border-radius:15px;padding:12px}.hero-stat small{display:block;color:#b9c6e2;text-transform:uppercase;letter-spacing:.05em;font-weight:750}.hero-stat b{font-size:19px}
.donut-wrap{display:flex;align-items:center;gap:16px}.donut{width:148px;height:148px;border-radius:50%;display:grid;place-items:center;flex:0 0 auto;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}.donut-in{width:104px;height:104px;border-radius:50%;background:#0d2149;display:grid;place-items:center;text-align:center;padding:10px}.donut-in b{font-size:25px;line-height:1}.donut-in span{font-size:11px;color:#b9c6e2}
.section-title{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:12px}.section-title h2{margin:0}.section-title p{margin:2px 0 0;color:var(--muted)}
.pipeline{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.pipe-step{position:relative;background:linear-gradient(180deg,#fff,#fbfcff);border:1px solid var(--line);border-radius:17px;padding:16px}.pipe-step:after{content:"›";position:absolute;right:-13px;top:38%;font-size:25px;color:#98a2b3;z-index:2}.pipe-step:last-child:after{display:none}.pipe-step small{display:block;color:var(--muted);font-weight:800;text-transform:uppercase;letter-spacing:.05em}.pipe-step b{font-size:23px;letter-spacing:-.03em}.pipe-step p{margin:2px 0 0;color:var(--muted)}
.action-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.action-card{border:1px solid var(--line);border-radius:17px;padding:16px;background:#fff;display:flex;gap:12px;align-items:flex-start}.action-card:hover{border-color:#84adff;box-shadow:var(--shadow-sm);text-decoration:none}.action-icon{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;font-size:19px;flex:0 0 auto}.action-card b{color:var(--ink)}.action-card p{color:var(--muted);margin:2px 0 0}
.tabs{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0 15px}.tabs a{padding:8px 12px;border:1px solid var(--line);background:#fff;border-radius:999px;color:#344054;font-weight:700}.tabs a:hover{text-decoration:none;border-color:#84adff}.tabs a.active{background:#101828;color:#fff;border-color:#101828}.tabs .count{opacity:.72;font-weight:600}
.client-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.client-card{border:1px solid var(--line);border-radius:17px;padding:16px;background:linear-gradient(180deg,#fff,#fcfdff)}.client-card:hover{border-color:#84adff}.client-top{display:flex;gap:11px;align-items:center}.avatar{width:45px;height:45px;border-radius:14px;background:linear-gradient(135deg,#175cd3,#7a5af8);color:#fff;display:grid;place-items:center;font-weight:900;flex:0 0 auto}.money-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:13px 0}.money-row div{background:#f8f9fc;border-radius:11px;padding:8px}.money-row small{display:block;color:var(--muted)}.money-row b{font-size:14px}
.nextstep{display:inline-flex;border-radius:9px;padding:4px 7px;font-weight:750;font-size:12px}.nextstep.ready{background:var(--greenbg);color:var(--green)}.nextstep.wait{background:var(--soft);color:var(--blue)}.nextstep.human{background:var(--amberbg);color:var(--amber)}.nextstep.locked{background:var(--redbg);color:var(--red)}.nextstep.done{background:#f2f4f7;color:#475467}
.queue-list{display:grid;gap:13px}.queue-help{margin-top:10px;color:var(--muted);font-size:12px;display:grid;gap:6px}.queue-help div{border-top:1px solid var(--line);padding-top:6px}.queue-help b{color:#344054}.queue-card{display:grid;grid-template-columns:50px minmax(0,1fr) minmax(210px,auto);gap:15px;border:1px solid var(--line);border-radius:18px;padding:16px;background:#fff}.queue-icon{width:50px;height:50px;border-radius:16px;display:grid;place-items:center;font-size:22px}.queue-actions{display:flex;gap:7px;flex-wrap:wrap;align-content:flex-start;justify-content:flex-end}.evidence{background:#f8f9fc;border-left:3px solid #b2ccff;padding:8px 10px;border-radius:0 10px 10px 0;margin-top:8px;color:#344054}
.learn-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.learn-card{border:1px solid var(--line);border-radius:18px;padding:17px;background:#fff}.playbook-row{display:grid;grid-template-columns:minmax(135px,1fr) minmax(110px,1.2fr) 92px;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}.meter{height:10px;border-radius:99px;background:#eaecf0;overflow:hidden}.meter span{display:block;height:100%;background:linear-gradient(90deg,#2e90fa,#12b76a);border-radius:99px}.winner{background:linear-gradient(135deg,#ecfdf3,#f0f9ff);border:1px solid #a6f4c5;border-radius:12px;padding:9px 11px;margin:8px 0}
.run-card{display:grid;grid-template-columns:54px minmax(0,1fr) auto;gap:14px;border:1px solid var(--line);border-radius:17px;padding:15px;background:#fff;margin-bottom:11px}.run-icon{width:54px;height:54px;border-radius:16px;background:var(--soft);color:var(--blue);display:grid;place-items:center;font-size:22px}.metric-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.metric-chips span{background:#f8f9fc;border:1px solid var(--line);padding:4px 7px;border-radius:999px;font-size:12px}
.settings-hero{position:relative;overflow:hidden;background:linear-gradient(135deg,#101828,#1849a9);color:#fff;border-radius:22px;padding:22px;margin-bottom:16px}.settings-hero p{color:#c7d2fe}.preview-box{background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);border-radius:16px;padding:15px}
.step-head{display:flex;gap:12px;align-items:flex-start;margin-bottom:8px}.stepnum{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#175cd3,#12b76a);color:#fff;display:grid;place-items:center;font-weight:900;flex:0 0 auto}.step-head p{margin:1px 0 0;color:var(--muted)}
.preset-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}.preset{text-align:left;align-items:flex-start;flex-direction:column;border-radius:15px;padding:13px;background:#fbfcfe}.preset b{font-size:14px}.preset span{font-weight:500;color:var(--muted);font-size:12px}.preset.active{border-color:#2e90fa;background:var(--soft);box-shadow:0 0 0 2px rgba(46,144,250,.15)}
.model-picks{display:flex;gap:7px;flex-wrap:wrap;margin:8px 0}.model-pick.active{background:#101828;color:#fff;border-color:#101828}.range-row{display:grid;grid-template-columns:minmax(0,1fr) 64px;gap:10px;align-items:center}.range-row output{font-weight:800;text-align:right}.setting-summary{font-size:15px;line-height:1.65}.setting-summary b{color:#fff}
.playbook-card{border:1px solid var(--line);background:linear-gradient(180deg,#fff,#fcfdff);border-radius:18px;padding:17px;margin-top:13px}.playbook-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.sample{background:#f8f9fc;border:1px dashed #b2ccff;border-radius:12px;padding:11px;color:#344054;margin-top:10px}
.savebar{position:sticky;bottom:14px;z-index:5;background:rgba(16,24,40,.96)!important;color:#fff;border-color:#101828;box-shadow:0 16px 36px rgba(16,24,40,.24)}.savebar .help{color:#c7d2fe}.savebar h2{color:#fff}.unsaved-dot{display:none;width:9px;height:9px;border-radius:50%;background:#f79009}.savebar.changed .unsaved-dot{display:inline-block}
.guide-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}.guide-card{border:1px solid var(--line);border-radius:17px;padding:17px;background:#fff}.guide-card .big{font-size:27px}.glossary{display:grid;grid-template-columns:repeat(2,1fr);gap:11px}.glossary div{border:1px solid var(--line);border-radius:13px;padding:12px;background:#fcfdff}.daily{display:grid;gap:10px}.daily-step{display:flex;gap:12px;align-items:flex-start}.daily-step .stepnum{width:30px;height:30px;font-size:13px}
.case-hero{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(250px,.7fr);gap:18px}.recommendation{background:linear-gradient(135deg,#ecfdf3,#eff8ff);border:1px solid #a6f4c5;border-radius:16px;padding:16px}.recommendation.warn{background:linear-gradient(135deg,#fffaeb,#fff7ed);border-color:#fedf89}.recommendation.locked{background:linear-gradient(135deg,#fef3f2,#fff1f3);border-color:#fecdca}
.footer-note{color:var(--faint);text-align:center;margin-top:28px;font-size:12px}
@media(max-width:1100px){.client-grid{grid-template-columns:1fr}.pipeline{grid-template-columns:repeat(2,1fr)}.pipe-step:after{display:none}.action-grid{grid-template-columns:1fr}.guide-grid{grid-template-columns:1fr}.learn-grid{grid-template-columns:1fr}}
@media(max-width:900px){.app{grid-template-columns:1fr}.sidebar{position:relative;height:auto;padding:16px}.sidenav{grid-template-columns:repeat(2,1fr)}.side-safety{display:none}main{padding:20px 15px 42px}.span3,.span4,.span6,.span8{grid-column:span 12}.formgrid{grid-template-columns:1fr}.hero-grid,.case-hero{grid-template-columns:1fr}.hero{padding:21px}.hero h1{font-size:29px}.hero-stats{grid-template-columns:1fr}.pipeline{grid-template-columns:1fr}.queue-card{grid-template-columns:44px 1fr}.queue-actions{grid-column:1/-1;justify-content:flex-start}.preset-grid{grid-template-columns:1fr}.playbook-row{grid-template-columns:1fr}.run-card{grid-template-columns:44px 1fr}.run-card>*:last-child{grid-column:1/-1}.glossary{grid-template-columns:1fr}.donut-wrap{align-items:flex-start}.donut{width:120px;height:120px}.donut-in{width:86px;height:86px}h1{font-size:25px}}
`;

const NAV = [
  { key: 'Overview', label: 'Home', href: '/', icon: '⌂' },
  { key: 'Clients', label: 'Clients & invoices', href: '/clients', icon: '▦' },
  { key: 'Human queue', label: 'Needs you', href: '/queue', icon: '!' },
  { key: 'Learned', label: 'What works', href: '/learned', icon: '↗' },
  { key: 'Runs', label: 'Activity', href: '/runs', icon: '◷' },
  { key: 'Settings', label: 'Controls', href: '/settings', icon: '⚙' },
  { key: 'Guide', label: 'Guide', href: '/guide', icon: '?' },
] as const;

function banner(url: URL): string {
  const msg = url.searchParams.get('msg');
  const err = url.searchParams.get('err');
  return `${msg ? `<div class="banner ok">✓ ${esc(msg)}</div>` : ''}${err ? `<div class="banner err">⚠ ${esc(err)}</div>` : ''}`;
}

function page(title: string, active: string, body: string, url: URL): string {
  const nav = NAV.map((item) => `<a href="${item.href}"${active === item.key ? ' class="active"' : ''}><span class="ico">${item.icon}</span>${item.label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><div class="app">
<aside class="sidebar">
  <a class="brand" href="/"><span class="mark">↩</span><span><strong>Remit</strong><small>Money Recovery Agent</small></span></a>
  <div><div class="side-label">Your control room</div><nav class="sidenav">${nav}</nav></div>
  <div class="side-safety"><b>◆ Safety always on</b><ul><li>No threats</li><li>No discounts</li><li>Opt-out stays locked</li><li>No write-offs</li></ul></div>
</aside>
<div class="mainwrap"><main><div class="wrap">${banner(url)}${body}<div class="footer-note">Remit works B2B invoices inside code-enforced safety rails. Contacts are ledger events in this simulator deployment.</div></div></main></div>
</div>
<script>
document.querySelectorAll('[data-filter-input]').forEach(function(input){
  input.addEventListener('input',function(){
    var q=input.value.toLowerCase();
    document.querySelectorAll('[data-search]').forEach(function(row){ row.style.display = row.getAttribute('data-search').toLowerCase().includes(q) ? '' : 'none'; });
  });
});
(function(){
  var form=document.getElementById('settings-form');
  if(!form) return;
  var savebar=document.getElementById('savebar');
  function field(name){ return form.querySelector('[name="'+name+'"]'); }
  function value(name,fallback){ var f=field(name); return f ? f.value : fallback; }
  function safe(v){ return String(v).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function shown(name,fallback){ return safe(value(name,fallback)); }
  function setField(name,val){ var f=field(name); if(f){ f.value=val; f.dispatchEvent(new Event('input',{bubbles:true})); } }
  function markChanged(){ if(savebar) savebar.classList.add('changed'); updateSummary(); syncControls(); markModel(); }
  function syncControls(){
    form.querySelectorAll('[data-sync-target]').forEach(function(range){
      var target=field(range.getAttribute('data-sync-target'));
      if(target && document.activeElement!==range) range.value=target.value;
      var out=form.querySelector('[data-output-for="'+range.getAttribute('data-sync-target')+'"]');
      if(out&&target) out.textContent=target.value+(range.getAttribute('data-suffix')||'');
    });
  }
  function selectedDays(){
    var labels={0:'Sun',1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat'};
    var days=[];
    form.querySelectorAll('input[name="sendDays"]:checked').forEach(function(box){ days.push(labels[box.value]); });
    return days.length?days.join(', '):'no days selected';
  }
  function updateSummary(){
    var box=document.getElementById('settings-preview');
    if(!box) return;
    var enabled=field('enabled')&&field('enabled').checked;
    var human=Number(value('planHumanAboveDollars','5000'));
    var humanText=isFinite(human)?'$'+human.toLocaleString('en-US'):'the limit you set';
    box.innerHTML='<b>'+(enabled?'Remit is ON.':'Remit is PAUSED.')+'</b> GitHub wakes it every hour, but it only works on <b>'+safe(selectedDays())+'</b> between <b>'+shown('sendStart','09:00')+'–'+shown('sendEnd','09:59')+'</b> ('+shown('timezone','Asia/Karachi')+'). It starts <b>'+shown('preDueReminderDays','2')+' day(s)</b> before due, waits at least <b>'+shown('minGapDays','3')+' days</b> between messages, and stops after <b>'+shown('maxContactsPerInvoice','6')+' contacts</b>. Plans can use up to <b>'+shown('planMaxInstalments','3')+' payments in '+shown('planMaxDays','45')+' days</b>; above <b>'+safe(humanText)+'</b>, you approve. Brain: <b>'+shown('draftModel','baseline:rules')+'</b>, budget <b>$'+shown('budgetUsd','1')+'</b> per sweep.';
  }
  function markModel(){
    var current=value('draftModel','');
    form.querySelectorAll('.model-pick').forEach(function(btn){ btn.classList.toggle('active',btn.getAttribute('data-model')===current); });
  }
  form.addEventListener('input',markChanged);
  form.addEventListener('change',markChanged);
  form.querySelectorAll('[data-sync-target]').forEach(function(range){
    range.addEventListener('input',function(){ var target=field(range.getAttribute('data-sync-target')); if(target){ target.value=range.value; markChanged(); }});
  });
  form.querySelectorAll('.model-pick').forEach(function(btn){
    btn.addEventListener('click',function(){ setField('draftModel',btn.getAttribute('data-model')); markChanged(); });
  });
  var presets={
    gentle:{preDueReminderDays:0,minGapDays:7,maxContactsPerInvoice:3,maxOverdueDays:60,planMinFirstPct:25,planHumanAboveDollars:2500,explorationPct:10,rewardWindowDays:7},
    balanced:{preDueReminderDays:2,minGapDays:3,maxContactsPerInvoice:6,maxOverdueDays:90,planMinFirstPct:25,planHumanAboveDollars:5000,explorationPct:15,rewardWindowDays:7},
    firm:{preDueReminderDays:3,minGapDays:3,maxContactsPerInvoice:6,maxOverdueDays:120,planMinFirstPct:50,planHumanAboveDollars:2500,explorationPct:5,rewardWindowDays:7}
  };
  form.querySelectorAll('.preset').forEach(function(btn){
    btn.addEventListener('click',function(){
      var preset=presets[btn.getAttribute('data-preset')];
      Object.keys(preset).forEach(function(name){ setField(name,preset[name]); });
      form.querySelectorAll('.preset').forEach(function(x){ x.classList.remove('active'); });
      btn.classList.add('active'); markChanged();
    });
  });
  updateSummary(); syncControls(); markModel();
})();
</script></body></html>`;
}

function authorized(req: IncomingMessage): boolean {
  const password = process.env.REVIEW_PASSWORD;
  if (!password) return process.env.NODE_ENV !== 'production';
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  return Buffer.from(header.slice(6), 'base64').toString('utf8') === `remit:${password}`;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Form is too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function redirect(res: ServerResponse, path: string, msg?: string, err?: string): void {
  const target = new URL(path.startsWith('/') && !path.startsWith('//') ? path : '/', 'http://localhost');
  if (msg) target.searchParams.set('msg', msg);
  if (err) target.searchParams.set('err', err);
  res.writeHead(303, { location: `${target.pathname}${target.search}` });
  res.end();
}

function moneyFull(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function plainReason(reason: unknown): string {
  return String(reason ?? '')
    .replace(/Balance (\d+)c exceeds the (\d+)c auto-plan limit/gi, (_m, balance: string, limit: string) => `The remaining balance is ${moneyFull(Number(balance))}, above the ${moneyFull(Number(limit))} automatic-plan limit`)
    .replace(/\b(\d+)c\b/g, (_m, cents: string) => moneyFull(Number(cents)))
    .replace(/\bgate:\s*/gi, 'Safety check: ');
}
function overdueLabel(inv: Invoice, worldDay: number): string {
  const d = daysOverdue(inv, worldDay);
  if (inv.status === 'paid') return inv.paidDay === null ? 'Paid' : `Paid day ${inv.paidDay}`;
  if (d < 0) return `Due in ${-d}d`;
  if (d === 0) return 'Due today';
  return `${d}d overdue`;
}
function statusBadge(status: string): string {
  const kind = status === 'paid' ? 'green' : status === 'open' ? 'blue' : status === 'disputed' ? 'red' : status === 'escalated' ? 'amber' : '';
  return `<span class="badge ${kind}">${esc(status)}</span>`;
}
function eventDetail(e: LedgerEvent): string {
  try {
    const parsed = JSON.parse(e.detail) as Record<string, unknown>;
    if (e.kind === 'contact' && typeof parsed.message === 'string') return `${playbookLabel(String(parsed.playbook ?? 'contact'))}: ${parsed.message}`;
    if (e.kind === 'promise' && parsed.day !== undefined) return `Promise to pay by day ${String(parsed.day)}`;
  } catch { /* plain text event */ }
  return e.detail;
}

type EnrichedInvoice = {
  inv: Invoice;
  events: LedgerEvent[];
  segment: Segment | '—';
  overdue: number;
  remaining: number;
  contacts: number;
  nextEligibleDay: number | null;
  suppressionReason: string | null;
  queue: Array<Record<string, unknown>>;
};

type DashboardData = {
  stats: LedgerStats | null;
  worldDay: number;
  invoices: Invoice[];
  debtors: Debtor[];
  debtorsById: Map<string, Debtor>;
  events: LedgerEvent[];
  eventsByInvoice: Map<string, LedgerEvent[]>;
  queue: Array<Record<string, unknown>>;
  settings: AgentSettings;
  suppressions: Map<string, string>;
  enriched: EnrichedInvoice[];
  byInvoiceId: Map<string, EnrichedInvoice>;
};

function nextEligible(inv: Invoice, events: LedgerEvent[], worldDay: number, settings: AgentSettings, suppressed: boolean): number | null {
  if (inv.status !== 'open' || remainingCents(inv) <= 0 || suppressed) return null;
  const contacts = events.filter((e) => e.kind === 'contact');
  if (contacts.length >= settings.maxContactsPerInvoice) return null;
  if (daysOverdue(inv, worldDay) > settings.maxOverdueDays) return null;
  let next = inv.dueDay - settings.preDueReminderDays;
  const last = contacts[contacts.length - 1];
  if (last) next = Math.max(next, last.day + settings.minGapDays);
  const promise = latestPromise(events);
  if (promise && !promise.paymentAfter) next = Math.max(next, promise.promisedDay + 1);
  return next;
}

async function loadDashboard(ledger: Ledger): Promise<DashboardData> {
  const [stats, invoices, queriedDebtors, events, queue, settings, suppressions] = await Promise.all([
    ledger.stats().catch(() => null),
    ledger.allInvoices(1000).catch(() => [] as Invoice[]),
    ledger.debtors().catch(() => [] as Debtor[]),
    ledger.allEvents().catch(() => [] as LedgerEvent[]),
    db.openQueue('live'),
    loadSettings('live'),
    db.suppressionDetails('live'),
  ]);
  const worldDay = stats?.worldDay ?? 0;
  const debtorsById = new Map<string, Debtor>();
  for (const d of queriedDebtors) debtorsById.set(d.id, d);
  for (const inv of invoices) {
    if (!debtorsById.has(inv.debtorId)) debtorsById.set(inv.debtorId, { id: inv.debtorId, name: inv.debtorName, email: '' });
  }
  const debtors = [...debtorsById.values()].sort((a, b) => a.name.localeCompare(b.name));
  const eventsByInvoice = new Map<string, LedgerEvent[]>();
  for (const e of events) {
    const list = eventsByInvoice.get(e.invoiceId) ?? [];
    list.push(e);
    eventsByInvoice.set(e.invoiceId, list);
  }
  const queueByInvoice = new Map<string, Array<Record<string, unknown>>>();
  for (const q of queue) {
    const id = String(q.invoice_id);
    const list = queueByInvoice.get(id) ?? [];
    list.push(q);
    queueByInvoice.set(id, list);
  }
  const enriched = invoices.map((inv) => {
    const invEvents = eventsByInvoice.get(inv.id) ?? [];
    const siblings = invoices.filter((i) => i.debtorId === inv.debtorId);
    const suppressionReason = suppressions.get(inv.id) ?? null;
    return {
      inv,
      events: invEvents,
      segment: siblings.length ? segmentOf(siblings, invEvents, worldDay) : '—',
      overdue: daysOverdue(inv, worldDay),
      remaining: remainingCents(inv),
      contacts: invEvents.filter((e) => e.kind === 'contact').length,
      nextEligibleDay: nextEligible(inv, invEvents, worldDay, settings, suppressionReason !== null),
      suppressionReason,
      queue: queueByInvoice.get(inv.id) ?? [],
    } satisfies EnrichedInvoice;
  });
  return {
    stats,
    worldDay,
    invoices,
    debtors,
    debtorsById,
    events,
    eventsByInvoice,
    queue,
    settings,
    suppressions,
    enriched,
    byInvoiceId: new Map(enriched.map((x) => [x.inv.id, x])),
  };
}

export const SEGMENT_LABELS: Record<string, string> = {
  new: 'New customer',
  'usually-pays': 'Usually pays',
  'slow-payer': 'Pays late',
  'promised-before': 'Promised before',
  'promise-broken': 'Promise missed',
  silent: 'Not replying',
  '—': 'Not enough history',
};
export const SEGMENT_HELP: Record<string, string> = {
  new: 'No useful payment history yet.',
  'usually-pays': 'Past invoices were paid on time or early.',
  'slow-payer': 'Past invoices were paid, but late.',
  'promised-before': 'They have promised a payment date before.',
  'promise-broken': 'A promised date passed without payment.',
  silent: 'Messages were sent, but there is no useful reply yet.',
  '—': 'Remit needs more history.',
};
export const PLAYBOOK_LABELS: Record<string, string> = {
  'friendly-plan-early': 'Friendly + payment plan',
  'formal-firm': 'Formal & firm',
  'friendly-remind-only': 'Gentle reminder',
};
export const PLAYBOOK_HELP: Record<string, string> = {
  'friendly-plan-early': 'Warm message that can offer split payments early.',
  'formal-firm': 'Short, factual business reminder. Firm, never threatening.',
  'friendly-remind-only': 'Assumes the invoice was missed and asks for a payment date.',
};
export function segmentLabel(segment: string): string { return SEGMENT_LABELS[segment] ?? segment; }
export function playbookLabel(playbook: string): string { return PLAYBOOK_LABELS[playbook] ?? playbook; }
export function initials(name: string): string {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? 'R') + (parts[1]?.[0] ?? '')).toUpperCase();
}
export type NextStepInfo = { label: string; kind: 'ready' | 'wait' | 'human' | 'locked' | 'done'; detail: string };
export function nextStepInfo(x: EnrichedInvoice, data: DashboardData): NextStepInfo {
  if (x.inv.status === 'paid' || x.remaining <= 0) return { label: '✓ Paid', kind: 'done', detail: 'Nothing left to collect.' };
  if (isOptOut(x, x.events, x.suppressionReason)) return { label: '⊘ Opted out', kind: 'locked', detail: 'The debtor asked Remit to stop. Automated contact stays locked.' };
  if (x.inv.status === 'disputed') return { label: '⚠ Needs you: dispute', kind: 'human', detail: 'Check the invoice problem before any more contact.' };
  if (x.inv.status === 'escalated') return { label: '⚠ Needs you', kind: 'human', detail: 'A person owns this case right now.' };
  if (x.queue.length) return { label: '⚠ Needs your decision', kind: 'human', detail: 'Open Needs you and choose what happens next.' };
  if (x.suppressionReason) return { label: '▌▌ Paused', kind: 'wait', detail: x.suppressionReason };
  if (x.contacts >= data.settings.maxContactsPerInvoice) return { label: '⚠ Contact limit reached', kind: 'human', detail: 'Remit has used its allowed messages. A person should decide next.' };
  if (x.overdue > data.settings.maxOverdueDays) return { label: '⚠ Too old for auto-chasing', kind: 'human', detail: `Older than your ${data.settings.maxOverdueDays}-day automation limit.` };
  const promise = latestPromise(x.events);
  if (promise && !promise.paymentAfter && promise.promisedDay >= data.worldDay) {
    return { label: `◷ Waiting for promise`, kind: 'wait', detail: `Debtor promised payment by world day ${promise.promisedDay}. Remit will not chase before then.` };
  }
  if (x.nextEligibleDay !== null && x.nextEligibleDay <= data.worldDay) {
    return data.settings.enabled
      ? { label: '● Ready now', kind: 'ready', detail: 'The next sweep may work this invoice if the policy gate allows it.' }
      : { label: '▌▌ Ready, but agent is off', kind: 'wait', detail: 'Resume the agent when you want work to continue.' };
  }
  if (x.nextEligibleDay !== null) return { label: `◷ Next on day ${x.nextEligibleDay}`, kind: 'wait', detail: 'Waiting for the due window or safe gap between messages.' };
  return { label: '◷ Waiting', kind: 'wait', detail: 'Not eligible for automated contact right now.' };
}
export function nextStepBadge(x: EnrichedInvoice, data: DashboardData): string {
  const s = nextStepInfo(x, data);
  return `<span class="nextstep ${s.kind}" title="${esc(s.detail)}">${esc(s.label)}</span>`;
}

function invoiceLink(x: EnrichedInvoice): string {
  return `<div style="display:flex;gap:9px;align-items:center"><span class="avatar" style="width:34px;height:34px;border-radius:10px;font-size:12px">${esc(initials(x.inv.debtorName))}</span><span><a href="/invoice?id=${encodeURIComponent(x.inv.id)}"><b>${esc(x.inv.id)}</b></a><br>${esc(x.inv.debtorName)}</span></div>`;
}

function invoiceRows(data: DashboardData, rows: EnrichedInvoice[]): string {
  if (!rows.length) return '<div class="empty"><div style="font-size:28px">✓</div><b>No invoices match this view.</b><br>Try another tab or add a new invoice.</div>';
  const body = rows.map((x) => {
    const step = nextStepInfo(x, data);
    const paidPct = x.inv.amountCents ? Math.round((x.inv.paidCents / x.inv.amountCents) * 100) : 0;
    const search = esc(`${x.inv.id} ${x.inv.debtorName} ${data.debtorsById.get(x.inv.debtorId)?.email ?? ''} ${x.inv.status} ${x.segment} ${segmentLabel(x.segment)} ${step.label}`);
    return `<tr data-search="${search}">
      <td>${invoiceLink(x)}</td>
      <td><b>${moneyFull(x.remaining)}</b><br><span class="muted">of ${moneyFull(x.inv.amountCents)} · ${paidPct}% paid</span><div class="progress" style="height:6px;margin-top:6px"><div style="width:${paidPct}%"></div></div></td>
      <td>World day ${x.inv.dueDay}<br><span class="muted">${esc(overdueLabel(x.inv, data.worldDay))}</span></td>
      <td><span class="badge blue" title="${esc(SEGMENT_HELP[x.segment] ?? '')}">${esc(segmentLabel(x.segment))}</span><br><span class="muted small">${x.contacts}/${data.settings.maxContactsPerInvoice} messages used</span></td>
      <td>${nextStepBadge(x, data)}<br><span class="muted small">${esc(step.detail)}</span></td>
      <td>${statusBadge(x.inv.status)}${x.queue.length ? `<br><span class="badge red">${x.queue.length} decision${x.queue.length === 1 ? '' : 's'} for you</span>` : ''}</td>
      <td><a class="button smallbtn" href="/invoice?id=${encodeURIComponent(x.inv.id)}">Open case →</a></td>
    </tr>`;
  }).join('');
  return `<div class="tablewrap"><table><thead><tr><th>Invoice / client</th><th>Money still owed</th><th>Due</th><th>Debtor type</th><th>What happens next?</th><th>Status</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`;
}

export function queueKindMeta(kind: string): { icon: string; label: string; bg: string; color: string; help: string } {
  switch (kind) {
    case 'optout': return { icon: '⊘', label: 'Stop-contact request', bg: '#fef3f2', color: '#b42318', help: 'The debtor asked Remit to stop. Contact must stay locked.' };
    case 'dispute': return { icon: '⚠', label: 'Invoice dispute', bg: '#fef3f2', color: '#b42318', help: 'Something may be wrong with the invoice. A person must check it.' };
    case 'distress': return { icon: '!', label: 'Serious risk', bg: '#fef3f2', color: '#b42318', help: 'Lawyer, insolvency, liquidation, or similar risk words were found.' };
    case 'policy': return { icon: '✎', label: 'Your check needed', bg: '#fffaeb', color: '#b54708', help: 'Remit prepared something, but a safety rule or money limit needs your decision.' };
    case 'escalated': return { icon: 'H', label: 'Human case', bg: '#eef4ff', color: '#175cd3', help: 'A person took this away from the agent.' };
    case 'escalation': return { icon: 'H', label: 'Human case', bg: '#eef4ff', color: '#175cd3', help: 'Remit asked a person to take over.' };
    default: return { icon: '!', label: kind, bg: '#f2f4f7', color: '#344054', help: 'Remit needs a person to decide.' };
  }
}
const QUEUE_ACTION_HELP: Record<QueueAction, string> = {
  resolve_dispute: 'Only click after you checked and fixed the invoice problem.',
  approve_plan: 'Remit checks the plan again before sending. Your approval removes only the dollar limit.',
  resume: 'Allow Remit to continue, still inside all safety rules.',
  keep_paused: 'Leave contact paused and close this task.',
};

function queueRows(data: DashboardData, returnTo: string, limit?: number): string {
  const queue = limit ? data.queue.slice(0, limit) : data.queue;
  if (!queue.length) return '<div class="empty"><div style="font-size:30px">✓</div><b>Nothing needs you right now.</b><br>Remit can keep working inside the safety rules.</div>';
  const body = queue.map((q) => {
    const x = data.byInvoiceId.get(String(q.invoice_id));
    const meta = queueKindMeta(String(q.kind));
    const detail = (q.detail ?? {}) as Record<string, unknown>;
    const storedDraft = (detail.draft && typeof detail.draft === 'object')
      ? detail.draft as { message?: unknown; instalments?: Array<{ day?: unknown; amountCents?: unknown }> }
      : null;
    const draftMessage = typeof detail.draft === 'string' ? detail.draft : storedDraft?.message;
    const instalmentText = storedDraft?.instalments?.length
      ? `<div class="evidence"><b>Proposed payment plan:</b> ${storedDraft.instalments.map((i) => `world day ${esc(i.day)}: ${moneyFull(Number(i.amountCents ?? 0))}`).join(' · ')}</div>`
      : '';
    const evidence = [
      detail.reply ? `<div class="evidence"><b>Debtor said:</b> “${esc(detail.reply)}”</div>` : '',
      draftMessage ? `<div class="evidence"><b>Message Remit wanted to send:</b> “${esc(draftMessage)}”</div>` : '',
      instalmentText,
    ].join('');
    const actions = allowedQueueActions(String(q.kind), q.detail);
    const friendlyWhy = plainReason(q.why);
    return `<article class="queue-card" data-search="${esc(`${q.invoice_id} ${x?.inv.debtorName ?? ''} ${q.kind} ${meta.label} ${friendlyWhy} ${q.why}`)}">
      <div class="queue-icon" style="background:${meta.bg};color:${meta.color}">${meta.icon}</div>
      <div>
        <div class="chips"><span class="badge" style="background:${meta.bg};color:${meta.color};border-color:${meta.bg}">${esc(meta.label)}</span>${x ? `<span class="badge blue">${esc(segmentLabel(x.segment))}</span><span class="badge">${moneyFull(x.remaining)} still owed</span>` : ''}</div>
        <h3 style="margin-top:8px">${x ? `<a href="/invoice?id=${encodeURIComponent(x.inv.id)}">${esc(x.inv.id)} — ${esc(x.inv.debtorName)}</a>` : esc(q.invoice_id)}</h3>
        <p style="margin:2px 0"><b>Why you are needed:</b> ${esc(friendlyWhy)}</p>
        ${friendlyWhy !== String(q.why ?? '') ? `<details><summary class="small">Exact system reason</summary><span class="mono">${esc(q.why)}</span></details>` : ''}
        <p class="muted" style="margin:2px 0">${esc(meta.help)}</p>
        ${evidence}
      </div>
      <div>
        <div class="queue-actions">${actions.map((action) => `
          <form class="inline-form" method="post" action="/act"><input type="hidden" name="qid" value="${esc(q.id)}"><input type="hidden" name="returnTo" value="${esc(returnTo)}"><button class="${action === 'keep_paused' ? '' : 'go'}" title="${esc(QUEUE_ACTION_HELP[action])}" name="action" value="${action}">${QUEUE_ACTION_LABELS[action]}</button></form>`).join('')}</div>
        <div class="queue-help">${actions.map((action) => `<div><b>${esc(QUEUE_ACTION_LABELS[action])}:</b> ${esc(QUEUE_ACTION_HELP[action])}</div>`).join('')}</div>
      </div>
    </article>`;
  }).join('');
  return `<div class="queue-list">${body}</div>`;
}

function isOptOut(x: EnrichedInvoice | undefined, events: LedgerEvent[], reason?: string | null): boolean {
  if (reason === 'debtor asked us to stop') return true;
  if (x?.queue.some((q) => q.kind === 'optout')) return true;
  return events.some((e) => e.kind === 'reply' && replySignal(e.detail) === 'optout');
}

function settingsSummary(s: AgentSettings): string {
  const st = scheduleStatus(s);
  return `<div class="chips">
    <span class="badge ${s.enabled ? 'green' : 'red'}">${s.enabled ? '● Agent ON' : '▌▌ Agent PAUSED'}</span>
    <span class="badge ${st.allowed ? 'blue' : 'amber'}">${esc(st.reason)}</span>
    <span class="badge">Model ${esc(s.draftModel)}</span>
    <span class="badge">Budget $${s.budgetUsd.toFixed(2)}/sweep</span>
    <span class="badge">Wait ${s.minGapDays} days between messages · max ${s.maxContactsPerInvoice} per invoice</span>
  </div>`;
}

function runStatText(raw: unknown): string {
  const s = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const bits: string[] = [];
  const add = (label: string, key: string) => { if (s[key] !== undefined) bits.push(`${label} ${String(s[key])}`); };
  add('day', 'day'); add('considered', 'considered'); add('contacted', 'contacted'); add('plans', 'plansOffered');
  add('queued', 'queued'); add('waited', 'waited'); add('rewards', 'rewardsCredited');
  if (s.costUsd !== undefined) bits.push(`cost $${Number(s.costUsd).toFixed(4)}`);
  if (s.collectedCents !== undefined) bits.push(`collected ${moneyFull(Number(s.collectedCents))}`);
  if (s.skipped) bits.push(`skipped: ${String(s.skipped)}`);
  return bits.join(' · ') || '—';
}

function runStatChips(raw: unknown): string {
  const s = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const chips: string[] = [];
  const add = (label: string, key: string) => { if (s[key] !== undefined) chips.push(`<span><b>${esc(s[key])}</b> ${label}</span>`); };
  add('checked', 'considered'); add('messages', 'contacted'); add('plans', 'plansOffered');
  add('for you', 'queued'); add('waiting', 'waited'); add('paid-after wins', 'rewardsCredited');
  if (s.day !== undefined) chips.unshift(`<span>World day <b>${esc(s.day)}</b></span>`);
  if (s.costUsd !== undefined) chips.push(`<span>Model cost <b>$${Number(s.costUsd).toFixed(4)}</b></span>`);
  if (s.collectedCents !== undefined) chips.push(`<span>Collected so far <b>${moneyFull(Number(s.collectedCents))}</b></span>`);
  if (s.skipped) chips.push(`<span style="background:#fffaeb;border-color:#fedf89">Skipped: ${esc(s.skipped)}</span>`);
  return chips.join('') || '<span>No summary saved</span>';
}

export async function serve(port: number, ledgerUrl: string): Promise<void> {
  await db.migrate();
  const ledger = new Ledger(ledgerUrl, process.env.LEDGER_TOKEN);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok\n'); return; }
      if (!authorized(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="remit"', 'content-type': 'text/plain' });
        res.end('authentication required\n');
        return;
      }
      if (req.method === 'POST' && !sameOrigin(req)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('cross-site form submission blocked\n');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const [data, runs, decisions] = await Promise.all([loadDashboard(ledger), db.recentRuns(5), db.recentDecisions(8)]);
        const invoiced = data.stats?.invoicedCents ?? data.invoices.reduce((sum, i) => sum + i.amountCents, 0);
        const collected = data.stats?.collectedCents ?? data.invoices.reduce((sum, i) => sum + i.paidCents, 0);
        const stillOwed = Math.max(0, invoiced - collected);
        const pct = invoiced ? Math.round((collected / invoiced) * 1000) / 10 : 0;
        const overdue = data.enriched.filter((x) => x.inv.status === 'open' && x.overdue > 0 && x.remaining > 0);
        const overdueCents = overdue.reduce((sum, x) => sum + x.remaining, 0);
        const ready = data.enriched.filter((x) => nextStepInfo(x, data).kind === 'ready');
        const readyCents = ready.reduce((sum, x) => sum + x.remaining, 0);
        const waiting = data.enriched.filter((x) => nextStepInfo(x, data).kind === 'wait');
        const humanRows = data.enriched.filter((x) => nextStepInfo(x, data).kind === 'human');
        const schedule = scheduleStatus(data.settings);
        const latestRun = runs[0];
        const segmentCounts = new Map<string, { count: number; cents: number }>();
        for (const x of data.enriched) {
          const cur = segmentCounts.get(x.segment) ?? { count: 0, cents: 0 };
          cur.count += 1; cur.cents += x.remaining; segmentCounts.set(x.segment, cur);
        }
        const aging = [
          { label: 'Not due yet', test: (x: EnrichedInvoice) => x.overdue <= 0, color: '#2e90fa' },
          { label: '1–7 days late', test: (x: EnrichedInvoice) => x.overdue >= 1 && x.overdue <= 7, color: '#12b76a' },
          { label: '8–30 days late', test: (x: EnrichedInvoice) => x.overdue >= 8 && x.overdue <= 30, color: '#f79009' },
          { label: '31–60 days late', test: (x: EnrichedInvoice) => x.overdue >= 31 && x.overdue <= 60, color: '#f04438' },
          { label: '61+ days late', test: (x: EnrichedInvoice) => x.overdue > 60, color: '#7a271a' },
        ].map((bucket) => {
          const rows = data.enriched.filter((x) => x.inv.status === 'open' && x.remaining > 0 && bucket.test(x));
          return { ...bucket, count: rows.length, cents: rows.reduce((sum, x) => sum + x.remaining, 0) };
        });
        const agingMax = Math.max(1, ...aging.map((b) => b.cents));
        const segmentCards = [...segmentCounts.entries()].sort((a, b) => b[1].cents - a[1].cents).map(([seg, v]) => `
          <div style="padding:11px 0;border-top:1px solid var(--line)">
            <div style="display:flex;justify-content:space-between;gap:10px"><b>${esc(segmentLabel(seg))}</b><span class="muted">${v.count} invoices · ${moneyFull(v.cents)}</span></div>
            <div class="muted small">${esc(SEGMENT_HELP[seg] ?? '')}</div>
            <div class="meter" style="margin-top:7px"><span style="width:${Math.max(3, Math.round((v.cents / Math.max(1, stillOwed)) * 100))}%"></span></div>
          </div>`).join('');
        const decisionRows = decisions.map((d) => `<tr><td>World day ${esc(d.world_day)}</td><td><a href="/invoice?id=${encodeURIComponent(String(d.invoice_id))}"><b>${esc(d.invoice_id)}</b></a></td><td>${esc(segmentLabel(String(d.segment)))}</td><td>${esc(playbookLabel(String(d.playbook)))}</td><td><b>${esc(d.outcome)}</b><br><span class="muted">${esc(plainReason(d.why))}</span></td></tr>`).join('');
        const nextMoveQueue = data.queue.length
          ? `<a class="action-card" href="/queue"><span class="action-icon" style="background:#fffaeb;color:#b54708">⚠</span><span><b>1. Decide ${data.queue.length} human case${data.queue.length === 1 ? '' : 's'}</b><p>Start where Remit is not allowed to act alone.</p></span></a>`
          : `<a class="action-card" href="/queue"><span class="action-icon" style="background:#ecfdf3;color:#067647">✓</span><span><b>1. No human cases waiting</b><p>Your decision pile is clear.</p></span></a>`;
        const nextMoveRun = !data.settings.enabled
          ? `<a class="action-card" href="/settings"><span class="action-icon" style="background:#fef3f2;color:#b42318">▌▌</span><span><b>2. Agent is paused</b><p>Resume it in Controls when you want work to continue.</p></span></a>`
          : `<a class="action-card" href="/clients?filter=ready"><span class="action-icon" style="background:#ecfdf3;color:#067647">▶</span><span><b>2. ${ready.length} invoices are ready</b><p>${moneyFull(readyCents)} can be considered by the next sweep, subject to the final safety check.</p></span></a>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit — Money mission control', 'Overview', `
          ${data.stats ? '' : '<div class="banner warn">⚠ The ledger is unreachable right now, so money numbers may be stale. Check the remit-ledger service.</div>'}
          <section class="hero">
            <div class="hero-grid">
              <div>
                <span class="eyebrow">● Money mission control · World day ${data.worldDay}</span>
                <h1>Get the money that’s waiting.</h1>
                <p class="sub">Remit chases B2B invoices, learns which lawful reminder style gets paid, and brings risky cases to you. Right now, <b style="color:#fff">${moneyFull(overdueCents)}</b> is overdue.</p>
                <div class="money-big">${moneyFull(collected)}</div>
                <div style="color:#c7d2fe;margin-top:4px">collected from ${moneyFull(invoiced)} invoiced</div>
                <div class="hero-stats">
                  <div class="hero-stat"><small>Still owed</small><b>${moneyFull(stillOwed)}</b></div>
                  <div class="hero-stat"><small>Ready next</small><b>${ready.length} · ${moneyFull(readyCents)}</b></div>
                  <div class="hero-stat"><small>Your local time</small><b>${esc(schedule.localTime)}</b><div class="small" style="color:#b9c6e2">${esc(data.settings.timezone)}</div></div>
                </div>
                <div class="actions" style="margin-top:18px">
                  <form class="inline-form" method="post" action="/control" onsubmit="return confirm('Run one collection day now? Remit may send allowed contacts, then the simulated world advances one day.')"><input type="hidden" name="action" value="run_now"><button class="large" style="background:#fff;color:#175cd3;border-color:#fff" ${data.settings.enabled ? '' : 'disabled'}>▶ Run one day now</button></form>
                  ${data.settings.enabled
                    ? '<form class="inline-form" method="post" action="/control" onsubmit="return confirm(\'Pause Remit? Scheduled sweeps will not work or advance the simulated day until you resume.\')"><input type="hidden" name="action" value="pause"><button class="large" style="background:rgba(255,255,255,.10);color:#fff;border-color:rgba(255,255,255,.35)">▌▌ Pause agent</button></form>'
                    : '<form class="inline-form" method="post" action="/control"><input type="hidden" name="action" value="resume"><button class="large go">▶ Resume agent</button></form>'}
                  <a class="button large" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.35)" href="/queue">Needs you (${data.queue.length})</a>
                </div>
              </div>
              <div class="donut-wrap">
                <div class="donut" style="background:conic-gradient(#12b76a 0 ${pct}%, rgba(255,255,255,.15) ${pct}% 100%)"><div class="donut-in"><span><b>${pct}%</b><br><span>collected</span></span></div></div>
                <div>
                  <span class="badge ${data.settings.enabled ? 'green' : 'red'}">${data.settings.enabled ? '● Agent ON' : '▌▌ Agent PAUSED'}</span>
                  <p style="color:#e0eaff"><b>${esc(schedule.reason)}.</b></p>
                  <p style="color:#b9c6e2">GitHub checks every hour. Outside your chosen window, it records a skip and does not move the simulated day.</p>
                  <a href="/settings" style="color:#7dd3fc;font-weight:800">Change schedule & controls →</a>
                </div>
              </div>
            </div>
          </section>

          <section style="margin-bottom:16px">
            <div class="section-title"><div><h2>Your next 3 moves</h2><p>Do these in order. Remit handles the rest inside the safety rules.</p></div><a class="button" href="/guide">How Remit works →</a></div>
            <div class="action-grid">
              ${nextMoveQueue}
              ${nextMoveRun}
              <a class="action-card" href="/clients#add-invoice"><span class="action-icon" style="background:#eef4ff;color:#175cd3">+</span><span><b>3. Add new money to chase</b><p>Add a client invoice in under a minute.</p></span></a>
            </div>
          </section>

          <section class="card">
            <div class="section-title"><div><h2>Money pipeline</h2><p>Follow the money left to right.</p></div><span class="badge blue">World day ${data.worldDay}</span></div>
            <div class="pipeline">
              <div class="pipe-step"><small>1 · Invoiced</small><b>${moneyFull(invoiced)}</b><p>${data.invoices.length} invoices total</p></div>
              <div class="pipe-step"><small>2 · Collected</small><b>${moneyFull(collected)}</b><p>${pct}% collected</p></div>
              <div class="pipe-step"><small>3 · Still owed</small><b>${moneyFull(stillOwed)}</b><p>${data.stats?.openCount ?? data.invoices.filter((i) => i.status === 'open').length} open invoices</p></div>
              <div class="pipe-step"><small>4 · Overdue now</small><b>${moneyFull(overdueCents)}</b><p>${overdue.length} late invoices</p></div>
            </div>
          </section>

          <div class="grid">
            <section class="span3 card kpi"><span class="kpi-icon">●</span><div class="label">Ready now</div><div class="value">${ready.length}</div><div class="note">${moneyFull(readyCents)} can be considered next</div></section>
            <section class="span3 card kpi"><span class="kpi-icon">◷</span><div class="label">Waiting safely</div><div class="value">${waiting.length}</div><div class="note">Promise date, due window, or message gap</div></section>
            <section class="span3 card kpi"><span class="kpi-icon">!</span><div class="label">Needs you</div><div class="value">${data.queue.length}</div><div class="note">${humanRows.length} invoices need human ownership</div></section>
            <section class="span3 card kpi"><span class="kpi-icon">✓</span><div class="label">Paid invoices</div><div class="value">${data.stats?.paidCount ?? data.invoices.filter((i) => i.status === 'paid').length}</div><div class="note">Closed cases in this world</div></section>

            <section class="card span8">
              <div class="section-title"><div><h2>Needs you first</h2><p>These are blocked from automated chasing for a reason.</p></div><a class="button smallbtn" href="/queue">Open all →</a></div>
              ${queueRows(data, '/', 3)}
            </section>

            <div class="span4">
              <section class="card">
                <div class="section-title"><div><h2>How late is the money?</h2><p>Older money needs attention sooner.</p></div></div>
                ${aging.map((b) => `<div style="margin:12px 0"><div style="display:flex;justify-content:space-between;gap:8px"><b>${b.label}</b><span>${moneyFull(b.cents)} · ${b.count}</span></div><div class="meter" style="margin-top:6px"><span style="width:${Math.round((b.cents / agingMax) * 100)}%;background:${b.color}"></span></div></div>`).join('')}
              </section>
              <section class="card">
                <div class="section-title"><div><h2>Last time Remit worked</h2><p>Plain summary. Full details are in Activity.</p></div></div>
                ${latestRun ? `<p><b>Run #${esc(latestRun.id)} · ${esc(latestRun.kind)}</b><br><span class="muted">${esc(latestRun.started_at)}</span></p><div class="metric-chips">${runStatChips(latestRun.stats)}</div><p><a class="button smallbtn" href="/runs">Open Activity →</a></p>` : '<p class="muted">No runs yet. Press “Run one day now” when ready.</p>'}
              </section>
            </div>

            <section class="card span8">
              <div class="section-title"><div><h2>Latest decisions</h2><p>What Remit chose, and why.</p></div><a class="button smallbtn" href="/runs">See all →</a></div>
              ${decisionRows ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Invoice</th><th>Debtor type</th><th>Message style</th><th>Result & why</th></tr></thead><tbody>${decisionRows}</tbody></table></div>` : '<div class="empty">No decisions yet. Run one day to see Remit work.</div>'}
            </section>
            <section class="card span4">
              <div class="section-title"><div><h2>Who owes the money?</h2><p>Remit groups debtors from real behaviour, not guesses.</p></div></div>
              ${segmentCards || '<p class="muted">No invoices yet.</p>'}
              <p><a class="button smallbtn" href="/learned">See what message style works →</a></p>
            </section>
          </div>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/queue') {
        const data = await loadDashboard(ledger);
        const kindCounts = new Map<string, number>();
        for (const q of data.queue) kindCounts.set(String(q.kind), (kindCounts.get(String(q.kind)) ?? 0) + 1);
        const summary = [...kindCounts.entries()].map(([kind, count]) => {
          const meta = queueKindMeta(kind);
          return `<section class="card kpi span3"><span class="kpi-icon" style="background:${meta.bg};color:${meta.color}">${meta.icon}</span><div class="label">${esc(meta.label)}</div><div class="value">${count}</div><div class="note">${esc(meta.help)}</div></section>`;
        }).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit — Needs you', 'Human queue', `
          <span class="eyebrow">Human judgement required</span>
          <h1>Needs you</h1>
          <p class="sub">Remit stopped before these cases on purpose. Read “Why you are needed”, open the case if you need more history, then choose one clear decision.</p>
          ${data.queue.length ? `<div class="grid">${summary}</div>` : ''}
          <div class="card" style="background:linear-gradient(135deg,#fffaeb,#fff);border-color:#fedf89">
            <h2>Your 20-second routine</h2>
            <div class="daily">
              <div class="daily-step"><span class="stepnum">1</span><div><b>Read the reason.</b><div class="muted">Dispute, opt-out, serious risk, or plan approval?</div></div></div>
              <div class="daily-step"><span class="stepnum">2</span><div><b>Check evidence.</b><div class="muted">The debtor’s words and the blocked message/plan are shown on the card.</div></div></div>
              <div class="daily-step"><span class="stepnum">3</span><div><b>Decide once.</b><div class="muted">Buttons are limited to what is safe for that case. Opt-outs can never be resumed here.</div></div></div>
            </div>
          </div>
          <input class="search" data-filter-input placeholder="Search invoice, client, problem type, or reason…">
          ${queueRows(data, '/queue')}`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/clients') {
        const data = await loadDashboard(ledger);
        const requestedFilter = url.searchParams.get('filter') ?? 'all';
        const filters = [
          { key: 'all', label: 'All invoices', test: (_x: EnrichedInvoice) => true },
          { key: 'ready', label: '● Ready now', test: (x: EnrichedInvoice) => nextStepInfo(x, data).kind === 'ready' },
          { key: 'overdue', label: 'Overdue', test: (x: EnrichedInvoice) => x.inv.status === 'open' && x.overdue > 0 && x.remaining > 0 },
          { key: 'human', label: 'Needs you', test: (x: EnrichedInvoice) => nextStepInfo(x, data).kind === 'human' || x.queue.length > 0 },
          { key: 'waiting', label: 'Waiting / paused', test: (x: EnrichedInvoice) => nextStepInfo(x, data).kind === 'wait' },
          { key: 'paid', label: 'Paid ✓', test: (x: EnrichedInvoice) => x.inv.status === 'paid' || x.remaining <= 0 },
        ];
        const activeFilter = filters.some((f) => f.key === requestedFilter) ? requestedFilter : 'all';
        const filterTabs = filters.map((f) => {
          const count = data.enriched.filter(f.test).length;
          return `<a href="/clients?filter=${f.key}"${activeFilter === f.key ? ' class="active"' : ''}>${f.label} <span class="count">(${count})</span></a>`;
        }).join('');
        const clientCards = data.debtors.map((debtor) => {
          const rows = data.enriched.filter((x) => x.inv.debtorId === debtor.id);
          const open = rows.reduce((sum, x) => sum + (x.inv.status === 'paid' ? 0 : x.remaining), 0);
          const overdueAmt = rows.filter((x) => x.overdue > 0 && x.inv.status === 'open').reduce((sum, x) => sum + x.remaining, 0);
          const paid = rows.reduce((sum, x) => sum + x.inv.paidCents, 0);
          const segs = [...new Set(rows.map((x) => x.segment))];
          const needs = rows.filter((x) => nextStepInfo(x, data).kind === 'human').length;
          return { debtor, rows, open, overdueAmt, paid, segs, needs };
        }).sort((a, b) => b.overdueAmt - a.overdueAmt || b.open - a.open).map((c) => `
          <article class="client-card" data-search="${esc(`${c.debtor.id} ${c.debtor.name} ${c.debtor.email} ${c.segs.map(segmentLabel).join(' ')}`)}">
            <div class="client-top"><span class="avatar">${esc(initials(c.debtor.name))}</span><div><a href="/client?id=${encodeURIComponent(c.debtor.id)}"><b>${esc(c.debtor.name)}</b></a><div class="muted small">${esc(c.debtor.email || 'No accounts email')} · ${esc(c.debtor.id)}</div></div></div>
            <div class="money-row">
              <div><small>Still owed</small><b>${moneyFull(c.open)}</b></div>
              <div><small>Overdue</small><b style="color:${c.overdueAmt ? '#b42318' : 'inherit'}">${moneyFull(c.overdueAmt)}</b></div>
              <div><small>Collected</small><b>${moneyFull(c.paid)}</b></div>
            </div>
            <div class="chips"><span class="badge">${c.rows.length} invoice${c.rows.length === 1 ? '' : 's'}</span>${c.needs ? `<span class="badge red">${c.needs} needs you</span>` : ''}${c.segs.map((seg) => `<span class="badge blue" title="${esc(SEGMENT_HELP[seg] ?? '')}">${esc(segmentLabel(seg))}</span>`).join(' ')}</div>
            <p style="margin:13px 0 0"><a class="button smallbtn" href="/client?id=${encodeURIComponent(c.debtor.id)}">Open client →</a></p>
          </article>`).join('');
        const invoicesSorted = [...data.enriched]
          .filter((x) => (filters.find((f) => f.key === activeFilter)?.test(x) ?? true))
          .sort((a, b) => (a.inv.status === 'open' ? 0 : 1) - (b.inv.status === 'open' ? 0 : 1) || b.overdue - a.overdue || b.remaining - a.remaining);
        const debtorOptions = data.debtors.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} (${esc(d.id)})</option>`).join('');
        const totalOpen = data.enriched.reduce((sum, x) => sum + (x.inv.status === 'paid' ? 0 : x.remaining), 0);
        const totalOverdue = data.enriched.filter((x) => x.inv.status === 'open' && x.overdue > 0).reduce((sum, x) => sum + x.remaining, 0);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit — Clients & invoices', 'Clients', `
          <span class="eyebrow">Who owes you money?</span>
          <h1>Clients & invoices</h1>
          <p class="sub">Find a case, add new money to chase, or open an invoice to record a payment, promise, plan, or pause.</p>
          <div class="grid">
            <section class="card kpi span4"><span class="kpi-icon">▦</span><div class="label">Clients</div><div class="value">${data.debtors.length}</div><div class="note">${data.invoices.length} invoices in the ledger</div></section>
            <section class="card kpi span4"><span class="kpi-icon">$</span><div class="label">Still owed</div><div class="value">${moneyFull(totalOpen)}</div><div class="note">Across every unpaid invoice</div></section>
            <section class="card kpi span4"><span class="kpi-icon">!</span><div class="label">Overdue money</div><div class="value">${moneyFull(totalOverdue)}</div><div class="note">Past its due world day</div></section>
          </div>
          <input class="search" data-filter-input placeholder="Search a client, email, invoice, debtor type, or next step…">
          <div class="grid">
            <section class="card span4" id="add-invoice">
              <div class="step-head"><span class="stepnum">+</span><div><h2>Add an invoice</h2><p>Tell Remit about new money someone owes.</p></div></div>
              <form method="post" action="/clients/add-invoice">
                <div class="divider"></div><h3>Step 1 — Who owes it?</h3>
                <label>Choose an existing client</label>
                <select name="debtorId"><option value="">— New client below —</option>${debtorOptions}</select>
                <div class="help">If the client already exists, choose them and skip the two “new client” boxes.</div>
                <label>New client business name</label><input name="debtorName" placeholder="Example Trading Ltd">
                <label>New client accounts email</label><input name="debtorEmail" placeholder="ap@example.com">
                <div class="divider"></div><h3>Step 2 — How much, and when was it due?</h3>
                <label>Invoice amount (USD)</label><input name="amount" required inputmode="decimal" placeholder="1250.00">
                <label>Due in days from today (world day ${data.worldDay})</label><input name="dueInDays" type="number" value="14" min="-365" max="3650" required>
                <div class="help"><b>14</b> = due in two weeks · <b>0</b> = due today · <b>-5</b> = already 5 days late.</div>
                <div class="divider"></div><h3>Step 3 — Add it</h3>
                <p class="muted">Remit will show it immediately. It still waits for the reminder window and safety gap before contacting.</p>
                <p><button class="primary large" style="width:100%">+ Add invoice</button></p>
              </form>
            </section>
            <section class="card span8">
              <div class="section-title"><div><h2>Clients owing money</h2><p>Most overdue clients appear first.</p></div></div>
              <div class="client-grid">${clientCards || '<div class="empty">No clients yet. Add your first invoice.</div>'}</div>
            </section>
            <section class="card span12">
              <div class="section-title"><div><h2>Invoices</h2><p>Use tabs to focus on one kind of work. “What happens next?” tells you the current state in plain English.</p></div></div>
              <div class="tabs">${filterTabs}</div>
              ${invoiceRows(data, invoicesSorted)}
            </section>
          </div>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/client') {
        const data = await loadDashboard(ledger);
        const debtor = data.debtorsById.get(url.searchParams.get('id') ?? '');
        if (!debtor) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('client not found\n'); return; }
        const rows = data.enriched.filter((x) => x.inv.debtorId === debtor.id);
        const open = rows.reduce((s, x) => s + (x.inv.status === 'paid' ? 0 : x.remaining), 0);
        const paid = rows.reduce((s, x) => s + x.inv.paidCents, 0);
        const overdue = rows.filter((x) => x.overdue > 0 && x.inv.status === 'open');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(`Remit client ${debtor.name}`, 'Clients', `
          <p><a href="/clients">← All clients & invoices</a></p>
          <div style="display:flex;gap:14px;align-items:center;margin-bottom:18px"><span class="avatar" style="width:58px;height:58px;border-radius:18px;font-size:19px">${esc(initials(debtor.name))}</span><div><span class="eyebrow">Client case file</span><h1>${esc(debtor.name)}</h1><p class="sub" style="margin:0">${esc(debtor.email || 'No accounts email')} · Client ID ${esc(debtor.id)} · ${[...new Set(rows.map((x) => segmentLabel(x.segment)))].join(', ')}</p></div></div>
          <div class="grid">
            <section class="card kpi span4"><div class="label">Open balance</div><div class="value">${moneyFull(open)}</div><div class="note">${rows.length} invoices</div></section>
            <section class="card kpi span4"><div class="label">Overdue invoices</div><div class="value">${overdue.length}</div><div class="note">${moneyFull(overdue.reduce((s, x) => s + x.remaining, 0))} overdue</div></section>
            <section class="card kpi span4"><div class="label">Collected</div><div class="value">${moneyFull(paid)}</div><div class="note">Payments recorded in ledger</div></section>
            <section class="card span6">
              <div class="step-head"><span class="stepnum">✎</span><div><h2>Client details</h2><p>Fix the business name or accounts-payable email.</p></div></div>
              <form method="post" action="/clients/update">
                <input type="hidden" name="debtorId" value="${esc(debtor.id)}"><input type="hidden" name="returnTo" value="/client?id=${encodeURIComponent(debtor.id)}">
                <label>Client/business name</label><input name="name" value="${esc(debtor.name)}" required>
                <label>Accounts email</label><input name="email" value="${esc(debtor.email)}" required>
                <p><button class="primary">Save client</button></p>
              </form>
            </section>
            <section class="card span6">
              <div class="step-head"><span class="stepnum">+</span><div><h2>Add another invoice</h2><p>New money owed by this same client.</p></div></div>
              <form method="post" action="/clients/add-invoice">
                <input type="hidden" name="debtorId" value="${esc(debtor.id)}">
                <label>Invoice amount (USD)</label><input name="amount" required inputmode="decimal" placeholder="1250.00">
                <label>Due in days from world day ${data.worldDay}</label><input name="dueInDays" type="number" value="14" min="-365" max="3650" required>
                <p><button class="primary">Add invoice</button></p>
              </form>
            </section>
            <section class="card span12"><div class="section-title"><div><h2>This client’s invoices</h2><p>Open a case to record money, a promise, or a plan.</p></div></div>${invoiceRows(data, rows)}</section>
          </div>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/invoice') {
        const data = await loadDashboard(ledger);
        const x = data.byInvoiceId.get(url.searchParams.get('id') ?? '');
        if (!x) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('invoice not found\n'); return; }
        const [decisions, trials] = await Promise.all([db.invoiceDecisions('live', x.inv.id), db.contactTrials('live', x.inv.id)]);
        const debtor = data.debtorsById.get(x.inv.debtorId);
        const optOut = isOptOut(x, x.events, x.suppressionReason);
        const defaultPlanCount = Math.min(2, data.settings.planMaxInstalments);
        const defaultFirstDay = data.worldDay + Math.min(7, data.settings.planMaxDays);
        const defaultLastDay = defaultPlanCount <= 1 ? defaultFirstDay : Math.max(defaultFirstDay, data.worldDay + Math.min(21, data.settings.planMaxDays));
        const templateValues = { debtor: x.inv.debtorName, invoice: x.inv.id, amount: moneyFull(x.remaining), remaining: moneyFull(x.remaining), dueDay: x.inv.dueDay, worldDay: data.worldDay, daysOverdue: x.overdue, overdue: x.overdue, planCount: defaultPlanCount, firstDay: defaultFirstDay, lastDay: defaultLastDay, firstPayment: moneyFull(defaultPlanCount ? Math.ceil(x.remaining / defaultPlanCount) : 0) };
        const isPaid = x.inv.status === 'paid' || x.remaining <= 0;
        const closedText = `No reminder is needed: invoice ${x.inv.id} has been paid in full.`;
        const reminder = isPaid ? closedText : renderTemplate(data.settings.templates['friendly-remind-only'], templateValues);
        const planMessage = isPaid ? closedText : renderTemplate(data.settings.templates['friendly-plan-early'], templateValues);
        const playbookOptions = data.settings.enabledPlaybooks.map((p) => `<option value="${p}">${esc(playbookLabel(p))} — ${esc(PLAYBOOK_HELP[p] ?? '')}</option>`).join('');
        const next = x.nextEligibleDay === null ? 'Not eligible' : x.nextEligibleDay <= data.worldDay ? 'Now' : `World day ${x.nextEligibleDay}`;
        const timeline = [...x.events].reverse().map((e) => `<div class="event ${esc(e.kind)}"><b>World day ${e.day} · ${esc(e.kind.replaceAll('_', ' '))}</b><br>${esc(eventDetail(e))}</div>`).join('') || '<p class="muted">No ledger events yet.</p>';
        const decisionRows = decisions.map((d) => `<tr><td>World day ${esc(d.world_day)}</td><td>${esc(playbookLabel(String(d.playbook)))}</td><td><b>${esc(d.outcome)}</b><br><span class="muted">${esc(d.action)}</span></td><td>${esc(plainReason(d.why))}</td></tr>`).join('');
        const trialRows = trials.map((t) => `<tr><td>#${t.contactEventId}</td><td>World day ${t.worldDay}</td><td>${esc(segmentLabel(t.segment))}</td><td>${esc(playbookLabel(t.playbook))}</td><td>${t.rewardedPaymentEventId ? '<span class="badge green">✓ Paid soon after</span>' : '<span class="muted">Not yet</span>'}</td></tr>`).join('');
        const canAct = x.inv.status === 'open' && x.remaining > 0 && !x.suppressionReason && !optOut;
        const step = nextStepInfo(x, data);
        const paidPct = x.inv.amountCents ? Math.round((x.inv.paidCents / x.inv.amountCents) * 100) : 0;
        const recommendationClass = step.kind === 'locked' ? 'locked' : step.kind === 'human' ? 'warn' : '';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(`Remit invoice ${x.inv.id}`, 'Clients', `
          <p><a href="/client?id=${encodeURIComponent(x.inv.debtorId)}">← ${esc(x.inv.debtorName)}</a></p>
          <section class="card pad-lg">
            <div class="case-hero">
              <div>
                <span class="eyebrow">Invoice case file</span>
                <h1>${esc(x.inv.id)}</h1>
                <p class="sub" style="margin-bottom:10px"><a href="/client?id=${encodeURIComponent(x.inv.debtorId)}"><b>${esc(x.inv.debtorName)}</b></a> · ${esc(debtor?.email || 'No accounts email')}</p>
                <div class="money-big" style="color:var(--ink)">${moneyFull(x.remaining)}</div>
                <div class="muted">still owed from ${moneyFull(x.inv.amountCents)} · ${moneyFull(x.inv.paidCents)} already paid (${paidPct}%)</div>
                <div class="progress" style="max-width:520px;margin:12px 0"><div style="width:${paidPct}%"></div></div>
                <div class="chips">${statusBadge(x.inv.status)} <span class="badge blue" title="${esc(SEGMENT_HELP[x.segment] ?? '')}">${esc(segmentLabel(x.segment))}</span><span class="badge">Due world day ${x.inv.dueDay} · ${esc(overdueLabel(x.inv, data.worldDay))}</span><span class="badge">${x.contacts}/${data.settings.maxContactsPerInvoice} messages used</span>${x.queue.length ? `<span class="badge red">${x.queue.length} decision${x.queue.length === 1 ? '' : 's'} for you</span>` : ''}</div>
              </div>
              <div class="recommendation ${recommendationClass}">
                <span class="eyebrow" style="color:#067647">What should happen next?</span>
                <div style="font-size:24px;font-weight:900;letter-spacing:-.025em;line-height:1.15">${esc(step.label)}</div>
                <p>${esc(step.detail)}</p>
                ${step.kind === 'human' ? '<a class="button go" href="/queue">Open Needs you →</a>' : step.kind === 'ready' ? '<span class="badge green">Final safety check still runs before any message</span>' : ''}
              </div>
            </div>
          </section>
          <div class="grid">
            <section class="card span6">
              <div class="step-head"><span class="stepnum">✉</span><div><h2>Message this debtor</h2><p>Pause, escalate, or send one guarded reminder.</p></div></div>
              ${optOut ? '<div class="banner err">This debtor opted out. Resume/send controls are locked. A person owns any further handling outside automated contact.</div>' : ''}
              ${isPaid ? '<div class="banner ok"><b>Case closed.</b> The full balance has been paid, so messaging tools are locked. The story and learning evidence below stay available for audit.</div>' : ''}
              <div class="actions">
                ${x.suppressionReason && !optOut ? `<form class="inline-form" method="post" action="/invoice/action"><input type="hidden" name="invoiceId" value="${esc(x.inv.id)}"><button class="go" name="action" value="resume">Resume contact</button></form>` : ''}
                ${!x.suppressionReason && x.inv.status === 'open' ? `<form class="inline-form" method="post" action="/invoice/action"><input type="hidden" name="invoiceId" value="${esc(x.inv.id)}"><button class="warnbtn" name="action" value="pause">Pause contact</button></form>` : ''}
                ${x.inv.status === 'open' ? `<form class="inline-form" method="post" action="/invoice/action" onsubmit="return confirm('Escalate this invoice to a person?')"><input type="hidden" name="invoiceId" value="${esc(x.inv.id)}"><input type="hidden" name="reason" value="Escalated from invoice dashboard."><button class="danger" name="action" value="escalate">Escalate</button></form>` : ''}
                ${x.inv.status === 'escalated' && !optOut ? `<form class="inline-form" method="post" action="/invoice/action"><input type="hidden" name="invoiceId" value="${esc(x.inv.id)}"><button class="go" name="action" value="reopen">Return to agent</button></form>` : ''}
                ${x.inv.status === 'disputed' ? `<form class="inline-form" method="post" action="/invoice/action" onsubmit="return confirm('Mark this dispute resolved and allow contact again?')"><input type="hidden" name="invoiceId" value="${esc(x.inv.id)}"><button class="go" name="action" value="resolve_dispute">Dispute resolved</button></form>` : ''}
              </div>
              <div class="divider"></div>
              <h3>Send a reminder now</h3><p class="muted">Edit the words if you want. Remit still checks promise dates, spacing, caps, threats, and discounts before sending.</p>
              <form method="post" action="/invoice/action">
                <input type="hidden" name="invoiceId" value="${esc(x.inv.id)}">
                <label>Message style (playbook)</label><select name="playbook" ${isPaid ? 'disabled' : ''}>${playbookOptions}</select>
                <label>Exact message</label><textarea name="message" required ${isPaid ? 'disabled' : ''}>${esc(reminder)}</textarea>
                <div class="help">◆ If a safety rule blocks it, nothing is sent and the reason appears at the top.</div>
                <p><button class="primary" name="action" value="send_message" ${canAct ? '' : 'disabled'}>Send reminder</button></p>
              </form>
            </section>

            <section class="card span6">
              <div class="step-head"><span class="stepnum">$</span><div><h2>Money & promises</h2><p>Tell Remit what happened outside the simulated world.</p></div></div>
              ${isPaid ? '<div class="banner ok"><b>Nothing left to record against this invoice.</b> Payment, promise, and new-plan tools are locked because the balance is $0.00.</div>' : ''}
              <form method="post" action="/invoice/action">
                <input type="hidden" name="invoiceId" value="${esc(x.inv.id)}">
                <div class="formgrid">
                  <div><label>Payment received (USD)</label><input name="paymentAmount" inputmode="decimal" placeholder="250.00" ${x.inv.status === 'paid' || x.inv.status === 'disputed' ? 'disabled' : ''}></div>
                  <div><label>Payment note</label><input name="paymentNote" placeholder="Bank transfer received" ${x.inv.status === 'paid' || x.inv.status === 'disputed' ? 'disabled' : ''}></div>
                </div>
                <p><button class="go" name="action" value="record_payment" ${x.inv.status === 'paid' || x.inv.status === 'disputed' ? 'disabled' : ''}>Record payment</button></p>
              </form>
              <div class="divider"></div>
              <form method="post" action="/invoice/action">
                <input type="hidden" name="invoiceId" value="${esc(x.inv.id)}">
                <label>Debtor promised to pay in how many days?</label><input name="promiseInDays" type="number" min="0" max="90" value="7" required ${x.inv.status === 'paid' || x.inv.status === 'disputed' ? 'disabled' : ''}>
                <div class="help">Remit will wait until after that promised date before chasing again.</div>
                <p><button name="action" value="record_promise" ${x.inv.status === 'paid' || x.inv.status === 'disputed' ? 'disabled' : ''}>Record promise</button></p>
              </form>
              <div class="divider"></div>
              <h3>Create an equal-split payment plan</h3><p class="muted">The total always stays exactly ${moneyFull(x.remaining)}. No discount is possible here.</p>
              <form method="post" action="/invoice/action">
                <input type="hidden" name="invoiceId" value="${esc(x.inv.id)}">
                <div class="formgrid">
                  <div><label>Message style</label><select name="playbook" ${isPaid ? 'disabled' : ''}>${playbookOptions}</select></div>
                  <div><label>Instalments</label><input name="planCount" type="number" min="1" max="${data.settings.planMaxInstalments}" value="${defaultPlanCount}" required ${isPaid ? 'disabled' : ''}></div>
                  <div><label>First payment in days</label><input name="planFirstInDays" type="number" min="1" max="${data.settings.planMaxDays}" value="${defaultFirstDay - data.worldDay}" required ${isPaid ? 'disabled' : ''}></div>
                  <div><label>Then every days (0 = same day)</label><input name="planEveryDays" type="number" min="0" max="45" value="${defaultPlanCount <= 1 ? 0 : defaultLastDay - defaultFirstDay}" required ${isPaid ? 'disabled' : ''}></div>
                  <div class="wide"><label>Message</label><textarea name="message" required ${isPaid ? 'disabled' : ''}>${esc(planMessage)}</textarea></div>
                </div>
                <div class="help">As the human operator, you may approve over the automatic dollar threshold. Exact total, dates, first-payment size, spacing, caps, and safe wording are still re-checked.</div>
                <p><button class="primary" name="action" value="create_plan" ${canAct ? '' : 'disabled'}>Create & send plan</button></p>
              </form>
            </section>

            <section class="card span6"><div class="step-head"><span class="stepnum">◷</span><div><h2>Story so far</h2><p>Newest event first.</p></div></div><div class="timeline">${timeline}</div></section>
            <section class="card span6">
              <div class="step-head"><span class="stepnum">✓</span><div><h2>What Remit decided</h2><p>Every choice keeps its reason.</p></div></div>
              ${decisionRows ? `<div class="tablewrap"><table style="min-width:560px"><thead><tr><th>When</th><th>Message style</th><th>Result</th><th>Why</th></tr></thead><tbody>${decisionRows}</tbody></table></div>` : '<p class="muted">No agent decisions yet.</p>'}
              <div class="divider"></div><h2>Learning evidence</h2><p class="muted">One row per real contact. The debtor type and message style are frozen at send time, so later events cannot rewrite history.</p>
              ${trialRows ? `<div class="tablewrap"><table style="min-width:560px"><thead><tr><th>Message</th><th>When</th><th>Type at that time</th><th>Style</th><th>Paid soon after?</th></tr></thead><tbody>${trialRows}</tbody></table></div>` : '<p class="muted">No contact trials yet.</p>'}
            </section>
          </div>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/settings') {
        const [settings, history] = await Promise.all([loadSettings('live'), db.settingsHistory('live', 10)]);
        const dayBoxes = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']]
          .map(([n, label]) => `<label class="check"><input type="checkbox" name="sendDays" value="${n}"${settings.sendDays.includes(Number(n)) ? ' checked' : ''}> ${label}</label>`).join('');
        const modelPicks = [
          ['baseline:rules', 'Free rules', 'Recommended · $0 · measured'],
          ['oss:openai/gpt-oss-20b', 'Groq OSS', 'Needs GROQ_API_KEY'],
          ['grok:grok-4.3', 'Grok 4.3', 'Needs XAI_API_KEY'],
          ['Claude:claude-haiku-4-5', 'Claude Haiku', 'Needs ANTHROPIC_API_KEY'],
          ['Claude:claude-sonnet-4-5', 'Claude Sonnet', 'Needs ANTHROPIC_API_KEY'],
          ['openai:gpt-5-mini', 'OpenAI mini', 'Needs OPENAI_API_KEY'],
        ].map(([model, label, note]) => `<button type="button" class="model-pick" data-model="${esc(model)}" title="${esc(note)}">${esc(label)}</button>`).join('');
        const sampleValues = { debtor: 'Example Trading Ltd', invoice: 'inv-123', amount: '$1,250.00', remaining: '$1,250.00', dueDay: 10, worldDay: 12, daysOverdue: 2, overdue: 2, planCount: 2, firstDay: 19, lastDay: 33, firstPayment: '$625.00' };
        const playbookCards = PLAYBOOKS.map((playbook) => `
          <article class="playbook-card">
            <div class="playbook-head">
              <div><h3>${esc(playbookLabel(playbook))}</h3><p class="muted" style="margin:0">${esc(PLAYBOOK_HELP[playbook] ?? '')}</p><span class="mono muted">${playbook}</span></div>
              <label class="check"><input type="checkbox" name="enabledPlaybooks" value="${playbook}"${settings.enabledPlaybooks.includes(playbook) ? ' checked' : ''}> Use this style</label>
            </div>
            <div class="formgrid">
              <div><label>How should it sound?</label><textarea name="tone_${playbook}" style="min-height:78px" required>${esc(settings.tones[playbook])}</textarea><div class="help">This guides an AI model. Code still blocks unsafe wording.</div></div>
              <div><label>Free-rules message</label><textarea name="template_${playbook}" required>${esc(settings.templates[playbook])}</textarea><div class="help">Used by baseline:rules. You may use placeholders like {debtor}, {invoice}, and {amount}.</div></div>
            </div>
            <div class="sample"><b>Example:</b> ${esc(renderTemplate(settings.templates[playbook], sampleValues))}</div>
          </article>`).join('');
        const historyRows = history.map((h) => {
          const saved = h.settings && typeof h.settings === 'object' ? h.settings as Record<string, unknown> : {};
          return `<tr><td>${esc(h.changed_at)}</td><td>${esc(h.changed_by)}</td><td>${saved.enabled ? '<span class="badge green">ON</span>' : '<span class="badge red">Paused</span>'}</td><td>${esc(saved.draftModel)}</td><td>${esc(saved.timezone)} ${esc(saved.sendStart)}–${esc(saved.sendEnd)}</td></tr>`;
        }).join('');
        const schedule = scheduleStatus(settings);
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const preview = `<b>${settings.enabled ? 'Remit is ON.' : 'Remit is PAUSED.'}</b> GitHub wakes it every hour, but it only works on <b>${settings.sendDays.map((d) => dayNames[d]).join(', ')}</b> between <b>${settings.sendStart}–${settings.sendEnd}</b> (${esc(settings.timezone)}). It waits at least <b>${settings.minGapDays} days</b> between messages and stops after <b>${settings.maxContactsPerInvoice} contacts</b>.`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit — Controls', 'Settings', `
          <section class="settings-hero">
            <div class="hero-grid">
              <div>
                <span class="eyebrow">You are in charge</span>
                <h1>Controls</h1>
                <p>Choose when Remit works, how patiently it reminds, what plans it may offer, which message styles it may learn from, and which brain writes drafts.</p>
                ${settingsSummary(settings)}
                <p style="color:#b9c6e2">Changes apply to the next live sweep. The benchmark exam always resets to safe defaults, so live experiments do not secretly move the exam.</p>
              </div>
              <div class="preview-box"><span class="eyebrow">Plain-English preview</span><div id="settings-preview" class="setting-summary">${preview}</div><p style="color:#b9c6e2">This preview updates as you change fields below. Nothing is saved until you press the blue save button.</p></div>
            </div>
          </section>

          <form id="settings-form" method="post" action="/settings/save">
            <section class="card">
              <div class="step-head"><span class="stepnum">★</span><div><h2>Start with a collection style</h2><p>Pick a preset, then fine-tune below. Presets never unlock threats or discounts.</p></div></div>
              <div class="preset-grid">
                <button type="button" class="preset" data-preset="gentle"><b>○ Gentle</b><span>Slower spacing, fewer messages, earlier human approval. Best when relationships matter most.</span></button>
                <button type="button" class="preset" data-preset="balanced"><b>◆ Balanced — recommended</b><span>The measured default: 3-day minimum gap, up to 6 messages, plans over $5,000 need you.</span></button>
                <button type="button" class="preset" data-preset="firm"><b>● Firm but lawful</b><span>Starts a little earlier, asks for a larger first plan payment, and escalates big plans sooner. Still no threats.</span></button>
              </div>
            </section>

            <div class="grid">
              <section class="card span6">
                <div class="step-head"><span class="stepnum">1</span><div><h2>When should Remit work?</h2><p>Power, your timezone, and the daily window GitHub is allowed to use.</p></div></div>
                <label class="check" style="font-size:15px;padding:13px"><input type="checkbox" name="enabled" value="1"${settings.enabled ? ' checked' : ''}> <span><b>Agent is ON</b><br><span class="muted">Turn off to pause all scheduled work. A paused sweep does not advance the simulated day.</span></span></label>
                <label>Your timezone</label>
                <input name="timezone" list="timezones" value="${esc(settings.timezone)}" required>
                <datalist id="timezones"><option value="Asia/Karachi"></option><option value="UTC"></option><option value="Europe/London"></option><option value="Europe/Berlin"></option><option value="America/New_York"></option><option value="America/Chicago"></option><option value="America/Denver"></option><option value="America/Los_Angeles"></option><option value="Asia/Dubai"></option><option value="Asia/Singapore"></option></datalist>
                <div class="help">For Pakistan, keep <b>Asia/Karachi</b>.</div>
                <label>Work on these days</label><div class="actions">${dayBoxes}</div>
                <div class="formgrid">
                  <div><label>Start time</label><input type="time" name="sendStart" value="${esc(settings.sendStart)}" required></div>
                  <div><label>End time</label><input type="time" name="sendEnd" value="${esc(settings.sendEnd)}" required></div>
                </div>
                <div class="evidence"><b>Easy rule:</b> use a one-hour window, like 09:00–09:59, for roughly one simulated day per real day. A long window lets hourly GitHub checks advance several simulated days.</div>
                <p class="help">Now in your timezone: <b>${esc(schedule.localTime)}</b> — ${esc(schedule.reason)}.</p>
              </section>

              <section class="card span6">
                <div class="step-head"><span class="stepnum">2</span><div><h2>How patiently should it remind?</h2><p>These numbers are world days in the simulator.</p></div></div>
                <div class="formgrid">
                  <div><label>Start reminding before due</label><input name="preDueReminderDays" type="number" min="0" max="14" value="${settings.preDueReminderDays}" required><div class="help">0 = due day only · 2 = two days early.</div></div>
                  <div><label>Wait between messages</label><input name="minGapDays" type="number" min="3" max="30" value="${settings.minGapDays}" required><div class="help">Safety minimum is 3 days.</div></div>
                  <div><label>Max messages per invoice</label><div class="range-row"><input type="range" name="range_maxContactsPerInvoice" min="1" max="6" step="1" value="${settings.maxContactsPerInvoice}" data-sync-target="maxContactsPerInvoice"><output data-output-for="maxContactsPerInvoice">${settings.maxContactsPerInvoice}</output></div><input name="maxContactsPerInvoice" type="number" min="1" max="6" value="${settings.maxContactsPerInvoice}" required><div class="help">After this, the case belongs to a person.</div></div>
                  <div><label>Stop auto-chasing after overdue</label><input name="maxOverdueDays" type="number" min="7" max="365" value="${settings.maxOverdueDays}" required><div class="help">Very old debt stays visible, but Remit stops chasing forever.</div></div>
                </div>
                <div class="evidence"><b>Promise rule is locked:</b> if a debtor promises a date, Remit waits until after it. It does not nag early.</div>
              </section>

              <section class="card span6">
                <div class="step-head"><span class="stepnum">3</span><div><h2>Payment plans</h2><p>How unpaid money may be split. The total never changes.</p></div></div>
                <div class="formgrid">
                  <div><label>Max number of payments</label><input name="planMaxInstalments" type="number" min="1" max="3" value="${settings.planMaxInstalments}" required></div>
                  <div><label>Finish all payments within</label><input name="planMaxDays" type="number" min="7" max="45" value="${settings.planMaxDays}" required><div class="help">Days from the offer.</div></div>
                  <div><label>First payment at least</label><div class="range-row"><input type="range" name="range_planMinFirstPct" min="25" max="100" step="1" value="${settings.planMinFirstPct}" data-sync-target="planMinFirstPct" data-suffix="%"><output data-output-for="planMinFirstPct">${settings.planMinFirstPct}%</output></div><input name="planMinFirstPct" type="number" min="25" max="100" value="${settings.planMinFirstPct}" required></div>
                  <div><label>You approve plans above (USD)</label><input name="planHumanAboveDollars" inputmode="decimal" value="${(settings.planHumanAboveCents / 100).toFixed(2)}" required><div class="help">Example: 5000 means plans above $5,000 wait for you.</div></div>
                </div>
                <div class="evidence"><b>Locked:</b> instalments must add up to the exact remaining balance. There is no discount switch.</div>
              </section>

              <div class="span6">
                <section class="card">
                  <div class="step-head"><span class="stepnum">4</span><div><h2>Which brain writes drafts?</h2><p>Pick a brain. The safety gate still checks every word.</p></div></div>
                  <div class="model-picks">${modelPicks}</div>
                  <label>Exact model name</label>
                  <input name="draftModel" list="models" value="${esc(settings.draftModel)}" required>
                  <datalist id="models"><option value="baseline:rules"></option><option value="oss:openai/gpt-oss-20b"></option><option value="grok:grok-4.3"></option><option value="grok:grok-4.7"></option><option value="Claude:claude-haiku-4-5"></option><option value="Claude:claude-sonnet-4-5"></option><option value="openai:gpt-5-mini"></option><option value="openai:gpt-5"></option></datalist>
                  <div class="help"><b>Free rules</b> is the measured $0 option. API keys are never typed here: scheduled runs use GitHub secrets, dashboard runs use Render environment secrets. No key = the case safely goes to a person instead of sending bad text.</div>
                  <label>Maximum AI spend per sweep (USD)</label>
                  <input name="budgetUsd" type="number" min="0" max="100" step="0.01" value="${settings.budgetUsd}" required>
                  <div class="help">When the budget is reached, Remit waits/escalates instead of overspending.</div>
                </section>
                <section class="card">
                  <div class="step-head"><span class="stepnum">5</span><div><h2>How should Remit learn?</h2><p>It tries styles, then keeps using what gets paid.</p></div></div>
                  <div class="formgrid">
                    <div><label>Try something different</label><div class="range-row"><input type="range" name="range_explorationPct" min="0" max="50" step="1" value="${settings.explorationPct}" data-sync-target="explorationPct" data-suffix="%"><output data-output-for="explorationPct">${settings.explorationPct}%</output></div><input name="explorationPct" type="number" min="0" max="50" step="1" value="${settings.explorationPct}" required><div class="help">15% means about 15 of 100 choices explore instead of using the current winner.</div></div>
                    <div><label>Count a win if paid within</label><div class="range-row"><input type="range" name="range_rewardWindowDays" min="1" max="14" step="1" value="${settings.rewardWindowDays}" data-sync-target="rewardWindowDays" data-suffix=" days"><output data-output-for="rewardWindowDays">${settings.rewardWindowDays} days</output></div><input name="rewardWindowDays" type="number" min="1" max="14" step="1" value="${settings.rewardWindowDays}" required><div class="help">This is correlation evidence, not proof the message caused payment.</div></div>
                  </div>
                </section>
              </div>

              <section class="card span12">
                <div class="step-head"><span class="stepnum">6</span><div><h2>Message styles Remit may test</h2><p>Turn styles on/off and edit their voice. Unsafe wording is rejected before saving and checked again before sending.</p></div></div>
                <details><summary><b>What are placeholders?</b></summary><p class="muted">Words in braces are filled from the invoice. For example, <span class="mono">{debtor}</span> becomes the client name and <span class="mono">{amount}</span> becomes the money owed. Available: <span class="mono">{debtor} {invoice} {amount} {remaining} {dueDay} {worldDay} {daysOverdue} {planCount} {firstDay} {lastDay} {firstPayment}</span>.</p></details>
                ${playbookCards}
              </section>

              <section class="card span12 savebar" id="savebar">
                <div class="section-title" style="margin:0"><div><h2><span class="unsaved-dot"></span> Ready to apply?</h2><p class="help" style="margin:0">Saved controls apply to the next live sweep. A saved copy is kept in the history below. No secrets are stored.</p></div><div class="actions"><button class="primary large" type="submit">Save controls</button><button type="submit" form="reset-settings" class="warnbtn">Reset recommended</button></div></div>
              </section>
            </div>
          </form>
          <form id="reset-settings" method="post" action="/settings/reset" onsubmit="return confirm('Reset all dashboard settings to recommended defaults?')"></form>

          <section class="card">
            <div class="step-head"><span class="stepnum">◆</span><div><h2>Safety vault — always locked</h2><p>These are product and legal-risk rails, not preferences.</p></div></div>
            <div class="guide-grid">
              <div class="guide-card"><div class="big">⊘</div><h3>Opt-out means stop</h3><p class="muted">No dashboard button can resume automated contact after a debtor opts out.</p></div>
              <div class="guide-card"><div class="big">×</div><h3>No threats or discounts</h3><p class="muted">Threat language and settle-for-less offers are blocked in code.</p></div>
              <div class="guide-card"><div class="big">$</div><h3>Exact money only</h3><p class="muted">Plans must total the exact balance. There is no write-off or delete-invoice tool.</p></div>
            </div>
            <details style="margin-top:14px"><summary>View locked banned phrases</summary><p class="mono">${POLICY.banned_phrases.map(esc).join(', ')}</p></details>
          </section>

          <section class="card">
            <div class="section-title"><div><h2>Recent control changes</h2><p>So you can see when behaviour changed.</p></div></div>
            ${historyRows ? `<div class="tablewrap"><table><thead><tr><th>Changed</th><th>By</th><th>Power</th><th>Brain</th><th>Work window</th></tr></thead><tbody>${historyRows}</tbody></table></div>` : '<div class="empty">No saved changes yet. Remit is using safe defaults.</div>'}
          </section>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/learned') {
        const [rows, settings] = await Promise.all([db.allPlaybookStats('live'), loadSettings('live')]);
        const totalContacts = rows.reduce((sum, r) => sum + Number(r.contacts), 0);
        const totalRewards = rows.reduce((sum, r) => sum + Number(r.rewards), 0);
        const overallRate = totalContacts ? Math.round((totalRewards / totalContacts) * 100) : 0;
        const bySegment = new Map<string, Map<string, { contacts: number; rewards: number }>>();
        for (const r of rows) {
          const seg = String(r.segment);
          const map = bySegment.get(seg) ?? new Map<string, { contacts: number; rewards: number }>();
          map.set(String(r.playbook), { contacts: Number(r.contacts), rewards: Number(r.rewards) });
          bySegment.set(seg, map);
        }
        const evidence = (contacts: number) => contacts >= 15 ? '<span class="badge green">Stronger evidence</span>' : contacts >= 5 ? '<span class="badge blue">Learning</span>' : contacts > 0 ? '<span class="badge amber">Early signal</span>' : '<span class="badge">Not tried</span>';
        const cards = [...bySegment.entries()].sort((a, b) => segmentLabel(a[0]).localeCompare(segmentLabel(b[0]))).map(([segment, map]) => {
          const stats = PLAYBOOKS.map((playbook) => ({ playbook, ...(map.get(playbook) ?? { contacts: 0, rewards: 0 }) }));
          const tried = stats.filter((x) => x.contacts > 0).sort((a, b) => (b.rewards / b.contacts) - (a.rewards / a.contacts) || b.contacts - a.contacts);
          const winner = tried.find((x) => x.rewards > 0);
          const triedContacts = tried.reduce((sum, x) => sum + x.contacts, 0);
          const rowsHtml = stats.map((x) => {
            const rate = x.contacts ? Math.round((x.rewards / x.contacts) * 100) : 0;
            const isWinner = winner && winner.playbook === x.playbook && x.contacts > 0;
            return `<div class="playbook-row"><div><b>${isWinner ? '★ ' : ''}${esc(playbookLabel(x.playbook))}</b><br><span class="muted small">${esc(PLAYBOOK_HELP[x.playbook] ?? '')}</span></div><div><div class="meter"><span style="width:${rate}%"></span></div><span class="muted small">${rate}% paid soon after</span></div><div style="text-align:right"><b>${x.rewards}/${x.contacts}</b><br>${evidence(x.contacts)}</div></div>`;
          }).join('');
          return `<article class="learn-card">
            <span class="eyebrow">Debtor type</span><h2 style="margin-top:2px">${esc(segmentLabel(segment))}</h2><p class="muted">${esc(SEGMENT_HELP[segment] ?? '')}</p>
            ${winner ? `<div class="winner"><b>Current winner:</b> ${esc(playbookLabel(winner.playbook))} — ${winner.rewards} paid soon after out of ${winner.contacts} messages.</div>` : tried.length ? `<div class="winner"><b>No winner yet.</b> ${triedContacts} message${triedContacts === 1 ? '' : 's'} tried for this debtor type, and none has been followed by payment inside the reward window yet. Remit will keep testing enabled styles.</div>` : '<div class="winner"><b>Still learning.</b> Remit will try each enabled style before trusting a winner.</div>'}
            ${rowsHtml}
          </article>`;
        }).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit — What works', 'Learned', `
          <span class="eyebrow">Learning from payment behaviour</span>
          <h1>What message style works?</h1>
          <p class="sub">Remit tries lawful styles, watches whether money arrives soon after, then uses the winner more often for that debtor type.</p>
          <div class="grid">
            <section class="card kpi span4"><span class="kpi-icon">✉</span><div class="label">Messages tested</div><div class="value">${totalContacts}</div><div class="note">Real contacts recorded as trials</div></section>
            <section class="card kpi span4"><span class="kpi-icon">✓</span><div class="label">Paid soon after</div><div class="value">${totalRewards}</div><div class="note">Within ${settings.rewardWindowDays} days after the latest message</div></section>
            <section class="card kpi span4"><span class="kpi-icon">↗</span><div class="label">Overall paid-soon rate</div><div class="value">${overallRate}%</div><div class="note">${settings.explorationPct}% exploration keeps testing alternatives</div></section>
          </div>
          <section class="card" style="background:linear-gradient(135deg,#eff8ff,#fff)">
            <h2>How to read “7/10”</h2>
            <p style="max-width:900px">It means Remit sent that style 10 times to this debtor type, and a payment arrived soon after 7 of them. This is useful evidence, not proof the message <i>caused</i> every payment. That is why the number of messages stays beside every percentage.</p>
            <div class="chips"><span class="badge amber">1–4 messages = early signal</span><span class="badge blue">5–14 = learning</span><span class="badge green">15+ = stronger evidence</span></div>
          </section>
          ${cards ? `<div class="learn-grid">${cards}</div>` : '<div class="empty"><div style="font-size:30px">○</div><b>No learning data yet.</b><br>Run a few collection days and this page will start showing winners.</div>'}
          <section class="card" style="margin-top:16px"><h2>Want to change the experiment?</h2><p class="muted">You can disable a style, change exploration, or edit its tone/template in Controls. Already-recorded trials never change.</p><a class="button primary" href="/settings">Open Controls →</a></section>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/runs') {
        const [runs, decisions] = await Promise.all([db.recentRuns(25), db.recentDecisions(60)]);
        const runCards = runs.map((r) => {
          const stats = r.stats && typeof r.stats === 'object' ? r.stats as Record<string, unknown> : {};
          const skipped = typeof stats.skipped === 'string' && stats.skipped.length > 0;
          const finished = Boolean(r.finished_at);
          const icon = !finished ? '…' : skipped ? '»' : r.kind === 'eval' ? '≡' : '▶';
          const title = r.kind === 'eval' ? 'Benchmark exam' : skipped ? 'Scheduled check — skipped' : 'Collection day worked';
          const status = !finished ? '<span class="badge amber">Not finished</span>' : skipped ? '<span class="badge amber">No-op</span>' : '<span class="badge green">Completed</span>';
          return `<article class="run-card">
            <div class="run-icon">${icon}</div>
            <div><div class="chips"><b>Run #${esc(r.id)}</b>${status}<span class="badge">${esc(r.scope)}</span><span class="badge blue">${esc(r.draft_model)}</span></div>
            <h3 style="margin-top:7px">${title}</h3>
            <div class="muted small">Started ${esc(r.started_at)}${r.finished_at ? ` · Finished ${esc(r.finished_at)}` : ''}</div>
            <div class="metric-chips">${runStatChips(r.stats)}</div>
            <details style="margin-top:8px"><summary class="small">Technical raw record</summary><span class="mono">${esc(JSON.stringify(r.stats))}</span></details></div>
            <div><span class="badge dark">World day ${esc(stats.day ?? '—')}</span></div>
          </article>`;
        }).join('');
        const decRows = decisions.map((d) => `<tr><td>World day ${esc(d.world_day)}</td><td><a href="/invoice?id=${encodeURIComponent(String(d.invoice_id))}"><b>${esc(d.invoice_id)}</b></a></td><td>${esc(segmentLabel(String(d.segment)))}</td><td>${esc(playbookLabel(String(d.playbook)))}</td><td><b>${esc(d.outcome)}</b><br><span class="muted">${esc(plainReason(d.why))}</span></td></tr>`).join('');
        const completed = runs.filter((r) => r.finished_at).length;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit — Activity', 'Runs', `
          <span class="eyebrow">Proof of work</span>
          <h1>Activity</h1>
          <p class="sub">Every time GitHub, you, or the benchmark asked Remit to work — including honest no-op checks when it was paused or outside the window.</p>
          <div class="grid">
            <section class="card kpi span4"><span class="kpi-icon">◷</span><div class="label">Recent runs shown</div><div class="value">${runs.length}</div><div class="note">Newest first</div></section>
            <section class="card kpi span4"><span class="kpi-icon">✓</span><div class="label">Finished records</div><div class="value">${completed}</div><div class="note">Completed or recorded as skipped</div></section>
            <section class="card kpi span4"><span class="kpi-icon">☰</span><div class="label">Invoice decisions</div><div class="value">${decisions.length}</div><div class="note">Most recent choices with reasons</div></section>
          </div>
          <section>
            <div class="section-title"><div><h2>Run history</h2><p>A skipped run is not a failure. It means Remit obeyed Pause or your work window.</p></div></div>
            ${runCards || '<div class="empty"><b>No runs yet.</b><br>Press “Run one day now” on Home.</div>'}
          </section>
          <section class="card" style="margin-top:16px">
            <div class="section-title"><div><h2>Invoice decisions</h2><p>The “why” is kept so you can audit Remit later.</p></div></div>
            ${decRows ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Invoice</th><th>Debtor type</th><th>Message style</th><th>Result & why</th></tr></thead><tbody>${decRows}</tbody></table></div>` : '<div class="empty">No decisions yet.</div>'}
          </section>`, url));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/guide') {
        const settings = await loadSettings('live');
        const schedule = scheduleStatus(settings);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Remit — Beginner guide', 'Guide', `
          <section class="hero">
            <span class="eyebrow">Start here · 2-minute guide</span>
            <h1>Remit, in simple words</h1>
            <p class="sub">Imagine the ledger is your bill book. Remit is a careful recovery clerk. It reads unpaid bills, sends only allowed reminders, waits when someone promised a date, and brings dangerous files to the owner — you.</p>
            <div class="chips"><span class="badge ${settings.enabled ? 'green' : 'red'}">${settings.enabled ? '● Remit is ON' : '▌▌ Remit is PAUSED'}</span><span class="badge blue">${esc(schedule.reason)}</span><span class="badge">Brain: ${esc(settings.draftModel)}</span></div>
          </section>

          <section class="card">
            <div class="section-title"><div><h2>Your 5-minute daily routine</h2><p>Use Remit in this order and you will not get lost.</p></div></div>
            <div class="daily">
              <div class="daily-step"><span class="stepnum">1</span><div><b>Start at <a href="/">Home</a>.</b><div class="muted">Look at overdue money, how much was collected, and “Your next 3 moves”.</div></div></div>
              <div class="daily-step"><span class="stepnum">2</span><div><b>Clear <a href="/queue">Needs you</a>.</b><div class="muted">These are disputes, opt-outs, serious risks, and plans Remit must not handle alone.</div></div></div>
              <div class="daily-step"><span class="stepnum">3</span><div><b>Open <a href="/clients?filter=overdue">overdue invoices</a>.</b><div class="muted">Each row says “What happens next?” in plain English: ready, waiting, paused, or needs you.</div></div></div>
              <div class="daily-step"><span class="stepnum">4</span><div><b>Record real-world news.</b><div class="muted">If money arrived or the debtor promised a date, open the invoice and record it. Remit cannot know unless the ledger is told.</div></div></div>
              <div class="daily-step"><span class="stepnum">5</span><div><b>Check work and learning weekly.</b><div class="muted"><a href="/runs">Activity</a> proves what ran. <a href="/learned">What works</a> shows which message style is winning.</div></div></div>
            </div>
          </section>

          <section>
            <div class="section-title"><div><h2>What each button in the left menu means</h2><p>Tap one to try it.</p></div></div>
            <div class="guide-grid">
              <a class="guide-card" href="/"><div class="big">⌂</div><h3>Home</h3><p class="muted">Money totals, next moves, latest work, Run one day, Pause.</p></a>
              <a class="guide-card" href="/clients"><div class="big">▦</div><h3>Clients & invoices</h3><p class="muted">Your bill book. Add invoices and open individual cases.</p></a>
              <a class="guide-card" href="/queue"><div class="big">⚠</div><h3>Needs you</h3><p class="muted">The owner’s pile. Remit stopped and needs your judgement.</p></a>
              <a class="guide-card" href="/learned"><div class="big">↗</div><h3>What works</h3><p class="muted">Which message style is followed by payment, by debtor type.</p></a>
              <a class="guide-card" href="/runs"><div class="big">◷</div><h3>Activity</h3><p class="muted">Proof of work: runs, skips, model, cost, and decisions.</p></a>
              <a class="guide-card" href="/settings"><div class="big">⚙</div><h3>Controls</h3><p class="muted">When Remit works, how patiently, plan rules, styles, brain, and budget.</p></a>
            </div>
          </section>

          <section class="card" style="margin-top:16px">
            <h2>Simple word meanings</h2>
            <div class="glossary">
              <div><b>Sweep / Run one day</b><p class="muted">One working round. In this simulator, one executed sweep also moves the world clock one day.</p></div>
              <div><b>World day</b><p class="muted">The simulator’s calendar number. Due dates, promises, and message gaps use world days, not real dates.</p></div>
              <div><b>Debtor type</b><p class="muted">A behaviour group Remit inferred from visible history: pays late, usually pays, not replying, and so on.</p></div>
              <div><b>Message style / playbook</b><p class="muted">One lawful way of asking: gentle reminder, formal reminder, or friendly message with a plan.</p></div>
              <div><b>Safety gate</b><p class="muted">Computer rules checked after writing. Threats, discounts, too-frequent messages, and wrong plan totals cannot pass.</p></div>
              <div><b>Paid soon after</b><p class="muted">A learning clue: money arrived inside the reward window after a message. Useful evidence, not absolute proof of cause.</p></div>
            </div>
          </section>

          <section class="card">
            <h2>Schedule example</h2>
            <p>GitHub wakes Remit every hour. Your Controls window decides whether that wake-up becomes work or a recorded skip.</p>
            <div class="tablewrap"><table style="min-width:620px"><thead><tr><th>You choose</th><th>What happens</th></tr></thead><tbody>
              <tr><td>Mon–Fri, 09:00–09:59</td><td>Usually one executed sweep per weekday = one simulated day per weekday.</td></tr>
              <tr><td>Mon–Fri, 09:00–17:00</td><td>Several hourly wake-ups may execute = several simulated days in one real day.</td></tr>
              <tr><td>Agent paused</td><td>Wake-ups are recorded, but no work happens and world time does not move.</td></tr>
              <tr><td>Run one day now</td><td>Works immediately even outside the clock window, but never while paused.</td></tr>
            </tbody></table></div>
          </section>

          <section class="card">
            <h2>“Why didn’t Remit send?”</h2>
            <p>Open the invoice and read <b>What should happen next?</b> The usual safe reasons are:</p>
            <ul>
              <li>the debtor promised a future date;</li>
              <li>the minimum gap since the last message has not finished;</li>
              <li>the invoice reached its message limit;</li>
              <li>it is disputed, escalated, paused, or opted out;</li>
              <li>it is not inside your reminder window yet;</li>
              <li>the agent is paused or outside your work hours;</li>
              <li>the chosen AI provider has no key or returned unusable text.</li>
            </ul>
            <p class="muted">No message is better than an unsafe message. Blocked work is recorded in Activity or sent to Needs you.</p>
          </section>

          <section class="card">
            <h2>Recommended beginner controls</h2>
            <p>Asia/Karachi · Monday–Friday · 09:00–09:59 · Free rules brain · $1 budget · start 2 days before due · wait 3 days · maximum 6 messages · plans up to 3 payments in 45 days · your approval above $5,000.</p>
            <a class="button primary" href="/settings">Open Controls →</a>
          </section>`, url));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/act') {
        const form = await readForm(req);
        const returnTo = form.get('returnTo') || '/queue';
        try {
          const qid = Number(form.get('qid'));
          const action = String(form.get('action') ?? '');
          if (!Number.isInteger(qid) || qid <= 0) throw new Error('Invalid queue item');
          const queue = await db.openQueue('live');
          const item = queue.find((q) => Number(q.id) === qid);
          if (!item) throw new Error('Queue item is no longer open');
          if (!allowedQueueActions(String(item.kind), item.detail).includes(action as QueueAction)) {
            throw new Error(`Action '${action}' is not allowed for a ${String(item.kind)} item`);
          }
          const invoiceId = String(item.invoice_id);
          const [inv, events, settings, suppressions] = await Promise.all([
            ledger.invoice(invoiceId), ledger.invoiceEvents(invoiceId), loadSettings('live'), db.suppressionDetails('live'),
          ]);
          if (!inv) throw new Error(`Invoice ${invoiceId} not found`);
          const optOutPresent = queue.some((q) => String(q.invoice_id) === invoiceId && String(q.kind) === 'optout')
            || suppressions.get(invoiceId) === 'debtor asked us to stop'
            || events.some((e) => e.kind === 'reply' && replySignal(e.detail) === 'optout');

          if (action === 'resolve_dispute') {
            await ledger.resolveDispute(invoiceId);
            if (!optOutPresent) await db.unsuppress('live', invoiceId);
          } else if (action === 'resume') {
            if (optOutPresent) throw new Error('Contact cannot be resumed: this debtor opted out');
            if (inv.status === 'escalated') await ledger.reopen(invoiceId);
            else if (inv.status === 'disputed') throw new Error('Resolve the dispute before resuming contact');
            await db.unsuppress('live', invoiceId);
          } else if (action === 'approve_plan') {
            if (inv.status !== 'open') throw new Error(`Plan cannot be sent: invoice is ${inv.status}, not open`);
            if (optOutPresent) throw new Error('Plan cannot be sent: this debtor opted out');
            if (suppressions.has(invoiceId)) throw new Error('Plan cannot be sent while contact is paused');
            const detail = (item.detail ?? {}) as { draft?: unknown };
            const draft = checkDraft(detail.draft);
            if (!draft || draft.action !== 'offer_plan' || !draft.instalments?.length) throw new Error('Stored plan draft is missing or invalid');
            const playbookRaw = String((item.detail as { playbook?: unknown } | undefined)?.playbook ?? '');
            if (!PLAYBOOKS.includes(playbookRaw as Playbook)) throw new Error('Stored plan is missing its playbook');
            const playbook = playbookRaw as Playbook;
            if (!settings.enabledPlaybooks.includes(playbook)) throw new Error(`Playbook ${playbook} is disabled. Keep paused or enable it in Settings first`);
            const stats = await ledger.stats();
            const verdict = gate(draft, inv, events, stats.worldDay, { ...policyFromSettings(settings), plan_human_above_cents: Number.MAX_SAFE_INTEGER });
            if (!verdict.ok) throw new Error(`Stored plan no longer passes policy: ${verdict.reason}`);
            const all = await ledger.allInvoices(1000);
            const segment = segmentOf(all.filter((i) => i.debtorId === inv.debtorId), events, stats.worldDay);
            await ledger.createPlan(invoiceId, draft.instalments);
            await ledger.logContact(invoiceId, playbook, settings.tones[playbook], draft.message);
            await recordContactTrial(ledger, 'live', inv.id, stats.worldDay, segment, playbook);
            await db.recordDecision({ scope: 'live', invoiceId, worldDay: stats.worldDay, segment, playbook, action: draft.action, outcome: 'human-approved-plan', why: 'Human approved the stored plan after fresh policy checks.' });
          }
          await db.resolveQueue(qid, action);
          redirect(res, returnTo, `${invoiceId}: ${QUEUE_ACTION_LABELS[action as QueueAction]}`);
        } catch (e) {
          redirect(res, returnTo, undefined, e instanceof Error ? e.message : String(e));
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/control') {
        const form = await readForm(req);
        const action = form.get('action');
        try {
          if (action === 'pause' || action === 'resume') {
            const settings = await loadSettings('live');
            await saveSettings('live', { ...settings, enabled: action === 'resume' }, 'dashboard');
            redirect(res, '/', action === 'pause' ? 'Agent paused. Scheduled sweeps will now be no-ops.' : 'Agent resumed.');
            return;
          }
          if (action === 'run_now') {
            const settings = await loadSettings('live');
            if (!settings.enabled) throw new Error('Agent is paused. Resume it before running.');
            const result = await sweep({ ledgerUrl, forceSchedule: true, source: 'dashboard' });
            if (result.busy) redirect(res, '/', 'Another sweep is already running. Nothing was started.');
            else if (result.skipped) redirect(res, '/', `Sweep skipped: ${result.skipped}`);
            else redirect(res, '/', `Sweep complete: ${result.contacted} contacts, ${result.plansOffered} plans, ${result.queued} queued, ${result.waited} waiting, cost $${result.costUsd.toFixed(4)}. World day is now ${result.worldDayAfter}.`);
            return;
          }
          throw new Error('Unknown control action');
        } catch (e) { redirect(res, '/', undefined, e instanceof Error ? e.message : String(e)); return; }
      }

      if (req.method === 'POST' && url.pathname === '/settings/save') {
        const form = await readForm(req);
        try {
          const tones = Object.fromEntries(PLAYBOOKS.map((p) => [p, form.get(`tone_${p}`) ?? '']));
          const templates = Object.fromEntries(PLAYBOOKS.map((p) => [p, form.get(`template_${p}`) ?? '']));
          const humanDollars = Number(String(form.get('planHumanAboveDollars') ?? '').replace(/[$,\s]/g, ''));
          await saveSettings('live', {
            enabled: form.has('enabled'),
            draftModel: form.get('draftModel'),
            budgetUsd: form.get('budgetUsd'),
            timezone: form.get('timezone'),
            sendDays: form.getAll('sendDays'),
            sendStart: form.get('sendStart'),
            sendEnd: form.get('sendEnd'),
            preDueReminderDays: form.get('preDueReminderDays'),
            minGapDays: form.get('minGapDays'),
            maxContactsPerInvoice: form.get('maxContactsPerInvoice'),
            maxOverdueDays: form.get('maxOverdueDays'),
            planMaxInstalments: form.get('planMaxInstalments'),
            planMaxDays: form.get('planMaxDays'),
            planMinFirstPct: form.get('planMinFirstPct'),
            planHumanAboveCents: Math.round(humanDollars * 100),
            explorationPct: form.get('explorationPct'),
            rewardWindowDays: form.get('rewardWindowDays'),
            enabledPlaybooks: form.getAll('enabledPlaybooks'),
            tones,
            templates,
          }, 'dashboard');
          redirect(res, '/settings', 'Settings saved. They apply to the next live sweep.');
        } catch (e) { redirect(res, '/settings', undefined, e instanceof Error ? e.message : String(e)); }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/settings/reset') {
        await readForm(req);
        try {
          await saveSettings('live', defaultSettings(), 'dashboard reset');
          redirect(res, '/settings', 'Settings reset to recommended defaults.');
        } catch (e) { redirect(res, '/settings', undefined, e instanceof Error ? e.message : String(e)); }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/clients/add-invoice') {
        const form = await readForm(req);
        const debtorId = form.get('debtorId')?.trim() || undefined;
        try {
          const stats = await ledger.stats();
          const dueInDays = Number(form.get('dueInDays'));
          if (!Number.isInteger(dueInDays) || dueInDays < -365 || dueInDays > 3650) throw new Error('Due-in-days must be a whole number from -365 to 3650');
          const invoiceId = await ledger.createInvoice({
            debtorId,
            debtorName: form.get('debtorName')?.trim() || undefined,
            debtorEmail: form.get('debtorEmail')?.trim() || undefined,
            amountCents: parseDollarsToCents(form.get('amount')),
            dueDay: stats.worldDay + dueInDays,
          });
          redirect(res, `/invoice?id=${encodeURIComponent(invoiceId)}`, `Invoice ${invoiceId} added.`);
        } catch (e) { redirect(res, debtorId ? `/client?id=${encodeURIComponent(debtorId)}` : '/clients', undefined, e instanceof Error ? e.message : String(e)); }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/clients/update') {
        const form = await readForm(req);
        const returnTo = form.get('returnTo') || '/clients';
        try {
          const debtorId = form.get('debtorId')?.trim();
          if (!debtorId) throw new Error('Missing client ID');
          await ledger.updateDebtor(debtorId, form.get('name')?.trim() ?? '', form.get('email')?.trim() ?? '');
          redirect(res, returnTo, 'Client saved.');
        } catch (e) { redirect(res, returnTo, undefined, e instanceof Error ? e.message : String(e)); }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/invoice/action') {
        const form = await readForm(req);
        const invoiceId = form.get('invoiceId')?.trim() ?? '';
        const back = invoiceId ? `/invoice?id=${encodeURIComponent(invoiceId)}` : '/clients';
        try {
          if (!invoiceId) throw new Error('Missing invoice ID');
          const action = form.get('action');
          const [inv, events, stats, settings, suppressions, queue] = await Promise.all([
            ledger.invoice(invoiceId), ledger.invoiceEvents(invoiceId), ledger.stats(), loadSettings('live'), db.suppressionDetails('live'), db.openQueue('live'),
          ]);
          if (!inv) throw new Error(`Invoice ${invoiceId} not found`);
          const policy = policyFromSettings(settings);
          const suppressionReason = suppressions.get(invoiceId) ?? null;
          const optOutPresent = queue.some((q) => String(q.invoice_id) === invoiceId && String(q.kind) === 'optout')
            || suppressionReason === 'debtor asked us to stop'
            || events.some((e) => e.kind === 'reply' && replySignal(e.detail) === 'optout');
          const segmentFor = async () => {
            const all = await ledger.allInvoices(1000);
            return segmentOf(all.filter((i) => i.debtorId === inv.debtorId), events, stats.worldDay);
          };
          const requireContactAllowed = () => {
            if (inv.status !== 'open') throw new Error(`Invoice is ${inv.status}, not open`);
            if (remainingCents(inv) <= 0) throw new Error('Invoice has no remaining balance');
            if (optOutPresent) throw new Error('Contact is locked: this debtor opted out');
            if (suppressionReason) throw new Error(`Contact is paused: ${suppressionReason}`);
          };
          const validPlaybook = (): Playbook => {
            const p = form.get('playbook');
            if (!p || !PLAYBOOKS.includes(p as Playbook)) throw new Error('Choose a valid playbook');
            if (!settings.enabledPlaybooks.includes(p as Playbook)) throw new Error(`Playbook ${p} is disabled in Settings`);
            return p as Playbook;
          };

          let message = 'Done.';
          if (action === 'pause') {
            await db.suppress('live', invoiceId, 'Paused from dashboard');
            message = 'Contact paused for this invoice.';
          } else if (action === 'resume') {
            if (optOutPresent) throw new Error('Cannot resume: this debtor opted out');
            if (inv.status === 'disputed') throw new Error('Resolve the dispute before resuming contact');
            if (inv.status === 'escalated') await ledger.reopen(invoiceId);
            await db.unsuppress('live', invoiceId);
            message = 'Contact resumed.';
          } else if (action === 'escalate') {
            if (inv.status === 'open') await ledger.escalate(invoiceId, form.get('reason')?.trim() || 'Escalated from invoice dashboard.');
            await db.suppress('live', invoiceId, 'Escalated from dashboard');
            await db.enqueue('live', invoiceId, 'escalated', 'Operator escalated this invoice from the dashboard.', {});
            message = 'Invoice escalated to a person.';
          } else if (action === 'reopen') {
            if (optOutPresent) throw new Error('Cannot return an opted-out debtor to automated contact');
            await ledger.reopen(invoiceId);
            await db.unsuppress('live', invoiceId);
            message = 'Invoice returned to the agent.';
          } else if (action === 'resolve_dispute') {
            await ledger.resolveDispute(invoiceId);
            if (!optOutPresent) await db.unsuppress('live', invoiceId);
            message = 'Dispute marked resolved.';
          } else if (action === 'record_payment') {
            await ledger.recordPayment(invoiceId, parseDollarsToCents(form.get('paymentAmount')), form.get('paymentNote')?.trim() ?? '');
            message = 'Payment recorded.';
          } else if (action === 'record_promise') {
            if (inv.status === 'paid') throw new Error('Invoice is already paid');
            if (inv.status === 'disputed') throw new Error('Resolve the dispute before recording a payment promise');
            const inDays = Number(form.get('promiseInDays'));
            if (!Number.isInteger(inDays) || inDays < 0 || inDays > 90) throw new Error('Promise must be 0–90 days from today');
            await ledger.recordPromise(invoiceId, stats.worldDay + inDays);
            message = `Promise recorded for world day ${stats.worldDay + inDays}.`;
          } else if (action === 'send_message') {
            requireContactAllowed();
            const playbook = validPlaybook();
            const draft = checkDraft({ action: 'contact', message: form.get('message') ?? '', why: 'Manual dashboard reminder.' });
            if (!draft) throw new Error('Message failed the draft check (empty/overlong, discount-like wording, or malformed)');
            const verdict = gate(draft, inv, events, stats.worldDay, policy);
            if (!verdict.ok) throw new Error(`Blocked by policy: ${verdict.reason}`);
            const segment = await segmentFor();
            await ledger.logContact(invoiceId, playbook, settings.tones[playbook], draft.message);
            await recordContactTrial(ledger, 'live', inv.id, stats.worldDay, segment, playbook);
            await db.recordDecision({ scope: 'live', invoiceId, worldDay: stats.worldDay, segment, playbook, action: draft.action, outcome: 'manual-contact', why: 'Operator sent this reminder from the dashboard.' });
            message = 'Reminder sent through the policy gate.';
          } else if (action === 'create_plan') {
            requireContactAllowed();
            const playbook = validPlaybook();
            const count = Number(form.get('planCount'));
            const firstIn = Number(form.get('planFirstInDays'));
            const every = Number(form.get('planEveryDays'));
            if (!Number.isInteger(count) || count < 1 || count > settings.planMaxInstalments) throw new Error(`Instalments must be 1–${settings.planMaxInstalments}`);
            if (!Number.isInteger(firstIn) || firstIn < 1) throw new Error('First payment must be at least 1 day ahead');
            if (!Number.isInteger(every) || every < 0) throw new Error('Instalment spacing cannot be negative');
            const remaining = remainingCents(inv);
            const base = Math.floor(remaining / count);
            const remainder = remaining - base * count;
            const instalments = Array.from({ length: count }, (_, i) => ({
              day: stats.worldDay + firstIn + i * every,
              amountCents: base + (i < remainder ? 1 : 0),
            }));
            const draft = checkDraft({ action: 'offer_plan', message: form.get('message') ?? '', instalments, why: 'Manual dashboard payment plan.' });
            if (!draft) throw new Error('Plan draft failed validation');
            const verdict = gate(draft, inv, events, stats.worldDay, { ...policy, plan_human_above_cents: Number.MAX_SAFE_INTEGER });
            if (!verdict.ok) throw new Error(`Blocked by policy: ${verdict.reason}`);
            const segment = await segmentFor();
            await ledger.createPlan(invoiceId, instalments);
            await ledger.logContact(invoiceId, playbook, settings.tones[playbook], draft.message);
            await recordContactTrial(ledger, 'live', inv.id, stats.worldDay, segment, playbook);
            await db.recordDecision({ scope: 'live', invoiceId, worldDay: stats.worldDay, segment, playbook, action: draft.action, outcome: 'manual-plan', why: 'Operator created this plan from the dashboard.' });
            message = 'Payment plan created and sent through the policy gate.';
          } else {
            throw new Error('Unknown invoice action');
          }
          redirect(res, back, message);
        } catch (e) { redirect(res, back, undefined, e instanceof Error ? e.message : String(e)); }
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  console.log(`remit control room on :${port} (ledger ${ledgerUrl})`);
}
