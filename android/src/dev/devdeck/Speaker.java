package dev.devdeck;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Plays the server's `audio` chunks (one Ogg/Opus sentence each) in order, one utterance after
 * the other, and reports progress to the UI as `tts` events. Everything runs on its own
 * thread: base64 decoding, the temp file per chunk and the MediaPlayer callbacks. Holds
 * transient audio focus (others duck) only while something is queued or playing.
 */
final class Speaker {
    interface Sink {
        /** Any thread: one local JSON message for the UI. */
        void event(String json);
    }

    private static final String TAG = "DevDeck";
    private static final long FOCUS_LINGER_MS = 400;  // bridges the gap between utterances
    private static final long STALL_MS = 20_000;  // no chunk for this long mid-reading: give up

    /** One utterance: chunks with the same identity, seq 0 .. last. */
    private static final class Utt {
        final String key, req, target, entryId;
        final boolean auto, ask;
        final ArrayDeque<Chunk> chunks = new ArrayDeque<>();
        boolean complete, started;
        String error;  // ended by voice_error / stall: finishes with tts error instead of end

        Utt(String key, String req, String target, String entryId, boolean auto, boolean ask) {
            this.key = key;
            this.req = req;
            this.target = target;
            this.entryId = entryId;
            this.auto = auto;
            this.ask = ask;
        }
    }

    private static final class Chunk {
        final int seq;
        final String text;
        final File file;  // null for an empty (end marker) chunk

        Chunk(int seq, String text, File file) {
            this.seq = seq;
            this.text = text;
            this.file = file;
        }
    }

    private final Sink sink;
    private final File dir;
    private final HandlerThread thread;
    private final Handler h;
    private final AudioManager audio;
    private final AudioAttributes attrs;
    private final AudioFocusRequest focusReq;
    private final Runnable releaseFocus = this::abandonFocus;
    private final Runnable stall = this::onStall;

    // Speaker thread only.
    private final List<Utt> utts = new ArrayList<>();  // arrival order; head is the one playing
    private final Set<String> dropped = new HashSet<>();  // stopped utterances still streaming
    private MediaPlayer player;
    private Chunk playing;
    private boolean focused;
    private long fileNo;

    Speaker(Context c, Sink sink) {
        this.sink = sink;
        dir = new File(c.getCacheDir(), "tts");
        audio = c.getSystemService(AudioManager.class);
        attrs = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
        thread = new HandlerThread("dd-tts");
        thread.start();
        h = new Handler(thread.getLooper());
        focusReq = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(this::onFocusChange, h)
                .build();
        h.post(this::cleanDir);  // leftovers of a killed process
    }

    /** Any thread: a raw server `audio` line (parsed on the speaker thread). */
    void offer(String line) {
        h.post(() -> onAudio(line));
    }

    /** Any thread: a raw server `voice_error` line; it ends that reading (no `last` follows). */
    void voiceError(String line) {
        h.post(() -> onVoiceError(line));
    }

    /** Any thread: stop playback and drop everything queued or still streaming. */
    void stop() {
        h.post(() -> stopNow(true));
    }

    /** Any thread: stop without an event and end the thread. */
    void shutdown() {
        h.post(() -> {
            stopNow(false);
            abandonFocus();
            thread.quitSafely();
        });
    }

    // ---- speaker thread ----

    /** Identity of a reading; `voice_error` carries the same fields as its `audio` chunks. */
    private static String key(String line) {
        return (Peek.bool(line, "auto", false) ? "a" : "") + (Peek.bool(line, "ask", false) ? "q" : "")
                + "|" + Peek.str(line, "req") + "|" + Peek.str(line, "target") + "|"
                + Peek.str(line, "entryId") + "|" + Peek.str(line, "toolCallId");
    }

    private void onAudio(String line) {
        h.removeCallbacks(stall);
        boolean last = Peek.bool(line, "last", false);
        int seq = (int) Peek.num(line, "seq", 0);
        String key = key(line);

        if (seq == 0) dropped.remove(key);
        if (dropped.contains(key)) {
            if (last) dropped.remove(key);
            return;
        }
        Utt u = null;
        if (seq != 0) {
            for (Utt x : utts) if (!x.complete && x.key.equals(key)) u = x;
        }
        if (u == null) {
            u = new Utt(key, Peek.str(line, "req"), Peek.str(line, "target"), Peek.str(line, "entryId"),
                    Peek.bool(line, "auto", false), Peek.bool(line, "ask", false));
            utts.add(u);
        }
        File f = null;
        String data = Peek.str(line, "data");
        if (data != null && !data.isEmpty()) {
            try {
                f = new File(dir, (fileNo++) + ".ogg");
                writeChunk(f, Base64.decode(data, Base64.DEFAULT));
            } catch (IllegalArgumentException | IOException e) {
                Log.w(TAG, "tts chunk " + seq + ": " + e);
                delete(f);
                f = null;
                event("error", u, seq, null, "bad audio chunk: " + e.getMessage());
            }
        }
        u.chunks.add(new Chunk(seq, Peek.str(line, "text"), f));
        if (last) u.complete = true;
        pump();
    }

