export type FrameHeader = {
  singleSegment: boolean
  checksum: boolean
  dictionaryIdFlag: number
  contentSizeFlag: number
}

export function parseDescriptor(byte: number): FrameHeader {
  return {
    contentSizeFlag: byte >> 6,
    dictionaryIdFlag: byte & 3,
    checksum: Boolean(byte & 4),
    singleSegment: Boolean(byte & 32),
  }
}

export function readBlockHeader(data: Uint8Array) {
  if (data.length < 3) return null
  const value = data[0] | (data[1] << 8) | (data[2] << 16)
  return {
    last: Boolean(value & 1),
    type: (value >> 1) & 3,
    size: value >> 3,
  }
}

export const MAX_DICTIONARY_ID = 0xffffffff

export type FrameId = number | string

export type FrameDictionarySelector =
  | { readonly kind: 'none' }
  | { readonly kind: 'application-zero' }
  | { readonly kind: 'explicit'; readonly id: number }

export const NO_DICTIONARY: FrameDictionarySelector = Object.freeze({ kind: 'none' })
export const APPLICATION_ZERO_DICTIONARY: FrameDictionarySelector = Object.freeze({
  kind: 'application-zero',
})

export function explicitDictionaryId(id: number): FrameDictionarySelector {
  if (!Number.isInteger(id)) {
    throw new TypeError(`Dictionary id must be an integer`)
  }
  if (id < 1 || id > MAX_DICTIONARY_ID) {
    throw new RangeError(`Dictionary id must be between 1 and ${MAX_DICTIONARY_ID}`)
  }
  return Object.freeze({ kind: 'explicit', id })
}

/**
 * null/undefined means the frame did not contain a dictionary id.
 * 0 is retained as Zstandard's application-defined dictionary convention;
 * it is deliberately different from “no dictionary”.
 */
export function frameDictionarySelector(id: number | null | undefined): FrameDictionarySelector {
  if (id === null || id === undefined) return NO_DICTIONARY
  if (id === 0) return APPLICATION_ZERO_DICTIONARY
  return explicitDictionaryId(id)
}

function dictionaryIdWidth(dictionaryIdFlag: number): 0 | 1 | 2 | 4 | null {
  return dictionaryIdFlag === 1
    ? 1
    : dictionaryIdFlag === 2
      ? 2
      : dictionaryIdFlag === 3
        ? 4
        : dictionaryIdFlag === 0
          ? 0
          : null
}

export function readDictionaryId(
  data: Uint8Array,
  offset: number,
  dictionaryIdFlag: number,
): number | null {
  const width = dictionaryIdWidth(dictionaryIdFlag)
  if (width === null) {
    throw new TypeError('dictionaryIdFlag must be between 0 and 3')
  }
  if (width === 0 || offset < 0 || data.length - offset < width) return null

  let value = 0
  for (let i = 0; i < width; i += 1) {
    value += data[offset + i] * 2 ** (8 * i)
  }
  return value >>> 0
}

/**
 * Parse the dictionary id from a frame descriptor byte and the following
 * little-endian bytes. Returns `null` when the frame has no dictionary id.
 */
export function parseFrameDictionaryId(frame: Uint8Array, descriptorOffset = 0): number | null {
  const descriptor = parseDescriptor(frame[descriptorOffset] ?? 0)
  const width = dictionaryIdWidth(descriptor.dictionaryIdFlag)
  if (width === null) return null
  if (width === 0) return null

  const contentSizeWidths = descriptor.singleSegment ? [1, 2, 4, 4] : [0, 2, 4, 8]
  const contentSizeWidth = contentSizeWidths[descriptor.contentSizeFlag]
  const windowDescriptorWidth = descriptor.singleSegment ? 0 : 1
  const offset = descriptorOffset + 1 + contentSizeWidth + windowDescriptorWidth

  return readDictionaryId(frame, offset, descriptor.dictionaryIdFlag)
}

export interface DictionaryVersion {
  readonly id: number
  readonly revision: number | string
  readonly digest: string
  readonly content: Uint8Array
}

export interface DictionaryHandle {
  readonly version: DictionaryVersion
  release(): void
}

