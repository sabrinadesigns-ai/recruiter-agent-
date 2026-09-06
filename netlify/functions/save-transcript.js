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

  const { email, sessionLog } = payload;
  if (!email || !Array.isArray(sessionLog) || sessionLog.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing email or session log" }) };
  }

  // Very light validation — not a full RFC 5322 check, just catches obvious junk.
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: "That doesn't look like a valid email" }) };
  }

  if (!process.env.GOOGLE_SHEETS_WEBHOOK_URL) {
    console.error("GOOGLE_SHEETS_WEBHOOK_URL is not set");
    return { statusCode: 500, body: JSON.stringify({ error: "Save is not configured yet" }) };
  }

  try {
    const response = await fetch(process.env.GOOGLE_SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "transcript", email, sessionLog })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Apps Script webhook error:", response.status, errText);
      return { statusCode: 502, body: JSON.stringify({ error: "Couldn't save right now" }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ok" })
    };
  } catch (err) {
    console.error("save-transcript function error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Couldn't save right now" }) };
  }
};
