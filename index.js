require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const twilio     = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app    = express();
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Supabase helpers ──────────────────────────────────────────
async function sbGet(key) {
  const { data } = await sb.from('crm_data').select('value').eq('key', key).single();
  if (!data) return null;
  try { return JSON.parse(data.value); } catch { return data.value; }
}
async function sbSet(key, value) {
  await sb.from('crm_data').upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() });
}

// ── Bot team management (stored in Supabase) ──────────────────
// Structure: { phone: { name, role, repId, addedBy, addedOn } }
async function getBotTeam() {
  const team = await sbGet('bot_team');
  return team || {};
}
async function saveBotTeam(team) {
  await sbSet('bot_team', team);
}

// ── Helpers ───────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); }
  catch { return d; }
}
function uid() { return Math.random().toString(36).slice(2,10).toUpperCase(); }
function inr(n) { if (!n) return '₹0'; return '₹' + Number(n).toLocaleString('en-IN'); }
function cleanPhone(p) { return (p||'').replace(/^\+/,'').replace(/\s/g,'').trim(); }
function isAdmin(phone) { return cleanPhone(phone) === cleanPhone(process.env.OWNER_PHONE||''); }

// ── Session state ─────────────────────────────────────────────
const sessions = {};
function getSession(from) {
  if (!sessions[from]) sessions[from] = { step:null, data:{} };
  return sessions[from];
}
function clearSession(from) { sessions[from] = { step:null, data:{} }; }

// ── Send WhatsApp message ─────────────────────────────────────
async function send(to, body) {
  await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
    to:   `whatsapp:${to}`,
    body
  });
}

// ── Menus ─────────────────────────────────────────────────────
function adminMenu() {
  return `🏥 *Ind Reveal CRM Bot*
━━━━━━━━━━━━━━━━━━━
👑 Admin Menu

*CRM Actions:*
1️⃣  Log a Visit
2️⃣  My Pipeline
3️⃣  Follow-ups Due Today
4️⃣  Add a Doctor
5️⃣  Warranty Status

*Team Management:*
6️⃣  Add Team Member
7️⃣  Remove Team Member
8️⃣  View Team List
9️⃣  View Full Team Pipeline

Type *menu* anytime to return.`;
}

function repMenu(name) {
  return `🏥 *Ind Reveal CRM Bot*
━━━━━━━━━━━━━━━━━━━
👋 Hi ${name}!

1️⃣  Log a Visit
2️⃣  My Pipeline
3️⃣  Follow-ups Due Today
4️⃣  Add a Doctor
5️⃣  Warranty Status

Type *menu* anytime to return.`;
}

// ── Webhook ───────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const from  = req.body.From?.replace('whatsapp:','');
  const body  = (req.body.Body||'').trim();
  const lower = body.toLowerCase();

  if (!from) return;

  const phone    = cleanPhone(from);
  const ownerPhone = cleanPhone(process.env.OWNER_PHONE||'');
  const botTeam  = await getBotTeam();
  const member   = botTeam[phone];
  const isOwner  = phone === ownerPhone;

  // ── Not authorised ──
  if (!isOwner && !member) {
    await send(from, `⛔ *Not Authorised*\n\nYou are not registered on the Ind Reveal CRM bot.\n\nAsk your admin to add you with:\n_add team +${phone} YourName_`);
    return;
  }

  const sess     = getSession(from);
  const userName = isOwner ? 'Admin' : member.name;
  const userRole = isOwner ? 'admin' : member.role;

  // ── Global commands ──
  if (['menu','hi','hello','start','0'].includes(lower)) {
    clearSession(from);
    await send(from, isOwner ? adminMenu() : repMenu(userName));
    return;
  }
  if (lower === 'cancel') {
    clearSession(from);
    await send(from, `❌ Cancelled.\n\n` + (isOwner ? adminMenu() : repMenu(userName)));
    return;
  }

  // ── Active session step ──
  if (sess.step) {
    await handleStep(from, body, sess, { isOwner, userRole, userName, phone, botTeam });
    return;
  }

  // ── Menu routing ──
  switch (body.trim()) {
    case '1': await startLogVisit(from, sess, { userName, phone }); break;
    case '2': await showPipeline(from, { isOwner, userRole, member, phone }); break;
    case '3': await showFollowups(from, { isOwner, userRole, member, phone }); break;
    case '4': await startAddDoctor(from, sess); break;
    case '5': await startWarrantyCheck(from, sess); break;
    // Admin only
    case '6':
      if (!isOwner) { await send(from, '⛔ Admin only.'); return; }
      await startAddMember(from, sess); break;
    case '7':
      if (!isOwner) { await send(from, '⛔ Admin only.'); return; }
      await startRemoveMember(from, sess, botTeam); break;
    case '8':
      if (!isOwner) { await send(from, '⛔ Admin only.'); return; }
      await showTeamList(from, botTeam); break;
    case '9':
      if (!isOwner) { await send(from, '⛔ Admin only.'); return; }
      await showFullTeamPipeline(from); break;
    default:
      await send(from, `❓ I didn't understand that.\n\n` + (isOwner ? adminMenu() : repMenu(userName)));
  }
});

