## ADDED Requirements

### Requirement: Dictation streams ordered PCM segments
The client MUST buffer base64 PCM segments in insertion order, start a stream with a generated `dictationId` when connected, send each segment with its zero-based sequence number and format, and process at most 128 chunks per flush turn (`scratchpad/reference/packages/app/src/dictation/dictation-stream-sender.ts:5-7,20-30,92-132`).

#### Scenario: Buffered segments are sent in order
- **GIVEN** a connected daemon and three queued PCM segments
- **WHEN** the stream becomes ready and `flush` runs
- **THEN** the daemon receives sequence numbers `0`, `1`, and `2` in that order, and `getFinalSeq()` returns `2` (`scratchpad/reference/packages/app/src/dictation/dictation-stream-sender.ts:61-67,112-132`)

#### Scenario: Flush is bounded
- **GIVEN** more than 128 pending segments
- **WHEN** one flush turn runs
- **THEN** it sends no more than 128 chunks and schedules another flush while segments remain (`scratchpad/reference/packages/app/src/dictation/dictation-stream-sender.ts:5,119-131`)

### Requirement: Dictation completion returns partial and final transcription
The daemon MUST create a streaming STT session for the requested language, emit partial transcripts as ordered segment text, use a 10,000 ms default final timeout and a 15-second default auto-commit interval, and emit explicit accepted, partial, final, or error events (`scratchpad/reference/packages/server/src/server/dictation/dictation-stream-manager.ts:17-24,97-126,138-156,165-184,207-228`).

#### Scenario: STT is unavailable
- **GIVEN** no STT provider is configured
- **WHEN** a dictation stream starts
- **THEN** the daemon emits `dictation_stream_error` with `retryable: false` and does not create an STT session (`scratchpad/reference/packages/server/src/server/dictation/dictation-stream-manager.ts:165-171`)

#### Scenario: Finish waits for the client drain
- **GIVEN** the client has pending segments and a connected stream
- **WHEN** the client calls `finish(finalSeq)`
- **THEN** it flushes all pending segments before sending `finishDictationStream(dictationId, finalSeq)` (`scratchpad/reference/packages/app/src/dictation/dictation-stream-sender.ts:179-203`)

### Requirement: Voice mode owns STT, TTS, interruption, and turn detection
The daemon MUST keep voice state within a session that owns STT, TTS, dictation streaming, audio buffering for interruption, voice-turn detection, and the MCP voice bridge, while delivering spoken input to the active agent (`scratchpad/reference/packages/server/src/server/session/voice/voice-session.ts:116-132,158-163`).

#### Scenario: Voice session is configured with speech providers
- **GIVEN** a voice session is created with STT, TTS, and optional turn detection providers
- **WHEN** the session initializes
- **THEN** it constructs TTS and STT managers and uses the configured STT language, defaulting to `en` (`scratchpad/reference/packages/server/src/server/session/voice/voice-session.ts:210-229`)

### Requirement: Dictation UI supports insert, insert-and-send, cancel, and retry
The client MUST show a microphone control when inactive; during recording or processing it MUST show duration and volume state, and after processing it MUST expose insert and insert-and-send actions; failed recognition MUST expose retry and discard/cancel actions (`scratchpad/reference/packages/app/src/components/dictation-controls.tsx:27-52,71-134`).

#### Scenario: Successful transcription offers two outcomes
- **GIVEN** dictation is no longer processing and has not failed
- **WHEN** the controls render
- **THEN** both `onAccept` and `onAcceptAndSend` controls are present (`scratchpad/reference/packages/app/src/components/dictation-controls.tsx:100-130`)

