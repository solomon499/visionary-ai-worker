const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const FAL_API_KEY = process.env.FAL_API_KEY || '5f22c618-1874-4e21-8f05-76e58c875449:c72f49474597d9f3f5129587f38930ef';
const FAL_MODEL = 'fal-ai/nano-banana-2'; // Gemini 3.1 Flash Image

// ─── fal.ai image generation ──────────────────────────────────────────────────
async function generateImages(prompt, count = 3, aspectRatio = '1:1') {
  const response = await fetch(`https://fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      num_images: Math.min(count, 4), // fal.ai max batch is 4
      image_size: aspectRatio === '9:16' ? 'portrait_4_3'
        : aspectRatio === '16:9' ? 'landscape_16_9'
        : aspectRatio === '4:5' ? 'portrait_4_3'
        : 'square_hd',
      sync_mode: true,
      enable_safety_checker: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`fal.ai error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  // fal.ai returns { images: [{ url, width, height, content_type }] }
  return (data.images || []).map(img => img.url).filter(Boolean);
}

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
  if (flow === 'email-sequence' || flow === 'sms-sequence' || task.type === 'workflow') {
    const sequenceType = flow === 'sms-sequence' ? 'SMS' : 'email';
    taskInstruction = `Create a complete ${sequenceType} sequence/workflow for: "${topic}"

You MUST output a single valid JSON object. No markdown. No code fences. No explanation. Just the raw JSON.

The JSON must follow this exact structure:
{
  "content": {
    "emails": [
      {
        "name": "Email name (short, descriptive)",
        "subject": "Subject line",
        "preview": "Preview text, 1 sentence",
        "body": "Full email body with {{first_name}} personalization, 200-400 words, clear CTA"
      }
    ],
    "sms": [
      {
        "name": "SMS name",
        "body": "SMS text under 160 chars with {{first_name}}"
      }
    ]
  },
  "workflow": {
    "name": "Workflow Name",
    "trigger": "Exact trigger description (e.g. 'Contact added to list: Webinar Registrants')",
    "steps": [
      { "action": "send_email", "email": "Email name matching content above", "delay": "immediate" },
      { "action": "wait", "duration": "24 hours" },
      { "action": "condition", "if": "no calendar booking", "then": "send_email", "email": "Next email name" },
      { "action": "send_sms", "sms": "SMS name matching content above", "delay": "immediate" }
    ]
  },
  "deploy_prompt": "Full step-by-step instructions for building this workflow in GHL. Start with: Open GHL → Automations → Workflows → + Create Workflow. Include every step: trigger setup, each action in order, wait times, condition branches, and how to attach each email/SMS to the correct workflow step. Write it as if handing off to a non-technical team member who will follow it literally."
}

Rules:
- Write COMPLETE email bodies — no placeholders like [insert body here]
- workflow.steps must reference email/SMS names exactly as they appear in content
- deploy_prompt must be complete enough to paste into Cowork or GHL AI Builder and get a working workflow built
- Include all emails AND sms relevant to the sequence type
- For email-only sequences, sms array can be empty []
- For sms-only sequences, emails array can be empty []`;
  } else if (flow === 'email-broadcast') {
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
  } else if (task.type === 'email') {
    // All email tasks: output ONLY the email, nothing else
    const basePrompt = task.prompt || `Write an email for: ${task.title}`;
    taskInstruction = `${basePrompt}

CRITICAL OUTPUT RULE: Output ONLY the email itself. No design notes. No color palettes. No "this email is designed to" sections. No hashtags. No purpose explanations. No markdown headers like ### FOOTER. No meta-commentary of any kind.

Format EXACTLY like this and nothing else:
Subject: [subject line]

Preview: [1 sentence preview text]

[email body]

[signature]`;
  } else if (task.type === 'ad') {
    const needsMedia = ctx.answers?.media === 'ai' || ctx.media === 'ai';
    const creativeCount = parseInt(ctx.answers?.creative_count || ctx.creative_count || '3', 10);
    const manychatKeyword = ctx.answers?.manychat_keyword || ctx.manychat_keyword || 'DM me';

    if (needsMedia) {
      // Two-phase: output structured JSON so Phase 2 can generate images
      taskInstruction = `You are building ${creativeCount} ad creative(s) for this campaign.

Output a single valid JSON object. No markdown. No code fences. No preamble.

{
  "creatives": [
    {
      "headline": "Short punchy headline (max 8 words)",
      "primary_text": "Ad body copy — 2-3 sentences, benefit-led, conversational",
      "cta": "Call to action text (e.g. 'Comment ${manychatKeyword} below')",
      "image_prompt": "Detailed visual prompt for this ad image. Must describe: subject (use character/brand details from CHARACTER VOICE), composition, lighting, mood, color palette, style. Be specific and cinematic. Do NOT mention brand name or text overlays — describe the visual only."
    }
  ]
}

Rules:
- Each creative must have a distinct angle (e.g. pain point, result, curiosity, social proof)
- image_prompt must follow the character's visual identity from the CHARACTER VOICE section
- Do not include any text/logos in the image_prompt — those get added as overlays
- ManyChat keyword for CTAs: ${manychatKeyword}`;
    } else {
      const adTypes = ctx.ad_types || ['direct-offer'];
      taskInstruction = `Create retarget ad variations.\nAd types: ${adTypes.join(', ')}\nManyChat keyword: ${manychatKeyword}\nFor each: Setting description, word-for-word script (30-60s), Copy (headline + primary text + CTA).`;
    }
  } else {
    // Standard playbook task — build rich instruction from answers + context
    const answers = ctx.answers || {};
    const playbookId = ctx.playbook_id || '';
    const needsMedia = answers.media === 'ai';

    if (Object.keys(answers).length > 0) {
      const answerLines = Object.entries(answers)
        .filter(([k, v]) => v && v !== '__add_offer' && k !== 'media')
        .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n');

      if (needsMedia) {
        // Two-phase: structured JSON output so Phase 2 can generate images
        taskInstruction = `Execute this content playbook: ${task.title}

PLAYBOOK: ${playbookId || playbookSlug || 'standard'}

USER INPUTS:
${answerLines}

${offer ? `OFFER: ${offer.name} — $${offer.price || 'free'}` : ''}

Output a single valid JSON object. No markdown. No code fences.

{
  "posts": [
    {
      "platform": "platform name",
      "caption": "Full post caption with hooks, body, and CTA",
      "hashtags": ["tag1", "tag2"],
      "image_prompt": "Detailed visual prompt for this post image. Describe: subject (use character/brand details from CHARACTER VOICE), composition, lighting, mood, color palette, style. Be specific. No text overlays — visuals only."
    }
  ]
}

Create one post per platform selected. Each image_prompt must follow the character's visual identity.`;
      } else {
        taskInstruction = `Execute this playbook task: ${task.title}

PLAYBOOK: ${playbookId || playbookSlug || 'standard'}

USER INPUTS:
${answerLines}

${offer ? `OFFER BEING PROMOTED:\n- Name: ${offer.name}\n- Price: $${offer.price || 'free'}\n- Description: ${offer.description || ''}\n- Tagline: ${offer.tagline || ''}` : ''}

Follow the playbook methodology exactly. Use the user's specific answers to customize every deliverable. Do not produce generic output.`;
      }
    } else {
      taskInstruction = task.prompt || `Complete this task: ${task.title}`;
    }
  }

  const isWorkflowTask = flow === 'email-sequence' || flow === 'sms-sequence' || task.type === 'workflow';

  const workflowSystemAddendum = isWorkflowTask
    ? `\n\nCRITICAL OUTPUT RULES FOR THIS TASK:
- Output ONLY a valid JSON object. Nothing else.
- No markdown code fences. No backticks. No "Here is the JSON:" preamble.
- No trailing text after the closing brace.
- All email bodies must be complete — no placeholders, no "[body here]".
- workflow.steps must reference email/SMS names exactly as written in content.
- deploy_prompt must be a complete, literal step-by-step guide ready for a human to follow in GHL.`
    : '';

  return {
    system: `You build business assets for a digital marketing business. Follow the playbook methodology exactly. Never produce generic content. Use the real business data provided. Write in the specified voice.

${playbookText ? `PLAYBOOK (follow this structure exactly):\n${playbookText}\n\n` : ''}${brandContext ? `BRAND:\n${brandContext}\n\n` : ''}${offer ? `OFFER:\n${JSON.stringify(offer, null, 2)}\n\n` : ''}${character ? `CHARACTER VOICE:\n${character}\n\n` : ''}${ica ? `IDEAL CUSTOMER:\n${ica}\n\n` : ''}${vision ? `VISION:\n${vision}\n\n` : ''}VOICE INSTRUCTION: ${voiceInstruction}${workflowSystemAddendum}`,
    userMessage: taskInstruction
  };
}

