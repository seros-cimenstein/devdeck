package dev.devdeck;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaRecorder;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * GPT Live call: a native WebRTC peer that talks straight to OpenAI (audio never passes through
 * the laptop). The daemon signals it (live_offer -> live_answer over LinkService) and owns the
 * sideband. A foreground service of type microphone, so the call goes on with the screen off or
 * the app in the background. All call state lives on the dd-live thread; WebRTC and audio
 * callbacks hop onto it and are dropped once their call generation is stale.
 */
public class LiveService extends Service {
    static final String ACTION_START = "dev.devdeck.LIVE_START";
    static final String ACTION_STOP = "dev.devdeck.LIVE_STOP";
    static final String ACTION_MUTE = "dev.devdeck.LIVE_MUTE";
    static final String EXTRA_OPTS = "opts";

    private static final String TAG = "DevDeckLive";
    private static final String CH_LIVE = "live";
    private static final int NOTE_ID = 3;
    // Host candidates gather in milliseconds; the server (ICE-lite) also learns the phone's
    // address from its connectivity checks, so the offer never waits long for candidates.
    private static final long GATHER_MS = 1000, ANSWER_MS = 30_000, CONNECT_MS = 20_000,
            LEVEL_MS = 100, ROUTE_DEBOUNCE_MS = 300;
    // AudioDeviceInfo types newer than the API 30 compile platform.
    private static final int TYPE_BLE_HEADSET = 26;

    static volatile LiveService instance;
    private static boolean webrtcReady;  // dd-live thread

    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread thread;
    private Handler live;
    private AudioManager audio;
    private NotificationManager notes;
    private PowerManager.WakeLock cpuWake, proximityWake;
    private WifiManager.WifiLock wifiLock;
    // START intents accepted on the main thread whose begin() has not run yet on dd-live.
    private final AtomicInteger pendingStarts = new AtomicInteger();

    // ---- dd-live thread only ----
    private int gen;  // bumped per call and on teardown; stale callbacks compare against it
    private JavaAudioDeviceModule adm;
    private PeerConnectionFactory factory;
    private PeerConnection pc;
    private AudioSource source;
    private AudioTrack track;
    private DataChannel dc;
    private String voice;
    private String req;  // live_offer id awaiting live_answer / error
    private boolean offerSent;
    private int savedMode = AudioManager.MODE_NORMAL;
    private AudioFocusRequest focus;
    private AudioDeviceCallback deviceCallback;
    private boolean scoStarted;
    private boolean lastLevelZero;
    private final Runnable applyRoute = this::applyRoute;

    // ---- written on dd-live, read anywhere (UI replay, notification) ----
    private volatile String phase = "ended";  // connecting | connected | ended | error
    private volatile boolean muted;
    private volatile String route = "speaker";
    private volatile String error, callId, mode = "concierge", target;
    private volatile long connectedAt;

    // Loudest buffer since the last level event, 0..1; written by the audio threads.
    private volatile float micPeak, spkPeak;

    // ---- static API (any thread) ----

    /** A call is being set up or running. */
    static boolean active() {
        LiveService s = instance;
        return s != null && s.isActive();
    }

    /** Current `live_local` state message while a call is active, else null (page replay). */
    static String activeState() {
        LiveService s = instance;
        return s != null && s.isActive() ? s.stateJson() : null;
    }

    /** Main thread: start (or replace) a call; opts JSON {voice, mode, target?}. */
    static void start(Context c, String opts) {
        c.startForegroundService(new Intent(c, LiveService.class).setAction(ACTION_START)
                .putExtra(EXTRA_OPTS, opts == null ? "{}" : opts));
    }

    /** Main thread. UI End: queued behind any start in flight; hangs up and tells the daemon. */
    static void stop(Context c) {
        c.startService(new Intent(c, LiveService.class).setAction(ACTION_STOP));
    }

