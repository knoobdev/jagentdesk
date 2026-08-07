## ADDED Requirements

### Requirement: Mobile pairing orders offer, Tailscale, and code verification

The mobile app MUST show the pairing-offer entry surface first when no offer is pending. After the user scans a QR code, opens a deep-link, or pastes a JAgentDesk v3 offer, the app MUST persist that offer, require a completed Tailscale login — interactive OR auth key — and only then establish the signed connection that asks for the six-digit code. Choosing Local MUST remain an explicit alternative.

#### Scenario: Fresh mobile launch shows pairing entry

- **WHEN** the app launches with no saved host and no pending pairing offer
- **THEN** the app shows the pairing entry surface with Scan desktop QR, Paste pairing link, and an explicit Local option; it does not claim Tailscale is connected

#### Scenario: Offer precedes the Tailscale login gate

- **WHEN** the user submits a valid QR, deep-link, or pasted JAgentDesk v3 offer while Tailscale is not connected
- **THEN** the app persists the offer and routes to Tailscale login; returning from login routes back to the same offer verification screen

#### Scenario: Auth-key or interactive login resumes verification

- **WHEN** the user completes Tailscale login with an auth key or the interactive browser flow
- **THEN** the app refreshes the real Tailscale status, returns to the persisted offer, and presents the six-digit verification step

#### Scenario: Initial status hydration does not start an unauthenticated node

- **WHEN** the mobile app reads Tailscale status before the user has selected interactive login or submitted an auth key, and no previously authenticated state exists
- **THEN** the status read returns the login-required state promptly without starting a new unauthenticated tsnet node, and the auth-key action remains immediately usable

#### Scenario: Previously authenticated state restores the embedded node

- **WHEN** the mobile app starts with a previously authenticated Tailscale state
- **THEN** it restores the embedded node in the background, reports connected only after the real native status is connected, and never treats the persisted marker alone as proof of a live connection

### Requirement: Per-device keypair generated and registered on pair

Each app device MUST generate and persist its own asymmetric keypair, and pairing MUST register that device's public key with the daemon's paired-device set; the daemon MUST likewise hold its own persistent keypair loaded via `loadOrCreateDaemonKeyPair` (jagentdesk daemon-keypair.ts:30-70).

#### Scenario: Device key registered at pair time

- **WHEN** a device completes pairing with a daemon
- **THEN** the daemon stores that device's public key as an authorized paired device and the device retains its private key locally

#### Scenario: Daemon key is stable across restarts

- **WHEN** the daemon restarts
- **THEN** it reloads the same keypair from `daemon-keypair.json` rather than regenerating (jagentdesk daemon-keypair.ts:37-50)

### Requirement: Pairing offer carries tailnet address and daemon pubkey, drops relay fields

The pairing offer MUST reuse the `#offer=<base64url>` QR/deep-link encoding (jagentdesk connection-offer.ts:37, 54-59; jagentdesk pairing-offer.ts:46) but its payload MUST carry the daemon's tailnet address and `daemonPublicKeyB64`, and MUST NOT carry the relay endpoint fields present in `ConnectionOfferV2` (jagentdesk connection-offer.ts:9-19).

#### Scenario: Offer payload replaces relay with tailnet address

- **WHEN** the daemon generates a pairing offer
- **THEN** the encoded payload contains the daemon tailnet host:port and `daemonPublicKeyB64`, and contains no `relay.endpoint`/`relay.useTls` fields (contrast jagentdesk connection-offer.ts:13-16)

#### Scenario: Scanner accepts the #offer= fragment

- **WHEN** the mobile scanner reads a QR whose value contains `#offer=` (jagentdesk pair-scan.tsx:113-117, 173-174)
- **THEN** the app decodes the base64url fragment and extracts the daemon tailnet address and public key

### Requirement: One active QR or link pairing uses one stable six-digit confirmation

