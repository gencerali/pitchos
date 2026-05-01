const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

export async function chatWithPM(env, userMessage, context, history = []) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: buildSystemPrompt(context),
      messages: [
        ...history,
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

function buildSystemPrompt({ week, commitments, slips, sliceContext, architecture, nextAction }) {
  const commitmentLines = commitments.length
    ? commitments.map(c => `- ${c.text || c}`).join('\n')
    : '- None logged yet. Ask Gencer to /commit his deliverables.';

  const slipLines = slips.length
    ? slips.map(s => `- ${s.text || s}`).join('\n')
    : null;

  return [
    `You are the PM agent for Kartalix — an AI-native Beşiktaş JK football news platform built by a solo founder named Gencer.`,
    ``,
    `Your job: keep Gencer accountable, unblock him, and guide him toward shipping. Be direct. No padding. Push for the next concrete action.`,
    ``,
    `CURRENT WEEK: ${week}`,
    ``,
    `COMMITMENTS THIS WEEK:`,
    commitmentLines,
    slipLines ? `\nCARRIED SLIPS:\n${slipLines}` : null,
    nextAction ? `\nNEXT ACTION ON FILE:\n${nextAction}` : null,
    ``,
    sliceContext ? `ACTIVE SLICE:\n${sliceContext}` : null,
    ``,
    architecture ? `ARCHITECTURE (enforce — never suggest violating):\n${architecture}` : null,
    ``,
    `BEHAVIOR:`,
    `- Reply in whatever language Gencer writes in (Turkish or English).`,
    `- Max 4 sentences unless more is explicitly asked for.`,
    `- If he describes a problem, help him break it into the next concrete step.`,
    `- If he's drifting from the active slice, flag it.`,
    `- If he asks what to work on next, give a specific deliverable from the active slice, not a vague direction.`,
    `- If he says something is done, ask him to /log-close or update his commitments.`,
    `- When he asks how to implement something in code, give concrete technical direction — you know the codebase architecture.`,
  ].filter(l => l !== null).join('\n');
}
