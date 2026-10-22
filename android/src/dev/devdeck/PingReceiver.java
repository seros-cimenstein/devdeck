package dev.devdeck;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Exact while-idle alarm of the hidden app: keeps the paused link alive (or redials it). */
public class PingReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        LinkService s = LinkService.instance;
        if (s != null) s.onAlarm();
    }
}