export interface DictionaryLoadContext {
  /** Aborted only when every coalesced waiter for this load has been cancelled. */
  readonly signal: AbortSignal
}

/**
 * A repository normally returns exactly one active revision. It may return
 * multiple rows when that is a natural result of a backend query; identical
 * revisions/summaries are deduplicated, while two active revisions for one id
 * make the frame fail because the frame header cannot choose between them.
 */
export type DictionaryLoadResult =
  | DictionaryVersion
  | readonly DictionaryVersion[]
  | null
  | undefined

export interface VersionedDictionaryRepository {
  load(id: number, context: DictionaryLoadContext): PromiseLike<DictionaryLoadResult> | DictionaryLoadResult
  open(version: DictionaryVersion): DictionaryHandle
}

export interface FrameDictionaryDecodeContext {
  readonly frameId: FrameId
  readonly selector: FrameDictionarySelector
  readonly requestedDictionaryId: number | null
}

export type FrameDictionaryDecoder<T> = (
  handle: DictionaryHandle | null,
  context: FrameDictionaryDecodeContext,
) => PromiseLike<T> | T

export interface ResolveFrameDictionaryOptions<T> {
  readonly frameId: FrameId
  readonly selector: FrameDictionarySelector
  readonly signal?: AbortSignal
  readonly decode: FrameDictionaryDecoder<T>
}

export type DictionaryResolutionErrorCode =
  | 'DICTIONARY_NOT_FOUND'
  | 'AMBIGUOUS_DICTIONARY_REVISION'
  | 'INVALID_DICTIONARY_RECORD'
  | 'DICTIONARY_LOAD_FAILED'
  | 'DICTIONARY_HANDLE_OPEN_FAILED'
  | 'DICTIONARY_HANDLE_RELEASE_FAILED'
  | 'FRAME_DECODER_FAILED'
  | 'FRAME_DICTIONARY_ABORTED'

export interface DictionaryResolutionErrorDetails {
  readonly code: DictionaryResolutionErrorCode
  readonly frameId: FrameId
  readonly requestedDictionaryId: number | null
  readonly message?: string
  readonly cause?: unknown
}

export class DictionaryResolutionError extends Error {
  readonly code: DictionaryResolutionErrorCode
  readonly frameId: FrameId
  readonly requestedDictionaryId: number | null

  constructor(details: DictionaryResolutionErrorDetails) {
    super(details.message ?? defaultErrorMessage(details), { cause: details.cause })
    this.name = 'DictionaryResolutionError'
    this.code = details.code
    this.frameId = details.frameId
    this.requestedDictionaryId = details.requestedDictionaryId
  }
}

export class FrameDictionaryAbortError extends DictionaryResolutionError {
  constructor(details: Omit<DictionaryResolutionErrorDetails, 'code'>) {
    super({ ...details, code: 'FRAME_DICTIONARY_ABORTED' })
    this.name = 'AbortError'
  }
}

function defaultErrorMessage(details: DictionaryResolutionErrorDetails): string {
  const dictionary =
    details.requestedDictionaryId === null ? 'no dictionary' : `dictionary ${details.requestedDictionaryId}`
  switch (details.code) {
    case 'DICTIONARY_NOT_FOUND':
      return `Frame ${details.frameId}: ${dictionary} was not found in the repository`
    case 'AMBIGUOUS_DICTIONARY_REVISION':
      return `Frame ${details.frameId}: ${dictionary} has more than one active revision`
    case 'INVALID_DICTIONARY_RECORD':
      return `Frame ${details.frameId}: ${dictionary} returned an invalid repository record`
    case 'DICTIONARY_LOAD_FAILED':
      return `Frame ${details.frameId}: failed to load ${dictionary}`
    case 'DICTIONARY_HANDLE_OPEN_FAILED':
      return `Frame ${details.frameId}: failed to open a handle for ${dictionary}`
    case 'DICTIONARY_HANDLE_RELEASE_FAILED':
      return `Frame ${details.frameId}: failed to release the handle for ${dictionary}`
    case 'FRAME_DECODER_FAILED':
      return `Frame ${details.frameId}: injected decoder failed for ${dictionary}`
    case 'FRAME_DICTIONARY_ABORTED':
      return `Frame ${details.frameId}: processing was cancelled while using ${dictionary}`
  }
}

