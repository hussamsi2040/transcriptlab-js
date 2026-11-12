export type TranscriptFormat = 'json' | 'text' | 'srt' | 'vtt';
export type TranscriptType = 'any' | 'manual' | 'generated';
export type TranscriptEngine = 'captions' | 'stt';
export type TranscriptExtra = 'srt' | 'vtt' | 'text';
/** `auto` prefers Whisper when configured; `diarize` pins `premium`. */
export type SpeechTier = 'normal' | 'premium' | 'auto';

/** One caption segment of a transcript. */
export interface TranscriptSegment {
  text: string;
  /** Start time in seconds. */
  start: number;
  /** Segment duration in seconds. */
  duration: number;
  /** Present on diarized speech-to-text transcripts. */
  speaker?: string;
}

/** Stored transcript document returned when `format: 'json'` (the default). */
export interface StoredTranscript {
  v: 1;
  video_id: string;
  url: string;
  language: { code?: string; name?: string; is_generated?: boolean } & Record<string, unknown>;
  translation: (Record<string, unknown>) | null;
  is_translatable?: boolean;
  translation_languages?: string[] | null;
  duration_seconds?: number | null;
  snippet_count?: number;
  snippets: TranscriptSegment[];
  text: string;
  metadata?: Record<string, unknown> | null;
  fetched_at: string;
}

/** Options shared by the single-transcript endpoints. */
export interface TranscriptOptions {
  /** Source language code, or `auto` (default). */
  lang?: string;
  /** Translate the transcript into this language code. `engine: 'stt'` does not support translation. */
  translate?: string;
  /** Caption track preference: `any` (default), `manual`, or `generated`. */
  type?: TranscriptType;
  /** Also bill and store these extra formats alongside the requested `format`. */
  also?: TranscriptExtra[];
  /** Include video metadata (default varies by endpoint). */
  metadata?: boolean;
  /** Strip filler words and punctuation artifacts. */
  cleanup?: boolean;
  /** `captions` (default) reads YouTube's caption tracks; `stt` transcribes audio. Never an automatic fallback. */
  engine?: TranscriptEngine;
  /** Speech model tier, `engine: 'stt'` only. `diarize` implies `premium`. */
  tier?: SpeechTier;
  /** Speaker diarization, `engine: 'stt'` only; pins `tier` to `premium`. */
  diarize?: boolean;
  /** Speaker map/count hint for diarization (e.g. `"alice=Speaker 1"`, `"2"`). */
  speakers?: string;
}

/**
 * Request body for {@link TranscriptLab.requestTranscript} and
 * {@link TranscriptLab.getTranscript}. Identify the video by `videoId`, or pass
 * any YouTube URL/watch string as `url`.
 */
export type TranscriptRequest =
  & ({ videoId: string; url?: never } | { url: string; videoId?: never })
  & TranscriptOptions
  & {
      /** Render format. Non-`json` formats return a plain string. */
      format?: TranscriptFormat;
      /** How long the API may spend before answering 202. 1000–60000, default 20000. */
      deadlineMs?: number;
    };

/**
 * 202 body for transcript requests that outlive `deadlineMs`.
 * The transcript is being produced; there is no job to poll — request
 * `location` again after `retryAfter` seconds.
 */
export interface TranscriptProcessing {
  video_id: string;
  state: 'processing';
  /** Absolute URL to poll (GET /v1/transcripts/{videoId} with your options). */
  location: string;
  /** Suggested seconds before the next poll, from the `Retry-After` header. */
  retryAfter: number;
}

/** `T` is `StoredTranscript` for `format: 'json'`, `string` for text/srt/vtt. */
export type TranscriptResult<T = StoredTranscript | string> =
  | { status: 'ready'; transcript: T }
  | { status: 'processing'; processing: TranscriptProcessing };

export interface DiscoverResult {
  video_id: string;
  url: string;
  available_transcripts: Array<{
    language_code: string;
    language: string;
    is_generated: boolean;
    is_translatable: boolean;
    translation_languages: string[] | null;
  }>;
  result_types: string[];
  source: { cache: string; fetched_at: string };
}

