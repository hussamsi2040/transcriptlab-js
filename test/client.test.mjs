import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  NotFoundError,
  RateLimitedError,
  StillProcessingError,
  TranscriptLab,
  TranscriptLabError,
  TranscriptUnavailableError,
  videoIdFromInput,
  verifyWebhook,
} from '../dist/index.js';

const SAMPLE_TRANSCRIPT = {
  v: 1,
  video_id: 'dQw4w9WgXcQ',
  url: 'https://youtu.be/dQw4w9WgXcQ',
  language: { code: 'en', name: 'English', is_generated: true },
  translation: null,
  snippets: [{ text: 'never gonna give you up', start: 0, duration: 2.5 }],
  text: 'never gonna give you up',
  fetched_at: '2026-11-12T00:00:00Z',
};

const SAMPLE_JOB = {
  id: 'job_01J',
  type: 'batch',
  status: 'queued',
  state: 'waiting',
  terminal: false,
  progress: 0,
  total_items: 2,
  completed_items: 0,
  failed_items: 0,
  credits_charged: 0,
  error_code: null,
  error: null,
  result_url: null,
  created_at: 1_700_000_000,
  started_at: null,
  finished_at: null,
  updated_at: 1_700_000_000,
  poll_url: 'https://transcriptlab.dev/v1/jobs/job_01J',
  items_url: 'https://transcriptlab.dev/v1/jobs/job_01J/items',
};

/** Stubbed fetch: records calls, serves scripted responses. */
function stubFetch(handlers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const method = init.method ?? 'GET';
    for (const h of handlers) {
      if (h.method === method && h.match.test(url)) {
        const out = typeof h.respond === 'function' ? h.respond({ url, init }) : h.respond;
        const headers = new Headers(out.headers ?? {});
        if (typeof out.body === 'string' && !headers.has('content-type')) {
          headers.set('content-type', 'text/plain');
        } else if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
        return new Response(
          typeof out.body === 'string' ? out.body : JSON.stringify(out.body),
          { status: out.status ?? 200, headers },
        );
      }
    }
    return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'unstubbed', request_id: 'req_x' } }), { status: 500 });
  };
  return { fetch, calls };
}

const lab = (fetch, extra = {}) =>
  new TranscriptLab({ apiKey: 'ytgw_' + 'a'.repeat(24), fetch, maxRetries: 0, ...extra });

