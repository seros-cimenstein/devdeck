package dev.devdeck;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;

/**
 * Android SpeechRecognizer for the UI's voice mode; main thread only. One listen session at a
 * time, each on a fresh recognizer. Every session reports `stt` events: ready, partial*, then
 * final or error, then exactly one end. Microphone levels arrive as throttled `rms` events.
 */
final class Recognizer {
    interface Sink {
        /** Main thread: one local JSON message for the UI. */
        void event(String json);
    }

    private static final String TAG = "DevDeck";
    private static final long RMS_MS = 66;        // ~15 level updates per second
    private static final long STOP_GRACE_MS = 5000;  // stopListening without a result

    private final Context ctx;
    private final Sink sink;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable rmsTask = this::flushRms;
    private final Runnable stopTimeout = this::cancel;

    private SpeechRecognizer sr;
    private int session;
    private boolean active, readySeen, retried, rmsPosted;
    private float rms;
    private String lang, lastPartial;
    private boolean partial, preferOffline;

    Recognizer(Context ctx, Sink sink) {
        this.ctx = ctx;
        this.sink = sink;
    }

    /** Starts a session (ending a running one first). */
    void start(String lang, boolean partial, boolean preferOffline) {
        cancel();
        this.lang = lang;
        this.partial = partial;
        this.preferOffline = preferOffline;
        retried = false;
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
            fail("unavailable");
            return;
        }
        active = true;
        begin();
    }

    /** User is done talking: finish with what was heard (final or error, then end). */
    void stop() {
        if (!active) return;
        if (sr != null) sr.stopListening();
        main.removeCallbacks(stopTimeout);
        main.postDelayed(stopTimeout, STOP_GRACE_MS);
    }

    /** Abort without a result; emits end if a session was running. */
    void cancel() {
        if (!active) return;
        if (sr != null) sr.cancel();
        finish(null, null, null);
    }

    void destroy() {
        cancel();
        releaseRecognizer();
    }

    /** A session that could not start (e.g. microphone permission denied). */
    void fail(String error) {
        emit("error", null, error);
        emit("end", null, null);
    }

    private void begin() {
        releaseRecognizer();
        readySeen = false;
        lastPartial = null;
        final int id = ++session;
        try {
            sr = SpeechRecognizer.createSpeechRecognizer(ctx);
            sr.setRecognitionListener(new Callbacks(id));
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang)
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial)
                    .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline)
                    .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
            sr.startListening(i);
        } catch (RuntimeException e) {
            Log.w(TAG, "speech recognizer: " + e);
            finish("error", null, "client");
        }
    }

    private void restart() {
        if (active) begin();
    }

    private void finish(String phase, String text, String error) {
        active = false;
        session++;  // late callbacks of this recognizer are ignored
        main.removeCallbacks(stopTimeout);
        main.removeCallbacks(rmsTask);
        rmsPosted = false;
        if (phase != null) emit(phase, text, error);
        emit("end", null, null);
        // Not destroyed inside its own callback; the next begin() or destroy() also releases it.
        main.post(this::releaseIfIdle);
    }

    private void releaseIfIdle() {
        if (!active) releaseRecognizer();
    }

    private void releaseRecognizer() {
        if (sr == null) return;
        try {
            sr.destroy();
        } catch (RuntimeException e) {
            Log.w(TAG, "speech recognizer destroy: " + e);
        }
        sr = null;
    }

    private void flushRms() {
        rmsPosted = false;
        if (!active) return;
        try {
            sink.event(new JSONObject().put("t", "stt").put("phase", "rms").put("rms", rms).toString());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private void emit(String phase, String text, String error) {
        try {
            JSONObject o = new JSONObject().put("t", "stt").put("phase", phase);
            if (text != null) o.put("text", text);
            if (error != null) o.put("error", error);
            sink.event(o.toString());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String best(Bundle b) {
        ArrayList<String> r = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (r == null || r.isEmpty() || r.get(0) == null) return "";
        return r.get(0).trim();
    }

    /** Constants 10-13 are API 31; the build targets the API 30 android.jar. */
    private static String errorName(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "network-timeout";
            case SpeechRecognizer.ERROR_NETWORK: return "network";
            case SpeechRecognizer.ERROR_AUDIO: return "audio";
            case SpeechRecognizer.ERROR_SERVER: return "server";
            case SpeechRecognizer.ERROR_CLIENT: return "client";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "speech-timeout";
            case SpeechRecognizer.ERROR_NO_MATCH: return "no-match";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "busy";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "permission";
            case 10: return "too-many-requests";
            case 11: return "server-disconnected";
            case 12:
            case 13: return "language";
            default: return "error-" + code;
        }
    }

    private final class Callbacks implements RecognitionListener {
        private final int id;

        Callbacks(int id) {
            this.id = id;
        }

        private boolean live() {
            return active && id == session;
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            if (!live()) return;
            readySeen = true;
            emit("ready", null, null);
        }

        @Override
        public void onBeginningOfSpeech() {
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            if (!live()) return;
            rms = rmsdB;
            if (!rmsPosted) {
                rmsPosted = true;
                main.postDelayed(rmsTask, RMS_MS);
            }
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
        }

        @Override
        public void onError(int error) {
            if (!live()) return;
            // Offline preferred but no offline model for the language: try once online.
            if (preferOffline && !readySeen && !retried && (error == SpeechRecognizer.ERROR_SERVER
                    || error == 12 || error == 13)) {
                retried = true;
                preferOffline = false;
                session++;  // the failed recognizer is released by begin(), outside its callback
                main.post(Recognizer.this::restart);
                return;
            }
            finish("error", null, errorName(error));
        }

        @Override
        public void onResults(Bundle results) {
            if (!live()) return;
            String text = best(results);
            if (text.isEmpty()) finish("error", null, "no-match");
            else finish("final", text, null);
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (!live()) return;
            String text = best(partialResults);
            if (text.isEmpty() || text.equals(lastPartial)) return;
            lastPartial = text;
            emit("partial", text, null);
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }
    }
}
