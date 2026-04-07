const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const RAILWAY_SECRET = process.env.RAILWAY_SECRET;

// Health check
app.get('/health', (req, res) => res.json({ ok: true, worker: 'visionary-ai-task-executor' }));

// Auth middleware
function requireSecret(req, res, next) {
  const auth = req.headers.authorization;
  if (!RAILWAY_SECRET || auth !== `Bearer ${RAILWAY_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Build system prompt from task + business brain
async function buildPrompt(task, userId) {
  const ctx = task.prompt_context || {};

  // Load offer data
  let offer = null;
  if (ctx.offer_id) {
    const { data } = await supabase.from('offers').select('*').eq('id', ctx.offer_id).single();
    offer = data;
  }

  // Load brand docs
  let brandContext = '';
  const { data: brand } = await supabase.from('brand_docs').select('*').eq('user_id', userId).limit(1).single();
  if (brand) brandContext = JSON.stringify(brand);

  // Load business brain sections
  let character = '', ica = '', vision = '';
  const { data: brainRows } = await supabase.from('business_brain').select('section, content').eq('user_id', userId);
  if (brainRows) {
    for (const row of brainRows) {
      if (row.section === 'character') character = row.content || '';
      if (row.section === 'ica') ica = row.content || '';
      if (row.section === 'vision') vision = row.content || '';
    }
  }

  // Load playbook if slug provided
  let playbookText = '';
  if (ctx.playbook_slug) {
    const { data: pb } = await supabase.from('playbook_prompts').select('prompt_text').eq('slug', ctx.playbook_slug).single();
    if (pb) playbookText = pb.prompt_text || '';
  }

  const voice = ctx.voice || 'character';
  const topic = ctx.topic || '';
  const flow = ctx.flow || task.type;

  const voiceInstruction = voice === 'personal'
    ? "Write in the owner/founder's personal voice — direct, conversational, authentic, first-person."
    : "Write in the character's voice as defined in CHARACTER VOICE below. Sign off as Arty.";

  let taskInstruction = '';
  if (flow === 'email-broadcast') {
    taskInstruction = `Write a broadcast email about: "${topic}"

Format EXACTLY:
Subject: [subject line]

Preview: [preview text, 1 sentence]

[email body — 200-400 words, conversational, clear CTA]

— [signature]`;
  } else if (flow === 'sms-blast') {
    const link = ctx.include_link && ctx.link_url ? `\nInclude this link: ${ctx.link_url}` : '';
    taskInstruction = `Write an SMS about: "${topic}"${link}\nUnder 160 chars. Punchy. Clear CTA. Reply with SMS text only.`;
  } else if (task.type === 'page') {
    taskInstruction = `Build a high-converting landing page as complete HTML/CSS.\nPage type: ${ctx.funnel_type || 'landing page'}\nInclude: headline, subheadline, benefits, CTA, offer details.\nReturn ONLY the complete HTML document.`;
  } else if (task.type === 'ad') {
    const adTypes = ctx.ad_types || ['direct-offer'];
    taskInstruction = `Create retarget ad variations.\nAd types: ${adTypes.join(', ')}\nManyChat keyword: ${ctx.manychat_keyword || 'DM me'}\nFor each: Setting description, word-for-word script (30-60s), Copy (headline + primary text + CTA).`;
  } else {
    taskInstruction = task.prompt || `Complete this task: ${task.title}`;
  }

  return {
    system: `You build business assets for a digital marketing business. Follow the playbook methodology exactly. Never produce generic content. Use the real business data provided. Write in the specified voice.

${playbookText ? `PLAYBOOK (follow this structure exactly):\n${playbookText}\n\n` : ''}${brandContext ? `BRAND:\n${brandContext}\n\n` : ''}${offer ? `OFFER:\n${JSON.stringify(offer, null, 2)}\n\n` : ''}${character ? `CHARACTER VOICE:\n${character}\n\n` : ''}${ica ? `IDEAL CUSTOMER:\n${ica}\n\n` : ''}${vision ? `VISION:\n${vision}\n\n` : ''}VOICE INSTRUCTION: ${voiceInstruction}`,
    userMessage: taskInstruction
  };
}

// Main execution endpoint
app.post('/execute', requireSecret, async (req, res) => {
  // Acknowledge immediately — don't block
  res.json({ received: true });

  const { task_id, user_id } = req.body;
  if (!task_id || !user_id) return;

  console.log(`[executor] Starting task ${task_id} for user ${user_id}`);

  try {
    // 1. Read task
    const { data: task, error: taskErr } = await supabase.from('tasks').select('*').eq('id', task_id).single();
    if (taskErr || !task) {
      console.error(`[executor] Task ${task_id} not found:`, taskErr?.message);
      return;
    }

    // 2. Mark as working
    await supabase.from('tasks')
      .update({ status: 'working', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', task_id);

    // 3. Get user's API key
    const { data: conn } = await supabase.from('openclaw_connections')
      .select('anthropic_api_key, ai_model')
      .eq('user_id', user_id)
      .single();

    if (!conn?.anthropic_api_key) {
      console.error(`[executor] No API key for user ${user_id}`);
      await supabase.from('tasks')
        .update({ status: 'failed', last_error: 'No Anthropic API key configured. Add it in Settings → Connections.', updated_at: new Date().toISOString() })
        .eq('id', task_id);
      return;
    }

    // 4. Build prompt
    const { system, userMessage } = await buildPrompt(task, user_id);
    const model = conn.ai_model || 'claude-3-5-sonnet-20241022';

    console.log(`[executor] Calling Anthropic for task ${task_id} with model ${model}`);

    // 5. Call Anthropic — no timeout pressure here
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': conn.anthropic_api_key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const result = data.content?.[0]?.text || '';

    // 6. Write result
    await supabase.from('tasks')
      .update({
        result,
        status: 'review',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        attempts: (task.attempts || 0) + 1,
      })
      .eq('id', task_id);

    console.log(`[executor] ✅ Task ${task_id} complete — moved to review`);

  } catch (error) {
    console.error(`[executor] ❌ Task ${task_id} failed:`, error.message);
    await supabase.from('tasks')
      .update({
        status: 'failed',
        last_error: error.message,
        attempts: ((await supabase.from('tasks').select('attempts').eq('id', task_id).single()).data?.attempts || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task_id);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[visionary-ai-worker] Running on port ${PORT}`));