describe('videoIdFromInput', () => {
  it('parses every YouTube URL shape', () => {
    assert.equal(videoIdFromInput('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(videoIdFromInput('https://youtu.be/dQw4w9WgXcQ?t=42'), 'dQw4w9WgXcQ');
    assert.equal(videoIdFromInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x'), 'dQw4w9WgXcQ');
    assert.equal(videoIdFromInput('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(videoIdFromInput('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(videoIdFromInput('not a video'), null);
    assert.equal(videoIdFromInput('https://vimeo.com/12345'), null);
  });
});

describe('TranscriptLab', () => {
  it('sends Bearer auth and camelCase→snake_case bodies', async () => {
    const { fetch, calls } = stubFetch([
      { method: 'POST', match: /\/v1\/transcripts$/, respond: { status: 200, body: SAMPLE_TRANSCRIPT } },
    ]);
    const res = await lab(fetch).requestTranscript({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      lang: 'en',
      deadlineMs: 5000,
      metadata: true,
    });
    assert.equal(res.status, 'ready');
    assert.equal(res.transcript.video_id, 'dQw4w9WgXcQ');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ytgw_${'a'.repeat(24)}`);
    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(
      { url: sent.url, lang: sent.lang, deadline_ms: sent.deadline_ms, metadata: sent.metadata, video_id: sent.video_id },
      { url: 'https://youtu.be/dQw4w9WgXcQ', lang: 'en', deadline_ms: 5000, metadata: true, video_id: undefined },
    );
  });

  it('getTranscript polls the read route on 202 until ready', async () => {
    const polls = [];
    const { fetch, calls } = stubFetch([
      {
        method: 'POST',
        match: /\/v1\/transcripts$/,
        respond: {
          status: 202,
          headers: { location: 'https://transcriptlab.dev/v1/transcripts/dQw4w9WgXcQ?format=json', 'retry-after': '0' },
          body: { video_id: 'dQw4w9WgXcQ', state: 'processing' },
        },
      },
      {
        method: 'GET',
        match: /\/v1\/transcripts\/dQw4w9WgXcQ$/,
        respond: () => {
          polls.push(1);
          return polls.length < 2
            ? { status: 202, headers: { 'retry-after': '0' }, body: { video_id: 'dQw4w9WgXcQ', state: 'processing' } }
            : { status: 200, body: SAMPLE_TRANSCRIPT };
        },
      },
    ]);
    const t = await lab(fetch).getTranscript({ videoId: 'dQw4w9WgXcQ' });
    assert.equal(t.video_id, 'dQw4w9WgXcQ');
    assert.equal(calls.filter((c) => c.init.method === 'GET' || c.init.method === undefined).length, 2);
  });

  it('getTranscript throws StillProcessingError when the wait budget expires', async () => {
    const { fetch } = stubFetch([
      {
        method: 'POST',
        match: /\/v1\/transcripts$/,
        respond: { status: 202, headers: { 'retry-after': '0' }, body: { video_id: 'dQw4w9WgXcQ', state: 'processing' } },
      },
      {
        method: 'GET',
        match: /\/v1\/transcripts\/dQw4w9WgXcQ$/,
        respond: { status: 202, headers: { 'retry-after': '0' }, body: { video_id: 'dQw4w9WgXcQ', state: 'processing' } },
      },
    ]);
    await assert.rejects(
      lab(fetch).getTranscript({ videoId: 'dQw4w9WgXcQ' }, { timeoutMs: 5 }),
      (err) => err instanceof StillProcessingError && err.resume.kind === 'transcript',
    );
  });

  it('maps API errors to typed subclasses with request_id', async () => {
    const { fetch } = stubFetch([
      {
        method: 'GET',
        match: /./,
        respond: { status: 404, body: { error: { code: 'video_not_found', message: 'nope', request_id: 'req_9' } } },
      },
    ]);
    await assert.rejects(lab(fetch).readTranscript('zzzzzzzzzzz'), (err) => {
      assert.ok(err instanceof NotFoundError);
      assert.ok(err instanceof TranscriptLabError);
      assert.equal(err.code, 'video_not_found');
      assert.equal(err.requestId, 'req_9');
      return true;
    });
  });

  it('422 maps to TranscriptUnavailableError', async () => {
    const { fetch } = stubFetch([
      {
        method: 'GET',
        match: /./,
        respond: { status: 422, body: { error: { code: 'transcript_unavailable', message: 'gone', request_id: 'r' } } },
      },
    ]);
    await assert.rejects(lab(fetch).readTranscript('zzzzzzzzzzz'), TranscriptUnavailableError);
  });

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    let n = 0;
    const { fetch, calls } = stubFetch([
      {
        method: 'GET',
        match: /./,
        respond: () => {
          n++;
          return n === 1
            ? { status: 429, headers: { 'retry-after': '0' }, body: { error: { code: 'rate_limited', message: 'slow', request_id: 'r' } } }
            : { status: 200, body: SAMPLE_TRANSCRIPT };
        },
      },
    ]);
    const res = await lab(fetch, { maxRetries: 1 }).readTranscript('dQw4w9WgXcQ');
    assert.equal(res.status, 'ready');
    assert.equal(calls.length, 2);
  });

  it('gives up with RateLimitedError when retries are exhausted', async () => {
    const { fetch } = stubFetch([
      {
        method: 'GET',
        match: /./,
        respond: { status: 429, headers: { 'retry-after': '0' }, body: { error: { code: 'rate_limited', message: 'slow', request_id: 'r' } } },
      },
    ]);
    await assert.rejects(lab(fetch, { maxRetries: 1 }).readTranscript('x'), (err) => {
      assert.ok(err instanceof RateLimitedError);
      assert.equal(err.retryAfter, 0);
      return true;
    });
  });

  it('batch() submits, waits for the job, and collects all item pages', async () => {
    const doneJob = { ...SAMPLE_JOB, status: 'succeeded', state: 'done', terminal: true, completed_items: 2, progress: 1 };
    const { fetch, calls } = stubFetch([
      { method: 'POST', match: /\/v1\/transcripts\/batch$/, respond: { status: 202, body: SAMPLE_JOB } },
      { method: 'GET', match: /\/v1\/jobs\/job_01J$/, respond: { status: 200, body: doneJob } },
      {
        method: 'GET',
        match: /\/v1\/jobs\/job_01J\/items/,
        respond: ({ url }) => {
          const u = new URL(url);
          return u.searchParams.get('cursor') === 'c2'
            ? { status: 200, body: { job_id: 'job_01J', status: 'succeeded', limit: 1, has_more: false, next_cursor: null, items: [{ video_id: 'v2222222222', status: 'done' }] } }
            : { status: 200, body: { job_id: 'job_01J', status: 'succeeded', limit: 1, has_more: true, next_cursor: 'c2', items: [{ video_id: 'v1111111111', status: 'done' }] } };
        },
      },
    ]);
    const { job, items } = await lab(fetch).batch({ urls: ['https://youtu.be/v1111111111', 'https://youtu.be/v2222222222'], webhookUrl: 'https://me.example/hook' });
    assert.equal(job.state, 'done');
    assert.deepEqual(items.map((i) => i.video_id), ['v1111111111', 'v2222222222']);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.webhook_url, 'https://me.example/hook');
  });

  it('transcribeMedia → getMediaTranscript polls the job then reads the transcript', async () => {
    const doneJob = { ...SAMPLE_JOB, type: 'stt_url', status: 'succeeded', state: 'done', terminal: true };
    const { fetch } = stubFetch([
      {
        method: 'POST',
        match: /\/v1\/media$/,
        respond: {
          status: 202,
          body: { media_id: 'm_abc', poll_url: 'https://transcriptlab.dev/v1/jobs/job_01J', transcript_url: 'https://transcriptlab.dev/v1/media/m_abc/transcript' },
        },
      },
      { method: 'GET', match: /\/v1\/jobs\/job_01J$/, respond: { status: 200, body: doneJob } },
      { method: 'GET', match: /\/v1\/media\/m_abc\/transcript/, respond: { status: 200, body: SAMPLE_TRANSCRIPT } },
    ]);
    const t = await lab(fetch).getMediaTranscript({ url: 'https://cdn.example/talk.mp3' });
    assert.equal(t.video_id, 'dQw4w9WgXcQ');
  });

  it('readTranscript returns text/srt/vtt as strings', async () => {
    const { fetch, calls } = stubFetch([
      { method: 'GET', match: /./, respond: { status: 200, body: '[0.00 - 0.05] hi' } },
    ]);
    const res = await lab(fetch).readTranscript('dQw4w9WgXcQ', { format: 'srt' });
    assert.equal(res.status, 'ready');
    assert.equal(typeof res.transcript, 'string');
    assert.match(new URL(calls[0].url).search, /format=srt/);
    assert.equal(calls[0].init.headers.Accept, 'text/plain');
  });

  it('query() sends mode-specific fields and returns the right shape', async () => {
    const { fetch, calls } = stubFetch([
      {
        method: 'POST',
        match: /\/v1\/transcripts\/query$/,
        respond: { status: 200, body: { mode: 'keyword', matches: [], summary: [{ term: 'api', count: 3, first_start: 12.5 }], truncated: false, count: 3 } },
      },
    ]);
    const res = await lab(fetch).query({ videoId: 'dQw4w9WgXcQ', mode: 'keyword', terms: ['api'], caseSensitive: true });
    assert.equal(res.mode, 'keyword');
    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual({ video_id: sent.video_id, mode: sent.mode, terms: sent.terms, case_sensitive: sent.case_sensitive }, { video_id: 'dQw4w9WgXcQ', mode: 'keyword', terms: ['api'], case_sensitive: true });
  });


  it('cancelJob issues DELETE', async () => {
    const { fetch, calls } = stubFetch([
      { method: 'DELETE', match: /\/v1\/jobs\/job_01J$/, respond: { status: 202, body: { ...SAMPLE_JOB, status: 'canceled', state: 'failed', terminal: true } } },
    ]);
    const job = await lab(fetch).cancelJob('job_01J');
    assert.equal(job.status, 'canceled');
    assert.equal(calls[0].init.method, 'DELETE');
  });

  it('requires an API key', () => {
    delete process.env.TRANSCRIPTLAB_API_KEY;
    assert.throws(() => new TranscriptLab({ fetch: async () => new Response('{}') }), /missing API key/i);
  });
});

describe('verifyWebhook', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'job.succeeded', created: 1700000000, data: { job_id: 'job_01J', status: 'succeeded', total: 2, completed: 2, failed: 0, credits_charged: 2 } });
  const sign = (t, b = body) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${b}`).digest('hex')}`;

  it('verifies a well-signed event', async () => {
    const t = Math.floor(Date.now() / 1000);
    const event = await verifyWebhook({ rawBody: body, signature: sign(t), secret });
    assert.equal(event.type, 'job.succeeded');
    assert.equal(event.data.job_id, 'job_01J');
  });

  it('rejects a tampered body', async () => {
    const t = Math.floor(Date.now() / 1000);
    await assert.rejects(
      verifyWebhook({ rawBody: body.replace('job_01J', 'job_evil'), signature: sign(t), secret }),
      /Invalid webhook signature/,
    );
  });

  it('rejects stale timestamps and malformed headers', async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    await assert.rejects(verifyWebhook({ rawBody: body, signature: sign(stale), secret }), /tolerance/);
    await assert.rejects(verifyWebhook({ rawBody: body, signature: 'garbage', secret }), /Malformed/);
  });

});
