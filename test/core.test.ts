import { describe, expect, it, vi } from 'vitest'
import {
  APPLICATION_ZERO_DICTIONARY,
  DictionaryResolutionError,
  FrameDictionaryResolver,
  FrameDictionaryAbortError,
  InMemoryVersionedDictionaryRepository,
  NO_DICTIONARY,
  explicitDictionaryId,
  frameDictionarySelector,
  parseDescriptor,
  parseFrameDictionaryId,
  readDictionaryId,
  type DictionaryHandle,
  type DictionaryLoadContext,
  type DictionaryVersion,
  type VersionedDictionaryRepository,
} from '../src/index.js'

describe('frame descriptor', () => {
  it('parses flags', () => {
    expect(parseDescriptor(32).singleSegment).toBe(true)
  })

  it.each([
    [1, 1, 1],
    [2, 7, 7],
    [3, 0 | (1 << 8) | (2 << 16) | (3 << 24), 0x03020100],
  ])('reads a %s-byte dictionary id', (flag, encoded, expected) => {
    const data = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1])
    data[4] = encoded & 0xff
    data[5] = (encoded >> 8) & 0xff
    data[6] = (encoded >> 16) & 0xff
    data[7] = (encoded >> 24) & 0xff
    expect(readDictionaryId(data, 4, flag)).toBe(expected)
  })

  it('returns null when dictionary id is absent or truncated', () => {
    expect(readDictionaryId(new Uint8Array([1]), 0, 0)).toBeNull()
    expect(readDictionaryId(new Uint8Array([1]), 0, 2)).toBeNull()
  })

  it('parses dictionary id from a complete frame header', () => {
    expect(parseFrameDictionaryId(new Uint8Array([32]))).toBeNull()
    expect(parseFrameDictionaryId(new Uint8Array([98, 0, 0, 7, 0]))).toBe(7)
    expect(parseFrameDictionaryId(new Uint8Array([65, 0, 0, 0, 9]))).toBe(9)
  })
})

describe('dictionary selector', () => {
  it('distinguishes absent id from application id zero and explicit ids', () => {
    expect(frameDictionarySelector(null)).toBe(NO_DICTIONARY)
    expect(frameDictionarySelector(undefined)).toBe(NO_DICTIONARY)
    expect(frameDictionarySelector(0)).toBe(APPLICATION_ZERO_DICTIONARY)
    expect(frameDictionarySelector(42)).toEqual(explicitDictionaryId(42))
  })

  it('rejects invalid explicit ids', () => {
    expect(() => explicitDictionaryId(0)).toThrow(RangeError)
    expect(() => explicitDictionaryId(1.5)).toThrow(TypeError)
  })
})

function version(id: number, revision: number | string, digest = `digest-${revision}`): DictionaryVersion {
  return {
    id,
    revision,
    digest,
    content: new TextEncoder().encode(`content-${id}-${String(revision)}`),
  }
}

