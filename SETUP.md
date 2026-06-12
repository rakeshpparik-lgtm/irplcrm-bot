# Ind Reveal WhatsApp CRM Bot — Setup Guide
Complete setup in ~30 minutes.

---

## STEP 1 — Twilio Setup (10 min)

1. Go to https://www.twilio.com and create a free account
2. Verify your phone number during signup
3. From the Console Dashboard, copy:
   - **Account SID** (starts with AC...)
   - **Auth Token** (click to reveal)
4. In the left sidebar go to **Messaging → Try it out → Send a WhatsApp message**
5. You will see the Twilio Sandbox number (usually +14155238886)
6. **IMPORTANT:** Follow the on-screen instructions to join the sandbox:
   - Save +14155238886 as a contact in WhatsApp
   - Send the join code (e.g. "join silver-tiger") to that number on WhatsApp
   - You will get a confirmation reply — sandbox is now active for your number

---

## STEP 2 — Deploy to Render (10 min)

1. Go to https://github.com and create a free account if you don't have one
2. Create a new repository called `indreveal-bot`
3. Upload all files from this folder to that repo (drag and drop in GitHub UI)
4. Go to https://render.com and sign up with your GitHub account
5. Click **New → Web Service**
6. Connect your `indreveal-bot` GitHub repository
7. Render auto-detects Node.js. Settings:
   - Name: `indreveal-whatsapp-bot`
   - Build Command: `npm install`
   - Start Command: `npm start`
8. Click **Advanced → Add Environment Variables** and add:

| Key | Value |
|-----|-------|
| TWILIO_ACCOUNT_SID | ACxxxxxxxx... (from Twilio) |
| TWILIO_AUTH_TOKEN | your token (from Twilio) |
| TWILIO_WHATSAPP_FROM | +14155238886 |
| OWNER_PHONE | 91XXXXXXXXXX (your number, 91 + 10 digits, no spaces) |
| SUPABASE_URL | https://dmvazsgkxrijmtitiqqi.supabase.co |
| SUPABASE_KEY | eyJhbGci... (already in .env.example) |

9. Click **Create Web Service**
10. Wait ~2 minutes for deployment. You will get a URL like:
    `https://indreveal-whatsapp-bot.onrender.com`

---

## STEP 3 — Connect Twilio to Render (5 min)

1. Go back to Twilio → **Messaging → Settings → WhatsApp Sandbox Settings**
2. In the field **"When a message comes in"** paste:
   `https://indreveal-whatsapp-bot.onrender.com/webhook`
3. Set method to **HTTP POST**
4. Click **Save**

---

## STEP 4 — Test It (2 min)

Open WhatsApp and send **"hi"** to the Twilio sandbox number (+14155238886).

You should get back:
```
🏥 Ind Reveal CRM Bot
━━━━━━━━━━━━━━━━━━━
Reply with a number:

1️⃣  Log a Visit
2️⃣  My Pipeline
3️⃣  Follow-ups Due Today
4️⃣  Add a Doctor
5️⃣  Warranty Status Check
```

---

## HOW TO USE

**Log a Visit:**
Send `1` → Bot asks for doctor name → select from list → choose stage → type summary → optional follow-up date

**Check Pipeline:**
Send `2` → Bot shows all active pipeline doctors grouped by stage

**Follow-ups Due:**
Send `3` → Bot shows all follow-ups due today + next 2 days with 🔴 for today

**Add a Doctor:**
Send `4` → Bot asks name, clinic, city, mobile, device interest → saved to CRM

**Warranty Check:**
Send `5` → Bot shows expired + expiring summary → type doctor name to search

**Navigation:**
- Type `menu` or `0` anytime to return to main menu
- Type `cancel` to cancel current flow

---

## NOTES

- The bot only responds to YOUR number (OWNER_PHONE). Others get "Unauthorised".
- All data syncs with the same Supabase database as irplcrm.netlify.app — real time.
- Render free tier sleeps after 15 min of inactivity. First message after sleep takes ~30 sec.
  Upgrade to Render Starter ($7/month) to keep it always awake.
- Twilio sandbox is free but requires re-joining every 72 hours.
  To go live, apply for a WhatsApp Business API number (~$15/month).

---

## TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| Bot not responding | Check Render logs for errors |
| "Unauthorised" message | Check OWNER_PHONE in Render env vars (digits only, no +) |
| Data not saving | Check SUPABASE_URL and SUPABASE_KEY |
| 30-sec delay | Render free tier sleeping — upgrade or ping it periodically |
