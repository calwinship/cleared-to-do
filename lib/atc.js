// Shared ATC logic: prompt, LLM call, and normalisation of the board.
import { shortLabel } from './db.js';

// OPENROUTER_MODELS (comma-separated, max 3) overrides the chain, e.g. "paid/model,free/model:free".
// OpenRouter tries them in order. Default: free models that support strict JSON-schema output.
const DEFAULT_MODELS = ['baidu/ernie-5.5-flash-preview:free', 'nvidia/nemotron-3.5-super-vl:free', 'openrouter/free'];
function modelChain() {
  const fromEnv = (process.env.OPENROUTER_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv.slice(0, 3) : DEFAULT_MODELS;
}

const FLIGHT = {
  task: { type: 'string', description: 'The task restated plainly in under 8 words' },
  callsign: { type: 'string', description: 'ONE uppercase word naming the task, e.g. "LAUNDRY"' },
  minutes: { type: 'integer', description: 'Realistic estimate in minutes' },
};
export const BOARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sequence', 'holding'],
  properties: {
    sequence: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['task', 'callsign', 'minutes'], properties: FLIGHT },
    },
    holding: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'callsign', 'minutes', 'note'],
        properties: { ...FLIGHT, note: { type: 'string', description: 'Short ATC-style note, max 6 words' } },
      },
    },
  },
};

export const MAX_INPUT = 2000;
export const MAX_FLIGHTS = 12;

export const SYSTEM = `You are the tower controller at "Cleared To Do", an airfield where to-do items are flights.
Convert the pilot's brain-dump of to-dos into flights. Respond with ONLY a JSON object, no prose, no code fences.

Rules:
- One flight per distinct task. Split run-on lists. Ignore filler words. At most ${MAX_FLIGHTS} flights.
- "task": the task restated plainly in under 8 words.
- "callsign": ONE real uppercase English word that names the task, never two words glued together (A-Z only, max 10 letters; "MUM" not "CALLMUM"). Examples: "LAUNDRY", "TAXES", "DENTIST". It is a short label for a map.
- "minutes": realistic integer estimate of how long it takes.
- SEQUENCE (cleared to land): urgent, time-bound, or quick-and-concrete tasks. Order them: most urgent first, then quick wins.
- HOLDING: anything vague, avoidable, someday/maybe, or with no clear next action. Give each a short ATC-style "note" (max 6 words), e.g. "expect further clearance tomorrow", "say intentions", "expect delay, low priority".

Shape:
{"sequence":[{"task":"Do laundry","callsign":"LAUNDRY","minutes":20}],
 "holding":[{"task":"Sort out taxes","callsign":"TAXES","minutes":120,"note":"expect further clearance tomorrow"}]}`;

// Spoken form of a callsign: just the word, Title Case. The number stays on the strip only.
function spokenCallsign(callsign) {
  const word = callsign.split(' ')[0];
  return word.charAt(0) + word.slice(1).toLowerCase();
}

const ORDINAL = ['one', 'two', 'three'];

// The tower call is always built here (never by the model) so phrasing stays consistent.
export function templateTransmission(flights) {
  const seq = flights.filter((f) => f.lane === 'seq').slice(0, 3).map((f) => spokenCallsign(f.callsign));
  const hold = flights.filter((f) => f.lane === 'hold');
  const parts = [
    'Tower, all stations.',
    ...seq.map((name, i) =>
      i === 0 ? `${name}, cleared to do, number one.` : `${name}, number ${ORDINAL[i]}, follow ${seq[i - 1]}.`,
    ),
    ...hold.slice(0, 2).map((f) => `${spokenCallsign(f.callsign)}, hold, ${f.note || 'expect further clearance'}.`),
  ];
  if (flights.filter((f) => f.lane === 'seq').length > 3 || hold.length > 2) {
    parts.push('Remaining traffic, follow the strips.');
  }
  return parts.join(' ');
}

function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanCallsign(raw, task) {
  let word = String(raw || '').toUpperCase().trim().split(/\s+/)[0].replace(/[^A-Z]/g, '').slice(0, 10);
  if (!word) word = String(task || 'TASK').toUpperCase().replace(/[^A-Z ]/g, '').split(' ').find((w) => w.length > 2)?.slice(0, 10) || 'TASK';
  return word;
}

