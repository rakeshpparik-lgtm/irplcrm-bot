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

function today() {
  return new Date().toISOString().slice(0, 10);
}
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return d; }
}
function uid() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}
function inr(n) {
  if (!n) return '₹0';
  return '₹' + Number(n).toLocaleString('en-IN');
}

// ── Session state (in-memory per user) ──────────────────────
const sessions = {};
function getSession(from) {
  if (!sessions[from]) sessions[from] = { step: null, data: {} };
  return sessions[from];
}
function clearSession(from) {
  sessions[from] = { step: null, data: {} };
}

// ── Send WhatsApp message ────────────────────────────────────
async function send(to, body) {
  await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
    to:   `whatsapp:${to}`,
    body
  });
}

// ── Main menu ────────────────────────────────────────────────
function mainMenu() {
  return `🏥 *Ind Reveal CRM Bot*
━━━━━━━━━━━━━━━━━━━
Reply with a number:

1️⃣  Log a Visit
2️⃣  My Pipeline
3️⃣  Follow-ups Due Today
4️⃣  Add a Doctor
5️⃣  Warranty Status Check

Type *menu* anytime to return here.`;
}

// ── Webhook endpoint ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // respond immediately to Twilio

  const from = req.body.From?.replace('whatsapp:', '');
  const body = (req.body.Body || '').trim();
  const lower = body.toLowerCase();

  if (!from) return;

  // Authorise only your number
  if (from !== process.env.OWNER_PHONE) {
    await send(from, '⛔ Unauthorised number. Contact your CRM admin.');
    return;
  }

  const sess = getSession(from);

  // ── Global commands ──
  if (['menu', 'hi', 'hello', 'start', '0'].includes(lower)) {
    clearSession(from);
    await send(from, mainMenu());
    return;
  }
  if (lower === 'cancel') {
    clearSession(from);
    await send(from, '❌ Cancelled.\n\n' + mainMenu());
    return;
  }

  // ── Route by session step ──
  if (sess.step) {
    await handleStep(from, body, sess);
    return;
  }

  // ── Main menu selection ──
  switch (body.trim()) {
    case '1': await startLogVisit(from, sess);     break;
    case '2': await showPipeline(from);             break;
    case '3': await showFollowups(from);            break;
    case '4': await startAddDoctor(from, sess);     break;
    case '5': await startWarrantyCheck(from, sess); break;
    default:
      await send(from, '❓ I didn\'t understand that.\n\n' + mainMenu());
  }
});

// ═══════════════════════════════════════════════════════════
// 1. LOG A VISIT
// ═══════════════════════════════════════════════════════════
async function startLogVisit(from, sess) {
  const docs = await sbGet('doctors') || [];
  if (!docs.length) {
    await send(from, '⚠️ No doctors in database yet. Add one first (option 4).');
    return;
  }
  sess.step = 'visit_doctor';
  sess.data = { docs };
  const list = docs.slice(0, 20).map((d, i) => `${i + 1}. ${d.name} (${d.city || '—'})`).join('\n');
  await send(from,
    `📋 *Log a Visit*\n━━━━━━━━━━━━━━\nReply with the doctor number or type their name:\n\n${list}${docs.length > 20 ? '\n\n_...type name to search more_' : ''}\n\n_Type *cancel* to go back_`
  );
}

