const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const FAL_API_KEY = process.env.FAL_API_KEY || '5f22c618-1874-4e21-8f05-76e58c875449:c72f49474597d9f3f5129587f38930ef';
const FAL_MODEL = 'fal-ai/nano-banana-2'; // Gemini 3.1 Flash Image
const STORAGE_BUCKET = 'task-media';

// ─── Upload base64 or URL image to Supabase Storage (account-scoped) ─────────
async function uploadImageToStorage(imageData, userId, taskId, index) {
  try {
    let buffer;
    let ext = 'png';

    if (imageData.startsWith('data:')) {
      // Base64 data URL → Buffer
      const match = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) throw new Error('Invalid base64 data URL');
      ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      buffer = Buffer.from(match[2], 'base64');
    } else if (imageData.startsWith('http')) {
      // Remote URL → fetch → Buffer
      const res = await fetch(imageData);
      if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
      const arrayBuf = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
      const ct = res.headers.get('content-type') || '';
      ext = ct.includes('jpeg') ? 'jpg' : 'png';
    } else {
      throw new Error('Unknown image format');
    }

    // Account-scoped path: users/{user_id}/tasks/{task_id}/{index}.{ext}
    const storagePath = `users/${userId}/tasks/${taskId}/creative-${index}.${ext}`;

    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, {
        contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        upsert: true,
      });

    if (error) throw new Error(`Storage upload error: ${error.message}`);

    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    return urlData.publicUrl;
  } catch (err) {
    console.error(`[storage] Upload failed for creative ${index}:`, err.message);
    return null; // Non-fatal: return null, keep image_urls empty
  }
}