export interface DiscoverOptions {
  /** How long the API may spend before answering 202. 1000–60000, default 20000. */
  deadlineMs?: number;
}

export type JobType = 'single' | 'batch' | 'channel' | 'discover' | 'stt' | 'stt_upload' | 'stt_url';
export type JobStatus =
  | 'queued'
  | 'launching'
  | 'upstream_running'
  | 'collecting'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'canceled';
/** Stable polling contract: stop when `state` is `done` or `failed`. */
export type JobState = 'waiting' | 'preparing' | 'processing' | 'done' | 'failed';

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  state: JobState;
  terminal: boolean;
  /** 0–1. */
  progress: number;
  total_items: number;
  completed_items: number;
  failed_items: number;
  credits_charged: number;
  error_code: string | null;
  error: string | null;
  result_url: string | null;
  webhook_configured?: boolean;
  /** Returned only in the submission response when `webhookUrl` was set. Save it to verify callbacks. */
  webhook_secret?: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
  poll_url: string;
  items_url: string;
}

export interface JobItem {
  video_id?: string;
  title?: string | null;
  duration_seconds?: number | null;
  view_count?: number | null;
  position?: number | null;
  status?: 'pending' | 'processing' | 'done' | 'failed';
  language_code?: string | null;
  translation_target?: string | null;
  error_code?: string | null;
  credits?: number;
  attempts?: number;
  updated_at?: number;
}

export interface JobItemsPage {
  job_id: string;
  status: string;
  limit: number;
  has_more: boolean;
  /** Pass as `cursor` for the next page; `null` on the last page. */
  next_cursor: string | null;
  items: JobItem[];
}

export interface LibraryEntry {
  video_id: string;
  last_fetched_at: number;
  fetches: number;
  title: string | null;
}