async function handleStep(from, body, sess) {
  switch (sess.step) {

    // ── VISIT steps ──────────────────────────────────────
    case 'visit_doctor': {
      const docs = sess.data.docs || await sbGet('doctors') || [];
      let doc = null;
      const num = parseInt(body);
      if (!isNaN(num) && num >= 1 && num <= docs.length) {
        doc = docs[num - 1];
      } else {
        const q = body.toLowerCase();
        const matches = docs.filter(d => d.name.toLowerCase().includes(q));
        if (matches.length === 1) {
          doc = matches[0];
        } else if (matches.length > 1) {
          sess.data.filteredDocs = matches;
          const list = matches.slice(0, 10).map((d, i) => `${i + 1}. ${d.name} (${d.city || '—'})`).join('\n');
          await send(from, `Found ${matches.length} matches:\n\n${list}\n\nReply with the number:`);
          sess.step = 'visit_doctor_pick';
          return;
        }
      }
      if (!doc) { await send(from, `❌ Doctor not found. Try again or type *cancel*.`); return; }
      sess.data.visitDoc = doc;
      sess.step = 'visit_stage';
      await send(from,
        `✅ *${doc.name}*\n\nWhat stage is this visit at?\n\n1. Lead\n2. Contacted\n3. Trial Running\n4. Proposal Sent\n5. Negotiation\n6. Won\n7. Lost`
      );
      break;
    }

    case 'visit_doctor_pick': {
      const matches = sess.data.filteredDocs || [];
      const num = parseInt(body);
      if (isNaN(num) || num < 1 || num > matches.length) {
        await send(from, `❌ Invalid. Reply 1–${matches.length}:`); return;
      }
      sess.data.visitDoc = matches[num - 1];
      sess.step = 'visit_stage';
      await send(from,
        `✅ *${sess.data.visitDoc.name}*\n\nStage:\n1. Lead\n2. Contacted\n3. Trial Running\n4. Proposal Sent\n5. Negotiation\n6. Won\n7. Lost`
      );
      break;
    }

    case 'visit_stage': {
      const stageMap = { '1':'Lead','2':'Contacted','3':'Trial Running','4':'Proposal Sent','5':'Negotiation','6':'Won','7':'Lost' };
      const stage = stageMap[body.trim()] || body;
      sess.data.visitStage = stage;
      sess.step = 'visit_summary';
      await send(from, `📝 Stage: *${stage}*\n\nType your visit summary (what was discussed, outcome, next steps):`);
      break;
    }

    case 'visit_summary': {
      sess.data.visitSummary = body;
      sess.step = 'visit_followup';
      await send(from, `📅 Follow-up date? (format: DD-MM-YYYY)\nOr type *skip* if none:`);
      break;
    }

    case 'visit_followup': {
      let followup = null;
      if (lower(body) !== 'skip') {
        const parts = body.split('-');
        if (parts.length === 3) followup = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
      }

      // Save visit
      const visits = await sbGet('visits') || [];
      const docs   = await sbGet('doctors') || [];
      const doc    = sess.data.visitDoc;
      const newVisit = {
        id:       'V' + uid(),
        doctor:    doc.id,
        rep:       'whatsapp_bot',
        date:      today(),
        type:      'WhatsApp Bot',
        stage:     sess.data.visitStage,
        summary:   sess.data.visitSummary,
        followup:  followup,
        created:   today()
      };
      visits.push(newVisit);

      // Update doctor stage
      const di = docs.findIndex(d => d.id === doc.id);
      if (di > -1) docs[di].stage = sess.data.visitStage;

      await sbSet('visits', visits);
      await sbSet('doctors', docs);

      let msg = `✅ *Visit Logged!*\n━━━━━━━━━━━━━━\n👨‍⚕️ Doctor: ${doc.name}\n📊 Stage: ${sess.data.visitStage}\n📝 Summary: ${sess.data.visitSummary}`;
      if (followup) msg += `\n📅 Follow-up: ${fmtDate(followup)}`;
      msg += '\n\n' + mainMenu();
      clearSession(from);
      await send(from, msg);
      break;
    }

    // ── ADD DOCTOR steps ────────────────────────────────
    case 'add_doctor_name': {
      sess.data.docName = body;
      sess.step = 'add_doctor_clinic';
      await send(from, `🏥 Clinic/Hospital name? (or *skip*):`);
      break;
    }

    case 'add_doctor_clinic': {
      sess.data.docClinic = lower(body) === 'skip' ? '' : body;
      sess.step = 'add_doctor_city';
      await send(from, `📍 City?:`);
      break;
    }

    case 'add_doctor_city': {
      sess.data.docCity = body;
      sess.step = 'add_doctor_mobile';
      await send(from, `📱 Mobile number? (or *skip*):`);
      break;
    }

    case 'add_doctor_mobile': {
      sess.data.docMobile = lower(body) === 'skip' ? '' : body;
      sess.step = 'add_doctor_device';
      const masters = await sbGet('masters') || {};
      const devices = (masters.devices || []).join(', ') || 'VEGA COMFORT, ORION, QLARA';
      await send(from, `💊 Device interest?\n${devices}\n\n(Type device name or *skip*):`);
      break;
    }

    case 'add_doctor_device': {
      sess.data.docDevice = lower(body) === 'skip' ? '' : body;

      // Save doctor
      const docs = await sbGet('doctors') || [];
      const newDoc = {
        id:        'DC' + uid(),
        name:      sess.data.docName,
        clinic:    sess.data.docClinic,
        city:      sess.data.docCity,
        mobile:    sess.data.docMobile,
        device:    sess.data.docDevice,
        stage:     'Unapproached',
        source:    'WhatsApp Bot',
        created:   today()
      };
      docs.push(newDoc);
      await sbSet('doctors', docs);

      const msg = `✅ *Doctor Added!*\n━━━━━━━━━━━━━━\n👨‍⚕️ ${newDoc.name}\n🏥 ${newDoc.clinic || '—'}\n📍 ${newDoc.city}\n📱 ${newDoc.mobile || '—'}\n💊 ${newDoc.device || '—'}\n📊 Stage: Unapproached\n\n` + mainMenu();
      clearSession(from);
      await send(from, msg);
      break;
    }

    // ── WARRANTY CHECK step ─────────────────────────────
    case 'warranty_search': {
      const inst = await sbGet('installations') || [];
      const q    = body.toLowerCase();
      const matches = inst.filter(i => (i.docName || '').toLowerCase().includes(q));
      if (!matches.length) {
        await send(from, `❌ No installations found for "${body}".\n\nTry again or type *cancel*:`);
        return;
      }
      const t = today();
      const soon = new Date(); soon.setDate(soon.getDate() + 30);
      const soonStr = soon.toISOString().slice(0, 10);
      let msg = `🔍 *Warranty Results for "${body}"*\n━━━━━━━━━━━━━━━━━━━\n`;
      matches.slice(0, 8).forEach(i => {
        const isExp  = i.warrantyExpiry < t;
        const isExpg = !isExp && i.warrantyExpiry <= soonStr;
        const icon   = isExp ? '❌' : isExpg ? '⚠️' : '✅';
        const status = isExp ? 'EXPIRED' : isExpg ? 'EXPIRING SOON' : 'Active';
        msg += `\n${icon} *${i.docName}*\n   Device: ${i.device}\n   SN: ${i.deviceSerial || '—'}\n   Expiry: ${fmtDate(i.warrantyExpiry)} (${status})\n`;
      });
      if (matches.length > 8) msg += `\n_...and ${matches.length - 8} more. Search more specifically._`;
      msg += '\n\n' + mainMenu();
      clearSession(from);
      await send(from, msg);
      break;
    }
  }
}

