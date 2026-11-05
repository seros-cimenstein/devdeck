package dev.devdeck;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Binder;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.Inflater;
import java.util.zip.InflaterInputStream;

/**
 * Foreground service that owns everything network-related: the control connection to
 * devdeck.py (raced over all paired hosts), the persistent offline queue, uploads, the
 * battery policy and the agent notifications. Server messages are handed to the UI verbatim.
 */
public class LinkService extends Service {
    static final String ACTION_ENQUEUE = "dev.devdeck.ENQUEUE";
    static final String ACTION_RELOAD = "dev.devdeck.RELOAD";
    static final String ACTION_WAKELOCK = "dev.devdeck.WAKELOCK";
    static final String EXTRA_ITEMS = "items";
    static final int DEFAULT_PORT = 47490;

    static final int ST_UNPAIRED = 0, ST_OFFLINE = 1, ST_CONNECTING = 2, ST_ONLINE = 3, ST_IDLE = 4;
    private static final String[] STATE_NAMES = {"unpaired", "offline", "connecting", "online", "idle"};

    private static final String TAG = "DevDeck";
    private static final String CH_LINK = "link", CH_ASK = "ask", CH_DONE = "done";
    private static final int NOTE_ID = 1;
    static final int NOTE_AGENT = 2;
    // Visible: ping often so a dead path is noticed within DEAD_MS. Hidden: the server sends
    // only state changes and an exact alarm pings every PING_BG_MS; DEAD_BG_MS without any
    // byte from the server means the path is gone.
    private static final long PING_MS = 10_000, PING_BG_MS = 10 * 60_000L, DEAD_MS = 35_000,
            DEAD_BG_MS = 25 * 60_000L;
    private static final long BACKOFF_MIN = 1000, BACKOFF_MAX = 5000, BACKOFF_BG_MAX = 60_000;
    // Notifications off: a hidden app keeps the link this long (quick app switches stay live).
    private static final long BG_LINGER_MS = 120_000;
    // After this long in the background a resumed link must prove itself within PROBE_MS,
    // otherwise it is presumed silently dead (NAT/relay path dropped) and redialled.
    private static final long PROBE_AFTER_MS = 60_000, PROBE_MS = 12_000;
    private static final int CONNECT_MS = 15_000, HANDSHAKE_MS = 20_000, READ_TICK_MS = 10_000,
            UPLOAD_IDLE_MS = 120_000;
    private static final long PROGRESS_MS = 1000, UPLOAD_RETRY_MS = 3000, ALARM_WAKE_MS = 45_000,
            RX_WAKE_MS = 3000;

    interface Listener {
        /** Main thread; server messages verbatim plus local ones, in order, coalesced per loop turn. */
        void onMessages(List<String> msgs);
    }

    final class LocalBinder extends Binder {
        LinkService service() {
            return LinkService.this;
        }
    }

    private static final class Conn {
        final Socket sock;
        final String host;
        final OutputStream out;

        Conn(Socket sock, String host) throws IOException {
            this.sock = sock;
            this.host = host;
            this.out = sock.getOutputStream();
        }

        void close() {
            closeQuietly(sock);
        }
    }

    static volatile LinkService instance;

    private final IBinder binder = new LocalBinder();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile Listener listener;

    private SharedPreferences prefs;
    private File queueFile;
    private HandlerThread writeThread;
    private Handler writer;
    private Thread linkThread, uploadThread;
    private PowerManager.WakeLock uploadWake, linkWake, alarmWake, rxWake;
    private WifiManager.WifiLock wifiLock;
    private ConnectivityManager.NetworkCallback netCallback;
    private NotificationManager notes;
    private AlarmManager alarms;
    private PendingIntent alarmIntent;

    private volatile boolean running;
    private final Object signal = new Object();
    private boolean signalled;
    private final Object uploadSignal = new Object();
    private boolean uploadSignalled;
    private final AtomicInteger configGen = new AtomicInteger();
    private final Object pingToken = new Object();

    private final ArrayList<JSONObject> queue = new ArrayList<>();  // guarded by itself
    private volatile Conn conn;
    private volatile int state = ST_OFFLINE;
    private volatile String host;
    private volatile long rtt = -1;
    private volatile long lastRx, resumedAt;
    private volatile String uploadName;
    private volatile int uploadPct;
    private long lastProgressAt;
    private volatile boolean visible;
    private volatile long hiddenAt = Long.MIN_VALUE / 2;
    private final Runnable lingerCheck = this::idleIfUnwanted;
    // A GPT Live call is up (LiveService): keep the link and its fast pings even when hidden.
    private volatile boolean inCall;

    // Screen the server last sent on the watched pane: offered as `have` on reconnect.
    private volatile String haveTarget;
    private volatile long haveRev;
    private volatile String lastSessions;

    // UI's latest `voice` message per target while on: re-sent after every reconnect.
    private final Map<String, String> voices = new LinkedHashMap<>();  // guarded by itself
    private Speaker speaker;

    // Read thread only: previous pane states for notification transitions.
    private final Map<String, String> lastStates = new HashMap<>();
    private final Map<String, String> lastAskIds = new HashMap<>();
    private final Map<String, String> lastSketchIds = new HashMap<>();
    private final Set<String> noted = new HashSet<>();

    private final ConcurrentLinkedQueue<String> inbox = new ConcurrentLinkedQueue<>();
    private final AtomicBoolean deliverPosted = new AtomicBoolean();
    private volatile boolean linkDirty;
    private final Runnable deliverTask = this::deliver;

