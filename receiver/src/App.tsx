/**
 * App.tsx — the SafeHaven receiver dashboard root.
 *
 * Wires the transport (ReceiverSocket) + media (VideoDecoderController,
 * AudioPlayer, AudioLevelMeter) into the incident model (useIncidentState) and
 * renders the ported UI (header / risk banner / tabs / video / audio / map /
 * log / footer / token-entry).
 *
 * Data flow (PROTOCOL §6–§8):
 *   socket.onEvent(payload)  → translateEvent(payload, ctx) → addEntry(...)
 *   socket.onMedia(frame)    → video frames → VideoDecoderController.pushVideo
 *                            → audio frames → AudioPlayer.pushAudio (+ meter)
 *   socket.onStatus(status)  → header connection state + terminal overlays
 *
 * The relay replays the FULL event log (then the last IDR) before any live
 * frame on join (§7/§8); because every event flows through the same addEntry
 * path, the dashboard reconstructs the entire timeline transparently.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useIncidentState } from './events/incidentState';
import { makeContext, translateEvent, type TranslateContext } from './events/translateEvent';
import {
  ReceiverSocket,
  type ConnectionStatus,
  type SocketCallbacks,
} from './transport/socket';
import { MediaKind, type MediaFrame } from './transport/frame';
import { readPairingFromLocation, type Pairing } from './transport/pairing';
import { InboundTransform } from './transport/inboundTransform';
import { VideoDecoderController } from './media/videoDecoder';
import { AudioPlayer } from './media/audioPlayer';
import { AudioLevelMeter } from './media/audioLevels';

import { SessionHeader } from './components/SessionHeader';
import { RiskBanner } from './components/RiskBanner';
import { Tabs, type TabId } from './components/Tabs';
import { VideoFeed } from './components/VideoFeed';
import { AudioPanel } from './components/AudioPanel';
import { GPSMap } from './components/GPSMap';
import { Pill } from './components/Pill';
import { IncidentLog } from './components/IncidentLog';
import { Footer } from './components/Footer';
import { TokenEntry } from './components/TokenEntry';
import { WaitingScreen } from './components/WaitingScreen';

export function App() {
  const incident = useIncidentState();
  const [tab, setTab] = useState<TabId>('live');

  // Pairing (token + key). Initialized from the URL fragment; the TokenEntry
  // overlay can set it when absent.
  const [pairing, setPairing] = useState<Pairing | null>(() => readPairingFromLocation());

  // Connection status (drives the header + terminal-close overlay).
  const [status, setStatus] = useState<ConnectionStatus>({ state: 'connecting' });

  // Video / audio liveness, surfaced from the media controllers.
  const [videoSupported, setVideoSupported] = useState(true);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [audioLive, setAudioLive] = useState(false);
  /** 44-bar levels snapshot, refreshed on a ~30fps loop while audio is live. */
  const [levels, setLevels] = useState<Float32Array | null>(null);

  // ── Long-lived instances (one per token) held in refs ──
  const socketRef = useRef<ReceiverSocket | null>(null);
  const transformRef = useRef<InboundTransform | null>(null);
  const videoRef = useRef<VideoDecoderController | null>(null);
  const audioRef = useRef<AudioPlayer | null>(null);
  const meterRef = useRef<AudioLevelMeter | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Per-connection translate context (reset on a fresh socket).
  const ctxRef = useRef<TranslateContext>(makeContext());

  // Keep stable refs to incident callbacks so the socket effect doesn't churn.
  const addEntryRef = useRef(incident.addEntry);
  const setVideoLiveRef = useRef(incident.setVideoLive);
  const setStaleSecsRef = useRef(incident.setStaleSecs);
  addEntryRef.current = incident.addEntry;
  setVideoLiveRef.current = incident.setVideoLive;
  setStaleSecsRef.current = incident.setStaleSecs;

  // Receives the <canvas> from VideoFeed; (re)attach the decoder's draw target.
  const onCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
  }, []);

  // ── Establish / tear down the session when the token changes ──
  const token = pairing?.token ?? null;
  const key = pairing?.key ?? '';

  useEffect(() => {
    if (!token) return;

    // Build the inbound transform from the pairing key (§9 — identity today).
    const transform = new InboundTransform(key);
    transformRef.current = transform;

    // Media controllers.
    const meter = new AudioLevelMeter();
    meterRef.current = meter;

    const audio = new AudioPlayer(transform);
    audioRef.current = audio;
    const unsubSamples = audio.onSamples((samples) => {
      meter.push(samples);
      if (!audioLive) setAudioLive(true);
    });

    const video = new VideoDecoderController({
      // Read the live on-screen canvas lazily. It may be null when frames first
      // arrive (tab not on "live" yet) — those frames are dropped after close,
      // and the next IDR (≤2s, §4.1) repaints once the canvas is mounted.
      getCanvas: () => canvasRef.current,
      transform,
      onFirstFrame: () => setVideoLiveRef.current(true),
      onUnsupported: () => setVideoSupported(false),
    });
    videoRef.current = video;
    // Probe WebCodecs/H.264 support up front (§4.3 graceful fallback).
    void video.probe().then((s) => setVideoSupported(s !== 'unsupported'));

    // Fresh translate context per connection (reconnect starts clean, §8).
    ctxRef.current = makeContext();

    const callbacks: SocketCallbacks = {
      onEvent: (payload) => {
        // ── SEAM (§9): inbound event payloads pass through InboundTransform
        // (identity today; AEAD-open lands here when crypto ships), symmetric
        // with the sender routing event payloads through OutboundTransform. ──
        const decoded = transform.openEvent(payload);
        const entries = translateEvent(decoded, ctxRef.current);
        for (const e of entries) {
          // For a SYNTHESIZED session (no real incident_start seen yet, §5.2),
          // derive a token-prefixed display name — the legacy ensureSession
          // fallback ("Sender <prefix>"). translateEvent can't do this because
          // it doesn't know the token; the App does.
          if (e.type === 'incident_start' && e.synthesized && e.personName == null) {
            e.personName = `Sender ${token.slice(0, 4)}`;
          }
          addEntryRef.current(e);
        }
      },
      onMedia: (frame: MediaFrame) => {
        if (frame.kind === MediaKind.Video) {
          videoRef.current?.pushVideo(frame);
        } else if (frame.kind === MediaKind.Audio) {
          audioRef.current?.pushAudio(frame);
        }
      },
      onStatus: (s) => setStatus(s),
    };

    const socket = new ReceiverSocket(token, callbacks);
    socketRef.current = socket;
    socket.start();

    return () => {
      unsubSamples();
      socket.close();
      video.dispose();
      audio.dispose();
      meter.reset();
      socketRef.current = null;
      videoRef.current = null;
      audioRef.current = null;
      meterRef.current = null;
      transformRef.current = null;
    };
    // audioLive intentionally excluded — it's a one-way latch read inside the
    // sample callback; including it would tear down the socket on first audio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, key]);

  // ── 1 Hz media tick: refresh video staleness + audio unlock state ──
  useEffect(() => {
    const id = setInterval(() => {
      const v = videoRef.current;
      if (v) {
        const stale = v.secondsSinceLastFrame();
        setStaleSecsRef.current(stale);
        // Freeze if we've rendered before but no frame for > 2s (IDR cadence is
        // 2s per §4.1, so >2s without a frame means a real stall).
        if (v.hasRenderedFrame()) {
          setVideoLiveRef.current(stale <= 2);
        }
      }
      const a = audioRef.current;
      if (a) setAudioUnlocked(a.isUnlocked());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ── ~30fps audio-meter loop: snapshot the 44 bars while audio is live ──
  // A separate, faster loop from the 1Hz tick so the bars feel responsive
  // without re-rendering the whole tree 30× a second elsewhere. Throttled to
  // ~33ms (legacy parity) and only runs once audio has started flowing.
  useEffect(() => {
    if (!audioLive) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 33) {
        const m = meterRef.current;
        if (m) {
          // Copy the meter's internal buffer so React sees a new reference and
          // the AudioPanel re-renders with fresh heights.
          setLevels(Float32Array.from(m.levels()));
        }
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioLive]);

  // Keep the decoder pointed at the live canvas if it remounts (tab switches).
  // The controller reads canvasRef lazily via getCanvas(), so no rebinding is
  // needed here — VideoFeed's onCanvas keeps canvasRef current.

  // ── Token entry / pairing handlers ──
  const handleTokenSubmit = useCallback((raw: string) => {
    // Accept a full "<token>:<key>" pairing or a bare token. Reuse the same
    // first-':' split as the URL parser by writing it to the fragment and
    // re-reading, so there is exactly one parse path.
    window.location.hash = raw;
    const parsed = readPairingFromLocation();
    if (parsed) setPairing(parsed);
  }, []);

  // React to manual hash edits / back-forward navigation.
  useEffect(() => {
    const onHash = () => {
      const parsed = readPairingFromLocation();
      setPairing(parsed);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const enableAudio = useCallback(() => {
    void audioRef.current?.resume().then(() => setAudioUnlocked(audioRef.current?.isUnlocked() ?? false));
  }, []);

  // ── Derived view state ──
  const personName = incident.session?.personName ?? null;

  // Status text for the header / waiting screen.
  const connected = status.state === 'open';
  const statusText =
    status.state === 'reconnecting'
      ? 'Reconnecting…'
      : status.state === 'terminated'
        ? 'Disconnected'
        : status.state === 'connecting'
          ? 'Connecting…'
          : undefined;

  const v = videoRef.current;
  const everRendered = v?.hasRenderedFrame() ?? false;
  const videoIsLive = !incident.videoFrozen && everRendered;

  // No token at all → token entry overlay (and nothing else).
  if (!token) {
    return <TokenEntry onSubmit={handleTokenSubmit} />;
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        paddingTop: 'env(safe-area-inset-top)',
      }}
    >
      {/* ── FIXED HEADER ── */}
      <div style={{ flexShrink: 0, background: '#050810', padding: '10px 14px 0' }}>
        <SessionHeader
          personName={personName}
          tier={incident.tier}
          connected={connected}
          hasSession={!!incident.session}
          elapsed={incident.elapsed}
          statusText={statusText}
        />
        <div style={{ marginBottom: 8 }}>
          <RiskBanner level={incident.riskLevel} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <Tabs tab={tab} onChange={setTab} />
        </div>
      </div>

      {/* ── SCROLLABLE CONTENT ── */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none' }}>
        {/* Terminal close → calm error; else waiting until a session opens. */}
        {status.state === 'terminated' ? (
          <TerminalNotice message={status.message} />
        ) : !incident.connected ? (
          <WaitingScreen statusText={statusText} />
        ) : (
          <>
            {tab === 'live' && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  animation: 'slideUp .3s ease',
                  padding: '0 14px 14px',
                }}
              >
                <VideoFeed
                  alertMode={incident.alertMode}
                  videoSupported={videoSupported}
                  live={videoIsLive}
                  frozen={incident.videoFrozen}
                  staleSecs={incident.staleSecs}
                  everRendered={everRendered}
                  tier={incident.tier}
                  onCanvas={onCanvas}
                />
                <AudioPanel
                  alertMode={incident.alertMode}
                  audioLabels={incident.audioLabels}
                  levels={levels}
                  audioUnlocked={audioUnlocked}
                  onEnableAudio={enableAudio}
                />
              </div>
            )}

            {tab === 'map' && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  animation: 'slideUp .3s ease',
                  paddingBottom: 14,
                }}
              >
                <GPSMap gps={incident.gps} gpsTrail={incident.gpsTrail} alertMode={incident.alertMode} />
                <div style={{ padding: '0 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Pill
                      label="ACCURACY"
                      value={
                        incident.gps && incident.gps.accuracy != null
                          ? `${incident.gps.accuracy.toFixed(0)} m`
                          : '—'
                      }
                      color="#3b82f6"
                    />
                    <Pill
                      label="SPEED"
                      value={
                        incident.gps && incident.gps.speed != null
                          ? `${(incident.gps.speed * 3.6).toFixed(1)} km/h`
                          : '—'
                      }
                      color="#a78bfa"
                    />
                    <Pill
                      label="HEADING"
                      value={
                        incident.gps && incident.gps.heading != null
                          ? `${incident.gps.heading.toFixed(0)}°`
                          : '—'
                      }
                      color="#f59e0b"
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Pill
                      label="ALTITUDE"
                      value={
                        incident.gps && incident.gps.altitude != null
                          ? `${incident.gps.altitude.toFixed(0)} m`
                          : '—'
                      }
                      color="#38bdf8"
                    />
                    {/* Accurate transport label: this is a server-mediated RELAY,
                        not the old P2P/WebRTC path. */}
                    <Pill label="SIGNAL" value={connected ? 'RELAY' : '—'} color="#34d399" />
                    <Pill
                      label="TRAIL"
                      value={incident.gpsTrail.length > 0 ? `${incident.gpsTrail.length} pts` : '—'}
                      color="#34d399"
                    />
                  </div>
                </div>
              </div>
            )}

            {tab === 'log' && (
              <div
                style={{
                  animation: 'slideUp .3s ease',
                  background: '#080e1a',
                  borderRadius: 12,
                  overflow: 'hidden',
                  margin: '0 14px 14px',
                }}
              >
                <IncidentLog incidentLog={incident.incidentLog} />
              </div>
            )}
          </>
        )}
      </div>

      {/* ── FIXED FOOTER ── */}
      <Footer gps={incident.gps} alertMode={incident.alertMode} />
    </div>
  );
}

/** Calm, non-alarming terminal-close notice (4002/4003/etc.). */
function TerminalNotice({ message }: { message: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: 'rgba(255,255,255,.06)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
        }}
      >
        ⚠
      </div>
      <div style={{ color: 'rgba(255,255,255,.7)', fontSize: 14, fontWeight: 600, maxWidth: 320 }}>
        {message}
      </div>
    </div>
  );
}
