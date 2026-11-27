package com.yoob52.pickup;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(name = "PickupUpdater")
public class PickupUpdater extends Plugin {
    private final AtomicBoolean installing = new AtomicBoolean();

    @PluginMethod
    public void install(PluginCall call) {
        String version = call.getString("version", "");
        String sha256 = call.getString("sha256", "");
        if (!version.matches("(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]?)\\.(0|[1-9][0-9]?)")
            || !sha256.matches("[a-f0-9]{64}")) {
            call.reject("Invalid update");
            return;
        }
        if (!installing.compareAndSet(false, true)) {
            call.reject("Update already in progress");
            return;
        }
        if (canInstall()) {
            download(call);
        } else {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.fromParts("package", getContext().getPackageName(), null));
            try {
                startActivityForResult(call, settings, "installPermissionResult");
            } catch (RuntimeException error) {
                installing.set(false);
                call.reject("Could not open installation settings", "INSTALL_PERMISSION");
            }
        }
    }

    @ActivityCallback
    private void installPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            installing.set(false);
        } else if (canInstall()) {
            download(call);
        } else {
            installing.set(false);
            call.reject("Installation permission not granted", "INSTALL_PERMISSION");
        }
    }

    private boolean canInstall() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private void download(PluginCall call) {
        new Thread(() -> {
            File apk = new File(getContext().getCacheDir(), "pickup-update.apk");
            try {
                downloadVerifiedApk(call.getString("version"), call.getString("sha256"), apk);
                getActivity().runOnUiThread(() -> openInstaller(call, apk));
            } catch (Exception error) {
                apk.delete();
                installing.set(false);
                call.reject("Could not download update");
            }
        }, "pickup-update").start();
    }

    private void downloadVerifiedApk(String version, String sha256, File apk) throws Exception {
        URL url = new URL("https://github.com/yoob52/PickUp/releases/download/v"
            + version + "/app-release.apk");
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Download failed");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long deadline = SystemClock.elapsedRealtime() + 300000;
            long size = 0;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(apk)) {
                byte[] buffer = new byte[65536];
                int length;
                while ((length = input.read(buffer)) != -1) {
                    size += length;
                    if (size > 256L * 1024 * 1024 || SystemClock.elapsedRealtime() > deadline) {
                        throw new IOException("Download exceeded limits");
                    }
                    digest.update(buffer, 0, length);
                    output.write(buffer, 0, length);
                }
            }
            byte[] expected = new byte[32];
            for (int i = 0; i < expected.length; i++) {
                expected[i] = (byte) Integer.parseInt(sha256.substring(i * 2, i * 2 + 2), 16);
            }
            if (!MessageDigest.isEqual(expected, digest.digest())) throw new IOException("APK checksum mismatch");
            PackageInfo archive = getContext().getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
            if (archive == null || !getContext().getPackageName().equals(archive.packageName)
                || !version.equals(archive.versionName)) throw new IOException("Unexpected APK");
        } finally {
            connection.disconnect();
        }
    }

    private void openInstaller(PluginCall call, File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Could not open the Android installer");
        } finally {
            installing.set(false);
        }
    }
}