// ═══════════════════════════════════════════════════════════
// STEP HANDLER
// ═══════════════════════════════════════════════════════════
async function handleStep(from, body, sess, ctx) {
  const lower = body.toLowerCase().trim();
  const { isOwner, userRole, userName, phone, botTeam } = ctx;

  switch (sess.step) {

    // ── ADD MEMBER ────────────────────────────────────────
    case 'add_member_phone': {
      // Accept: +919876543210 or 919876543210
      const newPhone = cleanPhone(body);
      if (newPhone.length < 10) {
        await send(from, `❌ Invalid number. Enter with country code.\nExample: +919876543210\n\nTry again or type *cancel*:`);
        return;
      }
      if (newPhone === cleanPhone(process.env.OWNER_PHONE)) {
        await send(from, `❌ That's your own number. Try again:`);
        return;
      }
      sess.data.newPhone = newPhone;
      sess.step = 'add_member_name';
      await send(from, `📱 Number: *+${newPhone}*\n\nWhat is their name?`);
      break;
    }
    case 'add_member_name': {
      sess.data.newName = body;
      sess.step = 'add_member_role';
      await send(from,
        `👤 Name: *${body}*\n\nWhat is their role?\n\n1. Sales Rep\n2. Manager`);
      break;
    }
    case 'add_member_role': {
      const roleMap = { '1':'rep', '2':'manager' };
      const role    = roleMap[body.trim()] || 'rep';

      // Find matching rep in CRM team
      const crmTeam = await sbGet('team') || [];
      const matched = crmTeam.find(t =>
        t.name.toLowerCase().includes(sess.data.newName.toLowerCase()) ||
        sess.data.newName.toLowerCase().includes(t.name.toLowerCase())
      );

      const newMember = {
        name:    sess.data.newName,
        role:    role,
        repId:   matched ? matched.id : null,
        addedBy: phone,
        addedOn: today()
      };

      const team = await getBotTeam();
      team[sess.data.newPhone] = newMember;
      await saveBotTeam(team);

      clearSession(from);
      await send(from,
        `✅ *Team Member Added!*\n━━━━━━━━━━━━━━\n👤 Name: ${newMember.name}\n📱 Phone: +${sess.data.newPhone}\n🎭 Role: ${role}\n${matched ? '🔗 Linked to CRM: '+matched.name : '⚠️ No CRM match — visits will still be logged'}\n\nThey can now send *hi* to this bot number to get started.\n\n` + adminMenu());
      break;
    }

    // ── REMOVE MEMBER ─────────────────────────────────────
    case 'remove_member_pick': {
      const members = Object.entries(botTeam);
      const num = parseInt(body);
      if (isNaN(num) || num < 1 || num > members.length) {
        await send(from, `❌ Invalid. Reply 1–${members.length}:`);
        return;
      }
      const [removePhone, removeMember] = members[num-1];
      delete botTeam[removePhone];
      await saveBotTeam(botTeam);
      clearSession(from);
      await send(from, `✅ *${removeMember.name}* (+${removePhone}) removed from bot.\n\n` + adminMenu());
      break;
    }

    // ── LOG VISIT steps ───────────────────────────────────
    case 'visit_doctor': {
      const docs = sess.data.docs || [];
      let doc = null;
      const num = parseInt(body);
      if (!isNaN(num) && num >= 1 && num <= docs.length) {
        doc = docs[num-1];
      } else {
        const q = lower;
        const matches = docs.filter(d => (d.name||'').toLowerCase().includes(q));
        if (matches.length === 1) {
          doc = matches[0];
        } else if (matches.length > 1) {
          sess.data.filteredDocs = matches;
          sess.step = 'visit_doctor_pick';
          const list = matches.slice(0,10).map((d,i) => `${i+1}. ${d.name} (${d.city||'—'})`).join('\n');
          await send(from, `Found ${matches.length}:\n\n${list}\n\nReply with number:`);
          return;
        } else {
          await send(from, `❌ No doctor found matching "${body}".\n\nTry a different name or type *cancel*:`);
          return;
        }
      }
      sess.data.visitDoc = doc;
      sess.step = 'visit_stage';
      await send(from, `✅ *${doc.name}*\n\nStage after this visit?\n\n1. Lead\n2. Contacted\n3. Trial Running\n4. Proposal Sent\n5. Negotiation\n6. Won\n7. Lost`);
      break;
    }
    case 'visit_doctor_pick': {
      const matches = sess.data.filteredDocs || [];
      const num = parseInt(body);
      if (isNaN(num) || num < 1 || num > matches.length) {
        await send(from, `❌ Reply 1–${matches.length}:`); return;
      }
      sess.data.visitDoc = matches[num-1];
      sess.step = 'visit_stage';
      await send(from, `✅ *${sess.data.visitDoc.name}*\n\nStage?\n1. Lead\n2. Contacted\n3. Trial Running\n4. Proposal Sent\n5. Negotiation\n6. Won\n7. Lost`);
      break;
    }
    case 'visit_stage': {
      const sm = {'1':'Lead','2':'Contacted','3':'Trial Running','4':'Proposal Sent','5':'Negotiation','6':'Won','7':'Lost'};
      sess.data.visitStage = sm[body.trim()] || body;
      sess.step = 'visit_summary';
      await send(from, `📝 Stage: *${sess.data.visitStage}*\n\nType your visit summary:`);
      break;
    }
    case 'visit_summary': {
      sess.data.visitSummary = body;
      sess.step = 'visit_followup';
      await send(from, `📅 Follow-up date? (DD-MM-YYYY)\nOr type *skip*:`);
      break;
    }
    case 'visit_followup': {
      let followup = null;
      if (lower !== 'skip') {
        const p = body.split('-');
        if (p.length === 3) followup = `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
      }
      const visits = await sbGet('visits') || [];
      const docs   = await sbGet('doctors') || [];
      const doc    = sess.data.visitDoc;

      // Find repId from CRM team
      const crmTeam  = await sbGet('team') || [];
      const botMember= (await getBotTeam())[cleanPhone(from)];
      const repId    = botMember?.repId || 'whatsapp_' + cleanPhone(from);

      visits.push({
        id:      'V'+uid(), doctor: doc.id, rep: repId,
        date:    today(), type: 'WhatsApp',
        stage:   sess.data.visitStage, summary: sess.data.visitSummary,
        followup, created: today()
      });
      const di = docs.findIndex(d => d.id === doc.id);
      if (di > -1) docs[di].stage = sess.data.visitStage;
      await sbSet('visits', visits);
      await sbSet('doctors', docs);

      let msg = `✅ *Visit Logged!*\n━━━━━━━━━━━━━━\n👨‍⚕️ ${doc.name}\n📊 ${sess.data.visitStage}\n📝 ${sess.data.visitSummary}`;
      if (followup) msg += `\n📅 Follow-up: ${fmtDate(followup)}`;
      clearSession(from);
      await send(from, msg + '\n\n' + (ctx.isOwner ? adminMenu() : repMenu(userName)));
      break;
    }

    // ── ADD DOCTOR steps ──────────────────────────────────
    case 'add_doctor_name': {
      sess.data.docName = body;
      sess.step = 'add_doctor_clinic';
      await send(from, `🏥 Clinic/Hospital name? (*skip* to skip):`);
      break;
    }
    case 'add_doctor_clinic': {
      sess.data.docClinic = lower === 'skip' ? '' : body;
      sess.step = 'add_doctor_city';
      await send(from, `📍 City?`);
      break;
    }
    case 'add_doctor_city': {
      sess.data.docCity = body;
      sess.step = 'add_doctor_mobile';
      await send(from, `📱 Mobile? (*skip* to skip):`);
      break;
    }
    case 'add_doctor_mobile': {
      sess.data.docMobile = lower === 'skip' ? '' : body;
      sess.step = 'add_doctor_device';
      const ms = await sbGet('masters') || {};
      const devs = (ms.devices||[]).join(', ') || 'VEGA COMFORT, ORION, QLARA';
      await send(from, `💊 Device interest?\n${devs}\n\n(Type name or *skip*):`);
      break;
    }
    case 'add_doctor_device': {
      sess.data.docDevice = lower === 'skip' ? '' : body;
      const botMember = (await getBotTeam())[cleanPhone(from)];
      const crmTeam   = await sbGet('team') || [];
      const repId     = botMember?.repId || null;

      const docs = await sbGet('doctors') || [];
      const newDoc = {
        id: 'DC'+uid(), name: sess.data.docName, clinic: sess.data.docClinic,
        city: sess.data.docCity, mobile: sess.data.docMobile, device: sess.data.docDevice,
        stage: 'Unapproached', source: 'WhatsApp Bot', rep: repId, created: today()
      };
      docs.push(newDoc);
      await sbSet('doctors', docs);

      clearSession(from);
      await send(from,
        `✅ *Doctor Added!*\n━━━━━━━━━━━━━━\n👨‍⚕️ ${newDoc.name}\n🏥 ${newDoc.clinic||'—'}\n📍 ${newDoc.city}\n📱 ${newDoc.mobile||'—'}\n💊 ${newDoc.device||'—'}\n\n` +
        (ctx.isOwner ? adminMenu() : repMenu(userName)));
      break;
    }

    // ── WARRANTY CHECK ────────────────────────────────────
    case 'warranty_search': {
      const inst = await sbGet('installations') || [];
      const q    = lower;
      const hits = inst.filter(i => (i.docName||'').toLowerCase().includes(q));
      if (!hits.length) {
        await send(from, `❌ No installations found for "${body}".\nTry again or *cancel*:`);
        return;
      }
      const t = today();
      const sn = new Date(); sn.setDate(sn.getDate()+30); const snStr = sn.toISOString().slice(0,10);
      let msg = `🔍 *Results for "${body}"*\n━━━━━━━━━━━━━━━━━━━\n`;
      hits.slice(0,8).forEach(i => {
        const isExp  = i.warrantyExpiry < t;
        const isExpg = !isExp && i.warrantyExpiry <= snStr;
        const icon   = isExp?'❌':isExpg?'⚠️':'✅';
        const status = isExp?'EXPIRED':isExpg?'EXPIRING SOON':'Active';
        msg += `\n${icon} *${i.docName}*\n   ${i.device} | SN: ${i.deviceSerial||'—'}\n   Expiry: ${fmtDate(i.warrantyExpiry)} (${status})\n`;
      });
      if (hits.length > 8) msg += `\n_...+${hits.length-8} more_`;
      clearSession(from);
      await send(from, msg + '\n\n' + (ctx.isOwner ? adminMenu() : repMenu(userName)));
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// TEAM MANAGEMENT FUNCTIONS
// ═══════════════════════════════════════════════════════════
async function startAddMember(from, sess) {
  sess.step = 'add_member_phone';
  sess.data = {};
  await send(from,
    `➕ *Add Team Member*\n━━━━━━━━━━━━━━\n\nEnter their WhatsApp number with country code:\n\nExample: *+919876543210*\n\n_Type *cancel* to go back_`);
}

async function startRemoveMember(from, sess, botTeam) {
  const members = Object.entries(botTeam);
  if (!members.length) {
    await send(from, `ℹ️ No team members added yet.\n\n` + adminMenu());
    return;
  }
  sess.step = 'remove_member_pick';
  const list = members.map(([p, m], i) => `${i+1}. ${m.name} (+${p}) — ${m.role}`).join('\n');
  await send(from, `🗑 *Remove Team Member*\n━━━━━━━━━━━━━━\n\n${list}\n\nReply with number to remove:\n_Type *cancel* to go back_`);
}

async function showTeamList(from, botTeam) {
  const members = Object.entries(botTeam);
  if (!members.length) {
    await send(from, `ℹ️ No team members yet.\nUse option 6 to add members.\n\n` + adminMenu());
    return;
  }
  let msg = `👥 *Bot Team Members (${members.length})*\n━━━━━━━━━━━━━━━━━━━\n`;
  members.forEach(([p, m], i) => {
    msg += `\n${i+1}. *${m.name}*\n   📱 +${p}\n   🎭 ${m.role}\n   📅 Added: ${fmtDate(m.addedOn)}\n`;
  });
  msg += '\n' + adminMenu();
  await send(from, msg);
}

// ═══════════════════════════════════════════════════════════
// CRM FUNCTIONS
// ═══════════════════════════════════════════════════════════
async function startLogVisit(from, sess, ctx) {
  const docs = await sbGet('doctors') || [];
  if (!docs.length) {
    await send(from, `⚠️ No doctors yet. Add one first (option 4).`);
    return;
  }
  // Filter to rep's own doctors if sales rep
  const botMember = (await getBotTeam())[cleanPhone(from)];
  const repId     = botMember?.repId;
  const myDocs    = repId ? docs.filter(d => d.rep === repId) : docs;
  const showDocs  = myDocs.length > 0 ? myDocs : docs;

  sess.step = 'visit_doctor';
  sess.data = { docs: showDocs };
  const list = showDocs.slice(0,20).map((d,i) => `${i+1}. ${d.name} (${d.city||'—'})`).join('\n');
  await send(from,
    `📋 *Log a Visit*\n━━━━━━━━━━━━━━\nSelect doctor or type name:\n\n${list}${showDocs.length>20?'\n\n_...type name to search_':''}\n\n_Type *cancel* to go back_`);
}

async function showPipeline(from, ctx) {
  const docs     = await sbGet('doctors') || [];
  const botMember= ctx.member;
  const repId    = botMember?.repId;

  // Reps see own pipeline; admin sees all
  let pipe = docs.filter(d => !['Won','Lost','Unapproached'].includes(d.stage));
  if (!ctx.isOwner && repId) pipe = pipe.filter(d => d.rep === repId);

  if (!pipe.length) {
    await send(from, `📊 *Pipeline*\n\nNo active pipeline doctors.\n\n` + (ctx.isOwner ? adminMenu() : repMenu(ctx.member?.name||'there')));
    return;
  }

  const order = ['Lead','Contacted','Trial Running','Proposal Sent','Negotiation'];
  const grouped = {};
  pipe.forEach(d => { if (!grouped[d.stage]) grouped[d.stage]=[]; grouped[d.stage].push(d); });

  let msg = `📊 *${ctx.isOwner?'Full':'My'} Pipeline (${pipe.length})*\n━━━━━━━━━━━━━━━━━━━\n`;
  order.forEach(stage => {
    if (!grouped[stage]) return;
    msg += `\n*${stage}* (${grouped[stage].length})\n`;
    grouped[stage].slice(0,5).forEach(d => {
      msg += `  • ${d.name}${d.city?', '+d.city:''}${d.device?' | '+d.device:''}${d.estval?' | '+inr(d.estval):''}\n`;
    });
    if (grouped[stage].length > 5) msg += `  _...+${grouped[stage].length-5} more_\n`;
  });
  msg += '\n' + (ctx.isOwner ? adminMenu() : repMenu(ctx.member?.name||'there'));
  await send(from, msg);
}

async function showFollowups(from, ctx) {
  const visits   = await sbGet('visits') || [];
  const docs     = await sbGet('doctors') || [];
  const t        = today();
  const sn       = new Date(); sn.setDate(sn.getDate()+3); const snStr=sn.toISOString().slice(0,10);
  const botMember= ctx.member;
  const repId    = botMember?.repId;

  let due = visits.filter(v => v.followup && v.followup >= t && v.followup <= snStr);
  if (!ctx.isOwner && repId) due = due.filter(v => v.rep === repId);
  due.sort((a,b) => a.followup.localeCompare(b.followup));

  if (!due.length) {
    await send(from, `📅 *Follow-ups*\n\n🎉 No follow-ups due in next 3 days!\n\n` + (ctx.isOwner ? adminMenu() : repMenu(botMember?.name||'there')));
    return;
  }

  let msg = `📅 *Follow-ups — Next 3 Days (${due.length})*\n━━━━━━━━━━━━━━━━━━━\n`;
  due.slice(0,10).forEach(v => {
    const doc   = docs.find(d => d.id === v.doctor) || {};
    const isToday = v.followup === t;
    msg += `\n${isToday?'🔴':'🟡'} *${doc.name||'Unknown'}*${isToday?' *(TODAY)*':''}\n   📅 ${fmtDate(v.followup)}\n   📝 ${(v.summary||'').slice(0,60)}${(v.summary||'').length>60?'...':''}\n`;
  });
  if (due.length > 10) msg += `\n_...+${due.length-10} more_`;
  msg += '\n\n' + (ctx.isOwner ? adminMenu() : repMenu(botMember?.name||'there'));
  await send(from, msg);
}

async function showFullTeamPipeline(from) {
  const docs = await sbGet('doctors') || [];
  const team = await sbGet('team') || [];
  const pipe = docs.filter(d => !['Won','Lost','Unapproached'].includes(d.stage));

  if (!pipe.length) {
    await send(from, `📊 No active pipeline.\n\n` + adminMenu()); return;
  }

  // Group by rep
  const byRep = {};
  pipe.forEach(d => {
    const rep = team.find(t => t.id === d.rep);
    const rn  = rep ? rep.name : 'Unassigned';
    if (!byRep[rn]) byRep[rn] = [];
    byRep[rn].push(d);
  });

  let msg = `📊 *Full Team Pipeline (${pipe.length})*\n━━━━━━━━━━━━━━━━━━━\n`;
  Object.entries(byRep).forEach(([repName, repDocs]) => {
    msg += `\n👤 *${repName}* (${repDocs.length})\n`;
    repDocs.slice(0,5).forEach(d => {
      msg += `  • ${d.name} — ${d.stage}${d.estval?' | '+inr(d.estval):''}\n`;
    });
    if (repDocs.length > 5) msg += `  _...+${repDocs.length-5} more_\n`;
  });
  msg += '\n' + adminMenu();
  await send(from, msg);
}

async function startAddDoctor(from, sess) {
  sess.step = 'add_doctor_name';
  sess.data = {};
  await send(from, `➕ *Add Doctor*\n━━━━━━━━━━━━━━\n\nDoctor's full name?\n\n_Type *cancel* to go back_`);
}

async function startWarrantyCheck(from, sess) {
  const inst = await sbGet('installations') || [];
  const t    = today();
  const sn   = new Date(); sn.setDate(sn.getDate()+30); const snStr=sn.toISOString().slice(0,10);
  const expiring = inst.filter(i => i.warrantyExpiry >= t && i.warrantyExpiry <= snStr);
  const expired  = inst.filter(i => i.warrantyExpiry < t);

  let msg = `🛡️ *Warranty Status*\n━━━━━━━━━━━━━━\n`;
  msg += `📊 Total: ${inst.length} | ✅ Active: ${inst.filter(i=>i.warrantyExpiry>=t).length} | ⚠️ Expiring: ${expiring.length} | ❌ Expired: ${expired.length}\n`;
  if (expiring.length) {
    msg += `\n⚠️ *Expiring in 30 days:*\n`;
    expiring.slice(0,5).forEach(i => { msg += `  • ${i.docName} — ${i.device} — ${fmtDate(i.warrantyExpiry)}\n`; });
  }
  if (expired.length) {
    msg += `\n❌ *Expired:*\n`;
    expired.slice(0,5).forEach(i => { msg += `  • ${i.docName} — ${i.device} — ${fmtDate(i.warrantyExpiry)}\n`; });
    if (expired.length > 5) msg += `  _...+${expired.length-5} more_\n`;
  }
  msg += `\n🔍 Type doctor name to search:`;
  sess.step = 'warranty_search';
  await send(from, msg);
}

// ── Health check ──────────────────────────────────────────
app.get('/', (req,res) => res.json({ status:'Ind Reveal CRM Bot ✅', time:new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
