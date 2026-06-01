//
//  RelayClient.swift
//  SafeHaven — Transport
//
//  Single server-mediated WebSocket to the relay (PROTOCOL §1–§2, §6, §8).
//  Backed by URLSessionWebSocketTask. One sender per token; carries both TEXT
//  (control + product events) and BINARY (media) frames.
//
//  Responsibilities:
//   - Connect as role=sender&token&v=1 (§1.3); idempotent start keyed by token
//     so re-entering an active tier never opens a 2nd socket (§8).
//   - Buffer-before-open / flush-on-open in arrival order (§8) so the very first
//     Tier-1 event (fired synchronously with the state change) is never lost.
//   - Auto-reconnect with backoff: start 2000ms, ×1.5 per close, cap 30000ms,
//     reset to 2000 on open (§8). seq resets on reconnect (handled by callers).
//   - Decode relay→sender `presence` frames; on `receiver_joined` ask the owner
//     to ensure encoding for the current tier and force an IDR (§6.2).
//   - Ping keepalive.
//   - Route every outbound payload through the OutboundTransform seam (§9).
//
//  All public mutation happens on the main actor; socket I/O completion handlers
//  hop back to main before touching state, so there are no data races.
//

import Foundation

/// Callbacks the RelayClient raises to its owner (TierController).
/// Main-actor isolated: the owner (TierController) is @MainActor, and all
/// invocations below already occur on the main actor.
@MainActor
protocol RelayClientDelegate: AnyObject {
    /// A receiver joined — ensure we're encoding for the current tier and force
    /// an IDR so the new viewer resyncs fast. PROTOCOL §6.2.
    func relayClientReceiverJoined(_ client: RelayClient, receivers: Int)
    /// The last receiver left. PROTOCOL §6.2.
    func relayClientReceiverLeft(_ client: RelayClient, receivers: Int)
    /// The socket transitioned to OPEN (initial connect or post-reconnect).
    /// Callers use this to reset per-kind `seq` counters (§8) on reconnect.
    func relayClientDidOpen(_ client: RelayClient, isReconnect: Bool)
}

@MainActor
final class RelayClient: NSObject {

    weak var delegate: RelayClientDelegate?

    // MARK: - Reconnect tuning (PROTOCOL §8 / §11)

    private let backoffStart: TimeInterval = 2.0
    private let backoffMultiplier = 1.5
    private let backoffCap: TimeInterval = 30.0
    private var backoff: TimeInterval = 2.0

    // MARK: - State

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var token: String?
    private let transform: OutboundTransform

    /// True between `start(token:)` and `stop()`. Drives reconnect.
    private(set) var isActive = false
    /// True once the socket has reached OPEN at least once for this start.
    private var isOpen = false
    /// Distinguishes the first open from post-reconnect opens.
    private var hasOpenedOnce = false

    /// Buffer-before-open queue. Holds fully-formed frames (TEXT strings and
    /// BINARY Data) emitted while the socket is not OPEN; flushed in order on
    /// open. PROTOCOL §8.
    private enum PendingFrame {
        case text(String)
        case binary(Data)
    }
    private var pending: [PendingFrame] = []

    private var reconnectWorkItem: DispatchWorkItem?
    private var pingTimer: Timer?
    private let pingInterval: TimeInterval = 20.0

    // MARK: - Init

    /// - Parameter pairingKey: the `key` half of the pairing ID, handed to the
    ///   OutboundTransform encryption seam (§9). Unused today.
    init(pairingKey: String) {
        self.transform = OutboundTransform(pairingKey: pairingKey)
        super.init()
    }

    // MARK: - Lifecycle

    /// Open the socket for `token`. Idempotent: a second call with the SAME
    /// token while active is a no-op (PROTOCOL §8 — re-entering an active tier
    /// must not open a 2nd socket). A call with a DIFFERENT token restarts.
    func start(token: String) {
        if isActive, self.token == token {
            return // idempotent — already connected/connecting for this token
        }
        if isActive {
            // Token changed — tear down the old connection first.
            teardownSocket()
        }
        self.token = token
        self.isActive = true
        self.backoff = backoffStart
        connect()
    }

    /// Close the socket and stop reconnecting. Drops the buffer.
    func stop() {
        isActive = false
        token = nil
        pending.removeAll()
        cancelReconnect()
        teardownSocket()
    }

    // MARK: - Sending

    /// Send a product event as a TEXT frame. The event payload is routed through
    /// the encryption seam; the `{type:"event",payload}` envelope stays cleartext.
    ///
    /// If the socket is not OPEN yet, the frame is buffered and flushed on open
    /// (PROTOCOL §8). This is the path that preserves the first Tier-1 event.
    func sendEvent<E: Encodable>(_ event: E) {
        do {
            // SEAM (§9): the event payload bytes traverse the SAME
            // OutboundTransform as media (identity today, so the wire is
            // byte-identical). EventEnvelope applies it to the serialized
            // payload; see Events.swift for the crypto-time format note.
            let text = try EventEnvelope.text(event, transform: transform)
            enqueueOrSend(.text(text))
        } catch {
            // Encoding a Codable struct should never fail; log and drop.
            print("[relay] failed to encode event: \(error.localizedDescription)")
        }
    }