// ─── fal.ai image generation ──────────────────────────────────────────────────
async function generateImages(prompt, count = 3, aspectRatio = '1:1', userFalKey = null) {
  const apiKey = userFalKey || FAL_API_KEY; // User's key takes priority; platform key is fallback
  const response = await fetch(`https://fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      num_images: Math.min(count, 4),
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

// ─── Agent type system prompts ───────────────────────────────────────────────
const AGENT_PROMPTS = {
  page: `You are a conversion-focused web developer. You build complete, self-contained HTML pages using inline CSS and proven funnel page structures. Output ONLY the complete HTML document. No explanations. No markdown. No code fences. Just the full <!DOCTYPE html> page ready to serve. Use high-contrast design, clear headline hierarchy, a dominant CTA button, and trust signals.`,

  copy: `You are a direct response copywriter trained in Hormozi, Brunson, Todd Brown, and Gary Halbert methodology. You write persuasive, specific, benefit-driven copy in the specified character voice. No generic filler. No corporate language. Every word earns its place. CTAs are specific and urgent.`,

  ads: `You are a Facebook Ads strategist. You create complete ad sets with multiple creative variations. Each ad includes: hook script (word-for-word, first 3 seconds scripted), ad copy (headline + primary text + CTA), ManyChat keyword integration, and production brief with setting/format/duration specs. Angles vary: pain point, result, curiosity, social proof.`,

  bot: `You create training documents for AI sales bots. You produce comprehensive offer documents that include: product details, pricing, objection responses with exact rebuttals, qualification questions, conversation flows with branching paths, escalation rules, and closing scripts. The bot should be able to sell and support using only this document.`,

  content: `You are a social content creator following the Daily 5 system. You produce platform-ready content with character voice, ManyChat keyword CTAs, trending format structures (hook-story-CTA), and caption copy with hashtags. Each piece has a specific platform, purpose, and time slot. Content is engaging, authentic, and drives action.`,

  workflow: `You design email and SMS automation workflows. You produce complete workflow blueprints with: trigger definition, step-by-step actions, wait durations, conditions/branches, and the full content for every email and SMS in the sequence. Also produce a deploy prompt ready to paste into Cowork or GHL AI Builder. Output as structured JSON only — no prose, no markdown.`,

  delivery: `You are a customer success specialist. You create clear, actionable delivery task briefs. Include all customer context, what needs to happen, how to do it, what done looks like, and any special instructions. Be thorough — the person receiving this task should be able to complete it without asking any questions.`,
};

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
  let logoUrl = '';
  let brandName = '';
  const { data: brand } = await supabase.from('brand_docs').select('*').eq('user_id', userId).limit(1).single();
  if (brand) {
    brandContext = JSON.stringify(brand);
    logoUrl = brand.user_logo_url || '';
    brandName = brand.user_brand_name || '';
  }

  // Load business brain sections — cap each section to control token cost
  // Full docs can be 30k+ chars; we extract the most relevant portion per task type
  const BRAIN_CAP = 3000; // ~750 tokens per section — enough context without burning budget
  let character = '', ica = '', vision = '', leadMagnets = '', paidOffers = '';
  const { data: brainRows } = await supabase.from('business_brain').select('section, content').eq('user_id', userId);
  if (brainRows) {
    for (const row of brainRows) {
      const content = (row.content || '').slice(0, BRAIN_CAP);
      if (row.section === 'character') character = content;
      if (row.section === 'ica') ica = content;
      if (row.section === 'vision') vision = content;
      if (row.section === 'lead_magnets') leadMagnets = content;
      if (row.section === 'paid_offers') paidOffers = content;
    }
  }

  // Load playbook if slug provided
  let playbookText = '';
  if (ctx.playbook_slug) {
    const { data: pb } = await supabase.from('playbook_prompts').select('prompt_text').eq('slug', ctx.playbook_slug).single();
    if (pb) playbookText = pb.prompt_text || '';
  }

  // Load agent memory for this user
  let memoryContext = '';
  try {
    const { data: memories } = await supabase
      .from('agent_memory')
      .select('key, value, category')
      .eq('user_id', userId)
      .order('category');
    if (memories && memories.length > 0) {
      memoryContext = `\n\nMember Context (remembered by AI):\n${memories.map(m => `- ${m.key}: ${m.value}`).join('\n')}`;
    }
  } catch (memErr) {
    console.warn('[buildPrompt] Could not load agent memory:', memErr.message);
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
    const pageAnswers = ctx.answers || {};
    const modelUrl = pageAnswers.model_url || ctx.model_url || null;
    const funnelType = ctx.funnel_type || pageAnswers.funnel_type || 'landing page';

    // If a model URL was provided, fetch and analyze it
    let modelPageAnalysis = '';
    if (modelUrl) {
      try {
        console.log(`[executor] Fetching model page: ${modelUrl}`);
        const pageRes = await fetch(modelUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VisionaryAI/1.0)' },
          signal: AbortSignal.timeout(10000),
        });
        if (pageRes.ok) {
          const html = await pageRes.text();

          // Step 1: Detect structural signals BEFORE stripping
          const hasNav = /<nav[\s>]/i.test(html);
          const hasHeader = /<header[\s>]/i.test(html);
          const hasVideo = /<video[\s>]|youtube\.com\/embed|vimeo\.com\/video|wistia|vidyard/i.test(html);
          const hasPopupForm = /modal|popup|pop-up|overlay|dialog/i.test(html) && /<form[\s>]/i.test(html);
          const hasInlineForm = /<form[\s>]/i.test(html) && !hasPopupForm;
          const hasTimer = /countdown|timer|setInterval/i.test(html);
          const sectionCount = (html.match(/<section[\s>]/gi) || []).length;

          // Step 2: Build a READABLE version — structure + copy together
          // Remove scripts/styles but keep ALL visible text and structural tags
          const readable = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, (m) => {
              // Keep a note if it's a popup/modal script
              if (/modal|popup|pop-up|overlay|openForm|showForm/i.test(m)) return '<!-- [POPUP/MODAL JAVASCRIPT DETECTED HERE] -->';
              return '';
            })
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<!--(?!\s*\[POPUP)[\s\S]*?-->/g, '')
            // Simplify tags — keep tag name, strip all attributes except src/href/type for context
            .replace(/<(img|iframe|video|input|button|a|form)([^>]*)>/gi, (m, tag, attrs) => {
              const src = (attrs.match(/src=["']([^"']+)["']/i) || [])[1] || '';
              const href = (attrs.match(/href=["']([^"']+)["']/i) || [])[1] || '';
              const type = (attrs.match(/type=["']([^"']+)["']/i) || [])[1] || '';
              const onclick = /onclick|data-open|data-modal|data-popup/i.test(attrs) ? ' [HAS_CLICK_ACTION]' : '';
              if (tag.toLowerCase() === 'iframe' && src) return `<iframe src="${src.slice(0,80)}">`;
              if (tag.toLowerCase() === 'img') return `<img${src ? ` src="${src.slice(0,80)}"` : ''}>`;
              if (tag.toLowerCase() === 'input') return `<input type="${type}">`;
              if (tag.toLowerCase() === 'a') return `<a${href ? ` href="${href.slice(0,80)}"` : ''}${onclick}>`;
              if (tag.toLowerCase() === 'button') return `<button${onclick}>`;
              return `<${tag}>`;
            })
            // Strip remaining attribute bloat from structural tags
            .replace(/<(div|section|header|footer|nav|main|article|aside|ul|ol|li|h[1-6]|p|span)[^>]*>/gi, (m, tag) => `<${tag}>`)
            .replace(/<(?!\/?(?:body|main|section|header|footer|nav|article|aside|div|h[1-6]|p|img|video|iframe|form|input|button|a|ul|ol|li|span)\b)[^>]+>/gi, '')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, 12000);

          modelPageAnalysis = `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MODEL PAGE — FULL CONTENT + STRUCTURE (${modelUrl})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This is the actual content of the page — structure AND copy together so you can model both the layout AND the psychological flow of the writing:

${readable}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PAGE SIGNALS DETECTED:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Nav/header bar: ${hasNav || hasHeader ? 'YES' : 'NO'}
- Video embed: ${hasVideo ? 'YES' : 'NO'}
- Form delivery: ${hasPopupForm ? 'POPUP/MODAL (button triggers a pop-up form — DO NOT put form inline on page)' : hasInlineForm ? 'INLINE FORM on page' : 'NO FORM'}
- Countdown timer: ${hasTimer ? 'YES — include working JS countdown' : 'NO'}
- Section count: ${sectionCount > 0 ? sectionCount : 'see structure above'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR INSTRUCTIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are a COPY MACHINE for this page's structure and psychology. You are NOT a designer. Do not invent.

1. SECTIONS: Build ONLY the sections that exist in the model. Count them above. Build exactly that many in exactly that order.
2. NO EXTRAS: No nav if the model has none. No extra testimonials, pricing tables, FAQ, or sections the model doesn't have. Nothing invented.
3. COPY PSYCHOLOGY: Read the actual copy above. Model the SAME psychological pattern (hook, agitate, solution, proof, CTA) but rewritten for this user's specific offer and audience.
4. FORM AS POPUP: ${hasPopupForm ? 'The model triggers a form in a pop-up/modal when a button is clicked. Your page MUST do the same — button click opens a modal overlay with the form inside. DO NOT put the form inline.' : 'Replicate the form delivery method shown above.'}
5. MEDIA PLACEHOLDERS: Every video/image slot = clearly labeled dashed-border placeholder box
6. BRAND: Apply the user\'s brand colors, fonts, and offer details — but structure and psychology come from the model`;

        }
      } catch (fetchErr) {
        console.warn(`[executor] Could not fetch model page: ${fetchErr.message}`);
        modelPageAnalysis = `\n\nNote: Could not fetch model page at ${modelUrl} — build based on the funnel type instead.`;
      }
    }

    const logoInstruction = logoUrl
      ? `LOGO: Use this logo image in the page: ${logoUrl} — place it exactly where the model page has a logo (typically top-left). Use <img src="${logoUrl}" alt="${brandName || 'Logo'}" style="max-height:60px;width:auto;">`
      : `LOGO: No logo URL provided. If the model page has a logo slot, use a placeholder: <div style="font-weight:700;font-size:18px;letter-spacing:1px;">${brandName || '[BRAND NAME]'}</div>`;

    taskInstruction = `Build a complete, fully functional HTML/CSS/JS landing page.
Page type: ${funnelType}
${modelUrl ? `You are modeling this page: ${modelUrl}` : ''}
${logoInstruction}

OUTPUT RULES (absolute):
1. Return ONLY the raw HTML document — no explanation, no markdown, no code fences, nothing before <!DOCTYPE
2. Inline CSS only (no external stylesheets except Google Fonts via <link>)
3. All JS inline in <script> tags
4. Missing media = placeholder box with dashed border and label formatted EXACTLY as: [ VIDEO: description ] or [ IMAGE: description ] or [ HEADSHOT: description ] — these will be replaced by the user later
5. Working JS for any interactive elements (pop-ups, timers, smooth scroll)${modelPageAnalysis}`;
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
        // platforms may be array or comma-string
        const rawPlatforms = answers.platforms;
        const platformsArr = Array.isArray(rawPlatforms)
          ? rawPlatforms
          : (rawPlatforms ? String(rawPlatforms).split(',').map(p => p.trim()) : ['social']);
        // Post count: Daily 5 = 5 posts/day × number of days
        const daysAnswer = answers.days ? parseInt(String(answers.days), 10) : null;
        const POSTS_PER_DAY = 5;
        const postCount = daysAnswer ? daysAnswer * POSTS_PER_DAY : POSTS_PER_DAY;
        const platforms = platformsArr;

        // Two-phase: structured JSON output so Phase 2 can generate images
        taskInstruction = `Execute this content playbook: ${task.title}

PLAYBOOK: ${playbookId || playbookSlug || 'standard'}

USER INPUTS:
${answerLines}

${offer ? `OFFER: ${offer.name} — $${offer.price || 'free'}` : ''}

Output a single valid JSON object with EXACTLY ${postCount} posts. No markdown. No code fences.

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

RULES:
- Generate EXACTLY ${postCount} posts in the posts array (${daysAnswer || 1} day${(daysAnswer || 1) > 1 ? 's' : ''} × 5 posts per day).
- Distribute posts across these platforms: ${platforms.join(', ')}. Cycle through platforms if there are more posts than platforms.
- Every post must be unique — different hook, angle, format, story.
- Group posts by day — vary the content type (story, tip, proof, hook, CTA) so each day has a full mix.
- Each image_prompt must follow the character's visual identity.`;
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

  // Select base system prompt: agent_type takes priority, then type, then default
  const agentType = task.agent_type || task.type || 'copy';
  const baseSystemPrompt = AGENT_PROMPTS[agentType] || AGENT_PROMPTS.copy;

  // Always append user notes so AI sees them regardless of task type
  const notesAddendum = (task.prompt && task.prompt !== taskInstruction)
    ? `\n\nADDITIONAL NOTES FROM USER:\n${task.prompt}`
    : '';

  // Include revision feedback if this is a redo
  const revisionFeedback = task.revision_feedback || task.result_metadata?.feedback || null;
  const revisionAddendum = revisionFeedback
    ? `\n\n⚠️ REVISION INSTRUCTIONS (this is a revised version — the previous output was rejected):\n${revisionFeedback}\n\nYou MUST address every point above. Do not repeat the previous version. Improve it based on this specific feedback.`
    : '';

  // Lean system prompt — Claude fetches context via tools instead of receiving it all upfront
  // This dramatically reduces input token cost while giving Claude access to full content on demand
  const toolGuidance = `\n\nYOU HAVE TOOLS. Before executing any task:
1. Call get_knowledge_base() for the sections relevant to this task (brand, ica, paid_offers, etc.)
2. Call get_playbook() if a playbook slug was provided in the task
3. Call get_offer() if an offer_id was provided
4. Call get_brand() if you need logo/colors/fonts
5. Call get_memory() if you need remembered context about this business
Only fetch what you actually need. Then produce the deliverable.`;

  return {
    system: baseSystemPrompt + toolGuidance + workflowSystemAddendum,
    userMessage: taskInstruction + notesAddendum + revisionAddendum
  };
}

