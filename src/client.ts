import { NetworkError, StillProcessingError, apiError } from './errors.js';
import type {
  BatchRequest,
  ChannelRequest,
  ChunkResult,
  ChunkQuery,
  DiscoverOptions,
  DiscoverResult,
  FetchLike,
  Job,
  JobItemsOptions,
  JobItemsPage,
  JobsPage,
  KeywordResult,
  KeywordQuery,
  LibraryOptions,
  LibraryPage,
  ListJobsOptions,
  MediaCachedResult,
  MediaPending,
  MediaRequest,
  MediaResult,
  RegexResult,
  RegexQuery,
  StoredTranscript,
  TranscriptFormat,
  TranscriptLabOptions,
  TranscriptOptions,
  TranscriptProcessing,
  TranscriptQuery,
  TranscriptQueryResult,
  TranscriptRequest,
  TranscriptResult,
  WaitOptions,
} from './types.js';

const DEFAULT_BASE_URL = 'https://transcriptlab.dev';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

interface RawResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  /** Expected render format; non-`json` bodies return as text. */
  format?: TranscriptFormat | undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted === true) {
    reject(signal.reason);
    return promise;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  return promise;
}

/** Extract an 11-char video id from a YouTube URL/watch string, or null. */
export function videoIdFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (VIDEO_ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0] ?? '';
    return VIDEO_ID.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v');
    if (v !== null && VIDEO_ID.test(v)) return v;
    const m = /^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
    if (m !== null && m[2] !== undefined && VIDEO_ID.test(m[2])) return m[2];
  }
  return null;
}