    /** A started reading plays what it has and ends with tts error; a queued one is dropped. */
    private void onVoiceError(String line) {
        String key = key(line);
        dropped.remove(key);
        String error = Peek.str(line, "error");
        for (int i = utts.size() - 1; i >= 0; i--) {
            Utt x = utts.get(i);
            if (x.complete || !x.key.equals(key)) continue;
            if (x.started) {
                x.complete = true;
                x.error = error == null || error.isEmpty() ? "synthesis failed" : error;
            } else {
                utts.remove(i);
                for (Chunk c : x.chunks) delete(c.file);
            }
        }
        pump();
    }

    /** The head reading got nothing for STALL_MS (link lost mid-stream): finish it. */
    private void onStall() {
        if (player != null || utts.isEmpty()) return;
        Utt u = utts.get(0);
        if (u.complete || !u.chunks.isEmpty()) return;
        u.complete = true;
        u.error = "audio stream stalled";
        dropped.add(u.key);
        pump();
    }

    /** Starts the next chunk if idle; finishes utterances whose last chunk has played. */
    private void pump() {
        while (player == null) {
            if (utts.isEmpty()) {
                if (focused) h.postDelayed(releaseFocus, FOCUS_LINGER_MS);
                return;
            }
            Utt u = utts.get(0);
            if (!u.started) {
                u.started = true;
                event("start", u, -1, null, null);
                if (!requestFocus()) {
                    event("error", u, -1, null, "audio focus denied");
                    stopNow(true);
                    return;
                }
            }
            Chunk c = u.chunks.poll();
            if (c == null) {
                if (!u.complete) {  // more is still streaming in
                    h.removeCallbacks(stall);
                    h.postDelayed(stall, STALL_MS);
                    return;
                }
                utts.remove(0);
                if (u.error != null) event("error", u, -1, null, u.error);
                else event("end", u, -1, null, null);
                continue;
            }
            if (c.file == null) continue;
            event("chunk", u, c.seq, c.text, null);
            play(u, c);
        }
    }

    private void play(Utt u, Chunk c) {
        MediaPlayer mp = new MediaPlayer();  // created here, so its callbacks run on this thread
        try {
            mp.setAudioAttributes(attrs);
            mp.setDataSource(c.file.getPath());
            mp.setOnCompletionListener(p -> chunkDone(p));
            mp.setOnErrorListener((p, what, extra) -> {
                event("error", u, c.seq, null, "playback failed (" + what + "/" + extra + ")");
                chunkDone(p);
                return true;
            });
            mp.prepare();
            mp.start();
            player = mp;
            playing = c;
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "tts play " + c.seq + ": " + e);
            mp.release();
            delete(c.file);
            event("error", u, c.seq, null, "playback failed: " + e.getMessage());
        }
    }

    private void chunkDone(MediaPlayer p) {
        if (p != player) return;
        releasePlayer();
        pump();
    }

    private void releasePlayer() {
        if (player != null) {
            player.release();
            player = null;
        }
        if (playing != null) {
            delete(playing.file);
            playing = null;
        }
    }

    private void stopNow(boolean report) {
        Utt head = utts.isEmpty() ? null : utts.get(0);
        h.removeCallbacks(stall);
        releasePlayer();
        if (dropped.size() > 64) dropped.clear();  // readings that never sent their last chunk
        for (Utt u : utts) {
            if (!u.complete) dropped.add(u.key);
        }
        utts.clear();
        cleanDir();
        if (report) event("stopped", head != null && head.started ? head : null, -1, null, null);
        if (focused) h.postDelayed(releaseFocus, FOCUS_LINGER_MS);
    }

    private void onFocusChange(int change) {
        // Transient ducking is applied by the system; a call or another player taking focus
        // ends this utterance (the UI then shows the stop and can replay).
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            if (player != null || !utts.isEmpty()) stopNow(true);
            abandonFocus();
        }
    }

    private boolean requestFocus() {
        h.removeCallbacks(releaseFocus);
        if (focused) return true;
        focused = audio.requestAudioFocus(focusReq) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        return focused;
    }

    private void abandonFocus() {
        h.removeCallbacks(releaseFocus);
        if (!focused || player != null || !utts.isEmpty()) return;
        focused = false;
        audio.abandonAudioFocusRequest(focusReq);
    }

    private void event(String phase, Utt u, int seq, String text, String error) {
        try {
            JSONObject o = new JSONObject().put("t", "tts").put("phase", phase);
            if (u != null) {
                if (u.req != null) o.put("req", u.req);
                if (u.target != null) o.put("target", u.target);
                if (u.entryId != null) o.put("entryId", u.entryId);
                if (u.auto) o.put("auto", true);
                if (u.ask) o.put("ask", true);
            }
            if (seq >= 0) o.put("seq", seq);
            if (text != null) o.put("text", text);
            if (error != null) o.put("error", error);
            sink.event(o.toString());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private void writeChunk(File f, byte[] b) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(b);
        }
    }

    /** Removes temp files that no queued or playing chunk refers to (all of them when idle). */
    private void cleanDir() {
        File[] files = dir.listFiles();
        if (files == null) return;
        Set<String> keep = new HashSet<>();
        if (playing != null && playing.file != null) keep.add(playing.file.getName());
        for (Utt u : utts) for (Chunk c : u.chunks) if (c.file != null) keep.add(c.file.getName());
        for (File f : files) if (!keep.contains(f.getName())) delete(f);
    }

    private static void delete(File f) {
        if (f != null && f.exists() && !f.delete()) Log.w(TAG, "cannot delete " + f);
    }
}
