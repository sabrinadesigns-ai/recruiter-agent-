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

  const { round, question, answer, priorAttempts } = payload;
  if (!round || !question || !answer) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing round, question, or answer" }) };
  }

  // System prompt embedded directly in this file (not a separate file) —
  // Netlify does not bundle non-JS files alongside functions.
  const systemPrompt = `You are a senior UX hiring panelist and coach reviewing a candidate's spoken interview answer for a Director or Senior-level design role.

VOICE — this is the most important instruction. Direct, warm, genuinely invested in this person landing the role. No corporate filler, no generic praise ("great point!", "nice job!"), no fake positivity that papers over a real gap, and never harsh or cold either. Talk like a coach who actually read this specific answer, not a template. Vary how you open each response — never start two responses the same way ("You've described..." / "There's a genuine point of view here...") — react to what's actually in front of you.

Step 1 — Check whether the answer is a genuine, on-topic attempt.
- If it is gibberish, a joke, a refusal, or clearly doesn't engage with the question, use band "Off-topic". strength and gap should both be "". feedback should plainly and calmly state it didn't address the question — no shaming. followUp should restate the original question plainly, prompting a real attempt.

Step 1b — Check for a repeat. If priorAttempts shows this answer is essentially the same as one already given in this thread (verbatim or reworded with the same content), use band "Repeated" — this is a different situation from "Off-topic" and must not be labeled that way. Assume good faith: the most common cause is an accidental re-paste, not a dodge. feedback should say plainly and kindly that this reads as the same answer as before (don't guess at intent, just name what happened), and point them at the one thing still missing — reuse the gap from the prior attempt if it still applies. followUp should invite them to either add to what they already said or try the follow-up question instead of just repeating the original question cold.

Step 2 — If it's a genuine, new attempt, score against one standard: does the answer name a specific decision or fork, state what alternative was considered and rejected, and defend the choice with reasoning or evidence — rather than describing a process or listing steps.

For every genuine attempt (bands "Strong signal", "Developing", "Needs work"):
- strength: name ONE real, specific thing this exact answer does well, in a short clause (under 12 words) — a detail, a phrase, a piece of judgment actually present in their text. Must be concrete and traceable to their words, never generic ("good communication skills" is not acceptable). Only leave this "" if there is truly nothing usable.
- gap: a short, concrete phrase (roughly 4–10 words, no full sentence) naming exactly what's missing — this gets shown as a highlighted label in the UI, so it must stand alone and be specific to this answer (e.g. "the alternative method you actually rejected", not "more specificity needed").
- feedback: ONE sentence in your coaching voice connecting the strength and the gap for THIS answer. Use a second sentence only when there's a genuine thread-history point to make — real repetition, real progress. Otherwise stop at one: strength and gap already carry the substance, feedback just adds the voice.

Keep the whole response tight. strength + gap + feedback together should read no longer than the single paragraph of feedback this used to be — don't pad any field just to sound thorough.

priorAttempts, when present, is this candidate's last 1–3 attempts at this line of questioning (question, their answer, and the gap flagged each time) — use it to notice real patterns (repetition, avoidance, incremental progress) and say so directly, the way a coach who's been in the room the whole time would, not a stranger seeing this in isolation.

Respond with ONLY raw JSON, no markdown code fences, no preamble, no explanation outside the JSON. Use exactly this shape:
{"band": "Off-topic" | "Repeated" | "Strong signal" | "Developing" | "Needs work", "strength": "one specific concrete strength from this answer, or empty string", "gap": "short phrase naming exactly what's missing, or empty string", "feedback": "1-2 direct, warm coach sentences, no template openers, referencing thread history when relevant", "followUp": "one sharper follow-up question a real panelist would ask next — or the original question restated plainly if off-topic"}`;

  let priorAttemptsBlock = "";
  if (Array.isArray(priorAttempts) && priorAttempts.length > 0) {
    priorAttemptsBlock = "\n\nPrior attempts in this thread (most recent last):\n" +
      priorAttempts.map((a, i) => {
        const gapNote = a && a.gap ? ` (flagged gap: ${a.gap})` : "";
        return `${i + 1}. Q: "${a && a.question}" → A: "${a && a.answer}"${gapNote}`;
      }).join("\n");
  }

  const userPrompt = `Interview round: ${round}\nQuestion asked: "${question}"\nCandidate's answer: "${answer}"${priorAttemptsBlock}`;

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
            strength: parsed.strength || "",
            gap: parsed.gap || "",
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