function retryAfterSeconds(headers: Headers, fallback: number): number {
  const raw = headers.get('retry-after');
  if (raw === null) return fallback;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

interface NodeProcessLike {
  env?: Record<string, string | undefined>;
}

/** Resolve the default API key from the environment when `process` exists. */
function envApiKey(): string | undefined {
  // `process` is absent in browsers/edge runtimes; probe globalThis without importing 'node:process'.
  const proc = (globalThis as Record<string, unknown>)['process'] as NodeProcessLike | undefined;
  return proc?.env?.['TRANSCRIPTLAB_API_KEY'];
}

/**
 * TranscriptLab API client.
 *
 * ```ts
 * const lab = new TranscriptLab('ytgw_…');
 * const { text } = await lab.getTranscript({ url: 'https://youtu.be/dQw4w9WgXcQ' });
 * ```
 */
export class TranscriptLab {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #waitTimeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(apiKeyOrOptions?: string | TranscriptLabOptions) {
    const options = typeof apiKeyOrOptions === 'string' ? { apiKey: apiKeyOrOptions } : (apiKeyOrOptions ?? {});
    const apiKey = options.apiKey ?? envApiKey();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'TranscriptLab: missing API key. Pass one to the constructor or set TRANSCRIPTLAB_API_KEY.',
      );
    }
    this.#apiKey = apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const f = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (f === undefined) {
      throw new Error('TranscriptLab: global fetch is unavailable; pass `fetch` in options.');
    }
    this.#fetch = f;
  }

  // -------------------------------------------------------------------------------------------
  // Transcripts
  // -------------------------------------------------------------------------------------------

  /**
   * POST /v1/transcripts — one attempt within `deadlineMs`.
   * Returns `{ status: 'ready' }` or `{ status: 'processing' }` (unbilled 202).
   * Prefer {@link getTranscript} unless you want to manage polling yourself.
   */
  async requestTranscript(request: TranscriptRequest & { format?: 'json' }): Promise<TranscriptResult<StoredTranscript>>;
  async requestTranscript(request: TranscriptRequest & { format: Exclude<TranscriptFormat, 'json'> }): Promise<TranscriptResult<string>>;
  async requestTranscript(request: TranscriptRequest): Promise<TranscriptResult<StoredTranscript | string>>;
  async requestTranscript(request: TranscriptRequest): Promise<TranscriptResult<StoredTranscript | string>> {
    const { format = 'json' } = request;
    const body = {
      ...(request.videoId !== undefined ? { video_id: request.videoId } : { url: request.url }),
      ...transcriptOptionsBody(request),
      format,
      ...(request.deadlineMs !== undefined ? { deadline_ms: request.deadlineMs } : {}),
    };
    const res = await this.#request({ method: 'POST', path: '/v1/transcripts', body, format });
    if (res.status === 200) {
      return { status: 'ready', transcript: res.body as StoredTranscript };
    }
    // 202 — still producing; Location names the read URL for these options.
    const payload = (res.body ?? {}) as Record<string, unknown>;
    const processing: TranscriptProcessing = {
      video_id: (payload['video_id'] as string) ?? videoIdFromInput(request.url ?? request.videoId ?? '') ?? '',
      state: 'processing',
      location: res.headers.get('location') ?? `${this.#baseUrl}/v1/transcripts/${payload['video_id'] ?? ''}`,
      retryAfter: retryAfterSeconds(res.headers, 2),
      ...payload,
    } as TranscriptProcessing;
    return { status: 'processing', processing };
  }

  /**
   * Request a transcript and poll until it is ready (default wait 5 min).
   * Throws `StillProcessingError` when the wait budget runs out — catch it and
   * call {@link readTranscript} later, or `transcript.unavailable` on failure.
   */
  async getTranscript(request: TranscriptRequest & { format?: 'json' }, wait?: WaitOptions): Promise<StoredTranscript>;
  async getTranscript(request: TranscriptRequest & { format: Exclude<TranscriptFormat, 'json'> }, wait?: WaitOptions): Promise<string>;
  async getTranscript(request: TranscriptRequest, wait?: WaitOptions): Promise<StoredTranscript | string>;
  async getTranscript(request: TranscriptRequest, wait?: WaitOptions): Promise<StoredTranscript | string> {
    const first = await this.requestTranscript(request as TranscriptRequest & { format?: 'json' });
    if (first.status === 'ready') return first.transcript;

    const deadline = now() + (wait?.timeoutMs ?? this.#waitTimeoutMs);
    const videoId =
      videoIdFromInput(request.videoId ?? request.url ?? '') ?? first.processing.video_id;
    for (;;) {
      await sleep(Math.min(first.processing.retryAfter * 1000, Math.max(0, deadline - now())), wait?.signal);
      const res = await this.#request({
        method: 'GET',
        path: `/v1/transcripts/${encodeURIComponent(videoId)}`,
        query: transcriptOptionsQuery(request),
        signal: wait?.signal,
        format: request.format,
      });
      if (res.status === 200) return res.body as StoredTranscript;
      // 202 → keep polling; non-2xx throws inside #request.
      if (now() >= deadline) {
        throw new StillProcessingError(
          `Transcript for ${videoId} still processing after wait timeout`,
          { kind: 'transcript', videoId },
        );
      }
    }
  }

  /**
   * GET /v1/transcripts/{videoId} — cache-only read; never starts upstream work.
   * 404 throws `NotFoundError`; 202 means your own run is still going and
   * returns `{ status: 'processing' }`; 422 throws `TranscriptUnavailableError`.
   */
  async readTranscript(
    videoIdOrUrl: string,
    options?: TranscriptOptions & { format?: 'json' },
  ): Promise<TranscriptResult<StoredTranscript>>;
  async readTranscript(
    videoIdOrUrl: string,
    options: TranscriptOptions & { format: Exclude<TranscriptFormat, 'json'> },
  ): Promise<TranscriptResult<string>>;
  async readTranscript(
    videoIdOrUrl: string,
    options?: TranscriptOptions,
  ): Promise<TranscriptResult<StoredTranscript | string>>;
  async readTranscript(
    videoIdOrUrl: string,
    options: TranscriptOptions & { format?: TranscriptFormat } = {},
  ): Promise<TranscriptResult<StoredTranscript | string>> {
    const videoId = videoIdFromInput(videoIdOrUrl) ?? videoIdOrUrl;
    const res = await this.#request({
      method: 'GET',
      path: `/v1/transcripts/${encodeURIComponent(videoId)}`,
      query: transcriptOptionsQuery(options),
      format: options.format,
    });
    if (res.status === 200) return { status: 'ready', transcript: res.body as StoredTranscript };
    const processing: TranscriptProcessing = {
      video_id: videoId,
      state: 'processing',
      location: res.headers.get('location') ?? '',
      retryAfter: retryAfterSeconds(res.headers, 2),
    };
    return { status: 'processing', processing };
  }

  /** Resume polling a transcript read after a previous `StillProcessingError`. */
  async waitForTranscript(
    videoIdOrUrl: string,
    options?: TranscriptOptions & { format?: 'json' },
    wait?: WaitOptions,
  ): Promise<StoredTranscript>;
  async waitForTranscript(
    videoIdOrUrl: string,
    options: TranscriptOptions & { format: Exclude<TranscriptFormat, 'json'> },
    wait?: WaitOptions,
  ): Promise<string>;
  async waitForTranscript(
    videoIdOrUrl: string,
    options?: TranscriptOptions,
    wait?: WaitOptions,
  ): Promise<StoredTranscript | string>;
  async waitForTranscript(
    videoIdOrUrl: string,
    options: TranscriptOptions & { format?: TranscriptFormat } = {},
    wait?: WaitOptions,
  ): Promise<StoredTranscript | string> {
    const videoId = videoIdFromInput(videoIdOrUrl) ?? videoIdOrUrl;
    const deadline = now() + (wait?.timeoutMs ?? this.#waitTimeoutMs);
    for (;;) {
      const res = await this.readTranscript(videoId, options as TranscriptOptions & { format?: 'json' });
      if (res.status === 'ready') return res.transcript;
      const delay = Math.min(res.processing.retryAfter * 1000, Math.max(0, deadline - now()));
      if (now() >= deadline) {
        throw new StillProcessingError(`Transcript for ${videoId} still processing`, {
          kind: 'transcript',
          videoId,
        });
      }
      await sleep(delay, wait?.signal);
    }
  }

  /**
   * GET /v1/transcripts/{videoId}/discover — list available caption tracks.
   * Free; polls while the gateway answers 202.
   */
  async discover(videoIdOrUrl: string, options?: DiscoverOptions, wait?: WaitOptions): Promise<DiscoverResult> {
    const videoId = videoIdFromInput(videoIdOrUrl) ?? videoIdOrUrl;
    const deadline = now() + (wait?.timeoutMs ?? this.#waitTimeoutMs);
    for (;;) {
      const res = await this.#request({
        method: 'GET',
        path: `/v1/transcripts/${encodeURIComponent(videoId)}/discover`,
        query: options?.deadlineMs !== undefined ? { deadline_ms: options.deadlineMs } : {},
        signal: wait?.signal,
      });
      if (res.status === 200) return res.body as DiscoverResult;
      if (now() >= deadline) {
        throw new StillProcessingError(`Discovery for ${videoId} still processing`, {
          kind: 'transcript',
          videoId,
        });
      }
      await sleep(Math.min(retryAfterSeconds(res.headers, 2) * 1000, deadline - now()), wait?.signal);
    }
  }

  /** GET /v1/transcripts — this account's paid transcript library. */
  async listTranscripts(options?: LibraryOptions): Promise<LibraryPage> {
    const res = await this.#request({
      method: 'GET',
      path: '/v1/transcripts',
      query: {
        ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.search !== undefined ? { search: options.search } : {}),
      },
    });
    return res.body as LibraryPage;
  }

  /** POST /v1/transcripts/query — regex, keyword, or chunk over a cached transcript. */
  async query(query: TranscriptQuery & ChunkQuery): Promise<ChunkResult>;
  async query(query: TranscriptQuery & RegexQuery): Promise<RegexResult>;
  async query(query: TranscriptQuery & KeywordQuery): Promise<KeywordResult>;
  async query(query: TranscriptQuery): Promise<TranscriptQueryResult>;
  async query(query: TranscriptQuery): Promise<TranscriptQueryResult> {
    const body: Record<string, unknown> = {
      ...(query.videoId !== undefined ? { video_id: query.videoId } : { url: query.url }),
      mode: query.mode,
      lang: query.lang,
      translate: query.translate,
      type: query.type,
      context_chars: query.contextChars,
    };
    if (query.mode === 'regex') {
      body['pattern'] = query.pattern;
      body['flags'] = query.flags;
    } else if (query.mode === 'keyword') {
      body['terms'] = query.terms;
      body['case_sensitive'] = query.caseSensitive;
    } else {
      body['target_tokens'] = query.targetTokens;
      body['max_tokens'] = query.maxTokens;
      body['overlap_snippets'] = query.overlapSnippets;
    }
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    const res = await this.#request({ method: 'POST', path: '/v1/transcripts/query', body });
    return res.body as TranscriptQueryResult;
  }

  // -------------------------------------------------------------------------------------------
  // Jobs (batch, channel, media)
  // -------------------------------------------------------------------------------------------

  /** POST /v1/transcripts/batch — queue up to the plan's URL limit. Returns the Job. */
  async createBatch(request: BatchRequest): Promise<Job> {
    const res = await this.#request({
      method: 'POST',
      path: '/v1/transcripts/batch',
      body: {
        urls: request.urls,
        lang: request.lang,
        translate: request.translate,
        type: request.type,
        formats: request.formats,
        metadata: request.metadata,
        webhook_url: request.webhookUrl,
      },
      headers: request.idempotencyKey !== undefined ? { 'Idempotency-Key': request.idempotencyKey } : {},
    });
    return res.body as Job;
  }

  /**
   * Submit a batch and poll it to `done`/`failed`, then read all item pages.
   * Items with `status: 'done'` succeeded; `error_code` explains failures.
   */
  async batch(
    request: BatchRequest,
    wait?: WaitOptions,
  ): Promise<{ job: Job; items: JobItemsPage['items'] }> {
    const job = await this.createBatch(request);
    const final = await this.waitForJob(job.id, wait);
    const items: JobItemsPage['items'] = [];
    for await (const item of this.jobItems(job.id)) items.push(item);
    return { job: final, items };
  }

  /** POST /v1/channels/transcribe — list or transcribe up to 10 channels. Returns the Job. */
  async transcribeChannel(request: ChannelRequest): Promise<Job> {
    const res = await this.#request({
      method: 'POST',
      path: '/v1/channels/transcribe',
      body: {
        channel: request.channel,
        mode: request.mode,
        max_videos: request.maxVideos,
        lang: request.lang,
        translate: request.translate,
        type: request.type,
        formats: request.formats,
        metadata: request.metadata,
        webhook_url: request.webhookUrl,
      },
      headers: request.idempotencyKey !== undefined ? { 'Idempotency-Key': request.idempotencyKey } : {},
    });
    return res.body as Job;
  }

  /** POST /v1/media — transcribe a public media-file URL. */
  async transcribeMedia(request: MediaRequest): Promise<MediaResult> {
    const res = await this.#request({
      method: 'POST',
      path: '/v1/media',
      body: {
        url: request.url,
        format: request.format,
        cleanup: request.cleanup,
        diarize: request.diarize,
        tier: request.tier,
        speakers: request.speakers,
        webhook_url: request.webhookUrl,
      },
    });
    if (res.status === 200) return { status: 'cached', result: res.body as MediaCachedResult };
    return { status: 'pending', pending: res.body as MediaPending };
  }

  /**
   * Submit a media URL and wait for the transcript. `wait` polls the returned
   * job, then reads `GET /v1/media/{mediaId}/transcript`.
   */
  async getMediaTranscript(
    request: MediaRequest & { format?: 'json' },
    wait?: WaitOptions,
  ): Promise<StoredTranscript>;
  async getMediaTranscript(
    request: MediaRequest & { format: Exclude<TranscriptFormat, 'json'> },
    wait?: WaitOptions,
  ): Promise<string>;
  async getMediaTranscript(request: MediaRequest, wait?: WaitOptions): Promise<StoredTranscript | string>;
  async getMediaTranscript(request: MediaRequest, wait?: WaitOptions): Promise<StoredTranscript | string> {
    const submitted = await this.transcribeMedia(request);
    if (submitted.status === 'cached') return submitted.result.document as StoredTranscript;
    const jobId = jobIdFromPollUrl(submitted.pending.poll_url) ?? submitted.pending.media_id;
    const mediaId = submitted.pending.media_id;
    await this.waitForJob(jobId, wait);
    return this.readMediaTranscript(mediaId, { format: request.format ?? 'json' } as { format: 'json' });
  }

  /** GET /v1/media/{mediaId}/transcript — read a finished media transcription. */
  async readMediaTranscript(mediaId: string, options?: { format?: 'json'; cleanup?: boolean; diarize?: boolean; speakers?: string }): Promise<StoredTranscript>;
  async readMediaTranscript(mediaId: string, options: { format: Exclude<TranscriptFormat, 'json'>; cleanup?: boolean; diarize?: boolean; speakers?: string }): Promise<string>;
  async readMediaTranscript(mediaId: string, options?: { format?: TranscriptFormat; cleanup?: boolean; diarize?: boolean; speakers?: string }): Promise<StoredTranscript | string>;
  async readMediaTranscript(
    mediaId: string,
    options: { format?: TranscriptFormat; cleanup?: boolean; diarize?: boolean; speakers?: string } = {},
  ): Promise<StoredTranscript | string> {
    const res = await this.#request({
      method: 'GET',
      path: `/v1/media/${encodeURIComponent(mediaId)}/transcript`,
      query: {
        format: options.format,
        cleanup: options.cleanup,
        diarize: options.diarize,
        speakers: options.speakers,
      },
      format: options.format,
    });
    return res.body as StoredTranscript;
  }

  // -------------------------------------------------------------------------------------------
  // Job bookkeeping
  // -------------------------------------------------------------------------------------------

  /** GET /v1/jobs — newest first. */
  async listJobs(options?: ListJobsOptions): Promise<JobsPage> {
    const res = await this.#request({
      method: 'GET',
      path: '/v1/jobs',
      query: { state: options?.state, cursor: options?.cursor, limit: options?.limit },
    });
    return res.body as JobsPage;
  }

  /** GET /v1/jobs/{jobId}. */
  async getJob(jobId: string): Promise<Job> {
    const res = await this.#request({ method: 'GET', path: `/v1/jobs/${encodeURIComponent(jobId)}` });
    return res.body as Job;
  }

  /** Poll a job until `state` is `done` or `failed`. */
  async waitForJob(jobId: string, wait?: WaitOptions): Promise<Job> {
    const deadline = now() + (wait?.timeoutMs ?? this.#waitTimeoutMs);
    for (;;) {
      const job = await this.getJob(jobId);
      if (job.state === 'done' || job.state === 'failed' || job.terminal) return job;
      if (now() >= deadline) {
        throw new StillProcessingError(`Job ${jobId} still ${job.state} after wait timeout`, {
          kind: 'job',
          jobId,
        });
      }
      await sleep(Math.min(2000, Math.max(0, deadline - now())), wait?.signal);
    }
  }

  /** DELETE /v1/jobs/{jobId} — cancel a non-terminal job. */
  async cancelJob(jobId: string): Promise<Job> {
    const res = await this.#request({ method: 'DELETE', path: `/v1/jobs/${encodeURIComponent(jobId)}` });
    return res.body as Job;
  }

  /** GET /v1/jobs/{jobId}/items — one page. */
  async listJobItems(jobId: string, options?: JobItemsOptions): Promise<JobItemsPage> {
    const res = await this.#request({
      method: 'GET',
      path: `/v1/jobs/${encodeURIComponent(jobId)}/items`,
      query: { status: options?.status, limit: options?.limit, cursor: options?.cursor },
    });
    return res.body as JobItemsPage;
  }

  /** Iterate every item of a job, fetching pages as needed. */
  async *jobItems(
    jobId: string,
    options?: Omit<JobItemsOptions, 'cursor'>,
  ): AsyncGenerator<JobItemsPage['items'][number], void, undefined> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listJobItems(jobId, { ...options, ...(cursor !== undefined ? { cursor } : {}) });
      for (const item of page.items) yield item;
      if (!page.has_more || page.next_cursor === null) return;
      cursor = page.next_cursor;
    }
  }

  // -------------------------------------------------------------------------------------------
  // HTTP core
  // -------------------------------------------------------------------------------------------

  async #request(init: RequestSpec, attempt = 0): Promise<RawResponse> {
    const url = new URL(`${this.#baseUrl}${init.path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    const signal = AbortSignal.any(
      [AbortSignal.timeout(this.#timeoutMs), ...(init.signal !== undefined ? [init.signal] : [])],
    );

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: init.format !== undefined && init.format !== 'json' ? 'text/plain' : 'application/json',
      ...init.headers,
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal,
      });
    } catch (cause) {
      if (attempt < this.#maxRetries) {
        await sleep(backoffMs(attempt), init.signal);
        return this.#request(init, attempt + 1);
      }
      throw new NetworkError(
        `TranscriptLab request failed after ${attempt + 1} attempt(s): ${url.pathname}`,
        cause,
      );
    }

    const rawText = await response.text();
    let body: unknown;
    if (init.format !== undefined && init.format !== 'json' && response.ok) {
      body = rawText;
    } else {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = rawText;
      }
    }

    const res: RawResponse = { status: response.status, headers: response.headers, body };

    if (response.ok || response.status === 202) return res;

    const retryAfter = retryAfterSeconds(response.headers, 0);
    if (attempt < this.#maxRetries && (response.status === 429 || response.status >= 500)) {
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt), init.signal);
      return this.#request(init, attempt + 1);
    }
    throw apiError(
      response.status,
      typeof body === 'object' && body !== null ? (body as { error?: { code?: string; message?: string; request_id?: string } }) : {},
      retryAfter,
    );
  }
}

function now(): number {
  return Date.now();
}

function backoffMs(attempt: number): number {
  // 0.5s, 1s, 2s… + up to 25% jitter.
  return 500 * 2 ** attempt * (1 + Math.random() * 0.25);
}


function transcriptOptionsBody(options: TranscriptOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    lang: options.lang,
    translate: options.translate,
    type: options.type,
    also: options.also,
    metadata: options.metadata,
    cleanup: options.cleanup,
    engine: options.engine,
    tier: options.tier,
    diarize: options.diarize,
    speakers: options.speakers,
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return body;
}

function transcriptOptionsQuery(options: TranscriptOptions & { format?: TranscriptFormat }): Record<string, string | number | boolean | undefined> {
  return {
    lang: options.lang,
    translate: options.translate,
    type: options.type,
    also: options.also?.join(','),
    metadata: options.metadata,
    cleanup: options.cleanup,
    engine: options.engine,
    tier: options.tier,
    diarize: options.diarize,
    speakers: options.speakers,
    format: options.format,
  };
}

function jobIdFromPollUrl(pollUrl: string): string | null {
  const m = /\/v1\/jobs\/([^/?#]+)/.exec(pollUrl);
  return m?.[1] !== undefined ? decodeURIComponent(m[1]) : null;
}