function lower(s) { return (s || '').toLowerCase().trim(); }

// ═══════════════════════════════════════════════════════════
// 2. MY PIPELINE
// ═══════════════════════════════════════════════════════════
async function showPipeline(from) {
  const docs = await sbGet('doctors') || [];
  const pipe = docs.filter(d => !['Won', 'Lost', 'Unapproached'].includes(d.stage));
  if (!pipe.length) {
    await send(from, `📊 *My Pipeline*\n\nNo active pipeline doctors yet.\n\n` + mainMenu());
    return;
  }

  const stageOrder = ['Lead','Contacted','Trial Running','Proposal Sent','Negotiation'];
  const grouped = {};
  pipe.forEach(d => {
    if (!grouped[d.stage]) grouped[d.stage] = [];
    grouped[d.stage].push(d);
  });

  let msg = `📊 *Sales Pipeline (${pipe.length} doctors)*\n━━━━━━━━━━━━━━━━━━━\n`;
  stageOrder.forEach(stage => {
    if (!grouped[stage]) return;
    msg += `\n*${stage}* (${grouped[stage].length})\n`;
    grouped[stage].slice(0, 5).forEach(d => {
      msg += `  • ${d.name}${d.city ? ', ' + d.city : ''}${d.device ? ' | ' + d.device : ''}${d.estval ? ' | ' + inr(d.estval) : ''}\n`;
    });
    if (grouped[stage].length > 5) msg += `  _...+${grouped[stage].length - 5} more_\n`;
  });

  msg += '\n' + mainMenu();
  await send(from, msg);
}

