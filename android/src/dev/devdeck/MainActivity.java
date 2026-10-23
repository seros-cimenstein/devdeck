package dev.devdeck;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The whole UI is the WebView SPA in assets/web/; this activity only hosts it, implements the
 * `DD` bridge and relays LinkService messages to `dd.receive`.
 */
public class MainActivity extends Activity implements LinkService.Listener {
    static final String ACTION_OPEN = "dev.devdeck.OPEN";
    static final String EXTRA_OPEN = "open";
    private static final int BG = 0xff0d1117;  // matches res/values/themes.xml and the web UI

    private static final String TAG = "DevDeck";
    // Served from assets through shouldInterceptRequest: a real https origin, so ES modules,
    // fonts, localStorage and IndexedDB behave as on the web (file:// breaks several of them).
    private static final String HOST = "appassets.androidplatform.net";
    private static final String INDEX = "https://" + HOST + "/web/index.html";
    private static final int REQ_FILES = 1;
    private static final int REQ_MIC = 2;
    private static final long BACK_TIMEOUT_MS = 1000;

    static volatile MainActivity current;

    private final Handler main = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private WebView web;
    private LinkService svc;
    private boolean bound, started, ready;
    private String pendingOpen;
    private boolean backPending;
    private final Runnable backTimeout = this::backUnhandled;
    private Recognizer recognizer;
    private String pendingListen;  // listen opts waiting for the microphone permission
    // Local events (stt) coalesced into one dd.receive script per main-loop turn.
    private final ArrayList<String> localOut = new ArrayList<>();
    private boolean localPosted;
    private final Runnable flushLocal = this::flushLocal;