class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void
  reject!: (reason?: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

class TestRepository implements VersionedDictionaryRepository {
  readonly loads: Array<{ id: number; context: DictionaryLoadContext }> = []
  releases: DictionaryHandle[] = []
  loadImpl?: (id: number, context: DictionaryLoadContext) => ReturnType<VersionedDictionaryRepository['load']>
  openSpy = vi.fn()

  constructor(private readonly store = new InMemoryVersionedDictionaryRepository()) {}

  put(value: DictionaryVersion) {
    this.store.put(value)
    return this
  }

  load(id: number, context: DictionaryLoadContext) {
    this.loads.push({ id, context })
    return this.loadImpl ? this.loadImpl(id, context) : this.store.load(id)
  }

  open(version: DictionaryVersion): DictionaryHandle {
    this.openSpy(version)
    const handle = this.store.open(version)
    return {
      version: handle.version,
      release: vi.fn(() => {
        this.releases.push(handle)
        handle.release()
      }),
    }
  }
}

function assertFrameError(
  error: unknown,
  code: string,
  frameId: number | string,
  requestedDictionaryId: number | null,
) {
  expect(error).toBeInstanceOf(DictionaryResolutionError)
  const typed = error as DictionaryResolutionError
  expect(typed.code).toBe(code)
  expect(typed.frameId).toBe(frameId)
  expect(typed.requestedDictionaryId).toBe(requestedDictionaryId)
}

describe('FrameDictionaryResolver', () => {
  it('passes no dictionary to the decoder without touching the repository', async () => {
    const repository = new TestRepository()
    const resolver = new FrameDictionaryResolver(repository)
    const decode = vi.fn(() => 'decoded')

    await expect(resolver.resolve({ frameId: 'none', selector: NO_DICTIONARY, decode })).resolves.toBe(
      'decoded',
    )
    expect(decode.mock.calls[0]?.[0]).toBeNull()
    expect(repository.loads).toHaveLength(0)
  })

  it('loads id zero as the application convention', async () => {
    const repository = new TestRepository().put(version(0, 'app-default'))
    const resolver = new FrameDictionaryResolver(repository)
    const decode = vi.fn(() => 'zero')

    await expect(
      resolver.resolve({ frameId: 1, selector: APPLICATION_ZERO_DICTIONARY, decode }),
    ).resolves.toBe('zero')
    expect(repository.loads).toEqual([
      expect.objectContaining({ id: 0 }),
    ])
    expect(decode.mock.calls[0]?.[0]?.version.revision).toBe('app-default')
  })

  it('reports a missing dictionary with frame id and requested dictionary id', async () => {
    const repository = new TestRepository()
    const resolver = new FrameDictionaryResolver(repository)

    await expect(
      resolver.resolve({
        frameId: 77,
        selector: explicitDictionaryId(123),
        decode: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'DICTIONARY_NOT_FOUND', frameId: 77, requestedDictionaryId: 123 })
  })

  it('reports ambiguous active revisions for the same dictionary id', async () => {
    const repository = new TestRepository()
    repository.loadImpl = () => [version(9, 'r1'), version(9, 'r2')]
    const resolver = new FrameDictionaryResolver(repository)

    try {
      await resolver.resolve({ frameId: 'f', selector: explicitDictionaryId(9), decode: vi.fn() })
      throw new Error('expected failure')
    } catch (error) {
      assertFrameError(error, 'AMBIGUOUS_DICTIONARY_REVISION', 'f', 9)
    }
  })

  it('accepts duplicate repository rows when revision and digest agree', async () => {
    const one = version(9, 1)
    const repository = new TestRepository()
    repository.loadImpl = () => [one, { ...one }]
    const resolver = new FrameDictionaryResolver(repository)

    await expect(
      resolver.resolve({
        frameId: 1,
        selector: explicitDictionaryId(9),
        decode: (handle) => handle.version.digest,
      }),
    ).resolves.toBe('digest-1')
  })

  it('rejects records for a different id', async () => {
    const repository = new TestRepository()
    repository.loadImpl = () => version(8, 1)
    const resolver = new FrameDictionaryResolver(repository)

    await expect(
      resolver.resolve({ frameId: 2, selector: explicitDictionaryId(9), decode: vi.fn() }),
    ).rejects.toMatchObject({ code: 'INVALID_DICTIONARY_RECORD', frameId: 2, requestedDictionaryId: 9 })
  })

  it('wraps a loading failure with frame id and dictionary id', async () => {
    const repository = new TestRepository()
    const cause = new Error('backend unavailable')
    repository.loadImpl = () => Promise.reject(cause)
    const resolver = new FrameDictionaryResolver(repository)

    await expect(
      resolver.resolve({ frameId: 'load-failed', selector: explicitDictionaryId(5), decode: vi.fn() }),
    ).rejects.toMatchObject({
      code: 'DICTIONARY_LOAD_FAILED',
      frameId: 'load-failed',
      requestedDictionaryId: 5,
      cause,
    })
  })

  it('coalesces concurrent requests for one dictionary and opens a per-frame handle', async () => {
    const repository = new TestRepository().put(version(10, 1))
    const deferred = new Deferred<DictionaryVersion | null>()
    repository.loadImpl = () => deferred.promise
    const resolver = new FrameDictionaryResolver(repository)

    const firstDecoder = vi.fn((handle: DictionaryHandle) => `first:${handle.version.revision}`)
    const secondDecoder = vi.fn((handle: DictionaryHandle) => `second:${handle.version.revision}`)

    const first = resolver.resolve({
      frameId: 'first',
      selector: explicitDictionaryId(10),
      decode: firstDecoder,
    })
    const second = resolver.resolve({
      frameId: 'second',
      selector: explicitDictionaryId(10),
      decode: secondDecoder,
    })
    await flush()

    expect(repository.loads).toHaveLength(1)
    deferred.resolve(version(10, 1))
    await expect(Promise.all([first, second])).resolves.toEqual(['first:1', 'second:1'])
    expect(repository.openSpy).toHaveBeenCalledTimes(2)
    expect(repository.releases).toHaveLength(2)
  })

  it('loads different dictionary ids concurrently as separate requests', async () => {
    const repository = new TestRepository()
    const ten = new Deferred<DictionaryVersion | null>()
    const eleven = new Deferred<DictionaryVersion | null>()
    repository.loadImpl = (id) => (id === 10 ? ten.promise : eleven.promise)
    const resolver = new FrameDictionaryResolver(repository)

    const first = resolver.resolve({
      frameId: 1,
      selector: explicitDictionaryId(10),
      decode: () => 10,
    })
    const second = resolver.resolve({
      frameId: 2,
      selector: explicitDictionaryId(11),
      decode: () => 11,
    })
    await flush()

    ten.resolve(version(10, 1))
    eleven.resolve(version(11, 1))
    await expect(Promise.all([first, second])).resolves.toEqual([10, 11])
    expect(repository.loads.map((load) => load.id).sort()).toEqual([10, 11])
  })

  it('does not cancel a coalesced load when one waiting frame is cancelled', async () => {
    const repository = new TestRepository().put(version(10, 1))
    const deferred = new Deferred<DictionaryVersion | null>()
    repository.loadImpl = (_id, context) => {
      deferred.promise.then(() => undefined, () => undefined)
      if (context.signal.aborted) throw new Error('already aborted')
      return deferred.promise
    }
    const resolver = new FrameDictionaryResolver(repository)
    const firstController = new AbortController()
    const firstDecoder = vi.fn()

    const first = resolver.resolve({
      frameId: 'cancelled',
      selector: explicitDictionaryId(10),
      signal: firstController.signal,
      decode: firstDecoder,
    })
    const second = resolver.resolve({
      frameId: 'surviving',
      selector: explicitDictionaryId(10),
      decode: (handle) => handle.version.revision,
    })
    await flush()

    firstController.abort()
    await expect(first).rejects.toBeInstanceOf(FrameDictionaryAbortError)
    await expect(first).rejects.toMatchObject({ frameId: 'cancelled', requestedDictionaryId: 10 })

    expect(repository.loads[0]?.context.signal.aborted).toBe(false)
    deferred.resolve(version(10, 1))
    await expect(second).resolves.toBe(1)
    expect(firstDecoder).not.toHaveBeenCalled()
    expect(repository.releases).toHaveLength(1)
  })

  it('cancels the underlying load only when its last waiter cancels', async () => {
    const repository = new TestRepository()
    const deferred = new Deferred<DictionaryVersion | null>()
    repository.loadImpl = (_id, context) => {
      deferred.promise.then(() => undefined, () => undefined)
      return new Promise(() => undefined)
    }
    const resolver = new FrameDictionaryResolver(repository)
    const controller = new AbortController()

    const request = resolver.resolve({
      frameId: 'sole',
      selector: explicitDictionaryId(10),
      signal: controller.signal,
      decode: vi.fn(),
    })
    await flush()
    const loadSignal = repository.loads[0]?.context.signal
    expect(loadSignal?.aborted).toBe(false)

    controller.abort()
    await expect(request).rejects.toBeInstanceOf(FrameDictionaryAbortError)
    expect(loadSignal?.aborted).toBe(true)
    deferred.resolve(null)
  })

  it('rejects immediately for cancellation before loading starts', async () => {
    const repository = new TestRepository()
    const resolver = new FrameDictionaryResolver(repository)
    const controller = new AbortController()
    controller.abort()

    await expect(
      resolver.resolve({
        frameId: 'early',
        selector: explicitDictionaryId(10),
        signal: controller.signal,
        decode: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'FRAME_DICTIONARY_ABORTED', frameId: 'early', requestedDictionaryId: 10 })
    expect(repository.loads).toHaveLength(0)
  })

  it('freezes dictionary content for a frame even when repository revision changes', async () => {
    const repository = new TestRepository().put(version(20, 1))
    const decoderStarted = new Deferred<void>()
    const decoderCanFinish = new Deferred<void>()
    const resolver = new FrameDictionaryResolver(repository)

    const frame = resolver.resolve({
      frameId: 'in-flight',
      selector: explicitDictionaryId(20),
      decode: (handle) => {
        decoderStarted.resolve()
        return decoderCanFinish.promise.then(() => handle.version.revision)
      },
    })

    await decoderStarted.promise
    repository.put(version(20, 2))
    decoderCanFinish.resolve()
    await expect(frame).resolves.toBe(1)

    await expect(
      resolver.resolve({
        frameId: 'after-update',
        selector: explicitDictionaryId(20),
        decode: (handle) => handle.version.revision,
      }),
    ).resolves.toBe(2)
    expect(repository.releases).toHaveLength(2)
  })

  it('releases the handle when a decoder finishes late after outer cancellation', async () => {
    const repository = new TestRepository().put(version(30, 1))
    const decoderStarted = new Deferred<void>()
    const decoderCanFinish = new Deferred<void>()
    let activeHandle: DictionaryHandle | null = null
    const resolver = new FrameDictionaryResolver(repository)
    const controller = new AbortController()

    const frame = resolver.resolve({
      frameId: 'late-decoder',
      selector: explicitDictionaryId(30),
      signal: controller.signal,
      decode: (handle) => {
        activeHandle = handle
        decoderStarted.resolve()
        return decoderCanFinish.promise.then(() => 'late')
      },
    })

    await decoderStarted.promise
    controller.abort()
    await expect(frame).rejects.toMatchObject({
      code: 'FRAME_DICTIONARY_ABORTED',
      frameId: 'late-decoder',
      requestedDictionaryId: 30,
    })
    expect(repository.releases).toHaveLength(0)

    decoderCanFinish.resolve()
    await flush()
    expect(repository.releases).toHaveLength(1)
    expect(activeHandle?.version.revision).toBe(1)
  })

  it('releases the handle when the decoder fails', async () => {
    const repository = new TestRepository().put(version(40, 1))
    const resolver = new FrameDictionaryResolver(repository)
    const failure = new Error('bad frame')

    await expect(
      resolver.resolve({
        frameId: 'decoder-failure',
        selector: explicitDictionaryId(40),
        decode: () => Promise.reject(failure),
      }),
    ).rejects.toMatchObject({
      code: 'FRAME_DECODER_FAILED',
      frameId: 'decoder-failure',
      requestedDictionaryId: 40,
      cause: failure,
    })
    expect(repository.releases).toHaveLength(1)
  })
})