// ─── TOOL DEFINITIONS ──────────────────────────────────────────────────────
const CLAUDE_TOOLS = [
  {
    name: 'get_knowledge_base',
    description: "Read a section of the user's business knowledge base. Available sections: vision (business goals, strategy), ica (ideal customer profile), brand (brand identity, voice), character (AI character/persona voice), lead_magnets (free offers), paid_offers (products/services/pricing). Call this FIRST before creating any content.",
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['vision', 'ica', 'brand', 'character', 'lead_magnets', 'paid_offers'] }
      },
      required: ['section']
    }
  },
  {
    name: 'get_playbook',
    description: 'Read a specific playbook by slug to get exact instructions, templates, and structure.',
    input_schema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug']
    }
  },
  {
    name: 'get_offer',
    description: 'Read details of a specific offer — pricing, description, benefits, positioning.',
    input_schema: {
      type: 'object',
      properties: { offer_id: { type: 'string' } },
      required: ['offer_id']
    }
  },
  {
    name: 'get_brand',
    description: "Read the user's brand settings: logo URL, brand name, colors, fonts.",
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_memory',
    description: 'Read AI memory notes for this user — important context the AI has learned.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'update_knowledge_base',
    description: 'Write new or updated information to a knowledge base section when you discover important business context that should be remembered.',
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['vision', 'ica', 'brand', 'character', 'lead_magnets', 'paid_offers'] },
        content: { type: 'string' },
        mode: { type: 'string', enum: ['replace', 'append'] }
      },
      required: ['section', 'content']
    }
  }
];

