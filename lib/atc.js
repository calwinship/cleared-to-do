// Shared ATC logic: prompt, LLM call, and normalisation of the board.

// OpenRouter accepts at most 3 fallback models per request, so each attempt gets its own chain.
const MODEL_CHAINS = [
  ['baidu/ernie-5.5-flash-preview:free', 'nvidia/nemotron-3.5-super-vl:free', 'google/gemma-4-31b-it:free'],
  ['nvidia/nemotron-3.5-super-vl:free', 'google/gemma-4-26b-a4b-it:free', 'openrouter/free'],
];

export const MAX_INPUT = 2000;
export const MAX_FLIGHTS = 12;
export const MAX_TRANSMISSION = 420; // keeps ElevenLabs free quota (10k chars/mo) alive

const SYSTEM = `You are the tower controller at "Cleared To Do", an airfield where to-do items are flights.
Convert the pilot's brain-dump of to-dos into flights. Respond with ONLY a JSON object, no prose, no code fences.

Rules:
- One flight per distinct task. Split run-on lists. Ignore filler words. At most ${MAX_FLIGHTS} flights.
- "task": the task restated plainly in under 8 words.
- "callsign": ONE real uppercase English word that names the task, never two words glued together (A-Z only, max 10 letters; "MUM" not "CALLMUM") + a space + a 2-digit number. Examples: "LAUNDRY 24", "TAXES 91", "DENTIST 37". Numbers must look like real flight numbers: varied and NOT sequential (never 01, 02, 03...). Callsigns must be unique.
- "minutes": realistic integer estimate of how long it takes.
- SEQUENCE (cleared to land): urgent, time-bound, or quick-and-concrete tasks. Order them: most urgent first, then quick wins.
- HOLDING: anything vague, avoidable, someday/maybe, or with no clear next action. Give each a short ATC-style "note" (max 6 words), e.g. "expect further clearance tomorrow", "say intentions", "expect delay, low priority".

Shape:
{"sequence":[{"task":"Do laundry","callsign":"LAUNDRY 24","minutes":20}],
 "holding":[{"task":"Sort out taxes","callsign":"TAXES 91","minutes":120,"note":"expect further clearance tomorrow"}]}`;

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

// Small models love LAUNDRY 01, MILK 02... Re-issue believable flight numbers if so.
function fixSequentialNumbers(flights) {
  const nums = flights.map((f) => parseInt(f.callsign.split(' ')[1], 10));
  const sequential = nums.length > 1 && nums.every((n, i) => n === nums[0] + i);
  if (!sequential) return;
  const used = new Set();
  for (const f of flights) {
    const word = f.callsign.split(' ')[0];
    let h = 0;
    for (const c of f.task + word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    let n = 11 + (h % 88);
    while (used.has(n)) n = 11 + ((n + 13) % 88);
    used.add(n);
    f.callsign = `${word} ${n}`;
  }
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

function cleanCallsign(raw, task, used) {
  let [word = '', num = ''] = String(raw || '').toUpperCase().trim().split(/\s+/);
  word = word.replace(/[^A-Z]/g, '').slice(0, 10);
  if (!word) word = String(task || 'TASK').toUpperCase().replace(/[^A-Z ]/g, '').split(' ').find(Boolean)?.slice(0, 10) || 'TASK';
  num = num.replace(/\D/g, '').slice(0, 2);
  if (!num) num = String(Math.floor(Math.random() * 90) + 10);
  num = num.padStart(2, '0');
  let cs = `${word} ${num}`;
  while (used.has(cs)) {
    num = String((parseInt(num, 10) + 7) % 100).padStart(2, '0');
    cs = `${word} ${num}`;
  }
  used.add(cs);
  return cs;
}

function cleanText(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalise(parsed) {
  const used = new Set();
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
        callsign: cleanCallsign(item.callsign, task, used),
        task,
        minutes,
        lane,
        note: lane === 'hold' ? cleanText(item.note, 48) || 'expect further clearance' : '',
        seq: lane === 'seq' ? flights.filter((f) => f.lane === 'seq').length + 1 : null,
        landed: false,
      });
    }
  };
  take(parsed.sequence, 'seq');
  take(parsed.holding, 'hold');

  fixSequentialNumbers(flights);
  return { flights, transmission: templateTransmission(flights) };
}

export async function requestClearance(text, apiKey) {
  const base = {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Pilot's to-do brain-dump:\n"""\n${text}\n"""` },
    ],
    temperature: 0.4,
    max_tokens: 4000,
    reasoning: { effort: 'low', exclude: true },
  };

  let lastErr = 'no response';
  for (const models of MODEL_CHAINS) {
    const body = { ...base, models };
    // Free models occasionally hang; cap each attempt so the fallback chain still fits in the 60s function limit.
    let r;
    try {
      r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      signal: AbortSignal.timeout(25000),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Cleared To Do',
      },
      body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err.name === 'TimeoutError' ? 'model timed out' : err.message;
      continue;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      lastErr = data.error?.message || `HTTP ${r.status}`;
      continue;
    }
    const content = data.choices?.[0]?.message?.content;
    const parsed = extractJson(content);
    if (parsed) {
      const board = normalise(parsed);
      if (board.flights.length) return { ...board, model: data.model };
      lastErr = 'model returned no flights';
    } else {
      lastErr = 'model returned unparseable JSON';
    }
  }
  const e = new Error(lastErr);
  e.status = 502;
  throw e;
}