// ═══════════════════════════════════════════════════════════
// 3. FOLLOW-UPS DUE TODAY
// ═══════════════════════════════════════════════════════════
async function showFollowups(from) {
  const visits = await sbGet('visits') || [];
  const docs   = await sbGet('doctors') || [];
  const t      = today();
  const soon   = new Date(); soon.setDate(soon.getDate() + 3);
  const soonStr= soon.toISOString().slice(0, 10);

  const due = visits.filter(v => v.followup && v.followup >= t && v.followup <= soonStr)
    .sort((a, b) => a.followup.localeCompare(b.followup));

  if (!due.length) {
    await send(from, `📅 *Follow-ups*\n\n🎉 No follow-ups due in the next 3 days!\n\n` + mainMenu());
    return;
  }

  let msg = `📅 *Follow-ups Due (Next 3 Days)*\n━━━━━━━━━━━━━━━━━━━\n`;
  due.slice(0, 10).forEach(v => {
    const doc  = docs.find(d => d.id === v.doctor) || {};
    const isToday = v.followup === t;
    const icon = isToday ? '🔴' : '🟡';
    msg += `\n${icon} *${doc.name || 'Unknown'}*\n   📅 ${fmtDate(v.followup)}${isToday ? ' *(TODAY)*' : ''}\n   📝 ${(v.summary || '').slice(0, 80)}${(v.summary || '').length > 80 ? '...' : ''}\n`;
  });
  if (due.length > 10) msg += `\n_...and ${due.length - 10} more_`;
  msg += '\n\n' + mainMenu();
  await send(from, msg);
}

// ═══════════════════════════════════════════════════════════
// 4. ADD DOCTOR - start
// ═══════════════════════════════════════════════════════════
async function startAddDoctor(from, sess) {
  sess.step = 'add_doctor_name';
  sess.data = {};
  await send(from, `➕ *Add New Doctor*\n━━━━━━━━━━━━━━\n\nDoctor's full name?\n\n_Type *cancel* to go back_`);
}

// ═══════════════════════════════════════════════════════════
// 5. WARRANTY CHECK - start
// ═══════════════════════════════════════════════════════════
async function startWarrantyCheck(from, sess) {
  const inst = await sbGet('installations') || [];
  if (!inst.length) {
    await send(from, `⚠️ No installations in database yet.\n\n` + mainMenu());
    return;
  }
  // Show expiring soon proactively
  const t     = today();
  const soon  = new Date(); soon.setDate(soon.getDate() + 30);
  const soonStr = soon.toISOString().slice(0, 10);
  const expiring = inst.filter(i => i.warrantyExpiry >= t && i.warrantyExpiry <= soonStr);
  const expired  = inst.filter(i => i.warrantyExpiry < t);

  let msg = `🛡️ *Warranty Status*\n━━━━━━━━━━━━━━\n`;
  msg += `📊 Total Installations: ${inst.length}\n`;
  msg += `✅ Active: ${inst.filter(i => i.warrantyExpiry >= t).length}\n`;
  msg += `⚠️ Expiring (30 days): ${expiring.length}\n`;
  msg += `❌ Expired: ${expired.length}\n`;

  if (expiring.length) {
    msg += `\n⚠️ *Expiring Soon:*\n`;
    expiring.slice(0, 5).forEach(i => {
      msg += `  • ${i.docName} — ${i.device} — ${fmtDate(i.warrantyExpiry)}\n`;
    });
  }
  if (expired.length) {
    msg += `\n❌ *Already Expired:*\n`;
    expired.slice(0, 5).forEach(i => {
      msg += `  • ${i.docName} — ${i.device} — ${fmtDate(i.warrantyExpiry)}\n`;
    });
    if (expired.length > 5) msg += `  _...+${expired.length - 5} more_\n`;
  }

  msg += `\n🔍 Search by doctor name? Type their name:`;
  sess.step = 'warranty_search';
  await send(from, msg);
}

// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Ind Reveal CRM Bot running ✅', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
