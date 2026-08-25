// netlify/functions/chat.js
//
// This function is the "brain" of the recruiter agent. The browser widget
// calls THIS endpoint (never the Claude API directly), so your API key
// never touches the browser.
//
// What it does, in order:
//   1. Reads the conversation history sent by the widget
//   2. Calls the Claude API with the system prompt + conversation
//   3. Fires off a log of the exchange to your Google Sheet (non-blocking —
//      if logging fails, the chat still works)
//   4. Returns Claude's reply to the widget

const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'system-prompt.txt'),
  'utf-8'
);

// Basic in-memory rate limiting per IP. Netlify functions are stateless
// between cold starts, so this is a soft limit, not a hard guarantee —
// but it stops the simplest abuse (someone hammering the endpoint in a
// tight loop). For stronger protection later, consider Netlify Rate Limiting
// (built into newer plans) or a small Upstash/Redis counter.
const requestLog = new Map(); // ip -> [timestamps]
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 15; // max messages per minute per IP

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

exports.handler = async (event) => {
  // CORS headers — adjust ALLOWED_ORIGIN in Netlify env vars once you know
  // your final domain (Figma Sites URL, custom domain, etc).
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  const ip =
    event.headers['x-nf-client-connection-ip'] ||
    event.headers['client-ip'] ||
    'unknown';

  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({
        error:
          "I'm getting a lot of messages right now — give me a moment and try again shortly.",
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: 'Invalid JSON' };
  }

  const { messages, sessionId } = payload;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, headers, body: 'Missing messages array' };
  }

  // Cap conversation length sent to the model (cost + abuse control).
  // Keeps the most recent turns, which is what matters for a live chat.
  const MAX_TURNS = 40;
  const trimmedMessages = messages.slice(-MAX_TURNS);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Server misconfigured: missing ANTHROPIC_API_KEY.',
      }),
    };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: trimmedMessages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Claude API error:', response.status, errText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error:
            "Something went wrong on my end — mind trying that again in a moment?",
        }),
      };
    }

    const data = await response.json();
    const replyText = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    // Fire-and-forget logging to Google Sheet. We don't await this in a
    // way that blocks the reply — but we do want errors caught so a
    // logging failure never breaks the chat experience.
    logToSheet({
      sessionId,
      userMessage: trimmedMessages[trimmedMessages.length - 1]?.content || '',
      assistantReply: replyText,
      ip,
    }).catch((err) => console.error('Sheet logging failed:', err));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: replyText }),
    };
  } catch (err) {
    console.error('Unexpected error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Unexpected server error — please try again shortly.',
      }),
    };
  }
};

async function logToSheet({ sessionId, userMessage, assistantReply, ip }) {
  const webhookUrl = process.env.SHEET_WEBHOOK_URL;
  if (!webhookUrl) return; // logging is optional — skip quietly if not set up

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: sessionId || 'unknown',
      userMessage,
      assistantReply,
      // IP is logged only as a coarse signal (e.g. rough geography via
      // later lookup if ever needed) — never shown to Sabrina as-is in the
      // sheet UI beyond what she configures the Apps Script to reveal.
      ip,
    }),
  });
}
