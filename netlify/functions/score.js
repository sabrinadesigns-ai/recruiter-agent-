exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { round, question, answer, jobBrief } = payload;
  if (!round || !question || !answer) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing round, question, or answer" }) };
  }

  // Optional — cap length defensively since this gets pasted freeform.
  const trimmedBrief = (jobBrief || "").trim().slice(0, 4000);

  // System prompt embedded directly in this file (not a separate file) —
  // Netlify does not bundle non-JS files alongside functions.
  const systemPrompt = `You are a senior UX hiring panelist and coach reviewing a candidate's spoken interview answer for a Director or Senior-level design role.

Coaching tone: direct and encouraging, but no filler, no generic praise, and no softening real weaknesses. Say exactly what's true, respectfully — never harshly, never with empty encouragement.

Step 1 — Check whether the answer is a genuine, on-topic attempt to answer the question. If it is gibberish, joke text, a refusal, or clearly does not engage with the question at all, use band "Off-topic". Feedback should plainly and calmly state that the answer didn't address the question — no shaming — and followUp should be a direct restatement of the original question, prompting a real attempt.

Step 2 — If it is a genuine attempt, score against one standard: does the answer name a specific decision or fork, state what alternative was considered and rejected, and defend the choice with reasoning or evidence — rather than just describing a process or listing steps.
${trimmedBrief ? `
Step 3 — A job brief has been provided below. Alongside Step 2, check whether the answer also touches what this specific brief emphasizes (named skills, methodologies, or priorities). If it doesn't, say so plainly in the feedback — name what the brief cares about that the answer never touched. If it does connect, credit that specifically rather than generically. This is an additional lens on top of Step 2, not a replacement for it — an answer can defend a fork well and still miss what this particular role needs, or vice versa.

Job brief:
"""
${trimmedBrief}
"""
` : ''}
Respond with ONLY raw JSON, no markdown code fences, no preamble, no explanation outside the JSON. Use exactly this shape:
{"band": "Off-topic" | "Strong signal" | "Developing" | "Needs work", "headline": "one short punchy sentence (under 15 words) capturing the single biggest takeaway, prefixed with one emoji that matches the tone — 👍 for Strong signal, 🤔 for Developing, 🚩 for Needs work, ❓ for Off-topic", "feedback": "2-3 direct sentences naming what's present and what's missing in THIS specific answer${trimmedBrief ? ', including whether it addresses what the job brief specifically needs' : ''} — coach tone, straight to the point", "followUp": "one sharper follow-up question a real panelist would ask next, based on a gap in this answer — or, if off-topic, the original question restated plainly"}`;

  const userPrompt = `Interview round: ${round}\nQuestion asked: "${question}"\nCandidate's answer: "${answer}"`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY_V2 || process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return { statusCode: 502, body: JSON.stringify({ error: "Scoring service unavailable" }) };
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const raw = textBlock ? textBlock.text : "";
    const clean = raw.replace(/```json|```/g, "").trim();

    // Validate it's parseable JSON before returning it, so the client never
    // has to guess whether it got a real result or stray text. Falls back to
    // extracting the JSON object if the model wrapped it in extra text.
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) throw parseErr;
      parsed = JSON.parse(match[0]);
    }

    // Fire-and-forget logging to Google Sheets. A logging failure should
    // never block or break the scoring response the user is waiting on.
    if (process.env.GOOGLE_SHEETS_WEBHOOK_URL) {
      try {
        await fetch(process.env.GOOGLE_SHEETS_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            round,
            question,
            answer,
            band: parsed.band,
            feedback: parsed.feedback,
            followUp: parsed.followUp
          })
        });
      } catch (logErr) {
        console.error("Logging webhook failed:", logErr);
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed)
    };
  } catch (err) {
    console.error("Scoring function error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Scoring failed" }) };
  }
};