    // ---- static helpers usable without a running instance ----

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("devdeck", Context.MODE_PRIVATE);
    }

    static boolean paired(Context c) {
        SharedPreferences p = prefs(c);
        return p.getString("token", null) != null && !hosts(p).isEmpty();
    }

    static List<String> hosts(SharedPreferences p) {
        List<String> out = new ArrayList<>();
        for (String h : p.getString("hosts", "").split(",")) {
            h = h.trim();
            if (!h.isEmpty()) out.add(h);
        }
        return out;
    }

    /** The terminal the UI last watched, or null before the first watch. */
    static String watchTarget(Context c) {
        return prefs(c).getString("target", null);
    }

    /** Latest raw `sessions` message, or null if none arrived since the service started. */
    static String sessions() {
        LinkService s = instance;
        return s == null ? null : s.lastSessions;
    }

    /** True if resolved pane target {@code pane} is what watch target {@code watch} refers to. */
    static boolean matches(String pane, String watch) {
        return pane.equals(watch) || pane.startsWith(watch + ":") || pane.startsWith(watch + ".");
    }

    static JSONObject sendItem(String target, String text, boolean enter) throws JSONException {
        return new JSONObject().put("t", "send").put("id", UUID.randomUUID().toString())
                .put("target", target).put("text", text).put("enter", enter);
    }

    static JSONObject clipItem(String text) throws JSONException {
        return new JSONObject().put("t", "clip").put("id", UUID.randomUUID().toString()).put("text", text);
    }

    static JSONObject uploadItem(String id, File f, String name) throws JSONException {
        return new JSONObject().put("t", "upload").put("id", id).put("path", f.getAbsolutePath())
                .put("name", name).put("size", f.length());
    }

    /** Adds items to the persistent queue, starting the service if needed. Any thread. */
    static void enqueue(Context c, JSONArray items) {
        LinkService s = instance;
        if (s != null) {
            s.addItems(items);
        } else {
            c.startForegroundService(new Intent(c, LinkService.class).setAction(ACTION_ENQUEUE)
                    .putExtra(EXTRA_ITEMS, items.toString()));
        }
    }

    static void closeQuietly(Socket s) {
        try {
            s.close();
        } catch (IOException ignored) {
        }
    }

    // ---- lifecycle ----

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        prefs = prefs(this);
        notes = getSystemService(NotificationManager.class);
        NotificationChannel link = new NotificationChannel(CH_LINK, "Connection", NotificationManager.IMPORTANCE_LOW);
        link.setShowBadge(false);
        notes.createNotificationChannel(link);
        notes.createNotificationChannel(new NotificationChannel(CH_ASK, "Agent questions",
                NotificationManager.IMPORTANCE_HIGH));
        notes.createNotificationChannel(new NotificationChannel(CH_DONE, "Agent finished",
                NotificationManager.IMPORTANCE_DEFAULT));
        queueFile = new File(getFilesDir(), "queue.json");
        speaker = new Speaker(this, this::toUi);
        loadQueue();
        state = paired(this) ? ST_OFFLINE : ST_UNPAIRED;
        startForeground(NOTE_ID, buildNote());

        writeThread = new HandlerThread("dd-write");
        writeThread.start();
        writer = new Handler(writeThread.getLooper());
        PowerManager pm = getSystemService(PowerManager.class);
        uploadWake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "devdeck:upload");
        uploadWake.setReferenceCounted(false);
        // Keeps CPU and Wi-Fi up while the app is in use so pings, screens and the queue are
        // never frozen mid-flight; released as soon as the app is hidden with nothing pending.
        linkWake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "devdeck:link");
        linkWake.setReferenceCounted(false);
        alarmWake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "devdeck:ping");
        alarmWake.setReferenceCounted(false);
        rxWake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "devdeck:rx");
        rxWake.setReferenceCounted(false);
        wifiLock = getSystemService(WifiManager.class)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "devdeck:link");
        wifiLock.setReferenceCounted(false);
        alarms = getSystemService(AlarmManager.class);
        alarmIntent = PendingIntent.getBroadcast(this, 0, new Intent(this, PingReceiver.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        running = true;
        applyWakelock();
        scheduleAlarm();
        linkThread = new Thread(this::linkLoop, "dd-link");
        linkThread.start();
        uploadThread = new Thread(this::uploadLoop, "dd-upload");
        uploadThread.start();

        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                if (conn == null && wantLink()) signal();
                signalUploads();
            }
        };
        getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(netCallback);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            if (ACTION_ENQUEUE.equals(intent.getAction())) {
                String items = intent.getStringExtra(EXTRA_ITEMS);
                if (items != null) {
                    try {
                        addItems(new JSONArray(items));
                    } catch (JSONException e) {
                        Log.w(TAG, "bad enqueue intent", e);
                    }
                }
            } else if (ACTION_RELOAD.equals(intent.getAction())) {
                reload();
            } else if (ACTION_WAKELOCK.equals(intent.getAction())) {
                setWakelock(!wakelock());
            }
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onDestroy() {
        running = false;
        instance = null;
        try {
            getSystemService(ConnectivityManager.class).unregisterNetworkCallback(netCallback);
        } catch (RuntimeException ignored) {
        }
        alarms.cancel(alarmIntent);
        Conn c = conn;
        if (c != null) c.close();
        signal();
        signalUploads();
        linkThread.interrupt();
        uploadThread.interrupt();
        writeThread.quit();
        speaker.shutdown();
        for (PowerManager.WakeLock w : new PowerManager.WakeLock[]{uploadWake, linkWake, alarmWake, rxWake}) {
            if (w.isHeld()) w.release();
        }
        if (wifiLock.isHeld()) wifiLock.release();
        UiStore.flushOpen(2000);  // the UI's last saves (drafts, answers) before the process may go
        super.onDestroy();
    }

    // ---- API for MainActivity / the JS bridge ----

    /** Main thread. The activity registers on create and unregisters on destroy. */
    void setListener(Listener l) {
        listener = l;
    }

    /** Main thread. Activity started (true) or stopped (false). */
    void setVisible(boolean vis) {
        if (vis == visible) return;
        long now = SystemClock.elapsedRealtime();
        long away = now - hiddenAt;
        visible = vis;
        writer.removeCallbacks(lingerCheck);
        if (vis) {
            resumedAt = now;
            String t = watchTarget(this);
            if (t != null) cancelAgentNote(t);
        } else {
            hiddenAt = now;
            writer.postDelayed(lingerCheck, BG_LINGER_MS + 100);
        }
        scheduleAlarm();
        Conn c = conn;
        if (c != null) {
            writeObj(c, obj("t", vis ? "resume" : "pause"));
            if (vis) {
                startPings(c);
                if (away > PROBE_AFTER_MS) probe(c, now);
            } else if (!inCall) {
                writer.removeCallbacksAndMessages(pingToken);
            }
        } else if (vis) {
            signal();
        }
        applyWakelock();
        fireLink();
    }

    /**
     * Live message from the UI (any thread). Returns false if offline. `watch` is remembered
     * for the next hello and for notification suppression; `voice` (while on) is re-sent after
     * every reconnect, also when it was sent offline.
     */
    boolean sendLive(String json) {
        JSONObject m;
        try {
            m = new JSONObject(json);
        } catch (JSONException e) {
            Log.w(TAG, "bad UI message " + json);
            return false;
        }
        String t = m.optString("t");
        if ("voice".equals(t)) {
            String target = m.optString("target");
            synchronized (voices) {
                if (m.optBoolean("on")) voices.put(target, json.indexOf('\n') >= 0 ? m.toString() : json);
                else voices.remove(target);
            }
        }
        if ("watch".equals(t)) {
            String target = m.optString("target", null);
            String view = m.optString("view", null);
            SharedPreferences.Editor ed = prefs.edit();
            if (target != null) {
                ed.putString("target", target);
                String ht = haveTarget;
                if (ht != null && !matches(ht, target)) haveTarget = null;
                if (visible) cancelAgentNote(target);
            }
            if (view != null) ed.putString("view", view);
            ed.apply();
        }
        Conn c = conn;
        if (c == null) return false;
        writeLine(c, json.indexOf('\n') >= 0 ? m.toString() : json);
        return true;
    }

    /** Queued item from the UI (any thread): fills `id`, persists, sends; returns the id. */
    String enqueueJson(String json) throws JSONException {
        JSONObject it = new JSONObject(json);
        String t = it.optString("t");
        if (!"send".equals(t) && !"clip".equals(t) && !"answer".equals(t)) {
            throw new JSONException("not a queue item: " + t);
        }
        String id = it.optString("id");
        if (id.isEmpty()) {
            id = UUID.randomUUID().toString();
            it.put("id", id);
        }
        addItems(new JSONArray().put(it));
        return id;
    }

    /** New UI page instance: it holds no screen, so stop offering one in hello. */
    List<String> replay() {
        haveTarget = null;
        List<String> out = new ArrayList<>(3);
        out.add(linkJson());
        String s = lastSessions;
        if (s != null) out.add(s);
        String call = LiveService.activeState();
        if (call != null) out.add(call);
        return out;
    }

    /** Any thread: stop the native TTS player and drop what is queued or streaming. */
    void stopSpeaking() {
        speaker.stop();
    }

    /**
     * Main thread. The UI page that switched voice mode on is gone: the server stops speaking
     * to this client (it would play with no UI around) and nothing is re-sent on reconnect.
     */
    void resetVoice() {
        List<String> targets;
        synchronized (voices) {
            targets = new ArrayList<>(voices.keySet());
            voices.clear();
        }
        Conn c = conn;
        if (c != null) {
            for (String target : targets) {
                try {
                    writeObj(c, new JSONObject().put("t", "voice").put("target", target).put("on", false));
                } catch (JSONException e) {
                    throw new IllegalStateException(e);
                }
            }
        }
        speaker.stop();
    }

    boolean wakelock() {
        return prefs.getBoolean("wakelock", true);
    }

    void setWakelock(boolean on) {
        prefs.edit().putBoolean("wakelock", on).apply();
        applyWakelock();
        fireLink();
    }

    boolean notifyOn() {
        return prefs.getBoolean("notify", true);
    }

    void setNotify(boolean on) {
        prefs.edit().putBoolean("notify", on).apply();
        if (!on) for (String t : notedSnapshot()) cancelAgentNote(t);
        writer.removeCallbacks(lingerCheck);
        if (!visible) writer.postDelayed(lingerCheck, Math.max(0, BG_LINGER_MS + 100
                - (SystemClock.elapsedRealtime() - hiddenAt)));
        scheduleAlarm();
        if (conn == null && wantLink()) signal();
        applyWakelock();
        fireLink();
    }

    /** Pairing changed: drop the current link and reconnect with the new config right away. */
    void reload() {
        configGen.incrementAndGet();
        haveTarget = null;
        Conn c = conn;
        if (c != null) c.close();
        state = paired(this) ? ST_OFFLINE : ST_UNPAIRED;
        fireLink();
        signal();
    }

    int queued() {
        synchronized (queue) {
            return queue.size();
        }
    }

    boolean online() {
        return conn != null;
    }

    boolean isVisible() {
        return visible;
    }

    /** Local message for the UI (any thread), delivered in order with the server's. */
    void local(String json) {
        toUi(json);
    }

    /** Main thread. LiveService call started/ended: the link stays up and pinged while it runs. */
    void setInCall(boolean on) {
        if (on == inCall) return;
        inCall = on;
        writer.removeCallbacks(lingerCheck);
        if (!visible) writer.postDelayed(lingerCheck, Math.max(0, BG_LINGER_MS + 100
                - (SystemClock.elapsedRealtime() - hiddenAt)));
        Conn c = conn;
        if (c != null) {
            if (on) startPings(c);
            else if (!visible) writer.removeCallbacksAndMessages(pingToken);
        } else if (on) {
            signal();
        }
        scheduleAlarm();
        applyWakelock();
    }

    // ---- battery policy ----

    /** Whether a connection is worth its battery cost right now. */
    private boolean wantLink() {
        return visible || inCall || notifyOn() || queued() > 0 || uploadName != null
                || SystemClock.elapsedRealtime() - hiddenAt < BG_LINGER_MS;
    }

    /** Close the link once it is no longer wanted; linkLoop then idles until it is. */
    private void idleIfUnwanted() {
        if (wantLink()) return;
        Conn c = conn;
        if (c != null) c.close();
        scheduleAlarm();
        applyWakelock();
    }

    /** Link wakelock + Wi-Fi lock: while visible, uploading or the queue is non-empty. */
    private synchronized void applyWakelock() {
        if (wakelock() && running && state != ST_UNPAIRED
                && (visible || inCall || queued() > 0 || uploadName != null)) {
            if (!linkWake.isHeld()) linkWake.acquire();
            if (!wifiLock.isHeld()) wifiLock.acquire();
        } else {
            if (linkWake.isHeld()) linkWake.release();
            if (wifiLock.isHeld()) wifiLock.release();
        }
    }

    /** Hidden with a wanted link: the exact idle-proof alarm is the only clock that runs. */
    private void scheduleAlarm() {
        if (alarms == null) return;
        if (running && !visible && state != ST_UNPAIRED && wantLink()) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + PING_BG_MS, alarmIntent);
        } else {
            alarms.cancel(alarmIntent);
        }
    }

    /** PingReceiver, main thread. */
    void onAlarm() {
        if (!running || visible) return;
        scheduleAlarm();
        if (!wantLink()) return;
        Conn c = conn;
        if (c != null && SystemClock.elapsedRealtime() - lastRx > DEAD_BG_MS) {
            Log.i(TAG, "link silent for too long, redialling");
            c.close();
            c = null;
        }
        alarmWake.acquire(ALARM_WAKE_MS);
        if (c != null) ping(c);
        else signal();
    }

    private void startPings(Conn c) {
        writer.removeCallbacksAndMessages(pingToken);
        pingLoop(c);
    }

    private void pingLoop(Conn c) {
        if (conn != c || !(visible || inCall)) return;
        ping(c);
        writer.postAtTime(() -> pingLoop(c), pingToken, SystemClock.uptimeMillis() + PING_MS);
    }

    private void ping(Conn c) {
        try {
            writeObj(c, new JSONObject().put("t", "ping").put("ts", SystemClock.elapsedRealtime()));
        } catch (JSONException ignored) {
        }
    }

    /** Redial unless the server says anything within PROBE_MS. */
    private void probe(Conn c, long since) {
        writer.postDelayed(() -> {
            if (conn == c && lastRx < since) {
                Log.i(TAG, "resumed link silent, redialling");
                c.close();
            }
        }, PROBE_MS);
    }

    // ---- queue ----

    void addItems(JSONArray items) {
        boolean upload = false;
        synchronized (queue) {
            Conn c = conn;
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                queue.add(it);
                if ("upload".equals(it.optString("t"))) upload = true;
                else if (c != null) writeObj(c, it);  // posted under the lock so order matches the queue
            }
            saveQueueLocked();
        }
        if (conn == null) signal();
        if (upload) signalUploads();
        scheduleAlarm();
        applyWakelock();
        fireLink();
    }

    private JSONObject removeItem(String id) {
        if (id == null) return null;
        JSONObject found = null;
        synchronized (queue) {
            for (int i = 0; i < queue.size(); i++) {
                if (id.equals(queue.get(i).optString("id"))) {
                    found = queue.remove(i);
                    saveQueueLocked();
                    break;
                }
            }
        }
        if (found != null) {
            idleIfUnwanted();
            applyWakelock();
            fireLink();
        }
        return found;
    }

    private void loadQueue() {
        if (!queueFile.exists()) return;
        try {
            JSONArray a = new JSONArray(readFile(queueFile));
            synchronized (queue) {
                for (int i = 0; i < a.length(); i++) queue.add(a.getJSONObject(i));
            }
        } catch (IOException | JSONException e) {
            Log.w(TAG, "queue unreadable, starting empty", e);
        }
    }

    private void saveQueueLocked() {
        try {
            writeFile(queueFile, new JSONArray(queue).toString());
        } catch (IOException e) {
            Log.w(TAG, "saving queue failed", e);
        }
    }

    // ---- control connection ----

    private void linkLoop() {
        long backoff = BACKOFF_MIN;
        while (running) {
            int gen = configGen.get();
            String token = prefs.getString("token", null);
            List<String> hostList = hosts(prefs);
            if (token == null || hostList.isEmpty()) {
                setState(ST_UNPAIRED, null);
                await(0);
                continue;
            }
            if (!wantLink()) {
                setState(ST_IDLE, null);
                await(0);
                continue;
            }
            setState(ST_CONNECTING, null);
            Conn c = race(token, hostList, prefs.getInt("port", DEFAULT_PORT));
            if (c != null && (gen != configGen.get() || !running)) {
                c.close();
                continue;
            }
            if (c == null) {
                if (!running) break;
                setState(ST_OFFLINE, null);
                if (!visible && alarmWake.isHeld()) alarmWake.release();
                if (await(backoff)) backoff = BACKOFF_MIN;
                // Hidden: retry rarely; a network change or the next alarm still retries at once.
                else backoff = Math.min(backoff * 2, visible || inCall ? BACKOFF_MAX : BACKOFF_BG_MAX);
                continue;
            }
            backoff = BACKOFF_MIN;
            Inflater inflater = new Inflater();
            try {
                c.sock.setSoTimeout(READ_TICK_MS);
                lastRx = SystemClock.elapsedRealtime();
                synchronized (queue) {
                    conn = c;
                    for (JSONObject it : queue) if (!"upload".equals(it.optString("t"))) writeObj(c, it);
                }
                synchronized (voices) {
                    for (String v : voices.values()) writeLine(c, v);
                }
                setState(ST_ONLINE, c.host);
                if (visible || inCall) startPings(c);
                else ping(c);
                signalUploads();
                readLoop(c, inflater);
            } catch (IOException | RuntimeException e) {
                Log.i(TAG, "link to " + c.host + " ended: " + e);
            } finally {
                c.close();
                inflater.end();
                conn = null;
            }
            rtt = -1;
            if (!running) break;
            setState(ST_OFFLINE, null);
            await(BACKOFF_MIN);
        }
    }

    private byte[] helloBytes(String token) {
        try {
            JSONObject h = new JSONObject().put("t", "hello").put("token", token)
                    .put("client", clientId()).put("paused", !visible);
            String target = prefs.getString("target", null);
            String view = prefs.getString("view", "chat");
            h.put("view", view);
            if (target != null) h.put("target", target);
            String ht = haveTarget;
            if (ht != null && target != null && "term".equals(view) && matches(ht, target)) {
                h.put("have", new JSONObject().put("target", ht).put("rev", haveRev));
            }
            return (h.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Dials every host in parallel; keeps the first that answers hello with welcome. */
    private Conn race(String token, List<String> hostList, int port) {
        byte[] hello = helloBytes(token);
        final Object lock = new Object();
        final Conn[] winner = {null};
        final int[] left = {hostList.size()};
        final List<Socket> sockets = new ArrayList<>();
        for (int i = 0; i < hostList.size(); i++) sockets.add(new Socket());
        for (int i = 0; i < hostList.size(); i++) {
            final String h = hostList.get(i);
            final Socket s = sockets.get(i);
            new Thread(() -> {
                Conn won = null;
                try {
                    s.setTcpNoDelay(true);
                    s.setKeepAlive(true);
                    s.connect(new InetSocketAddress(h, port), CONNECT_MS);
                    synchronized (lock) {
                        if (winner[0] != null) return;
                    }
                    s.setSoTimeout(HANDSHAKE_MS);
                    OutputStream out = s.getOutputStream();
                    out.write(hello);
                    out.flush();
                    JSONObject w = new JSONObject(readPlainLine(s.getInputStream()));
                    if (!"welcome".equals(w.optString("t"))) throw new IOException("unexpected reply " + w);
                    synchronized (lock) {
                        if (winner[0] == null) winner[0] = won = new Conn(s, h);
                    }
                } catch (IOException | JSONException e) {
                    Log.i(TAG, "dial " + h + ": " + e);
                } finally {
                    if (won == null) closeQuietly(s);
                    synchronized (lock) {
                        left[0]--;
                        lock.notifyAll();
                    }
                }
            }, "dd-dial-" + h).start();
        }
        Conn w;
        synchronized (lock) {
            while (winner[0] == null && left[0] > 0 && running) {
                try {
                    lock.wait(1000);
                } catch (InterruptedException e) {
                    break;
                }
            }
            w = winner[0];
        }
        for (Socket s : sockets) if (w == null || s != w.sock) closeQuietly(s);
        return w;
    }

    private void readLoop(Conn c, Inflater inflater) throws IOException {
        // Socket reads return whatever has arrived, so the inflater always gets the complete
        // SYNC_FLUSH block and emits the whole message without waiting for further bytes.
        InputStream in = new InflaterInputStream(c.sock.getInputStream(), inflater, 16384);
        byte[] buf = new byte[32768];
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        while (running && conn == c) {
            int n;
            try {
                n = in.read(buf);
            } catch (SocketTimeoutException e) {
                long now = SystemClock.elapsedRealtime();
                long since = Math.max(lastRx, visible ? resumedAt : 0);
                if (now - since > (visible || inCall ? DEAD_MS : DEAD_BG_MS)) throw new IOException("link dead");
                continue;
            }
            if (n < 0) throw new EOFException("server closed");
            lastRx = SystemClock.elapsedRealtime();
            if (!visible) rxWake.acquire(RX_WAKE_MS);  // finish handling (notifications) before sleeping
            int start = 0;
            for (int i = 0; i < n; i++) {
                if (buf[i] != '\n') continue;
                line.write(buf, start, i - start);
                handle(c, new String(line.toByteArray(), StandardCharsets.UTF_8));
                line.reset();
                start = i + 1;
            }
            line.write(buf, start, n - start);
        }
    }

    private void handle(Conn c, String line) {
        String t = Peek.str(line, "t");
        if (t == null) {
            Log.w(TAG, "bad line from server");
            return;
        }
        try {
            switch (t) {
                case "screen":
                    String target = Peek.str(line, "target");
                    if (target != null) {
                        haveTarget = target;
                        haveRev = Peek.num(line, "rev", 0);
                    }
                    break;
                case "sessions":
                    lastSessions = line;
                    onSessions(new JSONObject(line));
                    break;
                case "created":
                    String created = Peek.str(line, "target");
                    if (created != null) prefs.edit().putString("target", created).apply();
                    break;
                case "ack":
                    removeItem(Peek.str(line, "id"));
                    break;
                case "pong":
                    rtt = SystemClock.elapsedRealtime() - Peek.num(line, "ts", SystemClock.elapsedRealtime());
                    if (!visible && alarmWake.isHeld()) alarmWake.release();
                    fireLink();
                    break;
                case "audio":
                    speaker.offer(line);
                    break;
                case "voice_error":
                    speaker.voiceError(line);
                    break;
                case "live_answer":
                case "live":
                case "error":
                    LiveService.onLink(t, line);
                    break;
                case "live_send":  // for the call's data channel only, not for the UI
                    LiveService.onLink(t, line);
                    return;
                default:
                    break;
            }
        } catch (JSONException e) {
            Log.w(TAG, "bad " + t + " message", e);
        }
        toUi(line);
    }

    // ---- agent notifications ----

    private void onSessions(JSONObject m) throws JSONException {
        JSONArray a = m.getJSONArray("list");
        Map<String, Integer> perSession = new HashMap<>();
        for (int i = 0; i < a.length(); i++) perSession.merge(a.getJSONObject(i).optString("session"), 1, Integer::sum);
        boolean alerts = notifyOn();
        String watching = prefs.getString("target", null);
        Set<String> present = new HashSet<>();
        for (int i = 0; i < a.length(); i++) {
            JSONObject p = a.getJSONObject(i);
            String target = p.getString("target");
            String state = p.optString("state");
            JSONObject ask = p.optJSONObject("ask");
            String askId = ask == null ? null : ask.optString("toolCallId", null);
            JSONObject sketch = p.optJSONObject("sketch");
            String sketchId = sketch == null ? null : sketch.optString("toolCallId", null);
            present.add(target);
            String prev = lastStates.put(target, state);
            String prevAsk = askId != null ? lastAskIds.put(target, askId) : lastAskIds.remove(target);
            String prevSketch = sketchId != null ? lastSketchIds.put(target, sketchId) : lastSketchIds.remove(target);
            if (prev == null) continue;  // first sighting: no transition to report
            boolean looking = visible && watching != null && matches(target, watching);
            String session = p.optString("session", target);
            String label = perSession.getOrDefault(session, 1) > 1 ? target : session;
            if (sketchId != null) {
                // request_sketch: the agent waits for a drawing (state stays "working")
                if (alerts && !looking && !sketchId.equals(prevSketch)) {
                    String text = sketch.optString("prompt", "");
                    postAgentNote(target, CH_ASK, label + " wants a sketch", text.isEmpty() ? "Draw something for the agent" : text, false);
                }
                continue;
            }
            if (prevSketch != null) cancelAgentNote(target);
            if ("asking".equals(state)) {
                boolean fresh = !"asking".equals(prev) || (askId != null && prevAsk != null && !askId.equals(prevAsk));
                boolean detail = !fresh && askId != null && prevAsk == null && noted.contains(target);
                if (alerts && !looking && (fresh || detail)) postAsk(target, label, p, ask, !fresh);
            } else if ("idle".equals(state) && "working".equals(prev) && p.optBoolean("agent")) {
                if (alerts && !looking) postDone(target, label, p);
            } else if (!state.equals(prev)) {
                cancelAgentNote(target);
            }
        }
        lastStates.keySet().retainAll(present);
        lastAskIds.keySet().retainAll(present);
        lastSketchIds.keySet().retainAll(present);
        for (String t : new ArrayList<>(notedSnapshot())) if (!present.contains(t)) cancelAgentNote(t);
    }

    private void postAsk(String target, String label, JSONObject pane, JSONObject ask, boolean update) {
        String text = null;
        if (ask != null) {
            JSONArray qs = ask.optJSONArray("questions");
            JSONObject q = qs == null ? null : qs.optJSONObject(0);
            if (q != null) text = q.optString("question", null);
        }
        if (text == null || text.isEmpty()) text = pane.optString("context");
        if (text.isEmpty()) text = "Waiting for your answer";
        postAgentNote(target, CH_ASK, label + " needs you", text, update);
    }

    private void postDone(String target, String label, JSONObject pane) {
        String text = pane.optString("context");
        if (text.isEmpty()) text = "Turn complete";
        postAgentNote(target, CH_DONE, label + " finished", text, false);
    }

    private void postAgentNote(String target, String channel, String title, String text, boolean silent) {
        Intent open = new Intent(this, MainActivity.class).setAction(MainActivity.ACTION_OPEN)
                .setData(Uri.parse("devdeck://open/" + Uri.encode(target)))
                .putExtra(MainActivity.EXTRA_OPEN, target)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Notification n = new Notification.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xff58a6ff)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(CH_ASK.equals(channel) ? Notification.CATEGORY_MESSAGE : Notification.CATEGORY_STATUS)
                .setOnlyAlertOnce(silent)
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(this, target.hashCode(), open,
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .build();
        synchronized (noted) {
            noted.add(target);
        }
        notes.notify(target, NOTE_AGENT, n);
    }

    /** One agent notification per terminal (tag = target); any thread. */
    void cancelAgentNote(String target) {
        synchronized (noted) {
            noted.remove(target);
        }
        notes.cancel(target, NOTE_AGENT);
    }

    private List<String> notedSnapshot() {
        synchronized (noted) {
            return new ArrayList<>(noted);
        }
    }

    // ---- uploads ----

    private void uploadLoop() {
        while (running) {
            JSONObject item = null;
            synchronized (queue) {
                for (JSONObject it : queue) {
                    if ("upload".equals(it.optString("t"))) {
                        item = it;
                        break;
                    }
                }
            }
            Conn c = conn;
            if (item == null || c == null) {
                awaitUpload(0);
                continue;
            }
            try {
                upload(c.host, item);
            } catch (IOException | JSONException e) {
                Log.i(TAG, "upload interrupted: " + e);
                awaitUpload(UPLOAD_RETRY_MS);
            } finally {
                if (uploadWake.isHeld()) uploadWake.release();
                uploadName = null;
                applyWakelock();
                fireLink();
            }
        }
    }

    private void upload(String toHost, JSONObject item) throws IOException, JSONException {
        String id = item.getString("id");
        String name = item.getString("name");
        long size = item.getLong("size");
        File f = new File(item.getString("path"));
        if (!f.isFile() || f.length() != size) {
            removeItem(id);
            f.delete();
            toast("Dropped upload " + name + ": outbox copy is gone");
            return;
        }
        uploadName = name;
        uploadPct = 0;
        applyWakelock();
        fireLink();
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(toHost, prefs.getInt("port", DEFAULT_PORT)), CONNECT_MS);
            s.setSoTimeout(UPLOAD_IDLE_MS);
            OutputStream out = s.getOutputStream();
            InputStream in = s.getInputStream();
            JSONObject hdr = new JSONObject().put("t", "upload").put("token", prefs.getString("token", ""))
                    .put("id", id).put("name", name).put("size", size);
            out.write((hdr.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
            JSONObject r = new JSONObject(readPlainLine(in));
            if ("resume".equals(r.optString("t"))) {
                long off = r.getLong("offset");
                if (off < 0 || off > size) throw new IOException("bad resume offset " + off);
                uploadWake.acquire(30 * 60 * 1000L);
                try (FileInputStream fin = new FileInputStream(f)) {
                    fin.getChannel().position(off);
                    byte[] buf = new byte[65536];
                    long sent = off;
                    while (sent < size) {
                        int n = fin.read(buf, 0, (int) Math.min(buf.length, size - sent));
                        if (n < 0) throw new EOFException("outbox file shrank");
                        out.write(buf, 0, n);
                        sent += n;
                        progress(sent, size);
                    }
                    out.flush();
                }
                r = new JSONObject(readPlainLine(in));
            }
            if (!"done".equals(r.optString("t"))) throw new IOException("unexpected reply " + r);
            uploadPct = 100;
            removeItem(id);
            f.delete();
            toast("Uploaded " + name + " to " + r.optString("path"));
        }
    }

    private void progress(long sent, long size) {
        uploadPct = size == 0 ? 100 : (int) (sent * 100 / size);
        long now = SystemClock.elapsedRealtime();
        if (now - lastProgressAt < PROGRESS_MS) return;
        lastProgressAt = now;
        fireLink();
    }

    // ---- signalling ----

    private void signal() {
        synchronized (signal) {
            signalled = true;
            signal.notifyAll();
        }
    }

    /** Sleeps up to ms (0 = until signalled); returns true if woken by a signal. */
    private boolean await(long ms) {
        synchronized (signal) {
            if (!signalled && running) {
                try {
                    signal.wait(ms);
                } catch (InterruptedException ignored) {
                }
            }
            boolean was = signalled;
            signalled = false;
            return was;
        }
    }

    private void signalUploads() {
        synchronized (uploadSignal) {
            uploadSignalled = true;
            uploadSignal.notifyAll();
        }
    }

    private void awaitUpload(long ms) {
        synchronized (uploadSignal) {
            if (!uploadSignalled && running) {
                try {
                    uploadSignal.wait(ms);
                } catch (InterruptedException ignored) {
                }
            }
            uploadSignalled = false;
        }
    }

    // ---- socket writes ----

    private void writeObj(Conn c, JSONObject m) {
        writeLine(c, m.toString());
    }

    /** Queues one JSON line for the socket writer thread; a failed write kills the connection. */
    private void writeLine(Conn c, String json) {
        byte[] b = (json + "\n").getBytes(StandardCharsets.UTF_8);
        writer.post(() -> {
            if (conn != c) return;
            try {
                c.out.write(b);
                c.out.flush();
            } catch (IOException e) {
                c.close();
            }
        });
    }

    private static JSONObject obj(String k, String v) {
        try {
            return new JSONObject().put(k, v);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private String clientId() {
        String id = prefs.getString("client", null);
        if (id == null) {
            byte[] r = new byte[8];
            new SecureRandom().nextBytes(r);
            StringBuilder sb = new StringBuilder();
            for (byte x : r) sb.append(String.format("%02x", x & 0xff));
            id = sb.toString();
            prefs.edit().putString("client", id).commit();
        }
        return id;
    }

    // ---- UI plumbing ----

    private void setState(int st, String h) {
        if (state == st && (h == null || h.equals(host))) return;
        state = st;
        if (h != null) host = h;
        if (st != ST_ONLINE) rtt = -1;
        applyWakelock();
        fireLink();
    }

    private void toUi(String msg) {
        if (listener == null) return;
        inbox.add(msg);
        scheduleDelivery();
    }

    /** Link state changed: the UI gets one fresh `link` message per batch; the note is refreshed. */
    private void fireLink() {
        linkDirty = true;
        scheduleDelivery();
    }

    private void scheduleDelivery() {
        if (deliverPosted.compareAndSet(false, true)) main.post(deliverTask);
    }

    private void deliver() {
        deliverPosted.set(false);
        ArrayList<String> batch = new ArrayList<>();
        String m;
        while ((m = inbox.poll()) != null) batch.add(m);
        if (linkDirty) {
            linkDirty = false;
            batch.add(linkJson());
            updateNote();
        }
        Listener l = listener;
        if (l != null && !batch.isEmpty()) l.onMessages(batch);
    }

    String linkJson() {
        try {
            JSONObject o = new JSONObject().put("t", "link").put("state", STATE_NAMES[state])
                    .put("host", host == null ? JSONObject.NULL : host)
                    .put("rtt", rtt < 0 ? JSONObject.NULL : (Object) rtt)
                    .put("queued", queued()).put("wakelock", wakelock()).put("notify", notifyOn());
            String up = uploadName;
            if (up != null) o.put("uploading", new JSONObject().put("name", up).put("pct", uploadPct));
            return o.toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Local `toast` for the UI, or a system toast when no UI is around. */
    void toast(String text) {
        if (listener != null) {
            try {
                toUi(new JSONObject().put("t", "toast").put("text", text).toString());
            } catch (JSONException ignored) {
            }
        } else {
            main.post(() -> Toast.makeText(this, "DevDeck: " + text, Toast.LENGTH_LONG).show());
        }
    }

    /** One-line status for the ongoing notification. */
    private String statusLine() {
        StringBuilder sb = new StringBuilder();
        switch (state) {
            case ST_UNPAIRED: sb.append("Not paired"); break;
            case ST_CONNECTING: sb.append("Connecting"); break;
            case ST_IDLE: sb.append("Idle, reconnects when opened"); break;
            case ST_ONLINE:
                sb.append(visible ? "Connected via " : "Standing by via ").append(host);
                if (rtt >= 0) sb.append(" \u00b7 ").append(rtt).append(" ms");
                break;
            default: sb.append("Offline");
        }
        int q = queued();
        if (q > 0) sb.append(" \u00b7 ").append(q).append(" queued");
        if (uploadName != null) sb.append(" \u00b7 uploading ").append(uploadPct).append('%');
        return sb.toString();
    }

    private Notification buildNote() {
        Notification.Builder b = new Notification.Builder(this, CH_LINK)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xff58a6ff)
                .setContentTitle("DevDeck")
                .setContentText(statusLine())
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .addAction(new Notification.Action.Builder(null,
                        wakelock() ? "Release wakelock" : "Acquire wakelock",
                        PendingIntent.getService(this, 1, new Intent(this, LinkService.class).setAction(ACTION_WAKELOCK),
                                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build());
        String up = uploadName;
        if (up != null) {
            b.setContentTitle("DevDeck \u00b7 uploading " + up);
            b.setProgress(100, uploadPct, false);
        }
        return b.build();
    }

    private String lastNote;

    /** Main thread. Skips identical re-posts (every pong would otherwise re-post the note). */
    private void updateNote() {
        if (notes == null || !running) return;
        String key = statusLine() + wakelock() + uploadName;
        if (key.equals(lastNote)) return;
        lastNote = key;
        notes.notify(NOTE_ID, buildNote());
    }

    // ---- persistence ----

    private static String readFile(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /** Write-then-rename so a crash never leaves a half-written file. */
    private static void writeFile(File f, String s) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(s.getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(f)) throw new IOException("rename " + tmp + " failed");
    }

    private static String readPlainLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (;;) {
            int c = in.read();  // byte by byte: nothing past the newline may be consumed
            if (c < 0) throw new EOFException("closed before reply");
            if (c == '\n') break;
            if (b.size() > 1 << 20) throw new IOException("reply line too long");
            b.write(c);
        }
        return new String(b.toByteArray(), StandardCharsets.UTF_8);
    }
}
