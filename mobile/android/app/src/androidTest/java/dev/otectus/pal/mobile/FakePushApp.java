package dev.otectus.pal.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** A stand-in push app. Java, because it runs in the test package's own process, without the app's Kotlin runtime. */
public class FakePushApp extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        // The wake-up check hands over what the desktop posted, as a push server would (adb can send only text).
        if ("dev.otectus.pal.test.DELIVER".equals(intent.getAction())) {
            String hex = intent.getStringExtra("hex");
            byte[] message = new byte[hex.length() / 2];
            for (int i = 0; i < message.length; i++) message[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            context.sendBroadcast(new Intent("org.unifiedpush.android.connector.MESSAGE").setPackage(context.getPackageName().replaceAll("\\.test$", ""))
                .addFlags(Intent.FLAG_RECEIVER_FOREGROUND).putExtra("token", intent.getStringExtra("token")).putExtra("bytesMessage", message).putExtra("id", "m2"));
            return;
        }
        String token = intent.getStringExtra("token");
        if (token == null || !"org.unifiedpush.android.distributor.REGISTER".equals(intent.getAction())) return;
        String app = context.getPackageName().replaceAll("\\.test$", "");
        // Who asks, as Android tells a push app: the shared identity, or before Android 14 the marked intent.
        boolean identified = Build.VERSION.SDK_INT >= 34 ? app.equals(getSentFromPackage()) : intent.hasExtra("pi");
        String key = intent.getStringExtra("vapid");
        try (java.io.FileOutputStream out = context.openFileOutput("token", Context.MODE_PRIVATE)) { out.write(token.getBytes()); } catch (java.io.IOException ignored) { }
        context.sendBroadcast(new Intent("org.unifiedpush.android.connector.NEW_ENDPOINT").setPackage(app)
            .putExtra("token", token).putExtra("id", "m1")
            .putExtra("endpoint", "https://push.example/" + (identified ? "known" : "unknown") + "/" + (key == null ? "nokey" : "key" + key.length())));
    }
}