    /// Send a media frame. The caller supplies the cleartext payload; this method
    /// applies the OutboundTransform to the PAYLOAD ONLY, then prepends the
    /// cleartext 16-byte header. PROTOCOL §3/§9.
    func sendMedia(kind: FrameKind,
                   flags: FrameFlags,
                   cacheClass: CacheClass,
                   seq: UInt32,
                   ptsMicros: UInt64,
                   payload: Data) {
        // ── SEAM: transform the payload only; header stays cleartext. ──
        let transformed = transform.transform(payload)
        let frame = Frame.make(kind: kind,
                               flags: flags,
                               cacheClass: cacheClass,
                               seq: seq,
                               ptsMicros: ptsMicros,
                               payload: transformed)
        enqueueOrSend(.binary(frame))
    }

    private func enqueueOrSend(_ frame: PendingFrame) {
        guard isActive else { return }
        if isOpen, let task {
            transmit(frame, on: task)
        } else {
            // Buffer-before-open; flushed in order on open (§8).
            pending.append(frame)
        }
    }

    private func transmit(_ frame: PendingFrame, on task: URLSessionWebSocketTask) {
        let message: URLSessionWebSocketTask.Message
        switch frame {
        case .text(let s):   message = .string(s)
        case .binary(let d): message = .data(d)
        }
        task.send(message) { error in
            if let error {
                print("[relay] send error: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Connection

    private func connect() {
        guard isActive, let token, let url = RelayConfig.senderWebSocketURL(token: token) else {
            print("[relay] cannot connect: missing token or invalid URL")
            return
        }
        print("[relay] connecting to \(url.absoluteString)")

        let config = URLSessionConfiguration.default
        // Fail fast with a concrete error instead of silently waiting — our own
        // backoff (handleClose → scheduleReconnect) drives retries, and a visible
        // error is essential for diagnosing LAN/permission/firewall problems.
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 10
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session

        let task = session.webSocketTask(with: url)
        self.task = task
        isOpen = false
        task.resume()

        // Begin receiving immediately so we catch presence frames.
        receiveLoop()
    }

    private func teardownSocket() {
        stopPing()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        isOpen = false
    }

    /// Called from the URLSession delegate when the socket reaches OPEN.
    private func handleOpen() {
        isOpen = true
        backoff = backoffStart                 // reset backoff on open (§8)
        let isReconnect = hasOpenedOnce
        hasOpenedOnce = true
        print("[relay] connected to \(RelayConfig.host) (reconnect: \(isReconnect))")

        // Optional hello announce (reserved for future negotiation, §6.1).
        task?.send(.string(EventEnvelope.hello())) { _ in }

        // Flush buffered frames in arrival order (§8).
        if let task {
            let toFlush = pending
            pending.removeAll()
            for frame in toFlush { transmit(frame, on: task) }
        }

        startPing()
        delegate?.relayClientDidOpen(self, isReconnect: isReconnect)
    }

    /// Called on close/error to schedule a backoff reconnect (§8).
    private func handleClose(reason: String) {
        stopPing()
        isOpen = false
        task = nil
        session?.invalidateAndCancel()
        session = nil
        guard isActive else { return }
        print("[relay] closed (\(reason)); reconnecting in \(backoff)s")
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        cancelReconnect()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.isActive else { return }
            // Grow backoff for the NEXT attempt; this attempt uses current value.
            self.backoff = min(self.backoff * self.backoffMultiplier, self.backoffCap)
            self.connect()
        }
        reconnectWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff, execute: work)
    }

    private func cancelReconnect() {
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
    }

    // MARK: - Receive

    private func receiveLoop() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure(let error):
                    self.handleClose(reason: error.localizedDescription)
                case .success(let message):
                    self.handleIncoming(message)
                    // Keep receiving while still open.
                    if self.isActive { self.receiveLoop() }
                }
            }
        }
    }

    private func handleIncoming(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            handlePresenceText(text)
        case .data:
            // Receivers never send media to the sender; relay→sender is text only.
            break
        @unknown default:
            break
        }
    }

    /// The only relay→sender control frame is `presence` (PROTOCOL §6.1/§6.2).
    private func handlePresenceText(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        guard let presence = try? JSONDecoder().decode(PresenceMessage.self, from: data),
              presence.type == "presence" else {
            return
        }
        if presence.isReceiverJoined {
            delegate?.relayClientReceiverJoined(self, receivers: presence.receivers)
        } else if presence.isReceiverLeft {
            delegate?.relayClientReceiverLeft(self, receivers: presence.receivers)
        }
    }

    // MARK: - Keepalive

    private func startPing() {
        stopPing()
        let timer = Timer.scheduledTimer(withTimeInterval: pingInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.task?.sendPing { error in
                    if let error { print("[relay] ping error: \(error.localizedDescription)") }
                }
            }
        }
        pingTimer = timer
    }

    private func stopPing() {
        pingTimer?.invalidate()
        pingTimer = nil
    }
}

// MARK: - URLSessionWebSocketDelegate

extension RelayClient: URLSessionWebSocketDelegate {

    nonisolated func urlSession(_ session: URLSession,
                                webSocketTask: URLSessionWebSocketTask,
                                didOpenWithProtocol protocol: String?) {
        Task { @MainActor in self.handleOpen() }
    }

    nonisolated func urlSession(_ session: URLSession,
                                webSocketTask: URLSessionWebSocketTask,
                                didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                                reason: Data?) {
        let code = closeCode.rawValue
        Task { @MainActor in self.handleClose(reason: "close code \(code)") }
    }
}