function frameResolutionError(
  frameId: FrameId,
  requestedDictionaryId: number | null,
  code: DictionaryResolutionErrorCode,
  cause?: unknown,
): DictionaryResolutionError {
  return new DictionaryResolutionError({ frameId, requestedDictionaryId, code, cause })
}

function abortError(frameId: FrameId, requestedDictionaryId: number | null, cause?: unknown) {
  return new FrameDictionaryAbortError({ frameId, requestedDictionaryId, cause })
}

type SelectionErrorCode =
  | 'DICTIONARY_NOT_FOUND'
  | 'AMBIGUOUS_DICTIONARY_REVISION'
  | 'INVALID_DICTIONARY_RECORD'

class DictionarySelectionError extends Error {
  readonly code: SelectionErrorCode
  readonly requestedDictionaryId: number

  constructor(code: SelectionErrorCode, requestedDictionaryId: number, message: string) {
    super(message)
    this.name = 'DictionarySelectionError'
    this.code = code
    this.requestedDictionaryId = requestedDictionaryId
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateCandidate(candidate: unknown, requestedId: number): DictionaryVersion {
  if (!isRecord(candidate)) {
    throw new DictionarySelectionError(
      'INVALID_DICTIONARY_RECORD',
      requestedId,
      `Dictionary ${requestedId} record is not an object`,
    )
  }

  const { id, revision, digest, content } = candidate
  if (id !== requestedId) {
    throw new DictionarySelectionError(
      'INVALID_DICTIONARY_RECORD',
      requestedId,
      `Expected dictionary id ${requestedId} but repository returned ${String(id)}`,
    )
  }
  if ((typeof revision !== 'number' || !Number.isFinite(revision)) && typeof revision !== 'string') {
    throw new DictionarySelectionError(
      'INVALID_DICTIONARY_RECORD',
      requestedId,
      `Dictionary ${requestedId} has an invalid revision`,
    )
  }
  if (typeof revision === 'string' && revision.length === 0) {
    throw new DictionarySelectionError(
      'INVALID_DICTIONARY_RECORD',
      requestedId,
      `Dictionary ${requestedId} has an empty revision`,
    )
  }
  if (typeof digest !== 'string' || digest.length === 0) {
    throw new DictionarySelectionError(
      'INVALID_DICTIONARY_RECORD',
      requestedId,
      `Dictionary ${requestedId} has an empty content digest`,
    )
  }
  if (!(content instanceof Uint8Array)) {
    throw new DictionarySelectionError(
      'INVALID_DICTIONARY_RECORD',
      requestedId,
      `Dictionary ${requestedId} content must be a Uint8Array`,
    )
  }

  return Object.freeze({
    id,
    revision,
    digest,
    content: new Uint8Array(content),
  })
}

function freezeDictionaryVersion(requestedId: number, result: DictionaryLoadResult): DictionaryVersion {
  if (result === null || result === undefined) {
    throw new DictionarySelectionError(
      'DICTIONARY_NOT_FOUND',
      requestedId,
      `Dictionary ${requestedId} was not found`,
    )
  }

  const candidates = Array.isArray(result) ? result : [result]
  if (candidates.length === 0) {
    throw new DictionarySelectionError(
      'DICTIONARY_NOT_FOUND',
      requestedId,
      `Dictionary ${requestedId} was not found`,
    )
  }

  let selected: DictionaryVersion | null = null
  for (const candidate of candidates) {
    const version = validateCandidate(candidate, requestedId)
    if (selected === null) {
      selected = version
    } else if (version.revision !== selected.revision || version.digest !== selected.digest) {
      throw new DictionarySelectionError(
        'AMBIGUOUS_DICTIONARY_REVISION',
        requestedId,
        `Dictionary ${requestedId} has multiple active revisions`,
      )
    }
  }

  return selected as DictionaryVersion
}

/**
 * Small reference implementation for an active-revision dictionary store.
 * Different revisions may replace the active revision; an existing revision is
 * immutable and cannot be stored with a different digest.
 */
export class InMemoryVersionedDictionaryRepository implements VersionedDictionaryRepository {
  private readonly active = new Map<number, DictionaryVersion>()

  constructor(versions?: Iterable<DictionaryVersion>) {
    if (versions) {
      for (const version of versions) this.put(version)
    }
  }

  load(id: number): DictionaryVersion | null {
    return this.active.get(id) ?? null
  }

  open(version: DictionaryVersion): DictionaryHandle {
    const handleVersion: DictionaryVersion = {
      ...version,
      content: new Uint8Array(version.content),
    }
    let released = false
    return {
      version: handleVersion,
      release() {
        released = true
      },
    }
  }

  put(version: DictionaryVersion): this {
    const next = Object.freeze({
      id: version.id,
      revision: version.revision,
      digest: version.digest,
      content: new Uint8Array(version.content),
    })
    validateCandidate(next, next.id)

    const current = this.active.get(next.id)
    if (current && current.revision === next.revision && current.digest !== next.digest) {
      throw new Error(
        `Dictionary ${next.id} revision ${String(next.revision)} already exists with a different digest`,
      )
    }

    this.active.set(next.id, next)
    return this
  }
}

interface PendingDictionaryLoad {
  readonly controller: AbortController
  readonly promise: Promise<DictionaryLoadResult>
  waiters: number
  settled: boolean
}

export class FrameDictionaryResolver {
  private readonly repository: VersionedDictionaryRepository
  private readonly inflight = new Map<number, PendingDictionaryLoad>()

  constructor(repository: VersionedDictionaryRepository) {
    this.repository = repository
  }

  resolve<T>(options: ResolveFrameDictionaryOptions<T>): Promise<T> {
    const { frameId, selector, signal, decode } = options
    if (typeof decode !== 'function') {
      throw new TypeError('resolve requires a decode function')
    }

    const requestedDictionaryId =
      selector.kind === 'none'
        ? null
        : selector.kind === 'application-zero'
          ? 0
          : selector.id

    if (signal?.aborted) {
      return Promise.reject(abortError(frameId, requestedDictionaryId))
    }

    if (selector.kind === 'none') {
      return this.runDecoder(null, frameId, selector, null, signal, decode)
    }

    const requestedId = selector.kind === 'application-zero' ? 0 : selector.id

    return this.loadVersion(frameId, requestedId, signal).then((version) => {
      let handle: DictionaryHandle
      try {
        handle = this.repository.open(version)
        if (!handle || typeof handle.release !== 'function') {
          throw new TypeError('repository.open did not return a handle with a release method')
        }
      } catch (cause) {
        throw frameResolutionError(
          frameId,
          requestedId,
          'DICTIONARY_HANDLE_OPEN_FAILED',
          cause,
        )
      }

      if (signal?.aborted) {
        let releaseCause: unknown
        try {
          handle.release()
        } catch (cause) {
          releaseCause = cause
        }
        throw abortError(frameId, requestedId, releaseCause)
      }

      return this.runDecoder(handle, frameId, selector, requestedId, signal, decode)
    })
  }

  private loadVersion(
    frameId: FrameId,
    id: number,
    signal: AbortSignal | undefined,
  ): Promise<DictionaryVersion> {
    return new Promise((resolve, reject) => {
      const pending = this.joinLoad(id)

      const onAbort = () => {
        this.cancelOne(pending, id)
        reject(abortError(frameId, id))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      pending.promise.then(
        (result) => {
          signal?.removeEventListener('abort', onAbort)
          if (signal?.aborted) {
            reject(abortError(frameId, id))
            return
          }

          try {
            resolve(freezeDictionaryVersion(id, result))
          } catch (cause) {
            reject(toResolutionError(frameId, id, cause))
          }
        },
        (cause) => {
          signal?.removeEventListener('abort', onAbort)
          if (signal?.aborted) {
            reject(abortError(frameId, id))
            return
          }
          reject(frameResolutionError(frameId, id, 'DICTIONARY_LOAD_FAILED', cause))
        },
      )
    })
  }

  private joinLoad(id: number): PendingDictionaryLoad {
    const existing = this.inflight.get(id)
    if (existing) {
      existing.waiters += 1
      return existing
    }

    const controller = new AbortController()
    let promise: Promise<DictionaryLoadResult>
    try {
      promise = Promise.resolve(this.repository.load(id, { signal: controller.signal }))
    } catch (cause) {
      promise = Promise.reject(cause)
    }

    const pending: PendingDictionaryLoad = {
      controller,
      promise,
      waiters: 1,
      settled: false,
    }

    const settle = () => {
      pending.settled = true
      if (this.inflight.get(id) === pending) this.inflight.delete(id)
    }
    promise.then(settle, settle)
    this.inflight.set(id, pending)
    return pending
  }

  private cancelOne(pending: PendingDictionaryLoad, id: number): void {
    if (pending.settled) return
    pending.waiters -= 1
    if (pending.waiters > 0) return

    pending.settled = true
    if (this.inflight.get(id) === pending) this.inflight.delete(id)
    pending.controller.abort()
  }

  private runDecoder<T>(
    handle: DictionaryHandle | null,
    frameId: FrameId,
    selector: FrameDictionarySelector,
    requestedDictionaryId: number | null,
    signal: AbortSignal | undefined,
    decode: FrameDictionaryDecoder<T>,
  ): Promise<T> {
    if (signal?.aborted) {
      let releaseCause: unknown
      if (handle) {
        try {
          handle.release()
        } catch (cause) {
          releaseCause = cause
        }
      }
      return Promise.reject(abortError(frameId, requestedDictionaryId, releaseCause))
    }

    return new Promise<T>((resolve, reject) => {
      const context = Object.freeze({ frameId, selector, requestedDictionaryId })
      let outerSettled = false
      let decoderPromise: PromiseLike<T>

      try {
        decoderPromise = Promise.resolve(decode(handle, context))
      } catch (cause) {
        rejectAfterDecoder(cause)
        return
      }

      const onAbort = () => {
        if (outerSettled) return
        outerSettled = true
        reject(abortError(frameId, requestedDictionaryId))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      Promise.resolve(decoderPromise).then(
        (value) => {
          signal?.removeEventListener('abort', onAbort)
          try {
            handle?.release()
          } catch (cause) {
            if (!outerSettled) {
              outerSettled = true
              reject(
                frameResolutionError(
                  frameId,
                  requestedDictionaryId,
                  'DICTIONARY_HANDLE_RELEASE_FAILED',
                  cause,
                ),
              )
            }
            return
          }

          if (!outerSettled) {
            outerSettled = true
            resolve(value)
          }
        },
        (decoderCause) => {
          signal?.removeEventListener('abort', onAbort)
          let releaseCause: unknown
          try {
            handle?.release()
          } catch (cause) {
            releaseCause = cause
          }

          if (!outerSettled) {
            outerSettled = true
            if (releaseCause) {
              reject(
                frameResolutionError(
                  frameId,
                  requestedDictionaryId,
                  'DICTIONARY_HANDLE_RELEASE_FAILED',
                  releaseCause,
                ),
              )
            } else {
              reject(
                frameResolutionError(
                  frameId,
                  requestedDictionaryId,
                  'FRAME_DECODER_FAILED',
                  decoderCause,
                ),
              )
            }
          }
        },
      )

      function rejectAfterDecoder(cause: unknown) {
        let releaseCause: unknown
        try {
          handle?.release()
        } catch (releaseError) {
          releaseCause = releaseError
        }

        if (releaseCause) {
          reject(
            frameResolutionError(
              frameId,
              requestedDictionaryId,
              'DICTIONARY_HANDLE_RELEASE_FAILED',
              releaseCause,
            ),
          )
        } else {
          reject(frameResolutionError(frameId, requestedDictionaryId, 'FRAME_DECODER_FAILED', cause))
        }
      }
    })
  }
}

function toResolutionError(frameId: FrameId, id: number, cause: unknown): DictionaryResolutionError {
  if (cause instanceof DictionarySelectionError) {
    return new DictionaryResolutionError({
      frameId,
      requestedDictionaryId: id,
      code: cause.code,
      cause,
    })
  }
  return frameResolutionError(frameId, id, 'DICTIONARY_LOAD_FAILED', cause)
}