// Core execution logic — callable from HTTP route AND the poller
async function executeTask(task_id, user_id) {
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
    // Funnel page/bot builds get Opus — highest quality for high-value deliverables
    const isFunnelBuild = task.source === 'get-sales' && ['page', 'bot'].includes(task.type);
    const model = isFunnelBuild ? 'claude-opus-4-6' : (conn.ai_model || 'claude-sonnet-4-5-20250929');
    console.log(`[executor] Model: ${model} (funnel build: ${isFunnelBuild})`);

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
        max_tokens: task.type === 'page' ? 16000 : 4096,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic ${response.status}: ${errText}`);
    }

    const data = await response.json();
    let result = data.content?.[0]?.text || '';

    // Strip markdown code fences (```html ... ``` or ```json ... ``` or ``` ... ```)
    result = result.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    // For workflow tasks: strip any preamble before the JSON object
    const taskCtx = task.prompt_context || {};
    const isWorkflowResult = taskCtx.flow === 'email-sequence' || taskCtx.flow === 'sms-sequence' || task.type === 'workflow';
    if (isWorkflowResult) {
      const jsonStart = result.indexOf('{');
      const jsonEnd = result.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        result = result.slice(jsonStart, jsonEnd + 1).trim();
      }
    }

    // For email tasks: strip any metadata sections that leak through
    if (task.type === 'email') {
      const stripMarkers = [
        /\n---\n\*\*DESIGN NOTES/i,
        /\n---\n\*\*This email is designed/i,
        /\n#{1,3}\s*\*{0,2}DESIGN NOTES/i,
        /\n#{1,3}\s*\*{0,2}FOOTER/i,
        /\n\*\*DESIGN NOTES/i,
        /\nDESIGN NOTES:/i,
        /\n---\s*\nDesign Notes/i,
      ];
      for (const marker of stripMarkers) {
        const idx = result.search(marker);
        if (idx !== -1) result = result.slice(0, idx).trim();
      }
    }

    // 6. Phase 2 — fal.ai image generation (if task has image prompts from Claude)
    const needsMedia = taskCtx.answers?.media === 'ai' || taskCtx.media === 'ai';
    if (needsMedia && result.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(result);
        const items = parsed.creatives || parsed.posts || [];

        if (items.length > 0 && items[0]?.image_prompt) {
          console.log(`[executor] Phase 2 — generating ${items.length} image(s) via fal.ai (Nano Banana 2)`);

          const imageResults = await Promise.allSettled(
            items.map(item =>
              generateImages(
                item.image_prompt,
                1, // 1 image per creative/post
                taskCtx.answers?.platforms?.includes('instagram') ? '4:5' : '1:1'
              )
            )
          );

          // Attach image URLs back to each item
          items.forEach((item, i) => {
            const outcome = imageResults[i];
            item.image_urls = outcome.status === 'fulfilled' ? outcome.value : [];
            if (outcome.status === 'rejected') {
              console.error(`[executor] fal.ai error for item ${i}:`, outcome.reason?.message);
            }
          });

          // Rebuild result with image URLs attached
          result = JSON.stringify(parsed, null, 2);
          console.log(`[executor] Phase 2 complete — images attached to ${items.filter(i => i.image_urls?.length).length}/${items.length} items`);
        }
      } catch (parseErr) {
        console.error('[executor] Phase 2 parse error (non-fatal):', parseErr.message);
        // Fallback: keep text result as-is
      }
    }

    // 7. For page tasks — auto-deploy preview to Vercel before review
    let previewUrl = null;
    if (task.type === 'page' && result.trim().startsWith('<')) {
      try {
        const { data: tokenRow } = await supabase
          .from('oauth_tokens')
          .select('access_token, metadata')
          .eq('user_id', user_id)
          .eq('service', 'vercel')
          .single();

        if (tokenRow?.access_token) {
          const slug = task.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 35);

          const teamId = tokenRow.metadata?.team_id || null;
          const deployEndpoint = teamId
            ? `https://api.vercel.com/v13/deployments?teamId=${teamId}`
            : 'https://api.vercel.com/v13/deployments';

          const deployRes = await fetch(deployEndpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${tokenRow.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: `visionary-preview-${slug}`,
              files: [{ file: 'index.html', data: result }],
              projectSettings: { framework: null },
              target: 'production',
            }),
          });

          const deployData = await deployRes.json();
          if (deployRes.ok && deployData.url) {
            previewUrl = `https://${deployData.url}`;
            console.log(`[executor] Preview deployed: ${previewUrl}`);
          }
        }
      } catch (deployErr) {
        console.error(`[executor] Preview deploy failed (non-fatal):`, deployErr.message);
      }
    }

    // 7. Write result + preview URL
    await supabase.from('tasks')
      .update({
        result,
        result_url: previewUrl,
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
}

// Main execution endpoint — wraps executeTask
app.post('/execute', requireSecret, async (req, res) => {
  res.json({ received: true });
  const { task_id, user_id } = req.body;
  if (!task_id || !user_id) return;
  executeTask(task_id, user_id).catch(err =>
    console.error(`[executor] Unhandled error for ${task_id}:`, err.message)
  );
});

// ─── Auto-poller: pick up queued tasks without relying on Vercel fire-and-forget ───
let pollerRunning = false;

async function pollAndExecute() {
  if (pollerRunning) return; // prevent overlap
  pollerRunning = true;
  try {
    const { data: tasks, error } = await supabase
      .from('tasks')
      .select('id, user_id')
      .eq('status', 'queued')
      .eq('assigned_to', 'ai')
      .limit(5);

    if (error) {
      console.error('[poller] Supabase error:', error.message);
      return;
    }

    for (const task of tasks || []) {
      console.log(`[poller] Picked up queued task ${task.id}`);
      // Mark working immediately so next poll cycle doesn't double-pick
      const { error: markErr } = await supabase
        .from('tasks')
        .update({ status: 'working', updated_at: new Date().toISOString() })
        .eq('id', task.id)
        .eq('status', 'queued'); // only mark if still queued (race-condition guard)

      if (markErr) {
        console.error(`[poller] Failed to mark ${task.id} working:`, markErr.message);
        continue;
      }

      // Execute async — don't await so loop stays fast
      executeTask(task.id, task.user_id).catch(err =>
        console.error(`[poller] executeTask error for ${task.id}:`, err.message)
      );
    }
  } catch (err) {
    console.error('[poller] Unexpected error:', err.message);
  } finally {
    pollerRunning = false;
  }
}

setInterval(pollAndExecute, 20000); // every 20 seconds
console.log('[poller] Auto-poller started — checking for queued tasks every 20s');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[visionary-ai-worker] Running on port ${PORT}`));
