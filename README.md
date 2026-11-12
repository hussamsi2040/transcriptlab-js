# transcriptlab

JavaScript/TypeScript client for the [TranscriptLab API](https://transcriptlab.dev/docs) — YouTube transcripts, caption discovery, batch & channel jobs, and audio/media transcription. Zero dependencies; works on Node ≥ 22, Bun, Deno, and modern browsers.

```bash
npm install transcriptlab
```

## Quick start

```ts
import { TranscriptLab } from 'transcriptlab';

const lab = new TranscriptLab('ytgw_your_key'); // or set TRANSCRIPTLAB_API_KEY

// One call: requests the transcript and polls until it is ready.
const doc = await lab.getTranscript({ url: 'https://youtu.be/dQw4w9WgXcQ' });
console.log(doc.text);
console.log(doc.snippets); // [{ text, start, duration }]
```

`getTranscript` handles the API's `202 + Retry-After` contract for you. If the wait
budget expires it throws `StillProcessingError` — catch it and call
`lab.waitForTranscript(videoId)` later.

## API

| Method | Endpoint | Returns |
|---|---|---|
| `getTranscript(req, wait?)` | `POST /v1/transcripts` + polls | `StoredTranscript` or `string` |
| `requestTranscript(req)` | `POST /v1/transcripts` once | `{status:'ready'\|'processing'}` |
| `readTranscript(videoId, opts?)` | `GET /v1/transcripts/{id}` | `TranscriptResult` (never starts work) |
| `waitForTranscript(videoId, opts?, wait?)` | polls the read route | `StoredTranscript` or `string` |
| `discover(videoId)` | `GET …/discover` | `DiscoverResult` — free |
| `listTranscripts(opts?)` | `GET /v1/transcripts` | `LibraryPage` |
| `query(q)` | `POST /v1/transcripts/query` | regex / keyword / chunk result |
| `createBatch(req)` | `POST /v1/transcripts/batch` | `Job` |
| `batch(req, wait?)` | submit + wait + all items | `{ job, items }` |
| `transcribeChannel(req)` | `POST /v1/channels/transcribe` | `Job` |
| `transcribeMedia(req)` | `POST /v1/media` | cached doc or pending handles |
| `getMediaTranscript(req, wait?)` | `POST /v1/media` + polls | `StoredTranscript` or `string` |
| `readMediaTranscript(mediaId)` | `GET /v1/media/{id}/transcript` | `StoredTranscript` or `string` |
| `listJobs(opts?)` | `GET /v1/jobs` | `JobsPage` |
| `getJob(jobId)` | `GET /v1/jobs/{id}` | `Job` |
| `waitForJob(jobId, wait?)` | polls | `Job` (state `done`/`failed`) |
| `cancelJob(jobId)` | `DELETE /v1/jobs/{id}` | `Job` |
| `listJobItems(jobId, opts?)` | `GET …/items` | `JobItemsPage` |
| `jobItems(jobId)` | async iterator over all items | `JobItem[]` |

### Request options

```ts
await lab.getTranscript({
  url: 'https://youtu.be/dQw4w9WgXcQ', // or videoId: 'dQw4w9WgXcQ'
  format: 'srt',                     // 'json' (default) | 'text' | 'srt' | 'vtt'
  lang: 'en',                        // default 'auto'
  translate: 'es',                   // YouTube translation target
  type: 'manual',                    // 'any' | 'manual' | 'generated'
  also: ['srt', 'vtt'],              // store extra formats in one charge
  cleanup: true,                     // strip filler words
  engine: 'stt',                     // transcribe audio — explicit opt-in, never a fallback
  tier: 'premium',                   // 'normal' | 'premium' | 'auto'
  diarize: true,                     // speaker labels (implies premium)
});
```

Option names are camelCase; response fields mirror the API (`snake_case`).

### Errors

```ts
import { TranscriptLabError, InsufficientCreditsError } from 'transcriptlab';

try {
  await lab.getTranscript({ videoId: 'dQw4w9WgXcQ' });
} catch (err) {
  if (err instanceof InsufficientCreditsError) { /* top up */ }
  else if (err instanceof TranscriptLabError) {
    console.error(err.status, err.code, err.requestId, err.retryAfter);
  }
}
```

`NetworkError` wraps unreachable-host/timeout failures. `StillProcessingError`
means the wait budget ran out while work continues — `err.resume` tells you how
to keep polling.

### Retries & timeouts

```ts
const lab = new TranscriptLab({
  apiKey: 'ytgw_…',
  timeoutMs: 30_000,    // per request
  maxRetries: 3,        // network failures + 429/5xx, honors Retry-After
  waitTimeoutMs: 600_000,
});
```

### Webhooks

Batch/channel/media jobs accept `webhookUrl`. The submission response contains
`webhook_secret` — save it; it is only returned once.

```ts
import { verifyWebhook } from 'transcriptlab';

// In your HTTPS handler — pass the RAW body, not parsed JSON:
const event = verifyWebhook({
  rawBody,                                  // string | Buffer
  signature: req.headers['x-ytgw-signature'],
  secret: savedWebhookSecret,
});
// event.type: 'job.succeeded' | 'job.partial' | 'job.failed' | 'job.canceled'
```

Throws on a bad signature, malformed header, or timestamp older than 300 s —
reject the delivery on any throw.

### Iterating large result sets

```ts
for await (const item of lab.jobItems(jobId)) {
  if (item.status === 'done') console.log(item.video_id);
}
```

## Development

```bash
npm install
npm run build      # tsup → dist/ (ESM + CJS + types)
npm test           # build + node --test
npm run typecheck
```

## License

MIT