    static void requestMute(boolean on) {
        LiveService s = instance;
        if (s != null) s.live.post(() -> s.setMutedNow(on));
    }

    /** LinkService read thread: live_answer, error and live messages from the daemon. */
    static void onLink(String t, String line) {
        LiveService s = instance;
        if (s != null) s.live.post(() -> s.linkMessage(t, line));
    }

    // ---- lifecycle ----

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        audio = getSystemService(AudioManager.class);
        notes = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CH_LIVE, "Live call", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        notes.createNotificationChannel(ch);
        PowerManager pm = getSystemService(PowerManager.class);
        cpuWake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "devdeck:live");
        cpuWake.setReferenceCounted(false);
        // Screen off while the sensor is covered (pocket, cheek): no stray touches on Mute/End.
        if (pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
            proximityWake = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "devdeck:live-proximity");
            proximityWake.setReferenceCounted(false);
        }
        wifiLock = getSystemService(WifiManager.class)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "devdeck:live");
        wifiLock.setReferenceCounted(false);
        thread = new HandlerThread("dd-live");
        thread.start();
        live = new Handler(thread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_START.equals(action)) {
            String opts = intent.getStringExtra(EXTRA_OPTS);
            // Mute/route/mode for the note are reset by begin(); show the connecting note now.
            phase = "connecting";
            muted = false;
            error = null;
            boolean ok = enterForeground();
            pendingStarts.incrementAndGet();
            live.post(() -> {
                pendingStarts.decrementAndGet();
                if (ok) begin(opts);
                else end("microphone service refused to start", false);
            });
        } else if (ACTION_STOP.equals(action)) {
            live.post(() -> end(null, false));
        } else if (ACTION_MUTE.equals(action)) {
            live.post(() -> setMutedNow(!muted));
        } else {
            live.post(this::stopIfIdle);
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        instance = null;
        live.post(() -> {
            if (pc != null || req != null || offerSent) {
                sendStop();
                teardown();
                phase = "ended";
                emitState();
                linkLive(false);
            }
        });
        thread.quitSafely();
        super.onDestroy();
    }

    private boolean enterForeground() {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTE_ID, buildNote(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTE_ID, buildNote());
            }
            return true;
        } catch (RuntimeException e) {
            Log.w(TAG, "startForeground failed", e);
            return false;
        }
    }

    private boolean isActive() {
        String p = phase;
        return "connecting".equals(p) || "connected".equals(p);
    }

    // ---- call setup (dd-live) ----

    private void begin(String opts) {
        JSONObject o;
        try {
            o = new JSONObject(opts == null || opts.isEmpty() ? "{}" : opts);
        } catch (JSONException e) {
            o = new JSONObject();
        }
        if (pc != null || req != null || offerSent) teardown();  // replace: the daemon swaps sessions on the new offer
        gen++;
        mode = "direct".equals(o.optString("mode")) ? "direct" : "concierge";
        String t = o.optString("target", "");
        target = t.isEmpty() ? null : t;
        voice = o.optString("voice", "sol");
        error = null;
        callId = null;
        muted = false;
        connectedAt = 0;
        setPhase("connecting");
        LinkService link = LinkService.instance;
        if (link == null || !link.online()) {
            end("offline", false);
            return;
        }
        linkLive(true);
        cpuWake.acquire();
        if (!wifiLock.isHeld()) wifiLock.acquire();
        if (proximityWake != null) proximityWake.acquire();
        main.post(() -> volumeKeys(true));
        startAudio();
        try {
            createPeer();
        } catch (RuntimeException | UnsatisfiedLinkError e) {
            Log.w(TAG, "WebRTC setup failed", e);
            end("WebRTC setup failed: " + e.getMessage(), false);
        }
    }

    private void createPeer() {
        if (!webrtcReady) {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions
                    .builder(getApplicationContext()).createInitializationOptions());
            webrtcReady = true;
        }
        final int g = gen;
        adm = JavaAudioDeviceModule.builder(this)
                // Hardware AEC + NS on the voice-communication source: the model's voice is
                // cancelled from the microphone, so talking over it interrupts it (barge-in).
                .setUseHardwareAcousticEchoCanceler(JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported())
                .setUseHardwareNoiseSuppressor(JavaAudioDeviceModule.isBuiltInNoiseSuppressorSupported())
                .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                .setAudioAttributes(voiceAttrs())
                .setSamplesReadyCallback(s -> {
                    float l = level(s.getData());
                    if (l > micPeak) micPeak = l;
                })
                .setPlaybackSamplesReadyCallback(s -> {
                    float l = level(s.getData());
                    if (l > spkPeak) spkPeak = l;
                })
                .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback() {
                    @Override
                    public void onWebRtcAudioRecordInitError(String msg) {
                        audioFailed(g, "microphone: " + msg);
                    }

                    @Override
                    public void onWebRtcAudioRecordStartError(JavaAudioDeviceModule.AudioRecordStartErrorCode code, String msg) {
                        audioFailed(g, "microphone: " + msg);
                    }

                    @Override
                    public void onWebRtcAudioRecordError(String msg) {
                        audioFailed(g, "microphone: " + msg);
                    }
                })
                .setAudioTrackErrorCallback(new JavaAudioDeviceModule.AudioTrackErrorCallback() {
                    @Override
                    public void onWebRtcAudioTrackInitError(String msg) {
                        audioFailed(g, "speaker: " + msg);
                    }

                    @Override
                    public void onWebRtcAudioTrackStartError(JavaAudioDeviceModule.AudioTrackStartErrorCode code, String msg) {
                        audioFailed(g, "speaker: " + msg);
                    }

                    @Override
                    public void onWebRtcAudioTrackError(String msg) {
                        audioFailed(g, "speaker: " + msg);
                    }
                })
                .createAudioDeviceModule();
        factory = PeerConnectionFactory.builder().setOptions(new PeerConnectionFactory.Options())
                .setAudioDeviceModule(adm).createPeerConnectionFactory();

        PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(new ArrayList<>());
        cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        cfg.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
        cfg.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE;
        // New interfaces (Wi-Fi <-> mobile while walking) get checked against the server's
        // candidates without new signalling; the ICE-lite server learns the new path from them.
        cfg.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
        pc = factory.createPeerConnection(cfg, new PeerObserver(g));
        if (pc == null) throw new IllegalStateException("could not create the peer connection");

        MediaConstraints mc = new MediaConstraints();
        mc.mandatory.add(new MediaConstraints.KeyValuePair("googEchoCancellation", "true"));
        mc.mandatory.add(new MediaConstraints.KeyValuePair("googNoiseSuppression", "true"));
        mc.mandatory.add(new MediaConstraints.KeyValuePair("googAutoGainControl", "true"));
        mc.mandatory.add(new MediaConstraints.KeyValuePair("googHighpassFilter", "true"));
        source = factory.createAudioSource(mc);
        track = factory.createAudioTrack("mic", source);
        track.setEnabled(true);
        pc.addTrack(track, Collections.singletonList("devdeck-live"));

        // Required by the endpoint; events travel on the daemon's sideband, so messages here are
        // drained (an unobserved channel would queue them natively for the whole call).
        dc = pc.createDataChannel("oai-events", new DataChannel.Init());
        dc.registerObserver(new DataChannel.Observer() {
            @Override
            public void onBufferedAmountChange(long previous) {
            }

            @Override
            public void onStateChange() {
            }

            @Override
            public void onMessage(DataChannel.Buffer buffer) {
            }
        });

        pc.createOffer(new Sdp(g, "create offer") {
            @Override
            public void onCreateSuccess(SessionDescription desc) {
                live.post(() -> {
                    if (g != gen || pc == null) return;
                    pc.setLocalDescription(new Sdp(g, "set offer") {
                        @Override
                        public void onSetSuccess() {
                            live.postDelayed(() -> sendOffer(g), GATHER_MS);
                        }
                    }, desc);
                });
            }
        }, new MediaConstraints());
    }

    private void sendOffer(int g) {
        if (g != gen || offerSent || pc == null) return;
        SessionDescription local = pc.getLocalDescription();
        if (local == null) return;
        offerSent = true;
        req = UUID.randomUUID().toString();
        JSONObject m = new JSONObject();
        try {
            m.put("t", "live_offer").put("req", req).put("sdp", local.description).put("voice", voice).put("mode", mode);
            if (target != null) m.put("target", target);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        LinkService link = LinkService.instance;
        if (link == null || !link.sendLive(m.toString())) {
            offerSent = false;
            end("offline", false);
            return;
        }
        String sent = req;
        live.postDelayed(() -> {
            if (g == gen && sent.equals(req)) end("no answer from the laptop", false);
        }, ANSWER_MS);
    }

    private void linkMessage(String t, String line) {
        JSONObject m;
        try {
            m = new JSONObject(line);
        } catch (JSONException e) {
            return;
        }
        switch (t) {
            case "live_answer": {
                if (req == null || !req.equals(m.optString("req")) || pc == null) return;
                req = null;
                String id = m.optString("callId", "");
                callId = id.isEmpty() ? null : id;
                final int g = gen;
                pc.setRemoteDescription(new Sdp(g, "set answer") {
                    @Override
                    public void onSetSuccess() {
                        live.postDelayed(() -> {
                            if (g == gen && "connecting".equals(phase)) end("could not reach OpenAI", false);
                        }, CONNECT_MS);
                    }
                }, new SessionDescription(SessionDescription.Type.ANSWER, m.optString("sdp")));
                emitState();
                return;
            }
            case "error": {
                if (req == null) return;
                String r = m.optString("req", "");
                String e = m.optString("error", "Live call failed");
                // An old daemon rejects the message type itself (no req in that error).
                if (req.equals(r) || (r.isEmpty() && e.contains("live_offer"))) {
                    req = null;
                    end(e, true);
                }
                return;
            }
            case "live": {
                String p = m.optString("phase");
                if (!offerSent || (!"ended".equals(p) && !"error".equals(p))) return;
                String id = m.optString("callId", "");
                if (req != null) {
                    // Offer pending: only an error without a call id refers to it ("ended" may be
                    // the session this offer replaces).
                    if ("error".equals(p) && id.isEmpty()) {
                        req = null;
                        end(m.optString("error", "Live call failed"), true);
                    }
                    return;
                }
                if (!id.isEmpty() && callId != null && !id.equals(callId)) return;
                end("error".equals(p) ? m.optString("error", "Live call failed") : null, true);
                return;
            }
            default:
        }
    }

    private void onConnection(int g, PeerConnection.PeerConnectionState st) {
        if (g != gen) return;
        Log.i(TAG, "peer " + st);
        switch (st) {
            case CONNECTED:
                if (!"connected".equals(phase)) {
                    connectedAt = System.currentTimeMillis();
                    setPhase("connected");
                    live.postDelayed(() -> levelTick(g), LEVEL_MS);
                }
                break;
            case FAILED:
                end("connection to OpenAI lost", false);
                break;
            default:
        }
    }

    private void audioFailed(int g, String msg) {
        Log.w(TAG, "audio error: " + msg);
        live.post(() -> {
            if (g == gen) end(msg, false);
        });
    }

    // ---- ending (dd-live) ----

    /**
     * Hangs up. fromDaemon: the daemon reported the end itself, so no live_stop goes back.
     * err null = normal end, else the error shown to the user.
     */
    private void end(String err, boolean fromDaemon) {
        boolean had = pc != null || req != null || offerSent || isActive();
        if (!fromDaemon && offerSent) sendStop();
        teardown();
        if (had) {
            error = err;
            setPhase(err == null ? "ended" : "error");
        }
        linkLive(false);
        // A start that arrived meanwhile keeps the service (and its foreground state) alive.
        if (pendingStarts.get() > 0) return;
        stopForeground(true);
        stopSelf();
    }

    private void stopIfIdle() {
        if (pendingStarts.get() == 0 && pc == null && req == null && !offerSent && !isActive()) stopSelf();
    }

    private void sendStop() {
        LinkService link = LinkService.instance;
        if (link != null) link.sendLive("{\"t\":\"live_stop\"}");
    }

    private void teardown() {
        gen++;
        req = null;
        offerSent = false;
        connectedAt = 0;
        if (dc != null) {
            try {
                dc.unregisterObserver();
                dc.dispose();
            } catch (RuntimeException ignored) {
            }
            dc = null;
        }
        if (pc != null) {
            try {
                pc.dispose();
            } catch (RuntimeException e) {
                Log.w(TAG, "peer dispose", e);
            }
            pc = null;
        }
        if (source != null) {
            try {
                source.dispose();
            } catch (RuntimeException ignored) {
            }
            source = null;
        }
        track = null;
        if (factory != null) {
            factory.dispose();
            factory = null;
        }
        if (adm != null) {
            adm.release();
            adm = null;
        }
        micPeak = spkPeak = 0;
        stopAudio();
        if (proximityWake != null && proximityWake.isHeld()) {
            proximityWake.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY);
        }
        if (wifiLock.isHeld()) wifiLock.release();
        if (cpuWake.isHeld()) cpuWake.release();
        main.post(() -> volumeKeys(false));
    }

    private void linkLive(boolean on) {
        LinkService link = LinkService.instance;
        if (link != null) main.post(() -> link.setInCall(on));
    }

    private static void volumeKeys(boolean call) {
        MainActivity a = MainActivity.current;
        if (a != null) a.setVolumeControlStream(call ? AudioManager.STREAM_VOICE_CALL : AudioManager.STREAM_MUSIC);
    }

    // ---- mute + levels (dd-live) ----

    private void setMutedNow(boolean on) {
        if (!isActive() || muted == on) return;
        muted = on;
        if (track != null) track.setEnabled(!on);
        emitState();
        updateNote();
    }

    /** Levels for the orb at <= 10 Hz while connected and the UI is visible. */
    private void levelTick(int g) {
        if (g != gen) return;
        live.postDelayed(() -> levelTick(g), LEVEL_MS);
        float mic = muted ? 0 : micPeak, spk = spkPeak;
        micPeak = spkPeak = 0;
        LinkService link = LinkService.instance;
        if (link == null || !link.isVisible()) return;
        boolean zero = mic < 0.01f && spk < 0.01f;
        if (zero && lastLevelZero) return;
        lastLevelZero = zero;
        link.local(String.format(Locale.ROOT, "{\"t\":\"live_local\",\"mic\":%.2f,\"spk\":%.2f}", mic, spk));
    }

    /** PCM16 buffer -> RMS in dBFS mapped linearly from -60..0 dB onto 0..1. */
    private static float level(byte[] d) {
        int n = d.length / 2;
        if (n == 0) return 0;
        double sum = 0;
        for (int i = 0; i < n; i++) {
            int v = (short) ((d[2 * i] & 0xff) | (d[2 * i + 1] << 8));
            sum += (double) v * v;
        }
        double rms = Math.sqrt(sum / n) / 32768.0;
        if (rms < 1e-6) return 0;
        double db = 20 * Math.log10(rms);
        return (float) Math.max(0, Math.min(1, (db + 60) / 60));
    }

    // ---- audio focus + routing (dd-live) ----

    private static AudioAttributes voiceAttrs() {
        return new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
    }

    private void startAudio() {
        savedMode = audio.getMode();
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(voiceAttrs())
                .setOnAudioFocusChangeListener(change -> { }, live)
                .build();
        audio.requestAudioFocus(focus);
        audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
        applyRoute();
        // Earbuds or a headset connecting/disconnecting mid-call re-route (fires once at once too).
        deviceCallback = new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                scheduleRoute();
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                scheduleRoute();
            }
        };
        audio.registerAudioDeviceCallback(deviceCallback, live);
    }

    private void scheduleRoute() {
        live.removeCallbacks(applyRoute);
        live.postDelayed(applyRoute, ROUTE_DEBOUNCE_MS);
    }

    private static int rank(int type) {
        switch (type) {
            case TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                return 3;
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                return 2;
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return 1;
            default:
                return 0;
        }
    }

    private static String routeName(int type) {
        int r = rank(type);
        return r == 3 ? "bluetooth" : r == 2 ? "wired" : r == 1 ? "speaker" : "earpiece";
    }

    /** Bluetooth headset/earbuds, else a wired headset, else the loudspeaker. */
    private void applyRoute() {
        if (deviceCallback == null && focus == null) return;  // call already torn down
        String now;
        if (Build.VERSION.SDK_INT >= 31) {
            now = routeModern();
        } else {
            now = routeLegacy();
        }
        if (now != null && !now.equals(route)) {
            route = now;
            emitState();
            updateNote();
        }
    }

    /** API 31+: setCommunicationDevice (reflection: the compile platform is API 30). */
    @SuppressWarnings("unchecked")
    private String routeModern() {
        try {
            List<AudioDeviceInfo> devs = (List<AudioDeviceInfo>) AudioManager.class
                    .getMethod("getAvailableCommunicationDevices").invoke(audio);
            AudioDeviceInfo best = null;
            for (AudioDeviceInfo d : devs) if (best == null || rank(d.getType()) > rank(best.getType())) best = d;
            if (best == null) return null;
            AudioManager.class.getMethod("setCommunicationDevice", AudioDeviceInfo.class).invoke(audio, best);
            return routeName(best.getType());
        } catch (ReflectiveOperationException | RuntimeException e) {
            Log.w(TAG, "communication device routing failed, using legacy", e);
            return routeLegacy();
        }
    }

    @SuppressWarnings("deprecation")
    private String routeLegacy() {
        boolean bt = false, wired = false;
        for (AudioDeviceInfo d : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int r = rank(d.getType());
            if (r == 3) bt = true;
            else if (r == 2) wired = true;
        }
        if (bt) {
            audio.setSpeakerphoneOn(false);
            if (!scoStarted) {
                audio.startBluetoothSco();
                scoStarted = true;
            }
            audio.setBluetoothScoOn(true);
            return "bluetooth";
        }
        stopSco();
        audio.setSpeakerphoneOn(!wired);
        return wired ? "wired" : "speaker";
    }

    @SuppressWarnings("deprecation")
    private void stopSco() {
        if (!scoStarted) return;
        audio.setBluetoothScoOn(false);
        audio.stopBluetoothSco();
        scoStarted = false;
    }

    @SuppressWarnings("deprecation")
    private void stopAudio() {
        live.removeCallbacks(applyRoute);
        if (deviceCallback != null) {
            audio.unregisterAudioDeviceCallback(deviceCallback);
            deviceCallback = null;
        }
        if (focus == null) return;  // audio was never set up for this call
        boolean cleared = false;
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                AudioManager.class.getMethod("clearCommunicationDevice").invoke(audio);
                cleared = true;
            } catch (ReflectiveOperationException | RuntimeException e) {
                Log.w(TAG, "clearCommunicationDevice failed", e);
            }
        }
        if (!cleared) {
            stopSco();
            audio.setSpeakerphoneOn(false);
        }
        audio.setMode(savedMode);
        audio.abandonAudioFocusRequest(focus);
        focus = null;
    }

    // ---- UI events + notification ----

    private void setPhase(String p) {
        phase = p;
        emitState();
        if (isActive()) updateNote();
    }

    private String stateJson() {
        try {
            JSONObject o = new JSONObject().put("t", "live_local").put("active", isActive()).put("phase", phase)
                    .put("muted", muted).put("route", route).put("mode", mode);
            if (target != null) o.put("target", target);
            if (error != null) o.put("error", error);
            if (callId != null) o.put("callId", callId);
            return o.toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private void emitState() {
        LinkService link = LinkService.instance;
        if (link != null) link.local(stateJson());
    }

    private Notification buildNote() {
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        String who = "direct".equals(mode) && target != null ? target : "concierge";
        String status = "connected".equals(phase) ? "Live" : "Connecting";
        StringBuilder text = new StringBuilder(status).append(" \u00b7 ").append(route);
        if (muted) text.append(" \u00b7 muted");
        Notification.Builder b = new Notification.Builder(this, CH_LIVE)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xff58a6ff)
                .setContentTitle("Talking to " + who)
                .setContentText(text)
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), flags))
                .addAction(new Notification.Action.Builder(null, muted ? "Unmute" : "Mute",
                        PendingIntent.getService(this, 1, new Intent(this, LiveService.class).setAction(ACTION_MUTE), flags)).build())
                .addAction(new Notification.Action.Builder(null, "End",
                        PendingIntent.getService(this, 2, new Intent(this, LiveService.class).setAction(ACTION_STOP), flags)).build());
        long since = connectedAt;
        if (since > 0) b.setWhen(since).setShowWhen(true).setUsesChronometer(true);
        else b.setShowWhen(false);
        return b.build();
    }

    private void updateNote() {
        if (isActive()) notes.notify(NOTE_ID, buildNote());
    }

    // ---- WebRTC observers (signalling thread -> dd-live) ----

    private abstract class Sdp implements SdpObserver {
        final int g;
        final String what;

        Sdp(int g, String what) {
            this.g = g;
            this.what = what;
        }

        @Override
        public void onCreateSuccess(SessionDescription desc) {
        }

        @Override
        public void onSetSuccess() {
        }

        @Override
        public void onCreateFailure(String msg) {
            failed(msg);
        }

        @Override
        public void onSetFailure(String msg) {
            failed(msg);
        }

        private void failed(String msg) {
            Log.w(TAG, what + " failed: " + msg);
            live.post(() -> {
                if (g == gen) end(what + " failed: " + msg, false);
            });
        }
    }

    private final class PeerObserver implements PeerConnection.Observer {
        final int g;

        PeerObserver(int g) {
            this.g = g;
        }

        @Override
        public void onConnectionChange(PeerConnection.PeerConnectionState st) {
            live.post(() -> onConnection(g, st));
        }

        @Override
        public void onIceGatheringChange(PeerConnection.IceGatheringState st) {
            if (st == PeerConnection.IceGatheringState.COMPLETE) live.post(() -> sendOffer(g));
        }

        @Override
        public void onSignalingChange(PeerConnection.SignalingState st) {
        }

        @Override
        public void onIceConnectionChange(PeerConnection.IceConnectionState st) {
        }

        @Override
        public void onIceConnectionReceivingChange(boolean receiving) {
        }

        @Override
        public void onIceCandidate(IceCandidate c) {
        }

        @Override
        public void onIceCandidatesRemoved(IceCandidate[] cs) {
        }

        @Override
        public void onAddStream(MediaStream s) {
        }

        @Override
        public void onRemoveStream(MediaStream s) {
        }

        @Override
        public void onDataChannel(DataChannel d) {
        }

        @Override
        public void onRenegotiationNeeded() {
        }

        @Override
        public void onAddTrack(RtpReceiver r, MediaStream[] streams) {
        }
    }
}