// ─── TOOL EXECUTOR ─────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, userId) {
  console.log(`[tool] Executing ${toolName}:`, JSON.stringify(toolInput).slice(0, 100));
  try {
    switch (toolName) {
      case 'get_knowledge_base': {
        const { data } = await supabase.from('business_brain')
          .select('content').eq('user_id', userId).eq('section', toolInput.section).single();
        return data?.content || `Section '${toolInput.section}' is empty. No content uploaded yet.`;
      }
      case 'get_playbook': {
        const { data } = await supabase.from('playbook_prompts')
          .select('prompt_text, name').eq('slug', toolInput.slug).single();
        return data ? `PLAYBOOK: ${data.name}\n\n${data.prompt_text}` : `Playbook not found: ${toolInput.slug}`;
      }
      case 'get_offer': {
        const { data } = await supabase.from('offers').select('*').eq('id', toolInput.offer_id).single();
        return data ? JSON.stringify(data, null, 2) : `Offer not found: ${toolInput.offer_id}`;
      }
      case 'get_brand': {
        const { data } = await supabase.from('brand_docs').select('*').eq('user_id', userId).limit(1).single();
        return data ? JSON.stringify(data, null, 2) : 'No brand settings configured yet.';
      }
      case 'get_memory': {
        const { data } = await supabase.from('agent_memory')
          .select('key, value, category').eq('user_id', userId).order('category');
        if (!data?.length) return 'No memories stored yet.';
        return data.map(m => `[${m.category}] ${m.key}: ${m.value}`).join('\n');
      }
      case 'update_knowledge_base': {
        const { section, content, mode = 'replace' } = toolInput;
        let finalContent = content;
        if (mode === 'append') {
          const { data: existing } = await supabase.from('business_brain')
            .select('content').eq('user_id', userId).eq('section', section).single();
          if (existing?.content) finalContent = existing.content + '\n\n---\n\n' + content;
        }
        await supabase.from('business_brain')
          .upsert({ user_id: userId, section, content: finalContent, last_updated_at: new Date().toISOString() }, { onConflict: 'user_id,section' });
        return `✅ Updated '${section}' (${finalContent.length} chars).`;
      }
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `Tool error: ${err.message}`;
  }
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

    // 2. Mark as working + log activity
    await supabase.from('tasks')
      .update({ status: 'working', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', task_id);
    await supabase.from('task_notes').insert({ task_id, user_id, content: `⚡ AI picked up this task and started working.`, author_type: 'ai', author_name: 'OpenClaw AI' });

    // 3. Get user's API keys (Anthropic + fal.ai)
    const { data: conn } = await supabase.from('openclaw_connections')
      .select('anthropic_api_key, ai_model, fal_api_key')
      .eq('user_id', user_id)
      .single();

    if (!conn?.anthropic_api_key) {
      console.error(`[executor] No API key for user ${user_id}`);
      await supabase.from('tasks')
        .update({ status: 'failed', last_error: 'No Anthropic API key configured. Add it in Settings → Connections.', updated_at: new Date().toISOString() })
        .eq('id', task_id);
      return;
    }

    // 4. Build lean task instruction (no pre-loaded context — Claude fetches what it needs)
    const { system, userMessage } = await buildPrompt(task, user_id);
    const model = conn.ai_model || 'claude-sonnet-4-6';
    console.log(`[executor] Model: ${model} — agentic tool-calling mode`);

    // 5. Agentic loop — Claude reads task, calls tools to fetch context, then produces output
    const messages = [{ role: 'user', content: userMessage }];
    const MAX_TOOL_ROUNDS = 6;
    let result = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': conn.anthropic_api_key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: task.type === 'page' ? 8000 : 4096,
          system,
          tools: CLAUDE_TOOLS,
          messages,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const stopReason = data.stop_reason;
      console.log(`[executor] Round ${round + 1}: stop_reason=${stopReason}, blocks=${data.content?.length}`);

      // Add assistant response to message history
      messages.push({ role: 'assistant', content: data.content });

      if (stopReason === 'end_turn') {
        // Extract final text result
        result = data.content?.find(b => b.type === 'text')?.text || '';
        break;
      }

      if (stopReason === 'tool_use') {
        // Execute all tool calls in parallel
        const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
        const toolResults = await Promise.all(
          toolUseBlocks.map(async (block) => {
            const toolOutput = await executeTool(block.name, block.input, user_id);
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: String(toolOutput),
            };
          })
        );
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // max_tokens or other stop — extract what we have
      result = data.content?.find(b => b.type === 'text')?.text || '';
      break;
    }

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

    // 6a. Safety net: if AI returned planning text instead of JSON, extract JSON or re-prompt
    if (task.type === 'content' || task.source === 'playbook') {
      const jsonMatch = result.match(/\{[\s\S]*"(?:posts|creatives)"[\s\S]*\}/);
      if (jsonMatch) {
        // JSON embedded in text — extract it
        result = jsonMatch[0].trim();
        console.log('[executor] Extracted JSON from AI planning text');
      } else if (!result.trim().startsWith('{')) {
        // No JSON at all — re-ask Claude to output the structured format
        console.log('[executor] AI returned text instead of JSON — requesting structured output');
        try {
          const reAsk = await claudeClient.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 8000,
            messages: [
              { role: 'user', content: `You previously responded with planning text instead of the required JSON output. Here was your response:\n\n${result.slice(0,500)}\n\nNow output ONLY the JSON object with the posts/creatives array. No preamble, no explanation. Start your response with { and end with }.` }
            ],
          });
          const retryText = reAsk.content.find(b => b.type === 'text')?.text || '';
          const jsonRetry = retryText.match(/\{[\s\S]*\}/);
          if (jsonRetry) result = jsonRetry[0].trim();
        } catch (reAskErr) {
          console.error('[executor] Re-ask failed:', reAskErr.message);
        }
      }
    }

    // 6. Phase 2 — fal.ai image generation for social content posts
    const isContentTask = result.trim().startsWith('{');
    if (isContentTask) {
      try {
        const parsed = JSON.parse(result);
        const items = parsed.creatives || parsed.posts || [];

        if (items.length > 0) {
          console.log(`[executor] Phase 2 — generating ${items.length} image(s) via fal.ai`);

          const aspectRatio = taskCtx.answers?.platforms?.includes('instagram') ? '4:5' : '1:1';
          const userFalKey = conn?.fal_api_key || null;

          if (!userFalKey && !FAL_API_KEY) {
            console.warn('[executor] No fal.ai key available — skipping image generation. User should connect fal.ai in Settings.');
          }

          // Generate + upload sequentially to avoid hammering fal.ai
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            try {
              // Build image prompt: use Claude's image_prompt if present, otherwise derive from caption
              const captionSnippet = (item.caption || item.primary_text || item.headline || '').slice(0, 120);
              const platform = item.platform || 'social media';
              const derivedPrompt = item.image_prompt ||
                `Professional ${platform} marketing image. Modern, clean, bold design. Context: ${captionSnippet}. No text overlays. Photorealistic or stylized graphic, high quality.`;
              const rawUrls = await generateImages(derivedPrompt, 1, aspectRatio, userFalKey);
              if (rawUrls.length > 0) {
                // Upload to Supabase Storage (account-scoped) and swap base64/raw URL → CDN URL
                const cdnUrl = await uploadImageToStorage(rawUrls[0], user_id, task_id, i);
                item.image_urls = cdnUrl ? [cdnUrl] : [];
                console.log(`[executor] Creative ${i + 1} uploaded → ${cdnUrl || 'FAILED'}`);
              } else {
                item.image_urls = [];
              }
            } catch (err) {
              console.error(`[executor] fal.ai error for item ${i}:`, err.message);
              item.image_urls = [];
            }
          }

          // Rebuild result with image URLs attached
          result = JSON.stringify(parsed, null, 2);
          console.log(`[executor] Phase 2 complete — images attached to ${items.filter(i => i.image_urls?.length).length}/${items.length} items`);
        }
      } catch (parseErr) {
        console.error('[executor] Phase 2 parse error (non-fatal):', parseErr.message);
        // Fallback: keep text result as-is
      }
    }

    // 7. For page tasks — auto-deploy HTML to Vercel as a standalone static site
    const PLATFORM_URL = 'https://visionary-ai-blue.vercel.app';
    let deployedViaVercel = false;

    if (task.type === 'page' && result.trim().startsWith('<')) {
      const pageName = task.title
        ? task.title.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/, '').slice(0, 50)
        : `aim-page-${task_id.slice(0, 8)}`;

      console.log(`[executor] Deploying page task ${task_id} to Vercel as "${pageName}"...`);

      try {
        const deployRes = await fetch(`${PLATFORM_URL}/api/deploy/page`, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer aim-railway-secret-2026',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ html: result, task_id, page_name: pageName }),
        });

        if (deployRes.ok) {
          const deployData = await deployRes.json();
          console.log(`[executor] ✅ Page deployed to Vercel: ${deployData.url}`);
          deployedViaVercel = true;
          // The deploy route already updated Supabase — skip the normal update below
        } else {
          const errText = await deployRes.text();
          console.error(`[executor] Vercel deploy failed (${deployRes.status}): ${errText} — falling back to direct DB store`);
        }
      } catch (deployErr) {
        console.error(`[executor] Vercel deploy error: ${deployErr.message} — falling back to direct DB store`);
      }
    }

    // 8. Write result to DB (skip if Vercel deploy already handled it)
    if (!deployedViaVercel) {
      const PLATFORM_URL = process.env.PLATFORM_URL || 'https://visionary-ai-blue.vercel.app';
      const previewUrl = `${PLATFORM_URL}/api/tasks/${task_id}/preview`;
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
    } else {
      // Only bump the attempts counter — result/status/url already set by deploy route
      await supabase.from('tasks')
        .update({ attempts: (task.attempts || 0) + 1 })
        .eq('id', task_id);
    }

    console.log(`[executor] ✅ Task ${task_id} complete — moved to review`);

    // ── CARD SPLITTING: one card per piece of content ──────────────────
    // If the result has multiple posts/creatives, split into individual child tasks.
    // Exception: carousels and workflow sequences stay together.
    const isCarousel = task.type === 'carousel' || (task.prompt_context?.flow || '').includes('carousel');
    const isSequence = task.type === 'workflow' || (task.prompt_context?.flow || '').includes('sequence');
    if (!isCarousel && !isSequence && result.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(result);
        const items = parsed.posts || parsed.creatives || parsed.emails || parsed.ads || [];
        if (items.length > 1) {
          console.log(`[executor] Splitting ${items.length} items into individual review cards`);

          // Create a child task for each item
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const platform = item.platform || '';
            const itemTitle = platform
              ? `${task.title} — ${platform} (${i + 1}/${items.length})`
              : `${task.title} — Part ${i + 1}/${items.length}`;

            const insertRes = await supabase.from('tasks').insert({
              user_id,
              title: itemTitle,
              type: task.type,
              status: 'review',
              assigned_to: 'human',
              agent: task.agent,
              source: task.source,
              source_id: task_id,   // use source_id to link back to parent
              wave: task.wave,
              result: JSON.stringify({ posts: [item] }),
              completed_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            if (insertRes.error) console.error(`[executor] Child insert error:`, insertRes.error.message);
          }

          // Mark parent task as split (auto-approved container — not shown in inbox)
          await supabase.from('tasks')
            .update({ status: 'approved', result: `Split into ${items.length} individual review cards.`, updated_at: new Date().toISOString() })
            .eq('id', task_id);

          console.log(`[executor] ✅ Split complete — ${items.length} individual cards created`);
        }
      } catch (splitErr) {
        console.error('[executor] Card split error (non-fatal):', splitErr.message);
      }
    }
    // ──────────────────────────────────────────────────────────────────

    await supabase.from('task_notes').insert({ task_id, user_id, content: `✅ AI finished. Output is ready for your review.`, author_type: 'ai', author_name: 'OpenClaw AI' });

  } catch (error) {
    console.error(`[executor] ❌ Task ${task_id} failed:`, error.message);
    // Translate cryptic API errors into human-readable messages
    let humanError = error.message;
    if (/authentication|invalid.*key|api.?key|unauthorized/i.test(error.message)) {
      humanError = '🔑 Invalid or expired API key. Go to Settings → Connections and re-enter your Anthropic key.';
    } else if (/rate.?limit|too many requests|429/i.test(error.message)) {
      humanError = '⏱️ AI rate limit hit. Wait a minute and try again, or upgrade your Anthropic plan.';
    } else if (/quota|insufficient.?credits|billing|out.?of.?tokens/i.test(error.message)) {
      humanError = '💳 Your AI account is out of credits. Add credits at console.anthropic.com, then retry.';
    } else if (/timeout|timed out|ECONNRESET|ETIMEDOUT/i.test(error.message)) {
      humanError = '⌛ The AI took too long to respond. The task will be retried automatically.';
    } else if (/network|ENOTFOUND|fetch/i.test(error.message)) {
      humanError = '🌐 Network error reaching the AI. Check your connection and retry.';
    }
    await supabase.from('tasks')
      .update({
        status: 'failed',
        last_error: humanError,
        attempts: ((await supabase.from('tasks').select('attempts').eq('id', task_id).single()).data?.attempts || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task_id);
    await supabase.from('task_notes').insert({ task_id, user_id, content: `❌ ${humanError}`, author_type: 'ai', author_name: 'OpenClaw AI' });
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

// ─── Schedule poller: promote scheduled tasks to queued when due ──────────────
async function promoteScheduledTasks() {
  try {
    const now = new Date().toISOString();
    const { data: dueTasks, error } = await supabase
      .from('tasks')
      .select('id, title, team_member_id')
      .eq('status', 'scheduled')
      .lte('scheduled_for', now)
      .limit(20);

    if (error) {
      console.error('[scheduler] Supabase error:', error.message);
      return;
    }

    if (!dueTasks || dueTasks.length === 0) return;

    console.log(`[scheduler] Promoting ${dueTasks.length} scheduled task(s) to queued`);

    for (const task of dueTasks) {
      await supabase.from('tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', task.id)
        .eq('status', 'scheduled'); // guard against race
      console.log(`[scheduler] Task ${task.id} (${task.title}) → queued`);
    }
  } catch (err) {
    console.error('[scheduler] Error:', err.message);
  }
}

setInterval(promoteScheduledTasks, 60000); // every 60 seconds
console.log('[scheduler] Schedule poller started — promoting due tasks every 60s');

// ─── Stuck-task watchdog: auto-reset tasks stuck in 'working' > 8 min ────────
async function resetStuckTasks() {
  try {
    const cutoff = new Date(Date.now() - 8 * 60 * 1000).toISOString(); // 8 minutes ago
    const { data: stuckTasks, error } = await supabase
      .from('tasks')
      .select('id, title, attempts')
      .eq('status', 'working')
      .lt('updated_at', cutoff)
      .limit(10);

    if (error) { console.error('[watchdog] Supabase error:', error.message); return; }
    if (!stuckTasks || stuckTasks.length === 0) return;

    console.log(`[watchdog] Found ${stuckTasks.length} stuck task(s) — resetting to queued`);

    for (const task of stuckTasks) {
      // If already attempted 3+ times, mark failed instead of looping forever
      if ((task.attempts || 0) >= 3) {
        await supabase.from('tasks')
          .update({ status: 'failed', last_error: 'Task timed out after 3 attempts', updated_at: new Date().toISOString() })
          .eq('id', task.id).eq('status', 'working');
        console.log(`[watchdog] Task ${task.id} (${task.title}) → failed (3 attempts exhausted)`);
      } else {
        await supabase.from('tasks')
          .update({ status: 'queued', updated_at: new Date().toISOString() })
          .eq('id', task.id).eq('status', 'working');
        console.log(`[watchdog] Task ${task.id} (${task.title}) → re-queued (was stuck)`);
      }
    }
  } catch (err) {
    console.error('[watchdog] Error:', err.message);
  }
}

setInterval(resetStuckTasks, 60000); // check every minute
console.log('[watchdog] Stuck-task watchdog started — checking every 60s');

// ─── Escalation poller: alert on stale tasks (48h+ without progress) ─────────
let lastEscalationCheck = 0;
async function checkStaleTasksAndEscalate() {
  // Run every 6 hours (21600000 ms)
  if (Date.now() - lastEscalationCheck < 21600000) return;
  lastEscalationCheck = Date.now();

  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: staleTasks, error } = await supabase
      .from('tasks')
      .select('id, title, status, user_id, updated_at')
      .in('status', ['blocked', 'queued', 'review'])
      .lt('updated_at', cutoff)
      .limit(50);

    if (error) {
      console.error('[escalation] Supabase error:', error.message);
      return;
    }

    if (!staleTasks || staleTasks.length === 0) {
      console.log('[escalation] No stale tasks found');
      return;
    }

    // Group by user
    const byUser = {};
    for (const task of staleTasks) {
      if (!byUser[task.user_id]) byUser[task.user_id] = [];
      byUser[task.user_id].push(task);
    }

    // Get user profiles with Telegram IDs
    const userIds = Object.keys(byUser);
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, telegram_chat_id, email, first_name')
      .in('id', userIds);

    const profileMap = {};
    (profiles || []).forEach(p => profileMap[p.id] = p);

    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

    for (const userId of userIds) {
      const profile = profileMap[userId];
      const tasks = byUser[userId];
      if (!profile?.telegram_chat_id || !TELEGRAM_BOT_TOKEN) continue;

      const msg = `⚠️ *Stale Tasks Alert*\n\n${tasks.length} task(s) need attention (48h+ no progress):\n\n` +
        tasks.slice(0, 5).map(t => `• ${t.title} (${t.status})`).join('\n') +
        (tasks.length > 5 ? `\n... and ${tasks.length - 5} more` : '') +
        `\n\n[View Dashboard](https://visionary-ai-blue.vercel.app/projects)`;

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: profile.telegram_chat_id,
          text: msg,
          parse_mode: 'Markdown',
        }),
      }).catch(err => console.error('[escalation] Telegram failed:', err.message));
    }

    console.log(`[escalation] Checked ${staleTasks.length} stale tasks for ${userIds.length} users`);
  } catch (err) {
    console.error('[escalation] Error:', err.message);
  }
}

setInterval(checkStaleTasksAndEscalate, 3600000); // check every hour, but only escalate every 6h
console.log('[escalation] Stale task escalation started — checking every hour');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[visionary-ai-worker] Running on port ${PORT}`));
