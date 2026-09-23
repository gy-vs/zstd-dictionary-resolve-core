# Zstandard framing core

TypeScript library for Zstandard frame processing.

Run `npm install`, then `npm test` and `npm run build`.

## Dictionary resolution

A frame header can have no dictionary id, application-defined dictionary id `0`,
or an explicit positive dictionary id. These are represented separately:

```ts
import {
  FrameDictionaryResolver,
  InMemoryVersionedDictionaryRepository,
  NO_DICTIONARY,
  APPLICATION_ZERO_DICTIONARY,
  explicitDictionaryId,
  frameDictionarySelector,
  parseFrameDictionaryId,
} from './dist/index.js'

const id = parseFrameDictionaryId(frame)
const selector = id === null
  ? NO_DICTIONARY
  : frameDictionarySelector(id) // zero remains APPLICATION_ZERO_DICTIONARY

const resolver = new FrameDictionaryResolver(
  new InMemoryVersionedDictionaryRepository(),
)

const result = await resolver.resolve({
  frameId: 'frame-1',
  selector,
  signal,
  decode(handle, context) {
    // handle is null only for NO_DICTIONARY. It is released when the frame ends.
    return decodeFrameWithInjectedDictionary(frame, handle, context)
  },
})
```

Loads for the same dictionary id are merged. Cancelling one frame request does
not abort a shared load while another frame is waiting; it only aborts the
underlying load when the last waiter leaves. A frame receives a snapshot of the
selected revision, so later repository updates do not change in-flight decoding.
All repository and decoder errors are `DictionaryResolutionError` values and
include both `frameId` and `requestedDictionaryId`.