export interface LibraryPage {
  items: LibraryEntry[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface JobsPage {
  jobs: Job[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

/** Options for {@link TranscriptLab.createBatch}. */
export interface BatchRequest {
  /** YouTube URLs (watch, youtu.be, shorts, …). Plan controls the maximum per job. */
  urls: string[];
  lang?: string;
  translate?: string;
  type?: TranscriptType;
  /** Extra render formats to store per video (max 3). */
  formats?: TranscriptExtra[];
  metadata?: boolean;
  /** Optional HTTPS callback. Save `webhook_secret` from the returned Job to verify it. */
  webhookUrl?: string;
  /** Sent as the `Idempotency-Key` header; safe retries reuse it. */
  idempotencyKey?: string;
}

/** Options for {@link TranscriptLab.transcribeChannel}. */
export interface ChannelRequest {
  /** 1–10 channel references: URLs, handles (`@name`), or IDs. */
  channel: string | string[];
  /** `list` collects video metadata; `transcribe` also transcribes (capped at 250 videos/job). */
  mode?: 'list' | 'transcribe';
  maxVideos?: number;
  lang?: string;
  translate?: string;
  type?: TranscriptType;
  formats?: TranscriptExtra[];
  metadata?: boolean;
  webhookUrl?: string;
  idempotencyKey?: string;
}

/** Options for {@link TranscriptLab.transcribeMedia}. */
export interface MediaRequest {
  /** Public HTTPS URL of a media file (mp3, m4a, mp4, m4v, mov, webm, mkv, wav, flac, ogg, oga, opus, aac, wma, aiff, aif, mka, ts). Page URLs and YouTube URLs are rejected — use transcripts endpoints for YouTube. */
  url: string;
  format?: TranscriptFormat;
  cleanup?: boolean;
  /** Implies `tier: 'premium'` (Deepgram Nova-3). */
  diarize?: boolean;
  tier?: SpeechTier;
  speakers?: string;
  webhookUrl?: string;
}

/** 200 inline result for a cached media transcription. */
export interface MediaCachedResult {
  media_id: string;
  format: string;
  /** StoredTranscript for `format: 'json'`, otherwise rendered text/srt/vtt. */
  document: StoredTranscript | string;
  cache: string;
  charged_credits: number;
}

/** 202 result for a new media transcription. */
export interface MediaPending {
  media_id: string;
  poll_url: string;
  transcript_url: string;
}

export type MediaResult = { status: 'cached'; result: MediaCachedResult } | { status: 'pending'; pending: MediaPending };

export type QueryBase = { videoId: string; url?: never } | { url: string; videoId?: never };
export interface QueryShared {
  lang?: string;
  translate?: string;
  type?: TranscriptType;
  contextChars?: number;
}

export interface RegexQuery extends QueryShared {
  mode: 'regex';
  /** Required; applied per transcript snippet. Max 200 chars. */
  pattern: string;
  /** Flags supported: i, m, s, u, y. */
  flags?: string;
}

export interface KeywordQuery extends QueryShared {
  mode: 'keyword';
  /** 1–50 terms; combined length ≤ 4096 chars. */
  terms: string[];
  caseSensitive?: boolean;
}

export interface ChunkQuery extends QueryShared {
  mode: 'chunk';
  /** ≤ `maxTokens`. Default 256. */
  targetTokens?: number;
  /** Default 2048. */
  maxTokens?: number;
  overlapSnippets?: number;
}

export type TranscriptQuery = QueryBase & (RegexQuery | KeywordQuery | ChunkQuery);

export interface RegexResult {
  mode: 'regex';
  matches: Array<{
    text: string;
    start: number;
    duration: number;
    index: number;
    groups: string[];
    context: string | null;
  }>;
  truncated: boolean;
  count: number;
}

export interface KeywordResult {
  mode: 'keyword';
  matches: Array<{
    term: string;
    snippet_text: string;
    start: number;
    duration: number;
    offset_in_text: number;
  }>;
  summary: Array<{ term: string; count: number; first_start: number | null }>;
  truncated: boolean;
  count: number;
}

export interface ChunkResult {
  mode: 'chunk';
  chunks: Array<{
    index: number;
    text: string;
    start: number;
    end: number;
    token_estimate: number;
    snippet_start: number;
    snippet_end: number;
    oversize: boolean;
    overlap: boolean;
  }>;
  count: number;
  token_estimate_method: 'chars_div_4';
}

export type TranscriptQueryResult = RegexResult | KeywordResult | ChunkResult;

export interface ListJobsOptions {
  state?: JobState;
  cursor?: string;
  limit?: number;
}

export interface JobItemsOptions {
  status?: 'pending' | 'processing' | 'done' | 'failed';
  limit?: number;
  cursor?: string;
}

export interface LibraryOptions {
  cursor?: string;
  limit?: number;
  /** Substring filter over stored titles/video ids. */
  search?: string;
}

/** Polling controls for the `wait*` methods. */
export interface WaitOptions {
  /** Give up after this many milliseconds and throw `StillProcessingError`. Default 300000. */
  timeoutMs?: number;
  /** Abort polling from the outside. */
  signal?: AbortSignal;
}

/** Event delivered to a job's `webhookUrl`. */
export interface WebhookEvent {
  id: string;
  type: 'job.succeeded' | 'job.partial' | 'job.failed' | 'job.canceled';
  /** Unix timestamp in seconds. */
  created: number;
  data: {
    job_id: string;
    status: string;
    total: number;
    completed: number;
    failed: number;
    credits_charged: number;
  };
}

/** Fetch-compatible function — inject a stub in tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TranscriptLabOptions {
  /**
   * API key (`ytgw_…`). Omit to read `TRANSCRIPTLAB_API_KEY` from the
   * environment when `process` is available.
   */
  apiKey?: string;
  /** Default `https://transcriptlab.dev`. */
  baseUrl?: string;
  /** Per-request network timeout. Default 60000. */
  timeoutMs?: number;
  /** Retries for network failures and 429/5xx responses. Default 2. */
  maxRetries?: number;
  /** Default wait budget for `getTranscript`/`waitForJob` etc. Default 300000. */
  waitTimeoutMs?: number;
  /** Custom fetch (tests, proxies). Defaults to global `fetch`. */
  fetch?: FetchLike;
}