function cleanText(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalise(parsed) {
  const flights = [];
  const take = (list, lane) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (flights.length >= MAX_FLIGHTS) return;
      if (!item || typeof item !== 'object') continue;
      const task = cleanText(item.task, 80);
      if (!task) continue;
      const minutes = Math.min(600, Math.max(1, Math.round(Number(item.minutes) || 15)));
      flights.push({
        id: `f${flights.length + 1}`,
        callsign: cleanCallsign(item.callsign, task),
        task,
        minutes,
        lane,
        note: lane === 'hold' ? cleanText(item.note, 48) || 'expect further clearance' : '',
        landed: false,
      });
    }
  };
  take(parsed.sequence, 'seq');
  take(parsed.holding, 'hold');

  return { flights, transmission: templateTransmission(flights) };
}

// Local testing only (dev server with OPENROUTER_FIXTURE=1): a deterministic board without spending model quota.
function fixtureBoard(text) {
  const parts = text.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean).slice(0, MAX_FLIGHTS);
  const later = /maybe|someday|some day|one day|at some point|eventually/i;
  const item = (t, i) => ({ task: t.slice(0, 60), callsign: shortLabel(t), minutes: 10 + ((i * 7) % 50) });
  return {
    sequence: parts.filter((t) => !later.test(t)).map(item),
    holding: parts.filter((t) => later.test(t)).map((t, i) => ({ ...item(t, i + 5), note: 'expect further clearance' })),
  };
}

export async function requestClearance(text, apiKey) {
  if (process.env.OPENROUTER_FIXTURE === '1' && !process.env.VERCEL) {
    return { ...normalise(fixtureBoard(text)), model: 'fixture', usage: { in: 0, out: 0, cost: 0 } };
  }
  const body = {
    models: modelChain(),
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Pilot's to-do brain-dump:\n"""\n${text}\n"""` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'board', strict: true, schema: BOARD_SCHEMA } },
    provider: { require_parameters: true }, // only route to providers that enforce the schema
    temperature: 0.4,
    max_tokens: 4000, // reasoning models spend part of this before answering
    reasoning: { effort: 'low', exclude: true },
    usage: { include: true },
  };

  let lastErr = 'no response';
  // One deadline for the whole call: OpenRouter sends headers at once and holds the body open while
  // the model works, so the timeout must cover reading the body, and a slow first attempt eats the retry.
  const deadline = Date.now() + 52000; // function limit is 60s
  for (let attempt = 0; attempt < 2 && deadline - Date.now() > 8000; attempt++) {
    let r, data;
    try {
      r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        signal: AbortSignal.timeout(deadline - Date.now()),
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Cleared To Do' },
        body: JSON.stringify(body),
      });
      data = await r.json();
    } catch (err) {
      lastErr = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'model timed out' : `bad response (${err.message})`;
      console.warn(JSON.stringify({ evt: 'clearance_fetch_fail', attempt, err: lastErr }));
      continue;
    }
    if (!r.ok || data.error) {
      lastErr = data.error?.message || `HTTP ${r.status}`;
      // Our own key out of credit or daily free quota: retrying will not help. Upstream pool limits might clear.
      if (r.status === 402 || (r.status === 429 && !data.error?.metadata?.limit_source?.startsWith('upstream'))) break;
      continue;
    }
    const parsed = extractJson(data.choices?.[0]?.message?.content);
    if (parsed) {
      const board = normalise(parsed);
      if (board.flights.length) {
        const u = data.usage || {};
        console.log(JSON.stringify({ evt: 'clearance', model: data.model, in: u.prompt_tokens, out: u.completion_tokens, cost: u.cost ?? null }));
        return { ...board, model: data.model, usage: { in: u.prompt_tokens, out: u.completion_tokens, cost: u.cost ?? null } };
      }
      lastErr = 'model returned no flights';
    } else {
      const c = data.choices?.[0];
      console.warn(JSON.stringify({ evt: 'clearance_parse_fail', keys: Object.keys(data), model: data.model, finish: c?.finish_reason, len: c?.message?.content?.length ?? null, head: c?.message?.content?.slice(0, 160) ?? null, usage: data.usage && { out: data.usage.completion_tokens, reasoning: data.usage.completion_tokens_details?.reasoning_tokens } }));
      lastErr = 'model returned unparseable JSON';
    }
  }
  const e = new Error(lastErr);
  e.status = 502;
  throw e;
}
