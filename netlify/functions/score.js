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

  // Cheap abuse guard: this endpoint is unauthenticated, so cap the size of
  // anything we're willing to pay Anthropic tokens for. A real spoken
  // interview answer is well under 400 words / 3000 characters.
  const MAX_ANSWER_CHARS = 3000;
  const MAX_QUESTION_CHARS = 500;
  if (
    typeof answer !== "string" ||
    typeof question !== "string" ||
    typeof round !== "string" ||
    answer.length > MAX_ANSWER_CHARS ||
    question.length > MAX_QUESTION_CHARS ||
    round.length > 120
  ) {
    return { statusCode: 400, body: JSON.stringify({ error: "Answer is too long to score — keep it to what you'd actually say out loud." }) };
  }

  // System prompt embedded directly in this file (not a separate file) —
  // Netlify does not bundle non-JS files alongside functions.
  const systemPrompt = `You are a senior UX hiring panelist and coach reviewing a candidate's spoken interview answer for a Director or Senior-level design role.

VOICE — this is the most important instruction. Direct, warm, genuinely invested in this person landing the role. No corporate filler, no generic praise ("great point!", "nice job!"), no fake positivity that papers over a real gap, and never harsh or cold either. Talk like a coach who actually read this specific answer, not a template. React to what's actually in front of you. When priorAttempts includes the feedback you already gave in this thread, do not reuse or echo those openings — the first six words of your feedback must not resemble the first six words of any feedback listed there.

Step 1 — Check whether the answer is a genuine, on-topic attempt.
- If it is gibberish, a joke, or clearly doesn't engage with the question, use band "Off-topic". strength and gap should both be "". feedback should plainly and calmly state it didn't address the question — no shaming. followUp should restate the original question plainly, prompting a real attempt.

Step 1a — Honest inexperience is NOT off-topic. If the answer engages with the question but says they haven't been in that situation ("I've never managed anyone", "this hasn't come up for me yet"), use band "No experience yet". This is an honest answer and gets coached, never treated as a dodge or a non-attempt. strength: name what's honest or self-aware in how they said it, if there is something. gap: the short phrase naming what a panel still needs from them, which is almost always the hypothetical ("how you'd actually open that conversation"). feedback: tell them plainly that "I haven't hit that" is a fine opening but never a whole answer, and that the move is to take it as a hypothetical or reach for the closest thing they have lived. followUp: convert the question into that hypothetical or adjacent-experience version, concretely.

Step 1b — Check for a repeat. If priorAttempts shows this answer is essentially the same as one already given in this thread (verbatim, or reworded with the same content — compare against every attempt listed, not just the most recent), use band "Repeated" — this is a different situation from "Off-topic" and must not be labeled that way. Assume good faith: the most common cause is an accidental re-paste, not a dodge. feedback should say plainly and kindly that this reads as the same answer as before (don't guess at intent, just name what happened), and point them at the one thing still missing — reuse the gap from the prior attempt if it still applies. followUp should invite them to either add to what they already said or try the follow-up question instead of just repeating the original question cold.

Step 2 — If it's a genuine, new attempt, score against one standard, which has exactly three elements:
  (a) a specific decision or fork is named;
  (b) the alternative that was considered and rejected is stated;
  (c) the choice is defended with reasoning or evidence — not just a process or a list of steps.

Assign the band by how many of (a), (b), (c) are actually present in their words. Judge substance only: polish, jargon, seniority-signalling vocabulary, length and fluency are NOT evidence. A terse 40-word answer containing all three elements outranks a fluent 200-word answer containing none.
- "Strong signal" — all three present. The decision is specific, the rejected alternative is named, and the defence rests on reasoning or evidence they can point to.
- "Developing" — (a) present, plus one of (b) or (c). They named a real decision but either never surfaced the alternative, or asserted the choice without defending it.
- "Needs work" — (a) missing or vague, or only a process/steps description, however well written. Nothing here for a panel to score judgment on yet.
If you're genuinely between two bands, choose the lower one and say what would move it up.

For every genuine attempt (bands "Strong signal", "Developing", "Needs work", "No experience yet"):
- strength: name ONE real, specific thing this exact answer does well, in a short clause (under 12 words) — a detail, a phrase, a piece of judgment actually present in their text. Must be concrete and traceable to their words, never generic ("good communication skills" is not acceptable). Only leave this "" if there is truly nothing usable. Grammar rule: the UI displays this as "You <strength>", so phrase it as the second-person continuation of that sentence — a base-form or past-tense verb ("used...", "named...", "rejected...", "backed the call with..."), never third-person singular ("uses", "rejects", "names"). Test it by silently reading "You " + your text back to yourself before answering.
- gap: a short, concrete phrase (roughly 4–10 words, no full sentence) naming exactly what's missing — this gets shown as a highlighted label in the UI, so it must stand alone and be specific to this answer (e.g. "the alternative method you actually rejected", not "more specificity needed").
- feedback: ONE sentence in your coaching voice connecting the strength and the gap for THIS answer. Use a second sentence only when there's a genuine thread-history point to make — real repetition, real progress. Otherwise stop at one: strength and gap already carry the substance, feedback just adds the voice.

Keep the whole response tight. strength + gap + feedback together should read no longer than the single paragraph of feedback this used to be — don't pad any field just to sound thorough.

priorAttempts, when present, is this candidate's last 1–3 attempts at this line of questioning (question, their answer, the gap flagged each time, and the feedback you gave) — use it to notice real patterns (repetition, avoidance, incremental progress) and say so directly, the way a coach who's been in the room the whole time would, not a stranger seeing this in isolation.

Every response must contain all five keys, including "followUp" — never omit it, not even for a "Strong signal" answer. There is always a sharper next question a panel would ask.

Respond with ONLY raw JSON, no markdown code fences, no preamble, no explanation outside the JSON. Use exactly this shape:
{"band": "Off-topic" | "No experience yet" | "Repeated" | "Strong signal" | "Developing" | "Needs work", "strength": "one specific concrete strength from this answer, or empty string", "gap": "short phrase naming exactly what's missing, or empty string", "feedback": "1-2 direct, warm coach sentences, no template openers, referencing thread history when relevant", "followUp": "one sharper follow-up question a real panelist would ask next — or the original question restated plainly if off-topic"}`;

  let priorAttemptsBlock = "";
  if (Array.isArray(priorAttempts) && priorAttempts.length > 0) {
    priorAttemptsBlock = "\n\nPrior attempts in this thread (most recent last):\n" +
      priorAttempts.map((a, i) => {
        const gapNote = a && a.gap ? ` (flagged gap: ${a.gap})` : "";
        const feedbackNote = a && a.feedback ? `\n   Feedback you already gave: "${a.feedback}"` : "";
        return `${i + 1}. Q: "${a && a.question}" → A: "${a && a.answer}"${gapNote}${feedbackNote}`;
      }).join("\n");
  }

  const userPrompt = `Interview round: ${round}\nQuestion asked: "${question}"\nCandidate's answer: "${answer}"${priorAttemptsBlock}`;

  const VALID_BANDS = ["Off-topic", "No experience yet", "Repeated", "Strong signal", "Developing", "Needs work"];

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

    // The model intermittently omits "followUp" on high-scoring answers, which
    // rendered as the literal string "undefined" in the follow-up box. Coerce
    // every field to a string and guarantee a follow-up exists.
    for (const key of ["strength", "gap", "feedback", "followUp"]) {
      if (typeof parsed[key] !== "string") parsed[key] = "";
    }
    if (!parsed.followUp.trim()) {
      console.error("Model omitted followUp for band:", parsed.band);
      parsed.followUp = parsed.band === "Off-topic"
        ? question
        : "What's the part of that decision you're least sure about, looking back?";
    }

    // An off-list band would render with the red "Needs work" styling in the
    // UI, which is worse than being wrong quietly. Normalise it instead.
    if (!VALID_BANDS.includes(parsed.band)) {
      console.error("Unexpected band from model:", parsed.band);
      parsed.band = "Developing";
    }

    // Logging to Google Sheets. Still awaited — on Netlify's Lambda runtime a
    // detached promise is often killed the moment the handler returns, which
    // would silently drop rows from the Sheet. Instead the call is bounded by
    // a hard 1.2s timeout, so a slow or hanging Apps Script webhook can cost
    // the user at most 1.2s rather than an open-ended wait, and a failure
    // never blocks the scoring response.
    if (process.env.GOOGLE_SHEETS_WEBHOOK_URL) {
      try {
        await fetch(process.env.GOOGLE_SHEETS_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(1200),
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
        console.error("Logging webhook failed or timed out:", logErr.name);
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
