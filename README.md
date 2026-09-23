# Zstandard framing core

TypeScript library for Zstandard frame processing.

Run `npm install`, then `npm test` and `npm run build`.

## Dictionary resolution

`readDictionarySelector` parses the frame descriptor's dictionary-id flag and field:

- flag `00` -> `NO_DICTIONARY`
- flag `01/10/11` and value `0` -> `APPLICATION_DICTIONARY` (`id: 0`)
- a non-zero little-endian value -> `explicitDictionary(id)`

`createDictionaryFrameResolver(repository).resolveFrame(request)` uses the explicit id to load a versioned dictionary and passes a frozen `{ kind, lease }` value to the injected `decodeFrame` implementation. The lease includes the selected `revision`, copied `content`, and content `summary`.

Concurrent frames requesting the same explicit id share one repository load and one handle. Cancelling one frame removes only that waiter; the repository load is aborted only when every waiter has cancelled. After loading, aborting a frame cannot abort another decoder or release the shared handle early. The handle is released once after every frame using that load has completed, including a decoder that finishes late. Updates published to the repository after the load was selected do not affect the copied in-flight lease.

Repository and frame failures are represented by `DictionaryResolutionError` / `FrameDictionaryAbortError` and include `frameId` plus `dictionaryId`. `null` or `undefined` from the repository means the dictionary is missing.