    private final ServiceConnection conn = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            svc = ((LinkService.LocalBinder) binder).service();
            svc.setListener(MainActivity.this);
            svc.setVisible(started);
            if (ready) replay();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            svc = null;
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        current = this;
        prefs = LinkService.prefs(this);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);  // volume keys adjust the TTS voice
        recognizer = new Recognizer(this, this::emitLocal);
        WebView.setWebContentsDebuggingEnabled(true);
        createWeb();
        applyPairing(getIntent());
        takeOpen(getIntent());
        startForegroundService(new Intent(this, LinkService.class));
        bound = bindService(new Intent(this, LinkService.class), conn, Context.BIND_AUTO_CREATE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyPairing(intent);
        takeOpen(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        started = true;
        if (web != null) {
            web.onResume();
            web.resumeTimers();
        }
        if (svc != null) svc.setVisible(true);
    }

    @Override
    protected void onStop() {
        started = false;
        recognizer.cancel();  // the microphone is only ours while visible
        if (svc != null) svc.setVisible(false);
        if (web != null) {
            web.onPause();
            web.pauseTimers();
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        main.removeCallbacks(backTimeout);
        resetVoice();
        recognizer.destroy();
        if (svc != null) {
            svc.setVisible(false);
            svc.setListener(null);
        }
        if (bound) unbindService(conn);
        bound = false;
        svc = null;
        destroyWeb();
        super.onDestroy();
    }

    // ---- WebView ----

    private void createWeb() {
        ready = false;
        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setSupportMultipleWindows(false);
        web.addJavascriptInterface(new Bridge(web), "DD");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.w(TAG, "js: " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                }
                return true;
            }
        });
        setContentView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(INDEX);
        if (!started) {
            web.onPause();
        }
    }

    private void destroyWeb() {
        if (web == null) return;
        ViewGroup parent = (ViewGroup) web.getParent();
        if (parent != null) parent.removeView(web);
        web.destroy();
        web = null;
        ready = false;
    }

    private final class Client extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (view == web) {
                ready = false;
                resetVoice();  // a new page instance starts with voice mode off
            }
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            return serve(req.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;
            openExternal(u.toString());
            return true;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The renderer was killed (low memory) or crashed: start a fresh page instead of dying.
            Log.w(TAG, "WebView renderer gone, crashed=" + detail.didCrash());
            if (view == web) {
                destroyWeb();
                createWeb();
            }
            return true;
        }
    }

    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("map", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff2", "font/woff2");
        MIME.put("woff", "font/woff");
        MIME.put("ttf", "font/ttf");
        MIME.put("wasm", "application/wasm");
        MIME.put("txt", "text/plain");
    }

    /** Assets under /web/ on our virtual host; everything else (remote content) is refused. */
    private WebResourceResponse serve(Uri u) {
        String path = u.getPath();
        if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost()) || path == null
                || !path.startsWith("/web/") || path.contains("..")) {
            return status(404, "Not Found");
        }
        String rel = path.substring(1);
        if (rel.endsWith("/")) rel += "index.html";
        int dot = rel.lastIndexOf('.');
        String ext = dot < 0 ? "" : rel.substring(dot + 1).toLowerCase();
        String mime = MIME.getOrDefault(ext, "application/octet-stream");
        InputStream in;
        try {
            in = getAssets().open(rel, android.content.res.AssetManager.ACCESS_STREAMING);
        } catch (IOException e) {
            return status(404, "Not Found");
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        headers.put("Access-Control-Allow-Origin", "https://" + HOST);
        boolean text = mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
        return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", headers, in);
    }

    private static WebResourceResponse status(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, Collections.emptyMap(),
                new ByteArrayInputStream(new byte[0]));
    }

    // ---- LinkService -> JS ----

    @Override
    public void onMessages(List<String> msgs) {
        if (!ready || web == null) return;
        StringBuilder sb = new StringBuilder();
        // One script per batch; each message isolated so a throwing handler cannot drop the rest.
        for (String m : msgs) {
            sb.append("try{dd.receive(").append(JSONObject.quote(m)).append(")}catch(e){console.error(e)}\n");
        }
        web.evaluateJavascript(sb.toString(), null);
    }

    private void deliverLocal(JSONObject m) {
        List<String> one = new ArrayList<>(1);
        one.add(m.toString());
        onMessages(one);
    }

    private void emitLocal(String m) {
        localOut.add(m);
        if (!localPosted) {
            localPosted = true;
            main.post(flushLocal);
        }
    }

    private void flushLocal() {
        localPosted = false;
        if (localOut.isEmpty()) return;
        List<String> batch = new ArrayList<>(localOut);
        localOut.clear();
        onMessages(batch);
    }

    private void replay() {
        List<String> out = svc != null ? svc.replay() : new ArrayList<>();
        String target = pendingOpen != null ? pendingOpen : LinkService.watchTarget(this);
        pendingOpen = null;
        if (target != null) out.add(openMsg(target));
        onMessages(out);
    }

    private static String openMsg(String target) {
        try {
            return new JSONObject().put("t", "open").put("target", target).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Notification tap (or anything else) asking to show a terminal. */
    private void takeOpen(Intent intent) {
        String target = intent == null ? null : intent.getStringExtra(EXTRA_OPEN);
        if (target == null) return;
        intent.removeExtra(EXTRA_OPEN);
        open(target);
    }

    /** Main thread: switch the UI to target now, or as soon as it is ready. */
    void open(String target) {
        prefs.edit().putString("target", target).apply();
        if (svc != null) svc.cancelAgentNote(target);
        else getSystemService(NotificationManager.class).cancel(target, LinkService.NOTE_AGENT);
        if (ready) {
            List<String> one = new ArrayList<>(1);
            one.add(openMsg(target));
            onMessages(one);
        } else {
            pendingOpen = target;
        }
    }

    // ---- pairing ----

    /** `devdeck.py pair` starts us via adb with --es token, --es hosts, --ei port. */
    private void applyPairing(Intent intent) {
        if (intent == null) return;
        String token = intent.getStringExtra("token");
        String hosts = intent.getStringExtra("hosts");
        if (token == null || hosts == null) return;
        int port = LinkService.DEFAULT_PORT;
        Object p = intent.getExtras().get("port");
        if (p instanceof Integer) port = (Integer) p;
        else if (p != null) {
            try {
                port = Integer.parseInt(p.toString().trim());
            } catch (NumberFormatException ignored) {
            }
        }
        prefs.edit().putString("token", token).putString("hosts", hosts).putInt("port", port).commit();
        // Strip the secret so a later recreate doesn't re-apply it.
        intent.removeExtra("token");
        startForegroundService(new Intent(this, LinkService.class).setAction(LinkService.ACTION_RELOAD));
        Toast.makeText(this, "Paired: " + hosts + " port " + port, Toast.LENGTH_SHORT).show();
    }

    // ---- back ----

    @Override
    public void onBackPressed() {
        if (!ready || web == null) {
            moveTaskToBack(true);
            return;
        }
        backPending = true;
        main.removeCallbacks(backTimeout);
        main.postDelayed(backTimeout, BACK_TIMEOUT_MS);
        try {
            deliverLocal(new JSONObject().put("t", "back"));
        } catch (JSONException e) {
            backUnhandled();
        }
    }

    private void backResult(boolean handled) {
        if (!backPending) return;
        backPending = false;
        main.removeCallbacks(backTimeout);
        if (!handled) moveTaskToBack(true);
    }

    private void backUnhandled() {
        backResult(false);
    }

    // ---- voice ----

    /** Main thread. Barge-in: speaking stops before the microphone opens. */
    private void listen(String opts) {
        if (svc != null) svc.stopSpeaking();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startListening(opts);
            return;
        }
        boolean asking = pendingListen != null;
        pendingListen = opts;
        if (!asking) requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
    }

    private void startListening(String opts) {
        JSONObject o;
        try {
            o = new JSONObject(opts == null || opts.isEmpty() ? "{}" : opts);
        } catch (JSONException e) {
            Log.w(TAG, "bad listen opts: " + opts);
            o = new JSONObject();
        }
        recognizer.start(o.optString("lang", "en-US"), o.optBoolean("partial", true),
                o.optBoolean("preferOffline", true));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_MIC) return;
        String opts = pendingListen;
        pendingListen = null;
        if (opts == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            startListening(opts);
            return;
        }
        recognizer.fail("permission");
        // Denied for good: the system no longer asks, only the app settings can grant it.
        if (results.length > 0 && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
            toast("Allow the microphone for DevDeck to talk to the agent");
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", getPackageName(), null)));
            } catch (ActivityNotFoundException ignored) {
            }
        }
    }

    private void setVoiceMode(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /** Main thread. UI page replaced or gone: microphone, playback, screen and server voice off. */
    private void resetVoice() {
        pendingListen = null;
        recognizer.cancel();
        setVoiceMode(false);
        if (svc != null) svc.resetVoice();
    }

    // ---- files ----

    private void pickFiles() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(i, REQ_FILES);
        } catch (ActivityNotFoundException e) {
            toast("No file picker available");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILES || resultCode != RESULT_OK || data == null) return;
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        if (uris.isEmpty()) return;
        Context app = getApplicationContext();
        new Thread(() -> {
            int n = Outbox.queue(app, uris);
            main.post(() -> toast(Outbox.summary(n, uris.size())));
        }, "dd-outbox").start();
    }

    // ---- helpers ----

    private void toast(String text) {
        if (ready && web != null) {
            try {
                deliverLocal(new JSONObject().put("t", "toast").put("text", text));
                return;
            } catch (JSONException ignored) {
            }
        }
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }

    private void openExternal(String url) {
        Uri u = Uri.parse(url);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if (!scheme.equals("http") && !scheme.equals("https") && !scheme.equals("mailto")) {
            toast("Not opening " + url);
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            toast("No app can open " + url);
        }
    }

    private void haptic() {
        Vibrator v = getSystemService(Vibrator.class);
        if (v == null || !v.hasVibrator()) return;
        if (Build.VERSION.SDK_INT >= 29) v.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK));
        else v.vibrate(VibrationEffect.createOneShot(12, VibrationEffect.DEFAULT_AMPLITUDE));
    }

    /** Notifications toggled on but blocked for the app: take the user to the switch. */
    private void ensureNotificationsAllowed() {
        if (getSystemService(NotificationManager.class).areNotificationsEnabled()) return;
        toast("Allow DevDeck notifications to get agent alerts");
        try {
            startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    /** `window.DD`. Called on the WebView's JavaBridge thread; UI work hops to the main thread. */
    private final class Bridge {
        private final WebView owner;

        Bridge(WebView owner) {
            this.owner = owner;
        }

        @JavascriptInterface
        public boolean send(String json) {
            LinkService s = svc;
            return s != null && s.sendLive(json);
        }

        @JavascriptInterface
        public String enqueue(String json) {
            try {
                LinkService s = svc;
                if (s != null) return s.enqueueJson(json);
                JSONObject it = new JSONObject(json);
                if (it.optString("id").isEmpty()) it.put("id", java.util.UUID.randomUUID().toString());
                LinkService.enqueue(MainActivity.this, new org.json.JSONArray().put(it));
                return it.getString("id");
            } catch (JSONException e) {
                Log.w(TAG, "bad enqueue from UI: " + e.getMessage());
                return "";
            }
        }

        @JavascriptInterface
        public void pickFiles() {
            main.post(MainActivity.this::pickFiles);
        }

        @JavascriptInterface
        public void setWakelock(boolean on) {
            main.post(() -> {
                if (svc != null) svc.setWakelock(on);
            });
        }

        @JavascriptInterface
        public void setNotify(boolean on) {
            main.post(() -> {
                if (svc != null) svc.setNotify(on);
                if (on) ensureNotificationsAllowed();
            });
        }

        @JavascriptInterface
        public void copyText(String text) {
            main.post(() -> getSystemService(ClipboardManager.class)
                    .setPrimaryClip(ClipData.newPlainText("DevDeck", text)));
        }

        @JavascriptInterface
        public void openUrl(String url) {
            main.post(() -> openExternal(url));
        }

        @JavascriptInterface
        public void haptic() {
            main.post(MainActivity.this::haptic);
        }

        @JavascriptInterface
        public void ready() {
            main.post(() -> {
                if (owner != web) return;
                ready = true;
                replay();
            });
        }

        @JavascriptInterface
        public void backResult(boolean handled) {
            main.post(() -> MainActivity.this.backResult(handled));
        }

        /** Opens the microphone: opts JSON {lang?: "en-US", partial?: true, preferOffline?: true}. */
        @JavascriptInterface
        public void listen(String opts) {
            main.post(() -> {
                if (owner == web) MainActivity.this.listen(opts);
            });
        }

        /** Finishes the listen session with what was heard so far. */
        @JavascriptInterface
        public void stopListening() {
            main.post(recognizer::stop);
        }

        @JavascriptInterface
        public void stopSpeaking() {
            LinkService s = svc;
            if (s != null) s.stopSpeaking();
        }

        @JavascriptInterface
        public void setVoiceMode(boolean on) {
            main.post(() -> {
                if (owner == web) MainActivity.this.setVoiceMode(on);
            });
        }
    }
}