The daemon MUST NOT mint or expose a six-digit confirmation code on the initial QR/link offer. After a mobile device has submitted a JAgentDesk v3 offer, completed Tailscale login, reached the daemon, and sent its pre-hello identity hint, the daemon MUST create at most one active device connection request and one time-limited six-digit code. A reconnect from the same device during that request MUST reuse the same request ID and code; a different device MUST be rejected until the active request is completed, declined, or expires. The desktop MUST show that code only in the single active device request. QR scanning, pasted links, and deep-links MUST all navigate to the same verification step and MUST NOT connect or persist a new device before the matching code is entered.

#### Scenario: Initial offer has no confirmation code

- **WHEN** the desktop requests a current Tailscale pairing offer
- **THEN** the response contains no usable pairing code or expiry, the initial Pair device screen displays only the QR/link offer instructions, and the encoded `#offer=` payload contains no pairing code

#### Scenario: Pair device panel exposes the active request and code after the link is used

- **WHEN** a mobile device completes Tailscale login, uses the pairing offer to reach the daemon, and sends its pre-hello identity hint
- **THEN** the desktop receives `pairing.device.requested`, keeps the existing `Pair a device` sheet open, shows the supplied device identity and public-key fingerprint, shows exactly six decimal digits with a live countdown in the same sheet, and the mobile verification screen asks for that code; no second popup is opened

#### Scenario: Pair device panel waits for a request

- **WHEN** the desktop has opened `Pair a device` before a mobile device reaches the daemon
- **THEN** the sheet keeps the QR/link offer visible and renders a loading state explaining that device details and the unique six-digit code will appear only after a mobile device uses the pairing link and reaches this host

#### Scenario: Mobile submits the code automatically after six digits

- **WHEN** the user enters the sixth decimal digit of the active desktop request code on mobile
- **THEN** the mobile app submits that six-digit value immediately, shows a verifying state, and does not render a separate `Verify and pair` button

#### Scenario: Desktop entry points share one centered pair sheet

- **WHEN** the user opens `Pair a device` from Open Project, the sidebar, or Host settings, or a new device request auto-opens it
- **THEN** JAgentDesk renders exactly one centered desktop sheet for the local daemon; the request panel and QR/link offer remain inside that same sheet, with no duplicate overlay

#### Scenario: Reconnecting mobile reuses the active request

- **WHEN** the same mobile device reconnects while its first pairing request is still waiting for verification
- **THEN** the daemon keeps exactly one request ID and one six-digit code, updates that request to the newest live socket, and the desktop shows one request card only

#### Scenario: A second device cannot create a second request

- **WHEN** a different mobile device reaches the daemon while one pairing request is waiting for verification
- **THEN** the daemon keeps the existing request and code, sends the second device a pairing-in-progress cancellation, and the desktop receives no second request or code

#### Scenario: Tailnet pairing waits for human code entry

- **WHEN** a new mobile tailnet socket receives a challenge and waits for its owner to enter the desktop code
- **THEN** the daemon keeps that pending socket alive for the full five-minute pairing-code lifetime and MUST NOT close it with `Hello timeout` after the normal 15-second hello deadline

#### Scenario: Desktop reconnects before the request expires

- **WHEN** the mobile connection request arrives while the desktop session is reconnecting, or the renderer has not completed its trusted hello yet
- **THEN** the daemon retains the request until the five-minute code expiry or successful registration, replays it to the next trusted local desktop session, and the desktop opens the same popup with the same six-digit code

#### Scenario: Desktop reports successful pairing

- **WHEN** the mobile device submits the popup code and the daemon registers its public key
- **THEN** the desktop receives `pairing.device.completed`, changes the matching request card in the same popup to a success state containing the registered device ID/name, and keeps that acknowledgement visible until the user closes the sheet

#### Scenario: Desktop declines the active device request

- **WHEN** the user presses Decline on the active device request
- **THEN** the daemon removes that request, sends `pairing.device.cancelled` to the desktop and the waiting mobile socket, closes the mobile socket with the pairing-cancelled close code, and does not register the device

