package dev.devdeck;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Parcelable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Share target. Files go straight into the outbox/upload queue; plain text asks where to put it
 * (paste into a terminal, with or without Enter, or the PC clipboard). Pasting into a terminal
 * also makes it the one DevDeck shows next.
 */
public class ShareActivity extends Activity {
    private String target;
    private Button targetButton;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Intent in = getIntent();
        List<Uri> uris = streams(in);
        if (!uris.isEmpty()) {
            queueFiles(uris);
            return;
        }
        CharSequence cs = in.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (cs == null || cs.length() == 0) {
            Toast.makeText(this, "DevDeck: nothing to send", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }
        askForText(cs.toString());
    }

    private static List<Uri> streams(Intent in) {
        List<Uri> out = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(in.getAction())) {
            ArrayList<Parcelable> list = in.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) for (Parcelable p : list) if (p instanceof Uri) out.add((Uri) p);
        } else {
            Parcelable p = in.getParcelableExtra(Intent.EXTRA_STREAM);
            if (p instanceof Uri) out.add((Uri) p);
        }
        return out;
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private LinearLayout panel(String title) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(16), dp(20), dp(12));
        TextView t = new TextView(this);
        t.setText(title);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        t.setPadding(0, 0, 0, dp(8));
        box.addView(t);
        setContentView(box, new ViewGroup.LayoutParams(dp(300), ViewGroup.LayoutParams.WRAP_CONTENT));
        return box;
    }

    /** Copies while this activity (and so the URI grant) is alive, then finishes. */
    private void queueFiles(List<Uri> uris) {
        panel("Queuing " + uris.size() + " file(s)\u2026");
        setFinishOnTouchOutside(false);
        Context app = getApplicationContext();
        new Thread(() -> {
            int n = Outbox.queue(this, uris);
            runOnUiThread(() -> {
                Toast.makeText(app, Outbox.summary(n, uris.size()), Toast.LENGTH_SHORT).show();
                finish();
            });
        }, "dd-share").start();
    }

    private void askForText(String text) {
        List<String[]> terms = terminals();
        target = LinkService.watchTarget(this);
        if (target == null && !terms.isEmpty()) target = terms.get(0)[0];
        LinearLayout box = panel("Send to DevDeck");
        TextView preview = new TextView(this);
        preview.setText(text);
        preview.setMaxLines(4);
        preview.setEllipsize(TextUtils.TruncateAt.END);
        preview.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        preview.setPadding(0, 0, 0, dp(8));
        box.addView(preview);
        if (target != null) {
            targetButton = addButton(box, "", () -> pickTarget(terms));
            showTarget();
            addButton(box, "Paste", () -> queue(LinkService.sendItem(target, text, false), true));
            addButton(box, "Paste + Enter", () -> queue(LinkService.sendItem(target, text, true), true));
        }
        addButton(box, "PC clipboard", () -> queue(LinkService.clipItem(text), false));
    }

    /** [target, label] for every pane of the last known `sessions` list. */
    private static List<String[]> terminals() {
        List<String[]> out = new ArrayList<>();
        String s = LinkService.sessions();
        if (s == null) return out;
        try {
            JSONArray a = new JSONObject(s).getJSONArray("list");
            for (int i = 0; i < a.length(); i++) {
                JSONObject p = a.getJSONObject(i);
                String t = p.getString("target");
                String name = p.optString("session", t);
                String ctx = p.optString("context");
                out.add(new String[]{t, ctx.isEmpty() ? name : name + " \u00b7 " + ctx});
            }
        } catch (JSONException ignored) {
        }
        return out;
    }

    private void showTarget() {
        targetButton.setText("Terminal: " + target + " \u25be");
    }

    private void pickTarget(List<String[]> terms) {
        if (terms.isEmpty()) return;
        PopupMenu menu = new PopupMenu(this, targetButton);
        for (int i = 0; i < terms.size(); i++) menu.getMenu().add(0, i, i, terms.get(i)[1]);
        menu.setOnMenuItemClickListener(item -> {
            target = terms.get(item.getItemId())[0];
            showTarget();
            return true;
        });
        menu.show();
    }

    private interface Action {
        void run() throws JSONException;
    }

    private void queue(JSONObject item, boolean toTerminal) throws JSONException {
        LinkService.enqueue(this, new JSONArray().put(item));
        if (toTerminal) {
            MainActivity m = MainActivity.current;
            if (m != null) m.open(target);
            else LinkService.prefs(this).edit().putString("target", target).apply();
        }
        Toast.makeText(getApplicationContext(), "Queued", Toast.LENGTH_SHORT).show();
        finish();
    }

    private Button addButton(LinearLayout box, String label, Action a) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setOnClickListener(v -> {
            try {
                a.run();
            } catch (JSONException e) {
                Toast.makeText(getApplicationContext(), "DevDeck: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                finish();
            }
        });
        box.addView(b, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        return b;
    }
}