#### Scenario: Mobile reflects a desktop decline

- **WHEN** the waiting mobile socket receives `pairing.device.cancelled` after the desktop declines its request
- **THEN** the mobile pairing attempt stops with a user-visible declined message, cannot submit that request's code successfully, and must start a new pairing attempt to reconnect

#### Scenario: Completion signal updates the existing desktop card

- **WHEN** the mobile submits the correct request-bound code and completes the signed hello
- **THEN** the daemon broadcasts `pairing.device.completed` with the same request ID, the desktop removes the six-digit code/countdown from that card, and the card shows the connected device identity/ID without opening a second popup

#### Scenario: Refresh does not reveal or reuse a request code

- **WHEN** the desktop requests a forced pairing-offer refresh before the previous five-minute TTL ends
- **THEN** the daemon refreshes the offer URL without exposing a six-digit code; any code already issued to a connected device remains bound to that device request until its own expiry or successful registration

#### Scenario: QR scan stops at code verification

- **WHEN** mobile scans a valid JAgentDesk QR offer
- **THEN** mobile shows the six-digit verification screen and does not probe, save, or mark the daemon paired before successful code submission

#### Scenario: Link and deep-link stop at code verification

- **WHEN** mobile receives a valid offer by pasted link or operating-system deep-link
- **THEN** mobile shows the same six-digit verification screen and does not bypass it

#### Scenario: Pasted offer survives the Tailscale login route

- **WHEN** mobile submits a valid pasted offer while Tailscale is not yet connected
- **THEN** it persists the offer before replacing the paste route with Tailscale login, and returning to `pair-verify` does not fall back to the pair-start screen

#### Scenario: Wrong or expired code cannot enroll a device

- **WHEN** an unpaired device submits a missing, wrong, or expired code
- **THEN** the daemon rejects `pairing.device.register.request`, does not add the device to its paired-device store, and leaves the tailnet connection unauthorised

### Requirement: Signed hello via nonce challenge before session upgrade

The daemon MUST issue a random single-use nonce challenge and require the client to return a signature over that nonce produced with its paired device private key; the daemon MUST verify the signature against a registered paired public key before upgrading to an application session (replaces the bearer-password `hello` gate at jagentdesk websocket-server.ts:842-864).

#### Scenario: Valid signature upgrades the session

- **WHEN** a paired device returns a valid signature over the daemon-issued nonce using its registered private key
- **THEN** the daemon verifies it against the stored paired public key and proceeds to the `hello` → `server_info` handshake

#### Scenario: Nonce is single-use

- **WHEN** a signature over a nonce that has already been consumed (or that the daemon did not issue) is presented
- **THEN** the daemon rejects the connection and does not upgrade the session

### Requirement: Unpaired or foreign-key devices are rejected with a defined close code

The daemon MUST reject any connection whose signing key is not in the paired-device set (an arbitrary tailnet node), closing the socket with a defined WebSocket close code, mirroring JAgentDesk's refusal of a foreign key on an established channel (jagentdesk encrypted-channel.ts:523-530).

#### Scenario: Foreign key rejected

- **WHEN** a tailnet node that has never paired attempts to open a session and signs with an unregistered key
- **THEN** the daemon closes the socket with the defined authorization-failure close code and creates no session

#### Scenario: Missing signature rejected

- **WHEN** a client omits the signed-challenge response
- **THEN** the daemon closes the socket with the defined authorization-failure close code before `hello` is processed

### Requirement: Device revocation removes control access

The daemon MUST support revoking a paired device by removing its public key from the paired-device set, after which that device's signed hello MUST fail verification.

#### Scenario: Revoked device cannot reconnect

- **WHEN** an operator revokes a device and that device attempts to reconnect
- **THEN** the daemon's signature verification fails and the connection is rejected with the defined authorization-failure close code

#### Scenario: Other devices unaffected

- **WHEN** one device is revoked
- **THEN** other still-paired devices continue to connect and control the daemon
